// Daemon-hosted Streamable HTTP MCP endpoint (stateless, loopback-only)
// plus the user-managed credential CRUD routes backing `od mcp token` and
// (later) Settings → MCP.
//
// The endpoint is in-process: one POST handler creates a per-request MCP
// Server + stateless StreamableHTTPServerTransport, so the resolved auth
// grant for that request is captured in the tool handlers' closure. No MCP
// child process, no second port, no session state.
//
// Plan: specs/current/http-first-mcp-implementation-plan.md §4, §5, §9 Slice 1.

import type { Express, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { sendApiError } from '../http/api-errors.js';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import type { McpCredentialStore } from './credentials.js';
import type { McpAuthGrant, McpToolRegistry } from './registry.js';

export const MCP_HTTP_PATH = '/mcp';

const MCP_ACCEPT = 'application/json, text/event-stream';

export interface RegisterMcpHttpRoutesDeps {
  registry: McpToolRegistry;
  resolveGrant: (req: Request) =>
    | { ok: true; grant: McpAuthGrant }
    | { ok: false; status: number; code: 'UNAUTHORIZED' | 'TOOL_TOKEN_MISSING' | 'TOOL_TOKEN_EXPIRED'; message: string };
  serverInfo: { name: string; version: string };
}

export interface RegisterMcpCredentialRoutesDeps {
  credentialStore: McpCredentialStore;
}

// ── /mcp ───────────────────────────────────────────────────────────────────

export function registerMcpHttpRoutes(app: Express, deps: RegisterMcpHttpRoutesDeps): void {
  // Slice 1 is POST-only (stateless JSON responses). GET/DELETE exist in the
  // Streamable HTTP spec for SSE streams and session termination; without
  // server-initiated messages there is nothing to stream. Declaring 405 here
  // (instead of falling through to the SPA fallback) lets MCP clients report
  // a precise diagnostic.
  app.get(MCP_HTTP_PATH, (_req, res) => {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Accept-Post', MCP_ACCEPT);
    res.status(405).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'GET /mcp is not supported; this endpoint is a stateless POST-only Streamable HTTP MCP server',
      },
    });
  });
  app.delete(MCP_HTTP_PATH, (_req, res) => {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'DELETE /mcp is not supported; stateless endpoint holds no sessions',
      },
    });
  });
  app.options(MCP_HTTP_PATH, (req, res) => {
    const validation = validateLocalDaemonRequest(req);
    if (!validation.ok) {
      return sendApiError(res, 403, 'FORBIDDEN', validation.message, { details: validation.details });
    }
    res.setHeader('Vary', 'Origin');
    if (validation.origin) res.setHeader('Access-Control-Allow-Origin', validation.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  app.post(MCP_HTTP_PATH, async (req, res) => {
    const validation = validateLocalDaemonRequest(req);
    if (!validation.ok) {
      return sendApiError(res, 403, 'FORBIDDEN', validation.message, { details: validation.details });
    }
    res.setHeader('Vary', 'Origin');
    if (validation.origin) res.setHeader('Access-Control-Allow-Origin', validation.origin);

    const auth = deps.resolveGrant(req);
    if (!auth.ok) {
      return sendApiError(res, auth.status, auth.code, auth.message);
    }
    const grant = auth.grant;

    const server = new Server(deps.serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: deps.registry.listWireTools(grant),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params as { name: string; arguments?: unknown };
      return deps.registry.call(params.name, params.arguments, grant, undefined);
    });

    // Stateless transport: `sessionIdGenerator` omitted (the SDK treats an
    // absent generator as stateless — no session ids, no session validation).
    // exactOptionalPropertyTypes forbids passing it explicitly as undefined.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendApiError(res, 500, 'INTERNAL_ERROR', `MCP request failed: ${message}`);
      } else {
        res.end();
      }
    } finally {
      await server.close().catch(() => {});
    }
  });
}

// ── /api/mcp/credentials ───────────────────────────────────────────────────

export function registerMcpCredentialRoutes(app: Express, deps: RegisterMcpCredentialRoutesDeps): void {
  const { credentialStore } = deps;

  app.get('/api/mcp/credentials', (req, res) => {
    const denial = localOnly(req, res);
    if (denial) return denial;
    res.json({ credentials: credentialStore.list() });
  });

  app.post('/api/mcp/credentials', (req, res) => {
    const denial = localOnly(req, res);
    if (denial) return denial;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const allowedOperations = Array.isArray(body.allowedOperations)
      ? body.allowedOperations.filter((op): op is string => typeof op === 'string')
      : undefined;
    const ttlMs = typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : undefined;
    try {
      const { credential, token } = credentialStore.create({
        name,
        ...(allowedOperations ? { allowedOperations } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      // `token` is the only time the plaintext is ever returned.
      res.status(201).json({ credential, token });
    } catch (err) {
      sendApiError(res, 400, 'VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  app.delete('/api/mcp/credentials/:id', (req, res) => {
    const denial = localOnly(req, res);
    if (denial) return denial;
    const revoked = credentialStore.revoke(req.params.id);
    if (!revoked) {
      return sendApiError(res, 404, 'NOT_FOUND', `no MCP credential with id ${req.params.id}`);
    }
    res.json({ ok: true, revoked: true });
  });
}

function localOnly(req: Request, res: Response): Response | undefined {
  const validation = validateLocalDaemonRequest(req);
  if (!validation.ok) {
    return sendApiError(res, 403, 'FORBIDDEN', validation.message, { details: validation.details });
  }
  res.setHeader('Vary', 'Origin');
  if (validation.origin) res.setHeader('Access-Control-Allow-Origin', validation.origin);
  return undefined;
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerMcpCredentialRoutes, registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { registerCoreMcpTools } from '../src/mcp-http/tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const PROTOCOL_VERSION = '2025-06-18';

describe('MCP HTTP endpoint (/mcp)', () => {
  let server: http.Server | null = null;
  let base: string;
  let toolTokenRegistry: ToolTokenRegistry;
  let credentialStore: McpCredentialStore;

  beforeEach(async () => {
    toolTokenRegistry = new ToolTokenRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-mcp-http-'));
    credentialStore = new McpCredentialStore({ filePath: path.join(dir, 'credentials.json') });
    const registry = new McpToolRegistry();
    registerCoreMcpTools(registry);

    const app = express();
    app.use(express.json());
    registerMcpHttpRoutes(app, {
      registry,
      resolveGrant: (req) => resolveMcpGrant(req, { toolTokenRegistry, credentialStore }),
      serverInfo: { name: 'open-design', version: '0.0.0-test' },
    });
    registerMcpCredentialRoutes(app, { credentialStore });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    toolTokenRegistry.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  function mcpPost(message: unknown, token?: string) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(message),
    });
  }

  async function mcpRequest(method: string, params: unknown, token: string, id: number) {
    const resp = await mcpPost({ jsonrpc: '2.0', id, method, params }, token);
    expect(resp.status).toBe(200);
    return await resp.json() as {
      jsonrpc: '2.0';
      id: number;
      result?: unknown;
      error?: { code: number; message: string };
    };
  }

  it('runs initialize → tools/list → tools/call over a real MCP handshake', async () => {
    const { token } = credentialStore.create({ name: 'handshake', allowedOperations: ['mcp:ping'] });

    const init = await mcpRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    }, token, 1);
    expect(init.error).toBeUndefined();
    const initResult = init.result as { serverInfo: { name: string }; capabilities: { tools: unknown } };
    expect(initResult.serverInfo.name).toBe('open-design');
    expect(initResult.capabilities.tools).toBeDefined();

    const initialized = await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    expect(initialized.status).toBe(202);

    const list = await mcpRequest('tools/list', {}, token, 2);
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain('od_ping');
    expect(tools.find((tool) => tool.name === 'od_ping')?.inputSchema).toMatchObject({ type: 'object' });

    const call = await mcpRequest('tools/call', {
      name: 'od_ping',
      arguments: { message: 'hello' },
    }, token, 3);
    const callResult = call.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { ok: boolean; data: { pong: boolean; message: string } };
      isError?: boolean;
    };
    expect(callResult.isError).toBeUndefined();
    expect(callResult.structuredContent.ok).toBe(true);
    expect(callResult.structuredContent.data).toMatchObject({ pong: true, message: 'hello' });
    const [firstContent] = callResult.content;
    expect(firstContent).toBeDefined();
    expect(firstContent!.type).toBe('text');
  });

  it('returns INVALID_ARGS for bad tool arguments', async () => {
    const { token } = credentialStore.create({ name: 'args' });
    const call = await mcpRequest('tools/call', {
      name: 'od_ping',
      arguments: { message: 'x'.repeat(500) },
    }, token, 1);
    const result = call.result as { isError: boolean; structuredContent: { ok: false; error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('INVALID_ARGS');
  });

  it('filters tools/list and denies calls for scoped credentials', async () => {
    const { token } = credentialStore.create({ name: 'scoped', allowedOperations: ['other/*'] });
    const list = await mcpRequest('tools/list', {}, token, 1);
    expect((list.result as { tools: unknown[] }).tools).toEqual([]);

    const call = await mcpRequest('tools/call', { name: 'od_ping', arguments: {} }, token, 2);
    const result = call.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('TOOL_OPERATION_DENIED');
  });

  it('accepts run-scoped tool tokens (Mode A) and reports run identity', async () => {
    const runToken = toolTokenRegistry.mint({
      runId: 'run-1',
      projectId: 'p1',
      allowedOperations: ['mcp:ping'],
    });
    const call = await mcpRequest('tools/call', { name: 'od_ping', arguments: {} }, runToken.token, 1);
    const result = call.result as { structuredContent: { data: { caller: { kind: string; runId: string; projectId: string } } } };
    expect(result.structuredContent.data.caller).toMatchObject({ kind: 'run', runId: 'run-1', projectId: 'p1' });
  });

  it('rejects missing and invalid tokens with 401', async () => {
    const missing = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(missing.status).toBe(401);

    const invalid = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      'odmcp_bogus',
    );
    expect(invalid.status).toBe(401);
  });

  it('rejects non-loopback Host headers with 403', async () => {
    const { token } = credentialStore.create({ name: 'host-check' });
    // undici strips manual `host` headers, so use node:http to forge the Host.
    const resp = await rawPost(base, '/mcp', {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      host: 'evil.example.com',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    expect(resp.status).toBe(403);
  });

  it('answers GET/DELETE with 405 and supports OPTIONS preflight', async () => {
    const get = await fetch(`${base}/mcp`);
    expect(get.status).toBe(405);

    const del = await fetch(`${base}/mcp`, { method: 'DELETE' });
    expect(del.status).toBe(405);

    const options = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:7100' },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('http://localhost:7100');
  });

  it('manages credentials over /api/mcp/credentials', async () => {
    const create = await fetch(`${base}/api/mcp/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'crud', allowedOperations: ['mcp:ping'] }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { credential: { id: string; name: string }; token: string };

    const list = await fetch(`${base}/api/mcp/credentials`);
    expect(list.status).toBe(200);
    expect((await list.json() as { credentials: Array<{ id: string }> }).credentials.map((c) => c.id))
      .toContain(created.credential.id);

    // The created token works against /mcp.
    const call = await mcpRequest('tools/call', { name: 'od_ping', arguments: {} }, created.token, 1);
    expect((call.result as { isError?: boolean }).isError).toBeUndefined();

    const revoke = await fetch(`${base}/api/mcp/credentials/${created.credential.id}`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);

    const gone = await fetch(`${base}/api/mcp/credentials/${created.credential.id}`, { method: 'DELETE' });
    expect(gone.status).toBe(404);

    // And the revoked token no longer authenticates.
    const denied = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      created.token,
    );
    expect(denied.status).toBe(401);
  });

  it('rejects credential creation from non-loopback peers', async () => {
    const resp = await rawPost(base, '/api/mcp/credentials', {
      'content-type': 'application/json',
      host: 'evil.example.com',
    }, JSON.stringify({ name: 'nope' }));
    expect(resp.status).toBe(403);
  });
});

// Minimal raw HTTP POST helper: fetch() (undici) refuses to send a manual
// Host header, so the non-loopback Host tests need node:http directly.
function rawPost(
  base: string,
  pathAndQuery: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(pathAndQuery, base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

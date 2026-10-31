import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorCatalogDefinition, ConnectorCatalogToolDefinition } from '../src/connectors/catalog.js';
import { registerConnectorRoutes } from '../src/connectors/routes.js';
import type { ConnectorService } from '../src/connectors/service.js';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { registerConnectorMcpTools } from '../src/mcp-http/connector-tools.js';
import type { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { McpToolRegistry, type McpToolLogEntry } from '../src/mcp-http/registry.js';
import { registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import type { ApprovalRun } from '../src/mcp-http/approval-principal.js';

function readTool(name: string, useCase = false): ConnectorCatalogToolDefinition {
  return {
    name, title: name, requiredScopes: ['docs:read'],
    safety: { sideEffect: 'read', approval: 'auto', reason: 'fixture' },
    refreshEligible: true,
    ...(useCase ? { curation: { useCases: ['personal_daily_digest'] } } : {}),
  };
}

function definition(id: string, tools: ConnectorCatalogToolDefinition[]): ConnectorCatalogDefinition {
  return {
    id, name: id, provider: 'fixture', category: 'docs', authentication: 'none',
    minimumApproval: 'auto', tools, allowedToolNames: tools.map((tool) => tool.name),
  };
}

describe('connector MCP list', () => {
  let server: http.Server;
  let base: string;
  let tokens: ToolTokenRegistry;
  let registry: McpToolRegistry;
  let logs: McpToolLogEntry[];
  let service: ConnectorService;
  let definitions: ConnectorCatalogDefinition[];
  let statuses: Record<string, { status: 'connected' | 'available' }>;
  let fast: ReturnType<typeof vi.fn>;
  let preview: ReturnType<typeof vi.fn>;
  let run: ApprovalRun;
  let workspace: string | null;
  let projectPresent: boolean;
  let decisionAllowed: boolean;

  beforeEach(async () => {
    const read = readTool('docs.search');
    const digest = readTool('docs.list', true);
    const write = { ...readTool('docs.delete'), safety: { sideEffect: 'write' as const, approval: 'confirm' as const, reason: 'fixture' }, refreshEligible: false };
    definitions = [definition('docs', [read, digest, write, readTool('docs.fetch')]), definition('offline', [readTool('offline.search')]), { ...definition('partial', []), toolCount: 1 }];
    definitions[0]!.allowedToolNames = ['docs.search', 'docs.list', 'docs.delete'];
    statuses = { docs: { status: 'connected' }, offline: { status: 'available' }, partial: { status: 'connected' } };
    fast = vi.fn(() => definitions);
    preview = vi.fn(async (id: string) => definition(id, [readTool('partial.search', true)]));
    service = {
      listFastDefinitions: fast,
      listConnectorStatuses: () => statuses,
      getStatus: (entry: ConnectorCatalogDefinition) => statuses[entry.id],
      getPreviewDefinition: preview,
      getHydratedDefinition: vi.fn(async () => undefined),
    } as unknown as ConnectorService;
    tokens = new ToolTokenRegistry();
    run = { id: 'r1', projectId: 'p1', status: 'running', workspaceScope: null };
    workspace = null; projectPresent = true; decisionAllowed = true;
    logs = [];
    registry = new McpToolRegistry({ log: (entry) => logs.push(entry) });
    registerConnectorMcpTools(registry, { tokenRegistry: tokens, projectsRoot: 'synthetic-root', service,
      getRun: () => run, getProjectWorkspaceId: () => workspace, projectExists: () => projectPresent,
      decideProjectRequest: () => decisionAllowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' },
    });
    const credentials = {
      validateToken: (token: string | undefined) => token === 'synthetic-external'
        ? { ok: true, credential: { id: 'ext', name: 'external', allowedOperations: ['*'] } }
        : { ok: false, code: 'MCP_CREDENTIAL_INVALID' },
    } as unknown as McpCredentialStore;
    const app = express();
    app.use(express.json());
    registerMcpHttpRoutes(app, {
      registry,
      resolveGrant: (req) => resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials }),
      serverInfo: { name: 'fixture', version: '1' },
    });
    registerConnectorRoutes(app, {
      service, projectsRoot: 'synthetic-root',
      sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }),
      authorizeToolRequest: createToolRequestAuth(tokens).authorizeToolRequest,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    tokens.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function mint(options: Partial<Parameters<ToolTokenRegistry['mint']>[0]> = {}): string {
    return tokens.mint({ runId: 'r1', projectId: 'p1', allowedEndpoints: ['/mcp', '/api/tools/connectors/list'], allowedOperations: ['connectors:list'], ...options }).token;
  }

  async function call(token: string, args: object = {}) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connectors_list', arguments: args } }),
    });
  }

  async function result(response: Response) {
    expect(response.status).toBe(200);
    return (await response.json() as { result: { structuredContent: { ok: boolean; data?: { connectors: Array<{ id: string; tools: Array<{ name: string }> }> }; error?: { code: string }; meta: { truncated?: boolean } } } }).result.structuredContent;
  }

  it('matches the existing REST catalog and excludes disconnected, unallowed and unsafe tools', async () => {
    const token = mint();
    for (const useCase of [undefined, 'personal_daily_digest'] as const) {
      const query = useCase ? `?useCase=${useCase}` : '';
      const rest = await (await fetch(`${base}/api/tools/connectors/list${query}`, { headers: { authorization: `Bearer ${token}` } })).json();
      const mcp = await result(await call(token, useCase ? { useCase } : {}));
      expect(mcp.data).toEqual(rest);
      expect(mcp.data?.connectors.map((entry) => entry.id)).toEqual(['docs', 'partial']);
      expect(mcp.data?.connectors[0]?.tools.map((tool) => tool.name)).toEqual(useCase ? ['docs.list'] : ['docs.search', 'docs.list']);
    }
    expect(preview).toHaveBeenCalledWith('partial', { toolsLimit: 1000 });
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('denies missing audience, missing endpoint, external grants and invalid arguments before provider lookup', async () => {
    expect((await call(mint({ allowedEndpoints: ['/api/tools/connectors/list'] }))).status).toBe(401);
    expect((await result(await call(mint({ allowedEndpoints: ['/mcp'] })))).error?.code).toBe('TOOL_ENDPOINT_DENIED');
    expect((await result(await call('synthetic-external'))).error?.code).toBe('EXTERNAL_APPROVAL_REQUIRED');
    expect((await result(await call(mint(), { projectId: 'other' }))).error?.code).toBe('INVALID_ARGS');
    expect((await result(await call(mint(), { useCase: 'other' }))).error?.code).toBe('INVALID_ARGS');
    expect(fast).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('revalidates operation and caller identity, and rejects expired or revoked tokens', async () => {
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = (token: string) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined }) as Request;
    expect((await registry.call('connectors_list', {}, grant, undefined, req(mint({ allowedOperations: ['other'] })))).structuredContent).toMatchObject({ error: { code: 'TOOL_OPERATION_DENIED' } });
    const token = mint();
    for (const mismatch of [{ ...grant, runId: 'other' }, { ...grant, projectId: 'other' }]) {
      expect((await registry.call('connectors_list', {}, mismatch, undefined, req(token))).structuredContent).toMatchObject({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    }
    expect((await call(mint({ ttlMs: 1, nowMs: Date.now() - 1000 }))).status).toBe(401);
    tokens.revokeToken(token);
    expect((await call(token)).status).toBe(401);
    expect(fast).not.toHaveBeenCalled();
  });

  it('denies connector discovery after run scope, binding, or lifecycle changes', async () => {
    const token = mint();
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = (headers: Record<string, string> = {}) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : headers[name.toLowerCase()] }) as Request;
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1';
    expect((await registry.call('connectors_list', {}, grant, undefined, req())).structuredContent.ok).toBe(true);
    fast.mockClear();
    const denied = async (request = req()) => expect((await registry.call('connectors_list', {}, grant, undefined, request)).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    workspace = 'w2'; await denied();
    run.workspaceScope = null; await denied();
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1'; await denied(req({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'bob' }));
    decisionAllowed = false; await denied();
    decisionAllowed = true; projectPresent = false; await denied();
    projectPresent = true; run.cancelRequested = true; await denied();
    run.cancelRequested = false; run.status = 'succeeded'; await denied();
    expect(fast).not.toHaveBeenCalled();
  });

  it('does not publish connector discovery after authority changes during hydration', async () => {
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    for (const change of ['workspace', 'token', 'run'] as const) {
      workspace = 'w1'; run.cancelRequested = false;
      const token = mint();
      const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      preview.mockImplementation(async (id: string) => { entered(); await gate; return definition(id, [readTool('partial.search')]); });
      const pending = registry.call('connectors_list', {}, grant, undefined, req);
      await started;
      if (change === 'workspace') workspace = 'w2'; else if (change === 'token') tokens.revokeToken(token); else run.cancelRequested = true;
      release();
      expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    }
  });

  it('bounds oversized catalog responses without placing the bearer in results or logs', async () => {
    definitions[0]!.description = 'x'.repeat(80_000);
    const token = mint();
    const response = await call(token);
    const payload = JSON.stringify(await response.json());
    expect(payload.length).toBeLessThan(32_000);
    expect(payload).toContain('"truncated":true');
    expect(payload).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('does not expose provider failure details in results or logs', async () => {
    const marker = 'synthetic-provider-secret';
    preview.mockRejectedValueOnce(new Error(`provider failure: ${marker}`));
    const response = await call(mint());
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain('CONNECTOR_EXECUTION_FAILED');
    expect(payload).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(marker);
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorCatalogDefinition } from '../src/connectors/catalog.js';
import { registerConnectorRoutes } from '../src/connectors/routes.js';
import { CONNECTOR_RUN_RATE_LIMIT_CALLS, ConnectorService, ConnectorStatusService, type ConnectorExecuteRequest, type ConnectorExecutionContext } from '../src/connectors/service.js';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { registerConnectorMcpTools } from '../src/mcp-http/connector-tools.js';
import type { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { McpToolRegistry, type McpToolLogEntry } from '../src/mcp-http/registry.js';
import { registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import type { ApprovalRun } from '../src/mcp-http/approval-principal.js';

const definition: ConnectorCatalogDefinition = {
  id: 'docs', name: 'Docs', provider: 'fixture', category: 'docs', minimumApproval: 'auto',
  tools: [
    { name: 'docs.search', title: 'Search', requiredScopes: ['docs:read'], safety: { sideEffect: 'read', approval: 'auto', reason: 'fixture' }, refreshEligible: true },
    { name: 'docs.delete', title: 'Delete', requiredScopes: ['docs:write'], safety: { sideEffect: 'write', approval: 'confirm', reason: 'fixture' }, refreshEligible: false },
  ],
  allowedToolNames: ['docs.search', 'docs.delete'],
};

class FixtureService extends ConnectorService {
  calls = 0;
  failure?: Error;
  override listFastDefinitions() { return [definition]; }
  override async getDefinition(id: string) { return id === definition.id ? definition : undefined; }
  protected override async executeConnectorProviderTool(_request: ConnectorExecuteRequest, _context: ConnectorExecutionContext) {
    this.calls++;
    if (this.failure) throw this.failure;
    return { rows: ['synthetic'] };
  }
}

describe('connector MCP execution', () => {
  let server: http.Server;
  let base: string;
  let tokens: ToolTokenRegistry;
  let registry: McpToolRegistry;
  let service: FixtureService;
  let logs: McpToolLogEntry[];
  let run: ApprovalRun;
  let workspace: string | null;
  let projectPresent: boolean;
  let decisionAllowed: boolean;
  const args = { connectorId: 'docs', toolName: 'docs.search', input: { query: 'synthetic-argument' } };

  beforeEach(async () => {
    const status = new ConnectorStatusService();
    status.connect(definition, 'synthetic');
    service = new FixtureService(status);
    tokens = new ToolTokenRegistry();
    run = { id: 'run', projectId: 'project', status: 'running', workspaceScope: null };
    workspace = null; projectPresent = true; decisionAllowed = true;
    logs = [];
    registry = new McpToolRegistry({ log: (entry) => logs.push(entry) });
    registerConnectorMcpTools(registry, { tokenRegistry: tokens, projectsRoot: 'fixture', service,
      getRun: () => run, getProjectWorkspaceId: () => workspace, projectExists: () => projectPresent,
      decideProjectRequest: () => decisionAllowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' },
    });
    const credentials = { validateToken: (token: string | undefined) => token === 'external'
      ? { ok: true, credential: { id: 'ext', name: 'external', allowedOperations: ['*'] } }
      : { ok: false, code: 'MCP_CREDENTIAL_INVALID' } } as unknown as McpCredentialStore;
    const app = express();
    app.use(express.json());
    registerMcpHttpRoutes(app, { registry, resolveGrant: (req) => resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials }), serverInfo: { name: 'fixture', version: '1' } });
    registerConnectorRoutes(app, { service, projectsRoot: 'fixture', sendApiError: (res, statusCode, code, message, init) => res.status(statusCode).json({ error: { code, message, ...init } }), authorizeToolRequest: createToolRequestAuth(tokens).authorizeToolRequest });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { tokens.clear(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  function mint(options: Partial<Parameters<ToolTokenRegistry['mint']>[0]> = {}) {
    return tokens.mint({ runId: 'run', projectId: 'project', allowedEndpoints: ['/mcp', '/api/tools/connectors/execute'], allowedOperations: ['connectors:execute'], ...options }).token;
  }
  async function call(token: string, input: unknown = args) {
    return fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connectors_execute', arguments: input } }) });
  }
  async function result(response: Response) {
    expect(response.status).toBe(200);
    return (await response.json() as { result: { structuredContent: { ok: boolean; data?: unknown; error?: { code: string } } } }).result.structuredContent;
  }
  async function rest(token: string, input: unknown = args) {
    return fetch(`${base}/api/tools/connectors/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  }

  it('preserves plugin policy and returns the same result as REST', async () => {
    const restricted = { pluginSnapshotId: 'snapshot', pluginTrust: 'restricted' as const };
    expect((await result(await call(mint(restricted)))).error?.code).toBe('CONNECTOR_NOT_GRANTED');
    expect((await result(await call(mint({ ...restricted, pluginCapabilitiesGranted: ['connector:*'] })))).error?.code).toBe('CONNECTOR_NOT_GRANTED');
    expect(service.calls).toBe(0);
    const exact = mint({ ...restricted, pluginCapabilitiesGranted: ['connector:docs'] });
    const mcp = await result(await call(exact));
    expect(mcp.data).toEqual(await (await rest(exact)).json());
    expect((await result(await call(mint({ ...restricted, pluginTrust: 'trusted' })))).ok).toBe(true);
    expect(service.calls).toBe(3);
  });

  it('denies unsafe tools and invalid input before the provider', async () => {
    const token = mint();
    expect((await result(await call(token, { ...args, toolName: 'docs.delete' }))).error?.code).toBe('CONNECTOR_SAFETY_DENIED');
    expect((await result(await call(token, { ...args, input: [] }))).error?.code).toBe('INVALID_ARGS');
    expect((await result(await call(token, { ...args, input: { payload: 'x'.repeat(100_000) } }))).error?.code).toBe('VALIDATION_FAILED');
    expect((await result(await call(token, { ...args, projectId: 'other' }))).error?.code).toBe('INVALID_ARGS');
    const invalidPayload = JSON.stringify(await (await call(token, { ...args, 'synthetic-secret-key': 'synthetic-secret-value' })).json());
    expect(invalidPayload).not.toContain('synthetic-secret');
    expect(service.calls).toBe(0);
  });

  it('preserves REST project, purpose and bounded-input errors', async () => {
    const token = mint();
    for (const [input, statusCode, code] of [
      [{ ...args, projectId: 'other' }, 403, 'FORBIDDEN'],
      [{ ...args, purpose: 'artifact_refresh' }, 403, 'FORBIDDEN'],
      [{ ...args, input: { payload: 'x'.repeat(100_000) } }, 400, 'VALIDATION_FAILED'],
    ] as const) {
      const response = await rest(token, input);
      expect(response.status).toBe(statusCode);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
    }
    expect(service.calls).toBe(0);
  });

  it('revalidates audience, endpoint, operation, identity and revocation', async () => {
    expect((await call(mint({ allowedEndpoints: ['/api/tools/connectors/execute'] }))).status).toBe(401);
    expect((await result(await call(mint({ allowedEndpoints: ['/mcp'] })))).error?.code).toBe('TOOL_ENDPOINT_DENIED');
    expect((await result(await call('external'))).error?.code).toBe('EXTERNAL_APPROVAL_REQUIRED');
    const grant = { kind: 'run' as const, runId: 'run', projectId: 'project', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = (token: string) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined }) as Request;
    expect((await registry.call('connectors_execute', args, grant, undefined, req(mint({ allowedOperations: ['connectors:list'] })))).structuredContent).toMatchObject({ error: { code: 'TOOL_OPERATION_DENIED' } });
    const token = mint();
    expect((await registry.call('connectors_execute', args, { ...grant, runId: 'other' }, undefined, req(token))).structuredContent).toMatchObject({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    tokens.revokeToken(token);
    expect((await call(token)).status).toBe(401);
    expect(service.calls).toBe(0);
  });

  it('denies connector execution after run scope, binding, or lifecycle changes', async () => {
    const token = mint();
    const grant = { kind: 'run' as const, runId: 'run', projectId: 'project', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = (headers: Record<string, string> = {}) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : headers[name.toLowerCase()] }) as Request;
    run.workspaceScope = { schemaVersion: 1, projectId: 'project', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1';
    expect((await registry.call('connectors_execute', args, grant, undefined, req())).structuredContent.ok).toBe(true);
    const calls = service.calls;
    const denied = async (request = req()) => expect((await registry.call('connectors_execute', args, grant, undefined, request)).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    workspace = 'w2'; await denied();
    run.workspaceScope = null; await denied();
    run.workspaceScope = { schemaVersion: 1, projectId: 'project', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1'; await denied(req({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'bob' }));
    decisionAllowed = false; await denied();
    decisionAllowed = true; projectPresent = false; await denied();
    projectPresent = true; run.cancelRequested = true; await denied();
    run.cancelRequested = false; run.status = 'succeeded'; await denied();
    expect(service.calls).toBe(calls);
  });

  it('rechecks authority after connector hydration and before provider dispatch', async () => {
    run.workspaceScope = { schemaVersion: 1, projectId: 'project', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    const grant = { kind: 'run' as const, runId: 'run', projectId: 'project', credentialId: null, name: null, allowedOperations: ['*'] };
    const fast = vi.spyOn(service, 'listFastDefinitions').mockReturnValue([]);
    try {
      for (const change of ['workspace', 'token', 'run'] as const) {
        workspace = 'w1'; run.cancelRequested = false;
        const token = mint();
        const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
        let release!: () => void; let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const hydration = vi.spyOn(service, 'getHydratedDefinition').mockImplementation(async () => { entered(); await gate; return definition; });
        const pending = registry.call('connectors_execute', args, grant, undefined, req);
        await started;
        if (change === 'workspace') workspace = 'w2'; else if (change === 'token') tokens.revokeToken(token); else run.cancelRequested = true;
        release();
        expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
        hydration.mockRestore();
      }
      expect(service.calls).toBe(0);
    } finally { fast.mockRestore(); }
  });

  it('shares the per-run rate limit across REST and MCP', async () => {
    const token = mint();
    for (let i = 0; i < CONNECTOR_RUN_RATE_LIMIT_CALLS; i++) {
      if (i % 2 === 0) expect((await rest(token)).status).toBe(200);
      else expect((await result(await call(token))).ok).toBe(true);
    }
    expect((await result(await call(token))).error?.code).toBe('CONNECTOR_RATE_LIMITED');
    expect((await rest(token)).status).toBe(429);
    expect(service.calls).toBe(CONNECTOR_RUN_RATE_LIMIT_CALLS);
  });

  it('redacts provider errors and arguments from MCP results and logs', async () => {
    const token = mint();
    service.failure = new Error('synthetic-provider-secret');
    const payload = JSON.stringify(await (await call(token)).json());
    expect(payload).toContain('CONNECTOR_EXECUTION_FAILED');
    for (const secret of [token, 'synthetic-provider-secret', 'synthetic-argument']) {
      expect(payload).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
  });
});

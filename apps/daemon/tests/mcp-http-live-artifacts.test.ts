import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { sendApiError } from '../src/http/api-errors.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';
import { createLiveArtifact, listLiveArtifacts, updateLiveArtifact, getLiveArtifact, listLiveArtifactRefreshLogEntries } from '../src/live-artifacts/store.js';
import { refreshLiveArtifact } from '../src/live-artifacts/refresh-service.js';
import { connectorService } from '../src/connectors/service.js';
import { registerLiveArtifactMcpTools } from '../src/mcp-http/live-artifact-tools.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { McpToolRegistry, type McpToolLogEntry } from '../src/mcp-http/registry.js';
import { registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { registerLiveArtifactRoutes, type RegisterLiveArtifactRoutesDeps } from '../src/routes/live-artifact.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { createLiveArtifactForTool, type LiveArtifactToolWriteDeps } from '../src/services/live-artifact-tool-write.js';
import type { ApprovalRun } from '../src/mcp-http/approval-principal.js';

describe('live artifact MCP list', () => {
  let server: http.Server;
  let root: string;
  let base: string;
  let tokens: ToolTokenRegistry;
  let credentials: McpCredentialStore;
  let registry: McpToolRegistry;
  let allowed: boolean;
  let logs: McpToolLogEntry[];
  let list: ReturnType<typeof vi.fn<typeof listLiveArtifacts>>;
  let events: Array<{ runId: string; action?: string; phase?: string; artifactId?: string }>;
  let refresh: typeof refreshLiveArtifact;
  let writeAuthority: (projectId: string) => Promise<boolean>;
  let run: ApprovalRun;
  let workspace: string | null;
  let projectPresent: boolean;
  let decisionAllowed: boolean;
  let decisionHook: () => void;
  let createHook: typeof createLiveArtifact;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-mcp-artifacts-'));
    tokens = new ToolTokenRegistry();
    credentials = new McpCredentialStore({ filePath: path.join(root, 'credentials.json') });
    allowed = true;
    logs = [];
    events = [];
    run = { id: 'r1', projectId: 'p1', status: 'running', workspaceScope: null };
    workspace = null;
    projectPresent = true;
    decisionAllowed = true;
    decisionHook = () => {};
    createHook = createLiveArtifact;
    list = vi.fn(listLiveArtifacts);
    refresh = async (options) => {
      const { artifact } = await getLiveArtifact(options);
      await options.onStarted?.({ refreshId: 'refresh-fixture', artifact });
      return { artifact, refresh: { id: 'refresh-fixture', status: 'succeeded', refreshedSourceCount: 0 } };
    };
    const emitLiveArtifactEvent = (grant: { runId: string }, action: string, artifact: { id: string }) => { events.push({ runId: grant.runId, action, artifactId: artifact.id }); };
    const emitLiveArtifactRefreshEvent = (grant: { runId: string }, event: { phase: string; artifactId: string }) => { events.push({ runId: grant.runId, phase: event.phase, artifactId: event.artifactId }); };
    registry = new McpToolRegistry({ log: (entry) => logs.push(entry) });
    const authorizeProjectTool = async (projectId: string) => allowed && projectId === 'p1';
    writeAuthority = authorizeProjectTool;
    registerLiveArtifactMcpTools(registry, { tokenRegistry: tokens, projectsRoot: root, listLiveArtifacts: list, authorizeProjectTool,
      getRun: () => run, getProjectWorkspaceId: () => workspace, projectExists: () => projectPresent,
      decideProjectRequest: () => { decisionHook(); return decisionAllowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' }; },
      authorizeProjectToolWrite: (projectId) => writeAuthority(projectId), createLiveArtifact: (options) => createHook(options), updateLiveArtifact, refreshLiveArtifact: (options) => refresh(options),
      emitLiveArtifactEvent, emitLiveArtifactRefreshEvent,
    });
    const app = express();
    app.use(express.json());
    registerMcpHttpRoutes(app, {
      registry,
      resolveGrant: (req) => resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials }),
      serverInfo: { name: 'fixture', version: '1' },
    });
    registerLiveArtifactRoutes(app, {
      db: {}, paths: { PROJECTS_DIR: root }, auth: createToolRequestAuth(tokens),
      http: { sendApiError, requireLocalDaemonRequest, sendLiveArtifactRouteError: (res: express.Response) => res.status(500).json({ error: 'artifact error' }) },
      liveArtifacts: { createLiveArtifact, updateLiveArtifact, refreshLiveArtifact: (options: Parameters<typeof refresh>[0]) => refresh(options), listLiveArtifacts: list, getLiveArtifact, emitLiveArtifactEvent, emitLiveArtifactRefreshEvent }, projectStore: {},
      authorizeProjectRequest: async () => true,
      authorizeProjectToolRequest: async (res: express.Response, projectId: string) => {
        if (await authorizeProjectTool(projectId)) return { workspace: null };
        sendApiError(res, 403, 'FORBIDDEN', 'project denied');
        return null;
      },
    } as unknown as RegisterLiveArtifactRoutesDeps);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    tokens.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Only remove the test-owned directory returned by mkdtemp under the OS temp root.
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('od-mcp-artifacts-')) {
      throw new Error('refusing to remove an unexpected artifact fixture directory');
    }
    await rm(root, { recursive: true, force: true });
  });

  function mint(options: Partial<Parameters<ToolTokenRegistry['mint']>[0]> = {}) {
    return tokens.mint({
      runId: 'r1', projectId: 'p1',
      allowedEndpoints: ['/mcp', ...['list', 'create', 'update', 'refresh'].map((name) => `/api/tools/live-artifacts/${name}`)],
      allowedOperations: ['live-artifacts:list', 'live-artifacts:create', 'live-artifacts:update', 'live-artifacts:refresh'],
      ...options,
    }).token;
  }

  function call(token: string, args: object = {}, name = 'live_artifacts_list') {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  }

  async function result(response: Response) {
    expect(response.status).toBe(200);
    return (await response.json() as { result: { structuredContent: { ok: boolean; data?: unknown; error?: { code: string }; meta: { truncated?: boolean } } } }).result.structuredContent;
  }

  it('shares the REST artifact list for the authenticated project, including empty and repeat reads', async () => {
    const token = mint();
    expect((await result(await call(token))).data).toEqual({ artifacts: [] });
    const create = await fetch(`${base}/api/tools/live-artifacts/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: { title: 'Synthetic artifact', preview: { type: 'html', entry: 'index.html' }, document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { title: 'Synthetic artifact' } } } }),
    });
    expect(create.status).toBe(200);
    const rest = await fetch(`${base}/api/tools/live-artifacts/list`, { headers: { authorization: `Bearer ${token}` } });
    const expected = await rest.json() as { artifacts: Array<{ projectId: string; title: string }> };
    expect(expected.artifacts).toHaveLength(1);
    expect(expected.artifacts[0]).toMatchObject({ projectId: 'p1', title: 'Synthetic artifact' });
    expect((await result(await call(token))).data).toEqual(expected);
    expect((await result(await call(token))).data).toEqual(expected);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('denies missing MCP audience, missing list endpoint, untrusted external credentials and invalid project arguments', async () => {
    expect((await call(mint({ allowedEndpoints: ['/api/tools/live-artifacts/list'] }))).status).toBe(401);
    expect((await result(await call(mint({ allowedEndpoints: ['/mcp'] })))).error?.code).toBe('TOOL_ENDPOINT_DENIED');
    const external = credentials.create({ name: 'local external', allowedOperations: ['*'] });
    expect((await result(await call(external.token))).error?.code).toBe('EXTERNAL_APPROVAL_REQUIRED');
    expect((await result(await call(mint(), { projectId: 'p2' }))).error?.code).toBe('INVALID_ARGS');
    expect(list).not.toHaveBeenCalled();
  });

  it('revalidates the original token operation and rejects mismatched run and project identities', async () => {
    const token = mint({ allowedOperations: ['live-artifacts:create'] });
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
    expect((await registry.call('live_artifacts_list', {}, grant, undefined, req)).structuredContent).toMatchObject({ error: { code: 'TOOL_OPERATION_DENIED' } });
    const valid = mint();
    const validReq = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${valid}` : undefined } as Request;
    for (const mismatch of [{ ...grant, runId: 'other' }, { ...grant, projectId: 'other' }]) {
      expect((await registry.call('live_artifacts_list', {}, mismatch, undefined, validReq)).structuredContent).toMatchObject({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects expired or revoked runs and the same denied project on both surfaces', async () => {
    const expired = mint({ ttlMs: 1, nowMs: Date.now() - 1000 });
    expect((await call(expired)).status).toBe(401);
    const revoked = mint();
    tokens.revokeToken(revoked);
    expect((await call(revoked)).status).toBe(401);
    const valid = mint();
    allowed = false;
    expect((await result(await call(valid))).error?.code).toBe('PROJECT_SCOPE_DENIED');
    expect((await fetch(`${base}/api/tools/live-artifacts/list`, { headers: { authorization: `Bearer ${valid}` } })).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('rechecks the pinned run and workspace before each artifact read or write', async () => {
    const token = mint();
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    const req = (headers: Record<string, string> = {}) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : headers[name.toLowerCase()] }) as Request;
    const operations = [
      ['live_artifacts_list', {}], ['live_artifacts_create', { input: {} }],
      ['live_artifacts_update', { artifactId: 'missing', input: {} }], ['live_artifacts_refresh', { artifactId: 'missing' }],
    ] as const;
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1';
    expect((await registry.call('live_artifacts_list', {}, grant, undefined, req())).structuredContent.ok).toBe(true);
    list.mockClear();
    const denyAll = async (request: Request) => {
      for (const [name, args] of operations) expect((await registry.call(name, args, grant, undefined, request)).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    };
    workspace = 'w2'; await denyAll(req()); // rebound
    run.workspaceScope = null; await denyAll(req()); // an unbound run cannot inherit a later binding
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1'; await denyAll(req({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'bob' }));
    decisionAllowed = false; await denyAll(req()); // deleted/revoked binding
    decisionAllowed = true; projectPresent = false; await denyAll(req());
    projectPresent = true; run.cancelRequested = true; await denyAll(req());
    run.cancelRequested = false; run.status = 'succeeded'; await denyAll(req());
    expect(list).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(await listLiveArtifacts({ projectsRoot: root, projectId: 'p1' })).toEqual([]);
  });

  it('shares writes and refresh events across REST and MCP while binding the run', async () => {
    const token = mint();
    const input = { title: 'Created by MCP', preview: { type: 'html', entry: 'index.html' }, document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: {} } };
    const created = await result(await call(token, { input }, 'live_artifacts_create'));
    expect(created.ok).toBe(true);
    const artifact = (created.data as { artifact: { id: string; createdByRunId: string } }).artifact;
    expect(artifact.createdByRunId).toBe('r1');
    const updated = await fetch(`${base}/api/tools/live-artifacts/update`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ artifactId: artifact.id, input: { title: 'Updated by REST' } }) });
    expect(updated.status).toBe(200);
    const refreshed = await result(await call(token, { artifactId: artifact.id }, 'live_artifacts_refresh'));
    expect(refreshed.data).toMatchObject({ artifact: { title: 'Updated by REST' }, refresh: { status: 'succeeded', id: 'refresh-fixture' } });
    expect(events).toEqual([
      { runId: 'r1', action: 'created', artifactId: artifact.id },
      { runId: 'r1', action: 'updated', artifactId: artifact.id },
      { runId: 'r1', phase: 'started', artifactId: artifact.id },
      { runId: 'r1', phase: 'succeeded', artifactId: artifact.id },
    ]);
    expect((await getLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId: artifact.id })).artifact.title).toBe('Updated by REST');
  });

  it('retains a usable artifact reference for large create, update and refresh responses', async () => {
    const token = mint();
    const dataJson = { a: 'a'.repeat(10_000), b: 'b'.repeat(10_000), c: 'c'.repeat(10_000), d: 'd'.repeat(10_000) };
    const input = { title: 'Large artifact', preview: { type: 'html', entry: 'index.html' }, document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson } };
    const created = await result(await call(token, { input }, 'live_artifacts_create'));
    expect(created.meta.truncated).toBe(true);
    const data = created.data as { artifact: { id: string }; artifactUrl: string };
    expect(data.artifact.id).toBeTruthy();
    expect(data.artifactUrl).toBe(`/api/live-artifacts/${encodeURIComponent(data.artifact.id)}?projectId=p1`);
    const updated = await result(await call(token, { artifactId: data.artifact.id, input: { title: 'Updated large artifact' } }, 'live_artifacts_update'));
    const refreshed = await result(await call(token, { artifactId: data.artifact.id }, 'live_artifacts_refresh'));
    for (const response of [created, updated, refreshed]) {
      expect(response.ok).toBe(true);
      expect(response.meta.truncated).toBe(true);
      expect(response.data).toMatchObject({ artifact: { id: data.artifact.id, projectId: 'p1' }, artifactUrl: data.artifactUrl });
      expect(JSON.stringify(response.data).length).toBeLessThan(32_000);
    }
    expect(refreshed.data).toMatchObject({ refresh: { id: 'refresh-fixture', status: 'succeeded' } });
    const reference = await fetch(`${base}${data.artifactUrl}`);
    expect(reference.status).toBe(200);
    expect(await reference.json()).toMatchObject({ artifact: { id: data.artifact.id, title: 'Updated large artifact', document: { dataJson } } });
    expect(events.map((event) => event.phase ?? event.action)).toEqual(['created', 'updated', 'started', 'succeeded']);
  });

  it('does not start writes when already cancelled or cancelled while authorization is pending', async () => {
    const token = mint();
    const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    const scenarios = [
      { name: 'live_artifacts_create', args: { input: {} } },
      { name: 'live_artifacts_update', args: { artifactId: 'missing', input: {} } },
      { name: 'live_artifacts_refresh', args: { artifactId: 'missing' } },
    ];
    for (const scenario of scenarios) {
      const already = new AbortController(); already.abort();
      const rejected = await registry.call(scenario.name, scenario.args, grant, already.signal, req);
      expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_CALL_CANCELLED' } });
      let resume!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      writeAuthority = async () => { entered(); await gate; return true; };
      const controller = new AbortController();
      const pending = registry.call(scenario.name, scenario.args, grant, controller.signal, req);
      await started;
      controller.abort(); resume();
      expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_CALL_CANCELLED' } });
      writeAuthority = async () => true;
    }
    expect(events).toEqual([]);
    expect(await listLiveArtifacts({ projectsRoot: root, projectId: 'p1' })).toEqual([]);
  });

  it('rechecks scope and bearer after the asynchronous authority check', async () => {
    const token = mint();
    const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    workspace = 'w1';
    for (const change of ['workspace', 'token'] as const) {
      let resume!: () => void; let entered!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      writeAuthority = async () => { entered(); await gate; return true; };
      const pending = registry.call('live_artifacts_create', { input: {} }, grant, undefined, req);
      await started;
      if (change === 'workspace') workspace = 'w2'; else tokens.revokeToken(token);
      resume();
      expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      workspace = 'w1';
    }
    expect(events).toEqual([]);
    expect(await listLiveArtifacts({ projectsRoot: root, projectId: 'p1' })).toEqual([]);
  });

  it('dispatches synchronously after the final authority check, before a queued rebind or revoke', async () => {
    run.workspaceScope = { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' };
    const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
    for (const change of ['workspace', 'token'] as const) {
      workspace = 'w1';
      const token = mint();
      const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
      let checks = 0;
      let workspaceAtDispatch: string | null = '';
      let tokenAtDispatch = false;
      decisionHook = () => {
        if (++checks === 2) queueMicrotask(() => { if (change === 'workspace') workspace = 'w2'; else tokens.revokeToken(token); });
      };
      createHook = async () => {
        workspaceAtDispatch = workspace;
        tokenAtDispatch = tokens.validate(token, { endpoint: '/api/tools/live-artifacts/create', operation: 'live-artifacts:create' }).ok;
        return { artifact: { id: 'synthetic', projectId: 'p1' } } as Awaited<ReturnType<typeof createLiveArtifact>>;
      };
      const result = await registry.call('live_artifacts_create', { input: {} }, grant, undefined, req);
      expect(result.structuredContent.ok).toBe(true);
      expect(workspaceAtDispatch).toBe('w1');
      expect(tokenAtDispatch).toBe(true);
      expect(change === 'workspace' ? workspace === 'w2' : !tokens.validate(token, { endpoint: '/mcp' }).ok).toBe(true);
    }
  });

  it('reports a completed write and its event when cancellation arrives after dispatch', async () => {
    const grant = tokens.validate(mint(), { endpoint: '/mcp', operation: 'live-artifacts:create' });
    if (!grant.ok) throw new Error('fixture token did not validate');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const event = vi.fn();
    const deps = {
      projectsRoot: root, authorizeProjectToolWrite: async () => true,
      createLiveArtifact: async () => { entered(); await gate; return { artifact: { id: 'committed' } }; },
      emitLiveArtifactEvent: event,
    } as unknown as LiveArtifactToolWriteDeps;
    const controller = new AbortController();
    const pending = createLiveArtifactForTool(grant.grant, { input: {} }, deps, controller.signal);
    await started;
    controller.abort(); release();
    expect(await pending).toMatchObject({ ok: true, artifact: { id: 'committed' } });
    expect(event).toHaveBeenCalledOnce();
  });

  it('cancels a started real refresh before its source data is committed', async () => {
    await mkdir(path.join(root, 'p1'), { recursive: true });
    await writeFile(path.join(root, 'p1', 'source.json'), JSON.stringify({ summary: { value: 'new' } }));
    const input = { title: 'Cancelled refresh', preview: { type: 'html', entry: 'index.html' }, document: {
      format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
      dataJson: { summary: { value: 'old' } }, sourceJson: { type: 'local_file', input: { path: 'source.json' },
        outputMapping: { dataPaths: [{ from: 'json.summary', to: 'summary' }], transform: 'identity' }, refreshPermission: 'manual_refresh_granted_for_read_only' },
    } };
    const { artifact } = await createLiveArtifact({ projectsRoot: root, projectId: 'p1', input });
    const controller = new AbortController();
    await expect(refreshLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId: artifact.id, signal: controller.signal,
      onStarted: () => controller.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
    const persisted = await getLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId: artifact.id });
    expect(persisted.artifact.document.dataJson).toEqual({ summary: { value: 'old' } });
    expect(persisted.artifact.refreshStatus).toBe('failed');
  });

  it('propagates an in-flight refresh cancellation to the source and leaves prior data intact', async () => {
    const input = { title: 'In-flight cancellation', preview: { type: 'html', entry: 'index.html' }, document: {
      format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
      dataJson: { summary: { value: 'old' } }, sourceJson: { type: 'connector_tool', toolName: 'docs.search', input: {},
        connector: { connectorId: 'docs', toolName: 'docs.search' }, refreshPermission: 'manual_refresh_granted_for_read_only' },
    } };
    const { artifact } = await createLiveArtifact({ projectsRoot: root, projectId: 'p1', input });
    let entered!: () => void;
    let sourceSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const provider = vi.spyOn(connectorService, 'execute').mockImplementation(async (_input, options) => {
      sourceSignal = options.signal;
      entered();
      await new Promise<void>((_resolve, reject) => sourceSignal?.addEventListener('abort', () => reject(sourceSignal?.reason), { once: true }));
      throw new Error('unreachable');
    });
    try {
      const controller = new AbortController();
      const pending = refreshLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId: artifact.id, signal: controller.signal });
      await started;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
      expect(sourceSignal?.aborted).toBe(true);
      const persisted = await getLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId: artifact.id });
      expect(persisted.artifact.document.dataJson).toEqual({ summary: { value: 'old' } });
      expect(persisted.artifact.refreshStatus).toBe('failed');
    } finally {
      provider.mockRestore();
    }
  });

  it('fails closed on write authority, overrides, missing endpoint, expiry and revocation', async () => {
    const input = { title: 'No write' };
    const token = mint();
    for (const args of [{ input, projectId: 'p2' }, { input, createdByRunId: 'other' }]) {
      expect((await result(await call(token, args, 'live_artifacts_create'))).error?.code).toBe('INVALID_ARGS');
    }
    const missing = mint({ allowedEndpoints: ['/mcp'] });
    expect((await result(await call(missing, { input }, 'live_artifacts_create'))).error?.code).toBe('TOOL_ENDPOINT_DENIED');
    allowed = false;
    expect((await result(await call(token, { input }, 'live_artifacts_create'))).error?.code).toBe('PROJECT_SCOPE_DENIED');
    const expired = mint({ ttlMs: 1, nowMs: Date.now() - 1000 });
    expect((await call(expired, { input }, 'live_artifacts_create')).status).toBe(401);
    tokens.revokeToken(token);
    expect((await call(token, { input }, 'live_artifacts_create')).status).toBe(401);
    expect(events).toEqual([]);
    expect(await listLiveArtifacts({ projectsRoot: root, projectId: 'p1' })).toEqual([]);
  });

  it('reports refresh failures and emits the same failed event without fabricating success', async () => {
    const token = mint();
    refresh = async () => { throw new Error('synthetic refresh failure'); };
    const response = await result(await call(token, { artifactId: 'artifact-1' }, 'live_artifacts_refresh'));
    expect(response.error?.code).toBe('LIVE_ARTIFACT_STORAGE_FAILED');
    expect(events).toEqual([{ runId: 'r1', phase: 'failed', artifactId: 'artifact-1' }]);
  });

  it('requires each operation endpoint and rejects external, expired and revoked grants before writes', async () => {
    const cases = [
      { name: 'live_artifacts_create', args: { input: {} } },
      { name: 'live_artifacts_update', args: { artifactId: 'missing', input: {} } },
      { name: 'live_artifacts_refresh', args: { artifactId: 'missing' } },
    ];
    const external = credentials.create({ name: 'external', allowedOperations: ['*'] });
    for (const item of cases) {
      const missingEndpoint = mint({ allowedEndpoints: ['/mcp'] });
      expect((await result(await call(missingEndpoint, item.args, item.name))).error?.code).toBe('TOOL_ENDPOINT_DENIED');
      expect((await result(await call(external.token, item.args, item.name))).error?.code).toBe('EXTERNAL_APPROVAL_REQUIRED');
      const expired = mint({ ttlMs: 1, nowMs: Date.now() - 1000 });
      expect((await call(expired, item.args, item.name)).status).toBe(401);
      const revoked = mint();
      tokens.revokeToken(revoked);
      expect((await call(revoked, item.args, item.name)).status).toBe(401);
      const noOperation = mint({ allowedOperations: [] });
      const request = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${noOperation}` : undefined } as Request;
      const grant = { kind: 'run' as const, runId: 'r1', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['*'] };
      expect((await registry.call(item.name, item.args, grant, undefined, request)).structuredContent).toMatchObject({ error: { code: 'TOOL_OPERATION_DENIED' } });
      allowed = false;
      expect((await result(await call(mint(), item.args, item.name))).error?.code).toBe('PROJECT_SCOPE_DENIED');
      allowed = true;
    }
    expect(events).toEqual([]);
  });

  it('maps domain validation and missing artifact errors without exposing a bearer', async () => {
    const token = mint();
    const invalid = await result(await call(token, { input: {} }, 'live_artifacts_create'));
    expect(invalid.error?.code).toBe('LIVE_ARTIFACT_INVALID');
    const missing = await result(await call(token, { artifactId: 'missing', input: { title: 'x' } }, 'live_artifacts_update'));
    expect(missing.error?.code).toBe('LIVE_ARTIFACT_NOT_FOUND');
    expect(JSON.stringify({ invalid, missing, logs })).not.toContain(token);
    expect(events).toEqual([]);
  });

  it('refreshes from a real local file and persists the refreshed data and history', async () => {
    refresh = refreshLiveArtifact;
    await mkdir(path.join(root, 'p1'), { recursive: true });
    await writeFile(path.join(root, 'p1', 'metrics.json'), JSON.stringify({ summary: { owner: 'local source' } }));
    const input = {
      title: 'Local refresh', preview: { type: 'html', entry: 'index.html' },
      document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { summary: {} },
        sourceJson: { type: 'local_file', input: { path: 'metrics.json' }, outputMapping: { dataPaths: [{ from: 'json.summary', to: 'summary' }], transform: 'identity' }, refreshPermission: 'manual_refresh_granted_for_read_only' },
      },
    };
    const token = mint();
    const created = await result(await call(token, { input }, 'live_artifacts_create'));
    expect(created.ok).toBe(true);
    const artifactId = (created.data as { artifact: { id: string } }).artifact.id;
    const updated = await result(await call(token, { artifactId }, 'live_artifacts_refresh'));
    expect(updated.data).toMatchObject({ artifact: { document: { dataJson: { summary: { owner: 'local source' } } } }, refresh: { status: 'succeeded', refreshedSourceCount: 1 } });
    const persisted = await getLiveArtifact({ projectsRoot: root, projectId: 'p1', artifactId });
    expect(persisted.artifact.document?.dataJson).toMatchObject({ summary: { owner: 'local source' } });
    const history = await listLiveArtifactRefreshLogEntries({ projectsRoot: root, projectId: 'p1', artifactId });
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'document', status: 'succeeded' })]));
    expect(events.map((event) => event.phase ?? event.action)).toEqual(['created', 'started', 'succeeded']);
  });
});

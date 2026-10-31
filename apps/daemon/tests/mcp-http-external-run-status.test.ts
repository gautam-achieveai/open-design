import { describe, expect, it } from 'vitest';
import { registerExternalRunStatusMcpTool } from '../src/mcp-http/external-run-status-tools.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import { createProjectRunCommandService } from '../src/services/project-run-commands.js';

function fixture() {
  const tokens = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const run = { id: 'r', projectId: 'p', status: 'running' };
  const f = { tokens, registry, run, stored: run as typeof run | null, owner: 'p' as string | null,
    valid: true, visible: true, allowed: true, ops: ['run/run:read'], calls: 0,
    statusExtra: {} as Record<string, unknown>, events: [] as { event: string; data: unknown }[],
    discovery: undefined as (() => Promise<void>) | undefined,
    eventsRead: undefined as (() => Promise<void>) | undefined,
    originsRead: undefined as (() => Promise<void>) | undefined };
  const store = { validateToken: (value: string) => value === 'fixture-bearer' && f.valid
    ? { ok: true, credential: { id: 'c', name: 'fixture', allowedOperations: f.ops } }
    : { ok: false, code: 'MCP_CREDENTIAL_INVALID' } } as never;
  const unused = async () => undefined;
  const commands = createProjectRunCommandService({ createProject: unused, deleteProject: unused, startRun: unused,
    getRun: async (_req, res, execution) => {
      execution!.beforeMutation(); f.calls++;
      res.json({ ...f.run, ...f.statusExtra });
    } });
  registerExternalRunStatusMcpTool(registry, {
    toolTokenRegistry: tokens, credentialStore: store,
    peekRunProjectId: id => id === 'r' ? f.owner : null,
    peekInMemoryRun: id => id === 'r' ? f.stored : null,
    queryRun: commands.getRun,
    readUnboundProjectDetail: async () => { await f.discovery?.(); return { revalidate: () => f.visible }; },
    isUnboundProjectCurrentlyVisible: () => f.visible,
    decideProjectRequest: () => f.allowed ? { ok: true } : { ok: false, status: 403, code: 'PROJECT_SCOPE_DENIED', message: 'Denied' },
    readRunEvents: async (_run, assertCurrent) => { await f.eventsRead?.(); assertCurrent(); return f.events; },
    getOrigins: async () => { await f.originsRead?.(); return { daemonBaseUrl: 'http://127.0.0.1:17456', webBaseUrl: 'http://127.0.0.1:17457' }; },
  });
  const grant = { kind: 'external' as const, runId: null, projectId: null, credentialId: 'c', name: null, allowedOperations: ['run/run:read'] };
  const req = (headers: Record<string, string>) => ({ headers,
    get: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer fixture-bearer' : headers[name.toLowerCase()] }) as never;
  return Object.assign(f, { call: (args: unknown = { runId: 'r' }, headers: Record<string, string> = {}) =>
    registry.call('get_run', args, grant, undefined, req(headers)) });
}

describe('external shared run query', () => {
  it('returns the canonical failed status within the complete UTF8 MCP result budget', async () => {
    const f = fixture();
    try {
      const runs = createChatRunService({ createSseResponse: () => ({ send: () => true, end() {}, cleanup() {} }),
        createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }) });
      const run = runs.create({ projectId: 'p', agentId: 'amr' });
      runs.fail(run, 'AMR_INSUFFICIENT_BALANCE', 'Synthetic pause');
      f.run.status = 'failed'; f.statusExtra = { ...runs.statusBody(run), id: 'r', projectId: 'p' };
      const result = await f.call();
      expect(result.structuredContent).toMatchObject({ ok: true, data: { status: 'failed', errorCode: 'AMR_INSUFFICIENT_BALANCE' } });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32_000);
    } finally { f.tokens.clear(); }
  });

  it.each(['failed', 'canceled'])('keeps authorized %s status pollable', async status => {
    const f = fixture();
    try {
      f.run.status = status; f.statusExtra = { errorCode: status === 'failed' ? 'AMR_INSUFFICIENT_BALANCE' : null,
        failureAction: status === 'failed' ? 'recharge' : null };
      const result = await f.call();
      expect(result.structuredContent).toMatchObject({ ok: true, data: { id: 'r', status } });
      if (status === 'failed') expect(result.structuredContent).toMatchObject({ data: {
        rechargeUrl: expect.stringContaining('/dashboard?source=open_design'), hint: expect.stringContaining('same requestId') } });
    } finally { f.tokens.clear(); }
  });

  it('queries active status after authority without claiming enrichment is unavailable', async () => {
    const f = fixture();
    try { const result = await f.call(); expect(result.structuredContent).toMatchObject({ ok: true, data: { id: 'r', status: 'running' } });
      if (!result.structuredContent.ok) throw new Error('Expected active run query success');
      expect(result.structuredContent.data).not.toHaveProperty('enrichmentUnavailable'); expect(f.calls).toBe(1);
    } finally { f.tokens.clear(); }
  });

  it.each(['credential', 'operation', 'owner', 'visibility', 'authority'])('denies %s before query side effects', async change => {
    const f = fixture();
    try {
      if (change === 'credential') f.valid = false;
      if (change === 'operation') f.ops = ['browser/snapshot'];
      if (change === 'owner') f.owner = null;
      if (change === 'visibility') f.visible = false;
      if (change === 'authority') f.allowed = false;
      expect((await f.call()).structuredContent).toMatchObject({ ok: false, error: { code: 'RUN_UNAVAILABLE' } });
      expect(f.calls).toBe(0);
    } finally { f.tokens.clear(); }
  });

  it.each(['credential', 'visibility', 'owner'])('rechecks %s after discovery before query', async change => {
    const f = fixture();
    try {
      f.discovery = async () => { if (change === 'credential') f.valid = false; if (change === 'visibility') f.visible = false; if (change === 'owner') f.owner = 'other'; };
      expect((await f.call()).structuredContent.ok).toBe(false); expect(f.calls).toBe(0);
    } finally { f.tokens.clear(); }
  });

  it.each(['events', 'origins', 'identity'])('withholds output after %s changes authority following preparation', async change => {
    const f = fixture();
    try {
      f.run.status = 'succeeded'; f.statusExtra = { deliverableValid: true, deliverableValidation: 'valid', deliverableEntryFile: 'index.html', conversationId: 'c' };
      f.events = [{ event: 'agent', data: { type: 'text_delta', delta: 'Private fixture text' } }];
      if (change === 'events') f.eventsRead = async () => { f.valid = false; };
      if (change === 'origins') f.originsRead = async () => { f.visible = false; };
      if (change === 'identity') f.eventsRead = async () => { f.stored = { ...f.run }; };
      const result = await f.call();
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'RUN_QUERY_STARTED_RESULT_UNAVAILABLE' } });
      expect(JSON.stringify(result)).not.toContain('Private fixture text'); expect(f.calls).toBe(1);
    } finally { f.tokens.clear(); }
  });

  it('trims only agent text to the complete UTF8 budget and preserves delivery identity', async () => {
    const f = fixture();
    try {
      f.run.status = 'succeeded'; f.statusExtra = { deliverableValid: true, deliverableValidation: 'valid', deliverableEntryFile: 'index.html', conversationId: 'c' };
      f.events = [{ event: 'agent', data: { type: 'text_delta', delta: '😀'.repeat(12_000) } }];
      const result = await f.call();
      expect(result.structuredContent).toMatchObject({ ok: true, data: { id: 'r', projectId: 'p', status: 'succeeded',
        artifactRef: { projectId: 'p', entryFile: 'index.html' }, agentMessageTruncated: true,
        previewUrl: expect.stringContaining('127.0.0.1:17456'), studioUrl: expect.stringContaining('127.0.0.1:17457') } });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32_000);
      if (!result.structuredContent.ok) throw new Error('Expected bounded delivery query success');
      const data = result.structuredContent.data;
      if (!data || typeof data !== 'object' || !('agentMessage' in data)) throw new Error('Expected returned agent text');
      expect(String(data.agentMessage)).toMatch(/^(?:😀)+$/u);
    } finally { f.tokens.clear(); }
  });

  it('rejects scope, attribution and sensitive or oversized mandatory status without echo', async () => {
    const f = fixture();
    try {
      expect((await f.call({ runId: 'r' }, { 'x-od-workspace-id': 'w' })).structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_SCOPE_UNSUPPORTED' } });
      expect((await f.call({ runId: 'r', pluginWorkflowId: 'x' })).structuredContent).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_ARGUMENT' } });
      for (const error of ['fixture-bearer', 'mandatory'.repeat(5_000)]) {
        f.statusExtra = { error }; const result = await f.call();
        expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'RUN_STATUS_UNSAFE' } });
        expect(JSON.stringify(result)).not.toContain(error);
      }
    } finally { f.tokens.clear(); }
  });
});

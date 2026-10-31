import { describe, expect, it } from 'vitest';
import { beginRunCancellation, type RunCancellationTask } from '../src/routes/runs.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { registerExternalRunCancelMcpTool } from '../src/mcp-http/external-run-cancel-tools.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { StrategyTaskTransitionConflictError } from '../src/strategies/task-store.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OPERATION = 'run/run:cancel';
type RunService = ReturnType<typeof createChatRunService>;
function fixture(existing?: { runs: RunService; run: ReturnType<RunService['create']> }) {
  const runs = existing?.runs ?? createChatRunService({
    createSseResponse: () => ({ send: () => true, end: () => {}, cleanup: () => {} }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
  });
  const run = existing?.run ?? runs.create({ projectId: 'project' });
  if (!existing) run.status = 'running';
  const map = new Map<string, typeof run>([[run.id, run]]);
  const tokens = new ToolTokenRegistry();
  const registry = new McpToolRegistry();
  const state = {
    valid: true, visible: true, write: true, operations: [OPERATION], credentialId: 'credential',
    task: null as RunCancellationTask | null,
    taskReads: 0, casCalls: 0, physicalCalls: 0, hydrationCalls: 0, statusReads: 0,
    physicalTargets: [] as string[],
    waitSnapshot: undefined as Promise<void> | undefined,
    enteredSnapshot: undefined as (() => void) | undefined,
    onCas: undefined as ((task: RunCancellationTask) => RunCancellationTask) | undefined,
    onProject: undefined as (() => void) | undefined,
    onStatus: undefined as (() => void) | undefined,
    waitPhysical: undefined as Promise<void> | undefined,
    enteredPhysical: undefined as (() => void) | undefined,
    statusExtra: {} as Record<string, unknown>,
  };
  const credentialStore = { validateToken: (value: string) => value === 'cancel-fixture-bearer' && state.valid
    ? { ok: true, credential: { id: state.credentialId, name: 'fixture', allowedOperations: state.operations } }
    : { ok: false, code: 'MCP_CREDENTIAL_INVALID' } } as never;
  registerExternalRunCancelMcpTool(registry, {
    toolTokenRegistry: tokens, credentialStore,
    peekInMemoryRun: id => map.get(id),
    readUnboundProjectDetail: async () => { state.enteredSnapshot?.(); await state.waitSnapshot; return { revalidate: () => state.visible }; },
    decideProjectRequest: () => state.write ? { ok: true } : { ok: false, status: 403, code: 'FORBIDDEN', message: 'denied' },
    beginCancelRun: (target, options) => beginRunCancellation(target, {
      readTask: () => { state.taskReads++; return state.task; },
      resolveTarget: (id, fallback) => { state.hydrationCalls++; return map.get(id) ?? fallback; },
      cancelTask: task => {
        state.casCalls++;
        if (state.onCas) return state.onCas(task);
        state.task = { ...task, outcome: 'canceled', revision: task.revision + 1 };
        return state.task;
      },
      projectTask: task => { state.onProject?.(); return { outcome: task.outcome }; },
      cancelPhysical: async selected => {
        state.physicalCalls++;
        state.physicalTargets.push(selected.id);
        const pending = runs.cancel(selected, 'user_stop');
        state.enteredPhysical?.();
        await state.waitPhysical;
        return pending;
      },
    }, options),
    readRunStatus: target => { state.statusReads++; state.onStatus?.(); return { ...runs.statusBody(target), ...state.statusExtra }; },
  });
  const grant: McpAuthGrant = { kind: 'external', runId: null, projectId: null, credentialId: 'credential', name: null, allowedOperations: [OPERATION] };
  const headers: Record<string, string> = { authorization: 'Bearer cancel-fixture-bearer' };
  const request = { headers, get: (name: string) => headers[name.toLowerCase()] } as never;
  return { run, runs, map, tokens, registry, state, grant, headers,
    call: (args: unknown = { runId: run.id }, signal?: AbortSignal) => registry.call('cancel_run', args, grant, signal, request) };
}

describe('external exact in-memory run cancellation', () => {
  it('returns the canonical canceled status and terminal idempotency without hydration', async () => {
    const f = fixture();
    try {
      const first = await f.call();
      expect(first.structuredContent).toMatchObject({ ok: true, data: { ok: true, run: { id: f.run.id, status: 'canceled', cancelOrigin: 'user_stop' } } });
      expect((await f.call()).structuredContent.ok).toBe(true);
      expect(f.state.hydrationCalls).toBe(0);
      expect(f.run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(1);
    } finally { f.tokens.clear(); }
  });

  it('accepts a previously hydrated object already in the current map without new hydration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-mcp-cancel-hydrated-'));
    const options = { createSseResponse: () => ({ send: () => true, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }), runsLogDir: root as unknown as null };
    const original = createChatRunService(options);
    const seed = original.create({ projectId: 'project' });
    original.finish(seed, 'succeeded', 0, null);
    await (seed as { eventsLogFinalFlush?: Promise<unknown> }).eventsLogFinalFlush;
    const restored = createChatRunService(options);
    const hydrated = restored.get(seed.id);
    if (!hydrated) throw new Error('fixture hydration failed');
    const f = fixture({ runs: restored, run: hydrated });
    try {
      expect(hydrated).not.toBe(seed);
      expect((await f.call()).structuredContent).toMatchObject({ ok: true, data: { run: { id: seed.id, status: 'succeeded' } } });
      expect(f.state.hydrationCalls).toBe(0);
    } finally {
      f.tokens.clear();
      await restored.shutdownActive();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('denies wrong principal, operation, workspace headers and non-memory IDs before task reads', async () => {
    for (const change of ['run', 'operation', 'workspace', 'unknown', 'bound'] as const) {
      const f = fixture();
      try {
        if (change === 'run') { f.grant.kind = 'run'; f.grant.runId = f.run.id; f.grant.credentialId = null; }
        if (change === 'operation') f.state.operations = ['run/run:read'];
        if (change === 'workspace') f.headers['x-od-workspace-id'] = 'workspace';
        if (change === 'bound') f.state.visible = false;
        const result = await f.call(change === 'unknown' ? { runId: 'durable-only' } : undefined);
        expect(result.structuredContent.ok).toBe(false);
        expect(f.state.taskReads).toBe(0);
        expect(f.state.physicalCalls).toBe(0);
        expect(f.state.hydrationCalls).toBe(0);
      } finally { f.tokens.clear(); }
    }
  });

  it('rechecks credential, binding, exact object and write authority after async visibility discovery', async () => {
    for (const change of ['revoke', 'credential', 'binding', 'replace', 'write', 'abort'] as const) {
      const f = fixture();
      try {
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>(resolve => { entered = resolve; });
        f.state.enteredSnapshot = entered;
        f.state.waitSnapshot = new Promise<void>(resolve => { release = resolve; });
        const abort = new AbortController();
        const pending = f.call(undefined, abort.signal);
        await reached;
        if (change === 'revoke') f.state.valid = false;
        if (change === 'credential') f.state.credentialId = 'different';
        if (change === 'binding') f.state.visible = false;
        if (change === 'replace') f.map.set(f.run.id, { ...f.run });
        if (change === 'write') f.state.write = false;
        if (change === 'abort') abort.abort();
        release();
        expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'RUN_UNAVAILABLE' } });
        expect(f.state.casCalls).toBe(0);
        expect(f.state.physicalCalls).toBe(0);
        expect(f.state.taskReads).toBe(0);
      } finally { f.tokens.clear(); }
    }
  });

  it('rejects missing or foreign task targets before CAS without falling back to hydration', async () => {
    for (const change of ['missing', 'foreign-run', 'foreign-task'] as const) {
      const f = fixture();
      try {
        const target = f.runs.create({ projectId: change === 'foreign-run' ? 'foreign' : 'project' });
        if (change !== 'missing') f.map.set(target.id, target);
        f.state.task = { taskExecutionId: 'task', projectId: change === 'foreign-task' ? 'foreign' : 'project', revision: 1, activeRunId: target.id, outcome: 'running' };
        expect((await f.call()).structuredContent).toMatchObject({ ok: false, error: { code: 'RUN_UNAVAILABLE' } });
        expect(f.state.casCalls).toBe(0);
        expect(f.state.physicalCalls).toBe(0);
        expect(f.state.hydrationCalls).toBe(0);
      } finally { f.tokens.clear(); }
    }
  });

  it('reselects and revalidates targets after conflicts, including terminal reloads', async () => {
    for (const outcome of ['running', 'canceled']) for (const foreign of [false, true]) {
      const f = fixture();
      try {
        const target = f.runs.create({ projectId: foreign ? 'foreign' : 'project' });
        f.map.set(target.id, target);
        f.state.task = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: f.run.id, outcome: 'running' };
        f.state.onCas = task => {
          if (f.state.casCalls > 1) {
            f.state.task = { ...task, revision: task.revision + 1, outcome: 'canceled' };
            return f.state.task;
          }
          f.state.task = { ...task, revision: 2, activeRunId: target.id, outcome };
          throw new StrategyTaskTransitionConflictError('synthetic conflict');
        };
        const result = await f.call();
        if (foreign) {
          expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'CANCEL_STARTED_RESULT_UNAVAILABLE' } });
          expect(f.state.physicalCalls).toBe(0);
        } else {
          expect(result.structuredContent).toMatchObject({ ok: true, data: { run: { id: target.id, status: 'canceled' } } });
          expect(f.state.physicalTargets).toEqual([target.id]);
        }
        expect(f.state.casCalls).toBe(!foreign && outcome === 'running' ? 2 : 1);
        expect(f.state.hydrationCalls).toBe(0);
      } finally { f.tokens.clear(); }
    }
  });

  it('bounds conflict retries and does not claim no action after a possible CAS', async () => {
    const f = fixture();
    try {
      f.state.task = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: f.run.id, outcome: 'running' };
      f.state.onCas = task => {
        f.state.task = { ...task, revision: task.revision + 1 };
        throw new StrategyTaskTransitionConflictError('synthetic conflict');
      };
      expect((await f.call()).structuredContent).toMatchObject({ ok: false, error: { code: 'CANCEL_STARTED_RESULT_UNAVAILABLE' } });
      expect(f.state.casCalls).toBe(3);
      expect(f.state.physicalCalls).toBe(0);
    } finally { f.tokens.clear(); }
  });

  it('reports partial outcome from a possible committed CAS even before physical dispatch', async () => {
    for (const failure of ['read-after-commit', 'projection', 'revoke-after-cas'] as const) {
      const f = fixture();
      try {
        f.state.task = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: f.run.id, outcome: 'running' };
        f.state.onCas = task => {
          f.state.task = { ...task, revision: 2, outcome: 'canceled' };
          if (failure === 'read-after-commit') throw new Error('cancel-fixture-bearer');
          if (failure === 'revoke-after-cas') f.state.valid = false;
          return f.state.task;
        };
        if (failure === 'projection') f.state.onProject = () => { throw new Error('cancel-fixture-bearer'); };
        const result = await f.call();
        expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'CANCEL_STARTED_RESULT_UNAVAILABLE' } });
        expect(f.state.task.outcome).toBe('canceled');
        expect(f.state.casCalls).toBe(1);
        expect(f.state.physicalCalls).toBe(0);
        expect(JSON.stringify(result)).not.toContain('cancel-fixture-bearer');
      } finally { f.tokens.clear(); }
    }
  });

  it('does not project or disclose a result after post-dispatch revocation or disconnect', async () => {
    for (const change of ['revoke', 'binding', 'abort'] as const) {
      const f = fixture();
      try {
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>(resolve => { entered = resolve; });
        f.state.enteredPhysical = entered;
        f.state.waitPhysical = new Promise<void>(resolve => { release = resolve; });
        const abort = new AbortController();
        const pending = f.call(undefined, abort.signal);
        await reached;
        if (change === 'revoke') f.state.valid = false;
        if (change === 'binding') f.state.visible = false;
        if (change === 'abort') abort.abort();
        release();
        expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'CANCEL_STARTED_RESULT_UNAVAILABLE' } });
        expect(f.state.physicalCalls).toBe(1);
        expect(f.state.statusReads).toBe(0);
        expect(f.run.status).toBe('canceled');
      } finally { f.tokens.clear(); }
    }
  });

  it('suppresses unsafe or oversized canonical results without a second action', async () => {
    for (const value of ['cancel-fixture-bearer', 'x'.repeat(20_000)]) {
      const f = fixture();
      try {
        f.state.statusExtra = { error: value };
        const result = await f.call();
        expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'CANCEL_STARTED_RESULT_UNAVAILABLE' } });
        expect(f.state.physicalCalls).toBe(1);
        expect(JSON.stringify(result)).not.toContain('cancel-fixture-bearer');
      } finally { f.tokens.clear(); }
    }
  });
});

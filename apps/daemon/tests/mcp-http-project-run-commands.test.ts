import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProjectRunCommandService, LocalCommandFailure, type LocalCommandHandler } from '../src/services/project-run-commands.js';
import { ensureWorkspaceProject, getProject } from '../src/db.js';
import { createProjectRunCommandFixture } from './fixtures/project-run-command-fixture.js';

const commandService = (handler: LocalCommandHandler) => createProjectRunCommandService({ createProject: handler, deleteProject: handler, startRun: handler });
function barrier() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, wait: async () => { entered(); await held; } };
}

describe('shared project/run command collector', () => {
  it('preserves status/body and supplies only the controlled unbound request surface', async () => {
    const commands = commandService(async (req, res, execution) => {
      expect(req.get('authorization')).toBeUndefined();
      expect(req.get('x-od-workspace-id')).toBeUndefined();
      expect(req.get('x-od-client')).toBe('mcp');
      expect(req.query).toEqual({});
      expect(req.body).toEqual({ message: 'Synthetic' });
      execution!.beforeMutation();
      res.status(202).json({ runId: 'r', reused: true, resumed: false });
    });
    expect(await commands.startRun({ body: { message: 'Synthetic' }, assertCurrent: () => true })).toEqual({
      status: 202, body: { runId: 'r', reused: true, resumed: false }, mutationStarted: true,
    });
  });

  it.each([false, true])('reports access loss truthfully after possible effects: %s', async (began) => {
    let valid = true, effects = 0;
    const commands = commandService(async (_req, _res, execution) => {
      if (began) { execution!.beforeMutation(); effects++; }
      await Promise.resolve(); valid = false;
      execution!.beforeMutation(); effects++;
    });
    await expect(commands.createProject({ assertCurrent: () => valid })).rejects.toMatchObject({
      name: 'Error', mutationStarted: began, message: 'Local command result unavailable',
    } satisfies Partial<LocalCommandFailure>);
    expect(effects).toBe(began ? 1 : 0);
  });

  it('retains the native structured error response without inventing side effects', async () => {
    const commands = commandService(async (_req, res) => { res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Conflict' } }); });
    expect(await commands.startRun({ assertCurrent: () => true })).toEqual({ status: 409,
      body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Conflict' } }, mutationStarted: false });
  });
});

describe('external HTTP project/run commands with real REST handlers', () => {
  it('creates, starts, reuses, rejects changed requestId payloads, polls and deletes', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      const created = await f.call('create_project', { name: 'Synthetic', id: 'project' });
      expect(created).toMatchObject({ ok: true, data: { project: { id: 'project', metadata: { skipDiscoveryBrief: true } }, conversationId: expect.any(String) } });
      const args = { project: 'project', prompt: 'Synthetic', agent: 'codex', requestId: randomUUID() };
      const start = await f.call('start_run', args); expect(start.ok).toBe(true);
      const duplicate = await f.call('start_run', args);
      expect(duplicate).toMatchObject({ ok: true, data: { runId: start.data?.runId, reused: true } });
      expect(await f.call('start_run', { ...args, prompt: 'Changed' })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(await f.call('get_run', { runId: start.data?.runId })).toMatchObject({ ok: true, data: { projectId: 'project', status: 'running' } });
      expect(f.state.starts).toBe(1);
      expect(await f.call('delete_project', { project: 'project', confirm: true })).toMatchObject({ ok: true, data: { ok: true } });
      expect(getProject(f.db, 'project')).toBeNull();
    } finally { await f.close(); }
  });

  it('rejects retired Cloud runs before starting an agent or resuming a request', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      await f.call('create_project', { name: 'Synthetic retired runtime', id: 'cloud' });
      const args = { project: 'cloud', prompt: 'Synthetic', agent: 'amr', requestId: randomUUID() };
      expect(await f.call('start_run', args)).toMatchObject({ ok: false, error: { code: 'AGENT_UNAVAILABLE' } });
      expect(await f.call('start_run', { ...args, resume: true })).toMatchObject({ ok: false, error: { code: 'AGENT_UNAVAILABLE' } });
      expect(f.state.starts).toBe(0);
    } finally { await f.close(); }
  });

  it('rejects credential revocation during project preparation before the transaction', async () => {
    const f = await createProjectRunCommandFixture(); const gate = barrier();
    try {
      f.state.beforeCreateValidation = gate.wait;
      const pending = f.call('create_project', { name: 'Synthetic revoked', id: 'revoked' }); await gate.reached;
      f.store.revoke(f.credential.credential.id); gate.release();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(getProject(f.db, 'revoked')).toBeNull();
    } finally { gate.release(); await f.close(); }
  });

  it.each(['credential', 'binding'])('rechecks %s after plugin preparation awaits before any run claim', async (change) => {
    const f = await createProjectRunCommandFixture(); const gate = barrier();
    try {
      await f.call('create_project', { name: 'Synthetic', id: 'project' });
      f.state.beforeRegistryRead = gate.wait;
      const pending = f.call('start_run', { project: 'project', prompt: 'Synthetic', agent: 'codex' }); await gate.reached;
      if (change === 'credential') f.store.revoke(f.credential.credential.id);
      else ensureWorkspaceProject(f.db, { projectId: 'project', workspaceId: 'foreign', visibility: 'personal', resourceState: 'active',
        createdByWorkspaceMemberId: 'bob', updatedByWorkspaceMemberId: 'bob', createdAt: 1, updatedAt: 1 });
      gate.release();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(f.runs.list({})).toHaveLength(0); expect(f.state.starts).toBe(0);
    } finally { gate.release(); await f.close(); }
  });

  it('returns a partial outcome when a claim happened before revocation, without dispatching', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      await f.call('create_project', { name: 'Synthetic', id: 'project' });
      f.state.onClaim = () => { f.store.revoke(f.credential.credential.id); };
      expect(await f.call('start_run', { project: 'project', prompt: 'Synthetic', agent: 'codex' }))
        .toMatchObject({ ok: false, error: { code: 'COMMAND_STARTED_RESULT_UNAVAILABLE' } });
      expect(f.runs.list({})).toHaveLength(1); expect(f.state.starts).toBe(0);
    } finally { await f.close(); }
  });

  it('requires external explicit unbound scope, confirmation and supported attribution', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      expect(await f.call('create_project', { name: 'Synthetic', id: 'scoped' }, { 'x-od-workspace-id': 'foreign' })).toMatchObject({ ok: false });
      expect(getProject(f.db, 'scoped')).toBeNull();
      expect(await f.call('create_project', { name: 'Synthetic', pluginWorkflowId: 'unsupported' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_ARGUMENT' } });
      expect(await f.call('delete_project', { project: 'project', confirm: false })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
      expect(await f.call('start_run', { prompt: 'No active fallback' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
      expect(await f.call('start_run', { project: 'project', inputs: { nested: { apiKey: 'synthetic' } } })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_ARGUMENT' } });
      const grant = { kind: 'run' as const, runId: 'r', projectId: 'project', credentialId: null, name: null, allowedOperations: ['project/project:create'] };
      expect((await f.registry.call('create_project', { name: 'Run grant' }, grant, undefined, { get: () => undefined } as never)).structuredContent.ok).toBe(false);
      expect(f.state.starts).toBe(0);
    } finally { await f.close(); }
  });

  it('withholds a bearer-bearing response after a real project commit and reports a partial outcome', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      const result = await f.call('create_project', { id: 'sensitive', name: f.credential.token });
      expect(result).toMatchObject({ ok: false, error: { code: 'COMMAND_STARTED_RESULT_UNAVAILABLE' } });
      expect(JSON.stringify(result)).not.toContain(f.credential.token);
      expect(getProject(f.db, 'sensitive')).not.toBeNull();
    } finally { await f.close(); }
  });
});

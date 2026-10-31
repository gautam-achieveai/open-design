import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkspaceProject } from '../src/db.js';
import { writeProjectFile } from '../src/projects.js';
import { createProjectRunCommandFixture } from './fixtures/project-run-command-fixture.js';

type Fixture = Awaited<ReturnType<typeof createProjectRunCommandFixture>>;
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
async function successfulRun(f: Fixture, id = 'delivery') {
  expect((await f.call('create_project', { name: 'Synthetic delivery', id })).ok).toBe(true);
  const start = await f.call('start_run', { project: id, prompt: 'Synthetic artifact', agent: 'codex' });
  expect(start.ok).toBe(true);
  const run = f.runs.get(String(start.data?.runId))!;
  await writeProjectFile(f.projectsRoot, id, 'index.html', Buffer.from('<!doctype html><html><head><title>Synthetic</title></head><body>Fixture only</body></html>'));
  Object.assign(run, { artifactCount: 1, artifactOutcome: { diff: { touchedPaths: ['index.html'] } } });
  for (const delta of ['early ', 'middle ', 'late ', 'complete']) f.runs.emit(run, 'agent', { type: 'text_delta', delta });
  f.runs.finish(run, 'succeeded', 0, null);
  return run;
}

// Pause after the actual validator has read bytes, before its cache write.
function holdRead(file: string) {
  const read = fs.readFile;
  let entered!: () => void, release!: () => void, used = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const raw = await read(...args);
    if (!used && String(args[0]) === file) { used = true; entered(); await held; }
    return raw;
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  return { reached, release, restore: () => { release(); spy.mockRestore(); syncBuiltinESMExports(); } };
}

describe('HTTP run query through the native REST handler and durable registry', () => {
  it('validates an uncached durable run and reads complete text beyond the memory ring', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      const run = await successfulRun(f);
      expect(run.events.length).toBeLessThanOrEqual(2);
      await run.eventsLogFinalFlush;
      f.restartRegistry();
      expect(f.runRoutes.peekInMemoryRun(run.id)).toBeNull();
      await expect(f.call('get_run', { runId: run.id }, { authorization: 'Bearer invalid-synthetic' })).rejects.toThrow();
      const revoked = f.store.create({ name: 'Revoked fixture', allowedOperations: ['run/run:read'] });
      f.store.revoke(revoked.credential.id);
      await expect(f.call('get_run', { runId: run.id }, { authorization: 'Bearer ' + revoked.token })).rejects.toThrow();
      expect(f.state.queryGets).toBe(0);
      const result = await f.call('get_run', { runId: run.id });
      expect(result).toMatchObject({ ok: true, data: { id: run.id, projectId: 'delivery', status: 'succeeded',
        deliverableValid: true, deliverableValidation: 'valid', agentMessage: 'early middle late complete',
        artifactRef: { projectId: 'delivery', entryFile: 'index.html' }, previewUrl: expect.stringContaining(f.base),
        studioUrl: expect.stringContaining(f.base), previewUrlLifetime: 'current_daemon_session' } });
      expect(f.state.queryGets).toBeGreaterThan(0);
      expect(Reflect.get(f.design.runs.get(run.id)!, 'deliverableValid')).toBe(true);
    } finally { await f.close(); }
  });

  it('returns successful no-file clarification without inventing a preview', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      await f.call('create_project', { name: 'Question', id: 'question' });
      const start = await f.call('start_run', { project: 'question', prompt: 'Synthetic question', agent: 'codex' });
      const run = f.runs.get(String(start.data?.runId))!;
      f.runs.emit(run, 'agent', { type: 'text_delta', delta: 'Which synthetic option?' });
      f.runs.finish(run, 'succeeded', 0, null);
      const result = await f.call('get_run', { runId: run.id });
      expect(result).toMatchObject({ ok: true, data: { deliverableValid: false, agentMessage: 'Which synthetic option?', hint: expect.stringContaining('produced no files') } });
      expect(result.data).not.toHaveProperty('previewUrl'); expect(result.data).not.toHaveProperty('artifactRef');
    } finally { await f.close(); }
  });

  it('authorizes before the native invalid-strategy failure transition and returns its failed status', async () => {
    const f = await createProjectRunCommandFixture();
    try {
      await f.call('create_project', { name: 'Strategy', id: 'strategy' });
      const run = f.runs.create({ projectId: 'strategy', conversationId: 'c', assistantMessageId: 'a', agentId: 'codex',
        odNextTaskInputSnapshot: { taskExecutionId: 'missing', manifestSha256: 'x' } });
      const initial = run.status;
      await expect(f.call('get_run', { runId: run.id }, { authorization: 'Bearer invalid-synthetic' })).rejects.toThrow();
      expect(run.status).toBe(initial);
      const result = await f.call('get_run', { runId: run.id });
      expect(run.status).toBe('failed'); expect(run.errorCode).toBe('OD_NEXT_TASK_STATE_INVALID');
      expect(result).toMatchObject({ ok: true, data: { id: run.id, status: 'failed', errorCode: 'OD_NEXT_TASK_STATE_INVALID' } });
    } finally { await f.close(); }
  });

  it.each(['revoke', 'bind'])('prevents validation cache writes after %s during the actual file read', async change => {
    const f = await createProjectRunCommandFixture();
    let gate: ReturnType<typeof holdRead> | undefined;
    try {
      const run = await successfulRun(f);
      let writes = 0;
      const set = f.runs.setDeliverableValidation;
      f.runs.setDeliverableValidation = (...args: Parameters<typeof set>) => { writes++; return set(...args); };
      gate = holdRead(path.join(f.projectsRoot, 'delivery', 'index.html'));
      const pending = f.call('get_run', { runId: run.id }); await gate.reached;
      if (change === 'revoke') f.store.revoke(f.credential.credential.id);
      else ensureWorkspaceProject(f.db, { projectId: 'delivery', workspaceId: 'foreign', visibility: 'personal', resourceState: 'active',
        createdByWorkspaceMemberId: 'bob', updatedByWorkspaceMemberId: 'bob', createdAt: 1, updatedAt: 1 });
      gate.release();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'RUN_QUERY_STARTED_RESULT_UNAVAILABLE' } });
      expect(writes).toBe(0); expect(Reflect.get(run, 'deliverableValid')).not.toBe(true);
    } finally { gate?.restore(); await f.close(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createChatRunService } from '../../src/runtimes/runs.js';
import { ToolTokenRegistry } from '../../src/tool-tokens.js';
import { createClaudeOutputGuard, CLAUDE_OUTPUT_FAILURE_OVERRIDE } from '../../src/runtimes/claude-output-guard.js';

describe('Claude output seal terminal override', () => {
  it.each(['succeeded', 'canceled'])('downgrades %s before committing one terminal event and revokes the attempt', async status => {
    const tokens = new ToolTokenRegistry();
    let seal = () => true;
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      beforeFinish: (() => seal() ? undefined : CLAUDE_OUTPUT_FAILURE_OVERRIDE) as unknown as null,
    });
    const run = runs.create({ projectId: 'project' });
    const grant = tokens.mint({ runId: run.id, projectId: 'project', allowedEndpoints: ['/mcp'] });
    const guard = createClaudeOutputGuard(grant.token, () => {
      tokens.revokeToken(grant.token);
      runs.finish(run, 'failed', 1, null);
    });
    guard.accept({ type: 'text_delta', delta: grant.token.slice(0, 8) }, () => { throw new Error(grant.token); });
    seal = () => guard.seal();
    const termination = status === 'canceled'
      ? runs.terminateProcessTree(run, null, null, { termGraceMs: 0, killGraceMs: 0 })
      : null;
    runs.finish(run, status, 0, 'SIGTERM');
    if (termination) {
      expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(0);
      await termination;
    }
    runs.finish(run, status, 0, 'SIGTERM');
    expect(run).toMatchObject({ status: 'failed', exitCode: 1, signal: null, error: CLAUDE_OUTPUT_FAILURE_OVERRIDE.message });
    expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(1);
    expect(JSON.stringify(run.events)).not.toContain(grant.token);
    expect(tokens.validate(grant.token, { endpoint: '/mcp' }).ok).toBe(false);
  });

  it('ignores an attempted success override of a failed claim', () => {
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      beforeFinish: (() => ({ status: 'succeeded' })) as unknown as null,
    });
    const run = runs.create();
    runs.finish(run, 'failed', 1, null);
    expect(run.status).toBe('failed');
  });

  it('honors a termination barrier registered by a failing terminal seal', async () => {
    let barrier: Promise<unknown> | null = null;
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      beforeFinish: (() => {
        if (!barrier) {
          barrier = runs.terminateProcessTree(run, null, null, { termGraceMs: 0, killGraceMs: 0 });
          runs.finish(run, 'failed', 1, null);
        }
        return CLAUDE_OUTPUT_FAILURE_OVERRIDE;
      }) as unknown as null,
    });
    const run = runs.create();
    runs.finish(run, 'succeeded', 0, null);
    expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(0);
    await barrier;
    expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(1);
    expect(run.status).toBe('failed');
  });
});

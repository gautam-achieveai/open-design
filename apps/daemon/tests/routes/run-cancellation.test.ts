import { describe, expect, it } from 'vitest';
import { beginRunCancellation, RunCancellationError, type RunCancellationTask } from '../../src/routes/runs.js';
import { InvalidStrategyTaskRecordError, StrategyTaskTransitionConflictError } from '../../src/strategies/task-store.js';

describe('shared REST run cancellation operation', () => {
  it('keeps get/fallback selection and starts CAS, projection, user-stop dispatch synchronously', async () => {
    const order: string[] = [];
    const requested = { id: 'requested', projectId: 'project', strategyTask: undefined as unknown };
    const active = { ...requested, id: 'active' };
    const task: RunCancellationTask = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: active.id, outcome: 'running' };
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const start = beginRunCancellation(requested, {
      readTask: () => task,
      resolveTarget: (id, fallback) => { order.push('lookup'); return id === active.id ? active : fallback; },
      cancelTask: current => { order.push('cas'); return { ...current, revision: 2, outcome: 'canceled' }; },
      projectTask: current => { order.push('projection'); return { outcome: current.outcome }; },
      cancelPhysical: target => { order.push('dispatch'); expect(target).toBe(active); return wait; },
    });
    expect(order).toEqual(['lookup', 'cas', 'lookup', 'projection', 'dispatch']);
    release();
    expect(await start.completion).toBe(active);
    expect(active.strategyTask).toEqual({ outcome: 'canceled' });
  });

  it('keeps initial invalid-task and exhausted-conflict REST error codes', () => {
    const run = { id: 'run', projectId: 'project' };
    const base = { resolveTarget: (_id: string, fallback: typeof run) => fallback, projectTask: () => null, cancelPhysical: async () => {} };
    expect(() => beginRunCancellation(run, { ...base, readTask: () => { throw new InvalidStrategyTaskRecordError('invalid'); }, cancelTask: (task: RunCancellationTask) => task }))
      .toThrowError(expect.objectContaining({ code: 'OD_NEXT_TASK_STATE_INVALID', message: 'invalid' }));
    const task: RunCancellationTask = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: run.id, outcome: 'running' };
    let attempts = 0;
    try {
      beginRunCancellation(run, { ...base, readTask: () => task, cancelTask: () => { attempts++; throw new StrategyTaskTransitionConflictError('conflict'); } });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(RunCancellationError);
      expect(error).toMatchObject({ code: 'STRATEGY_TASK_CANCEL_CONFLICT', message: 'strategy task changed while cancellation was being applied' });
    }
    expect(attempts).toBe(3);
  });

  it('preserves REST selection when a conflict reload is terminal with a different active target', async () => {
    const requested = { id: 'requested', projectId: 'project', strategyTask: undefined as unknown };
    const activeA = { ...requested, id: 'active-a' };
    const activeB = { ...requested, id: 'active-b' };
    let task: RunCancellationTask = { taskExecutionId: 'task', projectId: 'project', revision: 1, activeRunId: activeA.id, outcome: 'running' };
    const lookups: string[] = [], physical: string[] = [];
    const started = beginRunCancellation(requested, {
      readTask: () => task,
      resolveTarget: (id, fallback) => { lookups.push(id); return id === activeA.id ? activeA : id === activeB.id ? activeB : fallback; },
      cancelTask: current => {
        task = { ...current, revision: 2, activeRunId: activeB.id, outcome: 'canceled' };
        throw new StrategyTaskTransitionConflictError('synthetic conflict');
      },
      projectTask: current => ({ outcome: current.outcome }),
      cancelPhysical: async target => { physical.push(target.id); },
    });
    expect(await started.completion).toBe(activeA);
    expect(physical).toEqual([activeA.id]);
    expect(lookups).not.toContain(activeB.id);
  });
});

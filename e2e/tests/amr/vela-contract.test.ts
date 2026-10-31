import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { attachAcpSession } from '../../../apps/daemon/src/agent-protocol/acp/session.ts';
import { summarizeRunToolProgress } from '../../../apps/daemon/src/run-diagnostics.ts';
import { decideSafeRunRetry } from '../../../apps/daemon/src/run-retry-policy.ts';

class ReplayChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { return true; }
}

// Generic ACP consumer safety survives removal of the proprietary runtime.
// Frames model the public ACP wire, not a claim that Vela still runs.
function replay(updates: Array<Record<string, unknown>>, terminal?: 'success' | 'failure' | 'cancel') {
  const child = new ReplayChild();
  const events: Array<{ event: string; data: unknown }> = [];
  const session = attachAcpSession({ child: child as never, prompt: 'local contract', model: null,
    send: (event, data) => events.push({ event, data }) });
  const frame = (value: unknown) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(value as object) })}\n`);
  frame({ id: 1, result: {} });
  frame({ id: 2, result: { sessionId: 'local-contract' } });
  for (const update of updates) frame({ method: 'session/update', params: { sessionId: 'local-contract', update } });
  if (terminal === 'success') frame({ id: 3, result: { stopReason: 'end_turn' } });
  if (terminal === 'failure') frame({ id: 3, error: { code: -32603, message: 'Runtime stream interrupted' } });
  if (terminal === 'cancel') session.abort();
  const result = { completed: session.completedSuccessfully(), fatal: session.hasFatalError() };
  // Finalization emits pending tools with host provenance. Those display-only
  // results must not count as agent-confirmed completion.
  session.abort();
  return { ...result, progress: summarizeRunToolProgress(events) };
}
const write = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'edit', title: 'Write', status: 'pending' });
const completed = (id: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'written' });

it('[P1] packaging no longer ships the retired Vela runtime', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../../tools/pack/package.json', import.meta.url), 'utf8'));
  expect({ ...pkg.dependencies, ...pkg.optionalDependencies }).not.toHaveProperty('@powerformer/vela-cli');
});

it('[P1] generic ACP completes only after its terminal response', () => {
  const updates = [write('one'), completed('one')];
  expect(replay(updates).completed).toBe(false);
  expect(replay(updates, 'success')).toMatchObject({ completed: true, fatal: false });
});

it('[P1] a failed continuation after committed tools does not permit unsafe replay', () => {
  expect(replay([write('one'), completed('one')], 'failure')).toMatchObject({ completed: false, fatal: true });
  expect(decideSafeRunRetry({ result: 'failed', attemptCount: 0,
    failure: { failure_category: 'upstream_unavailable', failure_detail: 'stream_disconnected', retryable: true },
    sideEffects: { toolCallSeen: true, artifactWriteSeen: true } }).shouldRetry).toBe(false);
});

it('[P1] cancellation never reports a successful pending Write', () => {
  expect(replay([write('pending')], 'cancel').completed).toBe(false);
});

it('[P1] one completed tool cannot hide a parallel outstanding Write', () => {
  expect(replay([write('one'), write('two'), completed('one')]).progress)
    .toMatchObject({ toolCallSeen: true, toolResultSent: false, hasOutstandingTool: true });
});

it('[P1] an unknown runtime error remains unsuccessful', () => {
  expect(replay([], 'failure')).toMatchObject({ completed: false, fatal: true });
});

import { describe, expect, it, vi } from 'vitest';
import { createClaudeOutputGuard } from '../../src/runtimes/claude-output-guard.js';

const token = 'synthetic-run-bearer-for-output-guard';

describe('Claude attempt output guard', () => {
  it('guards mapped channels, facts and errors while retaining ordinary identities and heartbeats', () => {
    const events: Record<string, unknown>[] = [];
    const fail = vi.fn();
    const guard = createClaudeOutputGuard(token, fail);
    const consume = (event: Record<string, unknown>) => { events.push(guard.sanitize(event)!); };
    guard.accept({ type: 'text_delta', delta: `ordinary ${token.slice(0, 13)}` }, consume);
    guard.accept({ type: 'status', label: 'working', sessionId: 'normal-session' }, consume);
    guard.accept({ type: 'text_delta', delta: `${token.slice(13)} retained` }, consume);
    guard.accept({ type: 'thinking_delta', delta: '' }, consume);
    guard.accept({ type: 'thinking_delta', delta: token.slice(0, 8) }, consume);
    guard.accept({ type: 'thinking_delta', delta: token.slice(8) }, consume);
    guard.accept({ type: 'tool_input_delta', id: 'normal-tool', name: 'Read', delta: token.slice(0, 7) }, consume);
    guard.accept({ type: 'tool_input_delta', id: 'normal-tool', name: 'Read', delta: token.slice(7) }, consume);
    guard.accept({ type: 'tool_use', id: 'normal-tool', name: 'Read', input: { note: token } }, consume);
    guard.accept({ type: 'error', message: token, raw: { detail: token } }, consume);
    guard.accept({ type: 'diagnostic', name: 'claude_child_runtime_fact', childId: 'normal-child', promptSafePayload: { text: token } }, consume);
    expect(guard.seal()).toBe(true);
    expect(fail).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(token);
    expect(events).toContainEqual({ type: 'thinking_delta', delta: '' });
    expect(events.some(event => event.sessionId === 'normal-session')).toBe(true);
    expect(events.some(event => event.id === 'normal-tool' && event.type === 'tool_use')).toBe(true);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toContain('ordinary ');
    expect(events.some(event => event.redactionTruncated === true)).toBe(true);
  });

  it('retains a multi-megabyte ordinary delta through downstream structured sanitization', () => {
    const guard = createClaudeOutputGuard(token, () => { throw new Error('unexpected guard failure'); });
    const delta = `${'x'.repeat(4095)}🧪${'ordinary text '.repeat(170_000)}`;
    const pieces: string[] = [];
    guard.accept({ type: 'text_delta', delta }, event => {
      const safe = guard.sanitize(event)!;
      expect(safe.redactionTruncated).toBeUndefined();
      expect((safe.delta as string).length).toBeLessThanOrEqual(4096);
      pieces.push(safe.delta as string);
    });
    expect(guard.seal()).toBe(true);
    expect(pieces.join('')).toBe(delta);
  });

  it('never throws from a failed seal and rejects later callbacks and sensitive required IDs', () => {
    const fail = vi.fn();
    const guard = createClaudeOutputGuard(token, fail);
    const consumer = vi.fn(() => { throw new Error(token); });
    guard.accept({ type: 'text_delta', delta: token.slice(0, 11) }, consumer);
    expect(guard.seal()).toBe(false);
    expect(guard.seal()).toBe(false);
    guard.accept({ type: 'text_delta', delta: 'late' }, consumer);
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    const ids = createClaudeOutputGuard(token, fail);
    ids.accept({ type: 'status', sessionId: token }, consumer);
    expect(ids.failed).toBe(true);
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('fails closed when sanitization cannot retain a required payload shape', () => {
    const fail = vi.fn();
    const consume = vi.fn();
    const guard = createClaudeOutputGuard(token, fail);
    guard.accept({ type: 'tool_use', id: 'normal-tool', name: 'Read', other: 'x'.repeat(1_048_577), input: { file_path: 'a' } }, consume);
    expect(guard.failed).toBe(true);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { createOrderedTokenCoordinator } from '../../src/runtimes/ordered-token-coordinator.js';

type CoordinatorOutput = ReturnType<ReturnType<typeof createOrderedTokenCoordinator>['flush']>[number];
const isText = (item: CoordinatorOutput): item is Extract<CoordinatorOutput, { type: 'text' }> => item.type === 'text';

describe('ordered token coordinator', () => {
  it('redacts every split in its own channel without letting other channels or events overtake it', () => {
    const token = 'odtt_synthetic_123';
    for (let split = 1; split < token.length; split++) {
      const guard = createOrderedTokenCoordinator([token]);
      const out = [
        ...guard.pushText('answer', `before ${token.slice(0, split)}`, { id: 'one' }),
        ...guard.pushEvent({ type: 'status', label: 'working' }),
        ...guard.pushText('thinking', 'ordinary'),
        ...guard.pushText('answer', `${token.slice(split)} after`, { id: 'two' }),
        ...guard.flush(),
      ];
      const answer = out.filter(isText).filter(item => item.channel === 'answer').map(item => item.text).join('');
      const combined = out.filter(item => item.type === 'text').map(item => item.text).join('');
      expect(answer).not.toContain(token);
      expect(combined).not.toContain(token);
      expect(JSON.stringify(out)).not.toContain(token);
      expect(answer.startsWith('before ')).toBe(true);
      expect(answer.endsWith(' after')).toBe(true);
      expect(out.map(item => item.type === 'event' ? 'event' : item.channel)).toEqual(['answer', 'answer', 'event', 'thinking', 'answer']);
    }
  });

  it('prevents combined-channel matches from reconstructing a secret in a different channel', () => {
    const guard = createOrderedTokenCoordinator(['abc']);
    const out = [
      ...guard.pushText('tool:b', 'a'), ...guard.pushText('tool:a', 'a'),
      ...guard.pushText('tool:b', 'b'), ...guard.pushText('tool:a', 'c'),
      ...guard.pushText('tool:b', 'bc'), ...guard.flush(),
    ];
    const text = (channel: string) => out.filter(isText).filter(item => item.channel === channel).map(item => item.text).join('');
    expect(text('tool:a')).not.toContain('abc');
    expect(text('tool:b')).not.toContain('abc');
    expect(out.filter(item => item.type === 'text').map(item => item.text).join('')).not.toContain('abc');
  });

  it('bounds interleaving by masking unresolved fragments while preserving normal event order', () => {
    const token = 'odtt_synthetic_123';
    const guard = createOrderedTokenCoordinator([token], { maxBufferedEvents: 2, maxBufferedUnits: 256 });
    const out = [
      ...guard.pushText('tool:a', 'odtt_'),
      ...guard.pushEvent({ type: 'status', index: 1 }),
      ...guard.pushEvent({ type: 'status', index: 2 }),
      ...guard.pushText('tool:a', 'synthetic_123'),
      ...guard.pushText('tool:b', 'ordinary'),
      ...guard.flush(),
    ];
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.filter(isText).filter(item => item.channel === 'tool:a').map(item => item.text).join('')).not.toContain(token);
    expect(out.filter(item => item.type === 'event').map(item => (item.event as { index: number }).index)).toEqual([1, 2]);
    expect(out.at(-1)).toMatchObject({ type: 'text', channel: 'tool:b', text: 'ordinary' });
  });

  it('flushes incomplete ordinary suffixes, preserves empty events, and sanitizes structured data', () => {
    const token = 'odtt_synthetic_123';
    const guard = createOrderedTokenCoordinator([token]);
    const out = [
      ...guard.pushText('thinking', ''),
      ...guard.pushText('answer', 'ordinary odtt_'),
      ...guard.pushEvent({ type: 'diagnostic', value: token }),
      ...guard.flush(),
    ];
    expect(out).toMatchObject([
      { type: 'text', channel: 'thinking', text: '' },
      { type: 'text', channel: 'answer', text: 'ordinary ' },
      { type: 'text', channel: 'answer', text: 'odtt_' },
      { type: 'event', event: { type: 'diagnostic', value: '[redacted-token]' } },
    ]);
    expect(guard.flush()).toEqual([]);
    expect(() => guard.pushText('answer', 'late')).toThrow('closed');
  });

  it('bounds pending token prefixes and explicitly signals structured truncation', () => {
    const token = 'x'.repeat(300) + 'y';
    const guard = createOrderedTokenCoordinator([token], { maxBufferedEvents: 128, maxBufferedUnits: 256 });
    const out = [
      ...guard.pushText('tool:one', 'x'.repeat(300)),
      ...guard.pushEvent({ type: 'detail', value: 'z'.repeat(1_048_577) }),
      ...guard.pushText('tool:one', 'y'),
      ...guard.flush(),
    ];
    expect(out.filter(item => item.type === 'text').map(item => item.text).join('')).not.toContain(token);
    expect(out.find(item => item.type === 'event')).toMatchObject({ type: 'event', truncated: true });
  });

  it('streams a large repeated-prefix chunk without dropping it before the next event', () => {
    const guard = createOrderedTokenCoordinator(['ab'], { maxBufferedUnits: 256 });
    const out = [
      ...guard.pushText('answer', 'a'.repeat(1_000_000)),
      ...guard.pushEvent({ type: 'status', label: 'after' }),
      ...guard.pushText('answer', 'b'),
      ...guard.flush(),
    ];
    const text = out.filter(isText).map(item => item.text).join('');
    expect(text.length).toBeGreaterThanOrEqual(1_000_000);
    expect(text).not.toContain('ab');
    expect(out.filter(isText).filter(item => item.text.startsWith('a')).reduce((n, item) => n + item.text.length, 0)).toBeGreaterThan(999_000);
    expect(out.findIndex(item => item.type === 'event')).toBeGreaterThan(out.findIndex(item => item.type === 'text'));
  });

  it('bounds large metadata and respects Unicode across incremental boundaries', () => {
    const token = '💎secret';
    const guard = createOrderedTokenCoordinator([token], { maxBufferedUnits: 256 });
    const out = [
      ...guard.pushText('tool:one', 'a'.repeat(255) + token.repeat(5000), { huge: 'z'.repeat(5_000_000) }),
      ...guard.pushText('tool:two', '💎'),
      ...guard.pushEvent({ type: 'status' }),
      ...guard.pushText('tool:two', 'secret'),
      ...guard.flush(),
    ];
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.some(item => item.truncated)).toBe(true);
    expect(out.filter(isText).map(item => item.text).join('')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it('preserves ordinary output larger than one processing slice', () => {
    const text = 'x'.repeat(5000);
    const guard = createOrderedTokenCoordinator(['odtt_synthetic_123']);
    const out = [...guard.pushText('answer', text), ...guard.flush()];
    expect(out.filter(isText).map(item => item.text).join('')).toBe(text);
    expect(out.some(item => item.truncated)).toBe(false);
  });

  it('fails closed when an output iterator is not drained or is abandoned', () => {
    const guard = createOrderedTokenCoordinator(['secret'], { maxBufferedUnits: 256 });
    const stream = guard.pushText('answer', 'x'.repeat(5000));
    expect(stream.next().done).toBe(false);
    expect(() => guard.pushEvent({ type: 'status' })).toThrow('drained');
    stream.return?.();
    expect(() => guard.pushText('answer', 'later')).toThrow('closed');
    expect(() => guard.flush()).toThrow('closed');
  });
});

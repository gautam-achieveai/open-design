import { describe, expect, it } from 'vitest';
import {
  createExactTokenStreamRedactor,
  createOrderedExactTokenRedactor,
  redactExactTokenEnvelope,
  redactExactTokens,
} from '../../src/runtimes/exact-token-redaction.js';

const marker = '[redacted-token]';

describe('exact run-token output redaction', () => {
  it('redacts each split position without losing surrounding output', () => {
    const token = 'odtt_synthetic_0123456789';
    for (let split = 0; split <= token.length; split++) {
      const redactor = createExactTokenStreamRedactor([token]);
      const result = redactor.push(`before ${token.slice(0, split)}`)
        + redactor.push(`${token.slice(split)} after`) + redactor.flush();
      expect(result).toBe(`before ${marker} after`);
    }
    const oneByte = createExactTokenStreamRedactor([token]);
    let result = '';
    for (const character of `a${token}b`) result += oneByte.push(character);
    expect(result + oneByte.flush()).toBe(`a${marker}b`);
  });

  it('handles multiple tokens, common prefixes, overlapping matches and incomplete suffixes', () => {
    const redactor = createExactTokenStreamRedactor(['abc', 'abcdef', 'bcd', '', 'abc']);
    expect(redactor.push('prefix ab')).toBe('prefix ');
    expect(redactor.push('cdef ')).toBe(`${marker} `);
    expect(redactor.push('bcd abx abc')).toBe(`${marker} abx `);
    expect(redactor.flush()).toBe(marker);

    const plain = createExactTokenStreamRedactor(['secret']);
    expect(plain.push('near sec')).toBe('near ');
    expect(plain.flush()).toBe('sec');
    expect(plain.flush()).toBe('');
    expect(() => plain.push('later')).toThrow('redaction stream is closed');
    const passthrough = createExactTokenStreamRedactor([]);
    expect(passthrough.push('normal')).toBe('normal');
    expect(passthrough.flush()).toBe('');
  });

  it('holds interleaved events until a token resolves and preserves their order', () => {
    const redactor = createOrderedExactTokenRedactor<{ id: string }, { status: string }>(['secret']);
    const output = [
      ...redactor.pushText('hello sec', { id: 'one' }),
      ...redactor.pushEvent({ status: 'waiting' }),
      ...redactor.pushText('ret world', { id: 'two' }),
      ...redactor.flush(),
    ];
    expect(output).toEqual([
      { type: 'text', text: 'hello ', metadata: { id: 'one' } },
      { type: 'text', text: marker, metadata: { id: 'one' } },
      { type: 'event', event: { status: 'waiting' } },
      { type: 'text', text: ' world', metadata: { id: 'two' } },
    ]);
    const near = createOrderedExactTokenRedactor<number, string>(['secret']);
    expect([
      ...near.pushText('sec', 1),
      ...near.pushEvent('status'),
      ...near.pushText('ond', 2),
      ...near.flush(),
    ]).toEqual([
      { type: 'text', text: 'sec', metadata: 1 },
      { type: 'event', event: 'status' },
      { type: 'text', text: 'ond', metadata: 2 },
    ]);
  });

  it('bounds interleaved buffering and masks an ambiguous suffix on saturation', () => {
    const redactor = createOrderedExactTokenRedactor<number, string>(['secret'], { maxBufferedEvents: 2 });
    expect(redactor.pushText('prefix sec', 1)).toEqual([{ type: 'text', text: 'prefix ', metadata: 1 }]);
    expect(redactor.pushEvent('one')).toEqual([]);
    expect(redactor.pushEvent('two')).toEqual([
      { type: 'text', text: marker, metadata: 1 },
      { type: 'event', event: 'one' },
      { type: 'event', event: 'two' },
    ]);
    expect(redactor.pushText('ret rest', 2)).toEqual([{ type: 'text', text: 'ret rest', metadata: 2 }]);
    expect(redactor.flush()).toEqual([]);
  });

  it('redacts nested values and keys without mutation or recursion through cycles', () => {
    const token = 'odtt_synthetic_123';
    const original: Record<string, unknown> = { nested: [{ text: `Bearer ${token}` }], [token]: 'value' };
    original.self = original;
    const result = redactExactTokens(original, [token]) as Record<string, unknown>;
    expect(result.nested).toEqual([{ text: `Bearer ${marker}` }]);
    expect(result[marker]).toBe('value');
    expect(result.self).toBe('[circular]');
    expect((original.nested as Array<{ text: string }>)[0]!.text).toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('uses a safe replacement even when a token occurs in the normal marker or contains brackets', () => {
    for (const token of ['redacted', '[redacted-token]', 'token]suffix']) {
      const stream = createExactTokenStreamRedactor([token]);
      const result = stream.push(`before ${token} after`) + stream.flush();
      expect(result).not.toContain(token);
      expect(result.startsWith('before ')).toBe(true);
      expect(result.endsWith(' after')).toBe(true);
      const original: Record<string, unknown> = { text: token, [token]: token };
      original.self = original;
      expect(JSON.stringify(redactExactTokens(original, [token]))).not.toContain(token);
    }
  });

  it('preserves interleaved order at every split boundary', () => {
    const token = 'odmcp_synthetic_12345';
    for (let split = 1; split < token.length; split++) {
      const redactor = createOrderedExactTokenRedactor<number, string>([token]);
      const output = [
        ...redactor.pushText(`before ${token.slice(0, split)}`, 1),
        ...redactor.pushEvent('status'),
        ...redactor.pushText(`${token.slice(split)} after`, 2),
        ...redactor.flush(),
      ];
      expect(output.map((item) => item.type === 'text' ? item.text : '|status|').join(''))
        .toBe(`before ${marker}|status| after`);
    }
  });


  it('keeps colliding redacted keys distinct without quadratic output growth', () => {
    const tokens = ['odtt_synthetic_A', 'odtt_synthetic_B'];
    const input: Record<string, number> = {};
    for (let i = 0; i < 1024; i++) {
      input[Array.from({ length: 10 }, (_, bit) => tokens[(i >> bit) & 1]!).join('')] = i;
    }
    const before = JSON.stringify(input);
    const result = redactExactTokens(input, tokens) as Record<string, number>;
    const serialized = JSON.stringify(result);
    expect(Object.keys(result)).toHaveLength(1024);
    expect(Object.values(result).sort((a, b) => a - b)).toEqual(Array.from({ length: 1024 }, (_, i) => i));
    expect(serialized.length).toBeLessThan(before.length * 2);
    expect(tokens.some((token) => serialized.includes(token))).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('marks truncated structured output when the text or node budget is exhausted', () => {
    const token = 'odtt_synthetic_secret';
    const tooLong = { text: 'x'.repeat(1_048_577) + token };
    const textResult = JSON.stringify(redactExactTokens(tooLong, [token]));
    expect(textResult).toContain('[truncated]');
    expect(textResult).not.toContain(token);
    expect(tooLong.text.endsWith(token)).toBe(true);

    const many = Array.from({ length: 12_000 }, (_, i) => i);
    const nodeResult = redactExactTokens(many, [token]) as unknown[];
    expect(nodeResult.length).toBeLessThan(many.length);
    expect(JSON.stringify(nodeResult)).toContain('[truncated]');
    expect(many).toHaveLength(12_000);
  });

  it('does not introduce digit tokens in generated collision names', () => {
    const input = { a1: 1, a2: 2, a3: 3 };
    const result = redactExactTokens(input, ['1', '2', '3']);
    expect(Object.values(result as object).sort()).toEqual([1, 2, 3]);
    expect(Object.keys(result as object).some((key) => /[123]/.test(key))).toBe(false);
  });


  it('retains an error code when optional message content exceeds the budget', () => {
    const token = 'odtt_synthetic_secret';
    const envelope = { type: 'error', error: { code: 'AGENT_EXECUTION_FAILED' } };
    const payload = { message: 'x'.repeat(1_048_577) + token };
    const result = redactExactTokenEnvelope(envelope, payload, [token]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).toEqual(envelope);
    expect(result.payloadTruncated).toBe(true);
    expect(JSON.stringify(result.payload)).toContain('[truncated]');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(payload.message.endsWith(token)).toBe(true);
  });

  it('preserves tool identities independently of collision-heavy optional data', () => {
    const tokens = ['odtt_synthetic_A', 'odtt_synthetic_B'];
    const input: Record<string, string> = {};
    for (let i = 0; i < 1024; i++) {
      input[Array.from({ length: 10 }, (_, bit) => tokens[(i >> bit) & 1]!).join('')] = 'value';
    }
    const envelope = { type: 'tool_use', id: 'call-1', name: 'read', isError: false };
    const result = redactExactTokenEnvelope(envelope, { input }, tokens);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).toEqual(envelope);
    expect(result.payloadTruncated).toBe(false);
    expect(Object.keys((result.payload as { input: object }).input)).toHaveLength(1024);
    expect(tokens.some((token) => JSON.stringify(result).includes(token))).toBe(false);
  });

  it('signals oversized tool payloads without losing the required event fields', () => {
    const envelope = { type: 'tool_result', toolUseId: 'call-1', isError: true };
    const payload = { content: Array.from({ length: 12_000 }, (_, i) => i) };
    const result = redactExactTokenEnvelope(envelope, payload, ['odtt_synthetic']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).toEqual(envelope);
    expect(result.payloadTruncated).toBe(true);
    expect(JSON.stringify(result.payload)).toContain('[truncated]');
    expect(payload.content).toHaveLength(12_000);
  });

  it('fails closed if required fields would be truncated or redacted', () => {
    expect(redactExactTokenEnvelope({ id: 'x'.repeat(1_048_577) }, {}, ['odtt_synthetic']))
      .toEqual({ ok: false, reason: 'required-envelope-unavailable' });
    expect(redactExactTokenEnvelope({ id: 'odtt_synthetic' }, {}, ['odtt_synthetic']))
      .toEqual({ ok: false, reason: 'required-envelope-unavailable' });
    expect(redactExactTokenEnvelope({ id: 'safe' }, {}, ['truncated']).ok).toBe(true);
  });

});

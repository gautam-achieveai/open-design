import {
  createExactTokenStreamRedactor,
  redactExactTokenEnvelope,
  type ExactTokenStreamRedactor,
} from './exact-token-redaction.js';

export const CLAUDE_OUTPUT_FAILURE = 'Agent output could not be safely processed.';
export const CLAUDE_OUTPUT_FAILURE_OVERRIDE = {
  status: 'failed' as const, code: 1, signal: null,
  errorCode: 'AGENT_EXECUTION_FAILED', message: CLAUDE_OUTPUT_FAILURE,
};

type Event = Record<string, unknown>;
type Consumer = (event: Event) => void;
type Pending = { channel: string; event: Event; consumer: Consumer; matcher: ExactTokenStreamRedactor };

/** Claude presentation boundary. Protocol parsing retains the original frames. */
export function createClaudeOutputGuard(token: string, onFailure: () => void) {
  let sealed = false;
  let failed = false;
  let pending: Pending | null = null;
  const fail = () => {
    if (failed) return;
    failed = true;
    sealed = true;
    pending = null;
    try { onFailure(); } catch { /* Never expose an exception or prevent terminal cleanup. */ }
  };
  const clean = (event: Event): Event => {
    const required: Event = {};
    const optional: Event = {};
    for (const [key, value] of Object.entries(event)) {
      // Routing/correlation fields must remain byte-identical. The parser's
      // originals are private; rewriting their displayed identity is unsafe.
      if (key === 'type' || key === 'name' || /(^id$|Id$|_id$)/u.test(key)) required[key] = value;
      else optional[key] = value;
    }
    const result = redactExactTokenEnvelope(required, optional, [token]);
    if (!result.ok || !result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
      throw new Error('unsafe Claude event envelope');
    }
    const payload = result.payload as Event;
    // Optional truncation must not turn a tool envelope into a different shape.
    for (const key of ['input', 'content', 'usage']) {
      const original = optional[key];
      if (original && typeof original === 'object') {
        const sanitized = payload[key];
        if (!sanitized || typeof sanitized !== 'object' || Array.isArray(original) !== Array.isArray(sanitized)) {
          throw new Error('unsafe Claude event payload');
        }
      }
    }
    return {
      ...payload,
      ...result.envelope as Event,
      ...(result.payloadTruncated ? { redactionTruncated: true } : {}),
    };
  };
  const maskPending = () => {
    const previous = pending;
    pending = null;
    if (!previous) return;
    const suffix = previous.matcher.maskPending();
    if (suffix) previous.consumer({ ...previous.event, delta: suffix, redactionTruncated: true });
  };
  return {
    get sealed() { return sealed; },
    get failed() { return failed; },
    accept(event: Event, consumer: Consumer): void {
      if (sealed) return;
      try {
        const stream = (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_input_delta')
          && typeof event.delta === 'string';
        const channel = stream ? `${event.type}:${event.type === 'tool_input_delta' ? event.id : ''}` : null;
        if (!stream || pending?.channel !== channel || pending.consumer !== consumer) maskPending();
        const safe = clean(stream ? { ...event, delta: '' } : event);
        if (!stream) { consumer(safe); return; }
        if (!pending) pending = { channel: channel!, event: safe, consumer, matcher: createExactTokenStreamRedactor([token]) };
        pending.event = safe;
        const delta = pending.matcher.push(event.delta as string);
        if (event.delta === '') consumer({ ...safe, delta: '' });
        // Downstream event sanitization has a structured payload budget. Keep
        // ordinary large text streaming through it without losing characters.
        for (let offset = 0; offset < delta.length;) {
          let end = Math.min(delta.length, offset + 4096);
          if (end < delta.length && /[\uD800-\uDBFF]/u.test(delta[end - 1]!) && /[\uDC00-\uDFFF]/u.test(delta[end]!)) end--;
          consumer({ ...safe, delta: delta.slice(offset, end) });
          offset = end;
        }
      } catch { fail(); }
    },
    /** Direct derived tails are already parsed; sanitize without reopening the stream. */
    sanitize(event: Event): Event | null {
      if (failed) return null;
      try { return clean(event); } catch { fail(); return null; }
    },
    /** Synchronous and idempotent, including when a downstream consumer throws. */
    seal(): boolean {
      if (sealed) return !failed;
      try { maskPending(); } catch { fail(); }
      sealed = true;
      return !failed;
    },
    fail,
  };
}

/**
 * Redacts exact, per-attempt tokens from output after protocol parsing.
 * Use a separate stream per logical output channel. Never feed protocol
 * frames through this module before their IDs and messages are parsed.
 */

const MARKER = '[redacted-token]';
const MAX_TOKENS = 64;
const MAX_TOKEN_LENGTH = 4096;
const MAX_BUFFERED_EVENTS = 128;

function normalizeTokens(values: readonly string[]): string[] {
  const unique = [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
  if (unique.length > MAX_TOKENS || unique.some((value) => value.length > MAX_TOKEN_LENGTH)) {
    throw new RangeError('exact-token redaction limits exceeded');
  }
  return unique;
}

// Boundaries must not become part of a token: otherwise a replacement could
// accidentally join surrounding text into the original secret. OD bearer
// tokens use the readable marker; unusual tokens get an unused non-surrogate UTF-16 code unit.
function markerFor(tokens: readonly string[]): string {
  if (tokens.every((token) => !token.includes('[') && !token.includes(']') && !MARKER.includes(token))) return MARKER;
  for (let offset = 0; offset < 0xffff; offset++) {
    const code = ((0xe000 - 1 + offset) % 0xffff) + 1;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const candidate = String.fromCharCode(code);
    if (tokens.every((token) => !token.includes(candidate))) return candidate.repeat(3);
  }
  throw new Error('unable to choose a redaction marker');
}

type Emit = (tag: number, value: string) => void;

/** Holds only the suffix that might still be the start of a token. */
class Matcher {
  readonly #tokens: string[];
  readonly #marker: string;
  #pending = '';
  #tags: number[] = [];

  constructor(tokens: readonly string[]) {
    this.#tokens = normalizeTokens(tokens);
    this.#marker = markerFor(this.#tokens);
  }

  get oldestPendingTag(): number | null { return this.#tags[0] ?? null; }

  push(value: string, tag: number, emit: Emit): void {
    for (let i = 0; i < value.length; i++) {
      if (!this.#pending) {
        let next = value.length;
        for (const token of this.#tokens) {
          const index = value.indexOf(token[0]!, i);
          if (index !== -1 && index < next) next = index;
        }
        if (next > i) {
          emit(tag, value.slice(i, next));
          i = next - 1;
          continue;
        }
      }
      this.#pending += value[i]!;
      this.#tags.push(tag);
      this.#drain(false, emit);
    }
  }

  flush(emit: Emit): void { this.#drain(true, emit); }

  /** A bounded event queue may mask an ambiguous prefix rather than leak it. */
  maskPending(emit: Emit): void {
    const tag = this.oldestPendingTag;
    if (tag !== null) emit(tag, this.#marker);
    this.#pending = '';
    this.#tags = [];
  }

  #drain(final: boolean, emit: Emit): void {
    while (this.#pending.length > 0) {
      const possibleLonger = !final && this.#tokens.some((token) =>
        token.length > this.#pending.length && token.startsWith(this.#pending));
      if (possibleLonger) return;
      let matched = '';
      for (const token of this.#tokens) {
        if (token.length > matched.length && this.#pending.startsWith(token)) matched = token;
      }
      if (matched) {
        emit(this.#tags[0]!, this.#marker);
        this.#pending = this.#pending.slice(matched.length);
        this.#tags.splice(0, matched.length);
      } else {
        emit(this.#tags[0]!, this.#pending[0]!);
        this.#pending = this.#pending.slice(1);
        this.#tags.shift();
      }
    }
  }
}

export interface ExactTokenStreamRedactor {
  /** Returns only text that can no longer become part of a token. */
  push(value: string): string;
  /** Masks a possible token suffix at an output boundary without closing. */
  maskPending(): string;
  /** Ends the channel and emits any incomplete non-token suffix. */
  flush(): string;
}

export function createExactTokenStreamRedactor(tokens: readonly string[]): ExactTokenStreamRedactor {
  const matcher = new Matcher(tokens);
  let closed = false;
  const collect = (work: (emit: Emit) => void): string => {
    const result: string[] = [];
    work((_tag, value) => result.push(value));
    return result.join('');
  };
  return {
    push(value) {
      if (closed) throw new Error('redaction stream is closed');
      return collect((emit) => matcher.push(value, 0, emit));
    },
    maskPending() {
      if (closed) return '';
      return collect((emit) => matcher.maskPending(emit));
    },
    flush() {
      if (closed) return '';
      closed = true;
      return collect((emit) => matcher.flush(emit));
    },
  };
}

export type OrderedRedactionOutput<T, E> =
  | { type: 'text'; text: string; metadata: T }
  | { type: 'event'; event: E };

type PendingEntry<T, E> =
  | { type: 'text'; tag: number; metadata: T; pieces: string[] }
  | { type: 'event'; tag: number; event: E };

/**
 * Preserves event order while matching across text events. Feed each output
 * channel into its own instance. Events between parts of a possible token are
 * held until it resolves. On queue saturation, the ambiguous suffix is masked
 * before queued events are released; this may hide a nonsecret prefix.
 */
export function createOrderedExactTokenRedactor<T, E>(tokens: readonly string[], options: {
  maxBufferedEvents?: number;
} = {}): {
  pushText(value: string, metadata: T): OrderedRedactionOutput<T, E>[];
  pushEvent(event: E): OrderedRedactionOutput<T, E>[];
  flush(): OrderedRedactionOutput<T, E>[];
} {
  const matcher = new Matcher(tokens);
  const max = options.maxBufferedEvents ?? MAX_BUFFERED_EVENTS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_BUFFERED_EVENTS) {
    throw new RangeError('redaction event buffer limit is invalid');
  }
  const entries: PendingEntry<T, E>[] = [];
  let nextTag = 0;
  let closed = false;
  const emit: Emit = (tag, value) => {
    const entry = entries.find((item) => item.tag === tag);
    if (!entry || entry.type !== 'text') throw new Error('redaction ordering state is invalid');
    entry.pieces.push(value);
  };
  const release = (): OrderedRedactionOutput<T, E>[] => {
    const output: OrderedRedactionOutput<T, E>[] = [];
    const oldest = matcher.oldestPendingTag;
    while (entries.length > 0 && (oldest === null || entries[0]!.tag < oldest)) {
      const item = entries.shift()!;
      if (item.type === 'event') output.push({ type: 'event', event: item.event });
      else {
        const text = item.pieces.join('');
        if (text) output.push({ type: 'text', text, metadata: item.metadata });
      }
    }
    // A text event can have a safe prefix followed by a held token prefix.
    // Emit that safe prefix now rather than retaining an arbitrarily large
    // output chunk while waiting for the next event.
    const first = entries[0];
    if (oldest !== null && first?.type === 'text' && first.tag === oldest && first.pieces.length > 0) {
      output.push({ type: 'text', text: first.pieces.join(''), metadata: first.metadata });
      first.pieces = [];
    }
    return output;
  };
  const enforceBound = (): void => {
    if (entries.length > max && matcher.oldestPendingTag !== null) matcher.maskPending(emit);
  };
  return {
    pushText(value, metadata) {
      if (closed) throw new Error('redaction stream is closed');
      const entry: PendingEntry<T, E> = { type: 'text', tag: nextTag++, metadata, pieces: [] };
      entries.push(entry);
      matcher.push(value, entry.tag, emit);
      enforceBound();
      return release();
    },
    pushEvent(event) {
      if (closed) throw new Error('redaction stream is closed');
      entries.push({ type: 'event', tag: nextTag++, event });
      enforceBound();
      return release();
    },
    flush() {
      if (closed) return [];
      closed = true;
      matcher.flush(emit);
      return release();
    },
  };
}

/**
 * Clone JSON-shaped output while redacting exact tokens, including keys.
 * Large graphs are truncated rather than allowing unbounded work or output.
 */
function redactStructured(value: unknown, tokens: readonly string[]): { value: unknown; truncated: boolean; changed: boolean } {
  const secrets = normalizeTokens(tokens).sort((a, b) => b.length - a.length);
  const marker = markerFor(secrets);
  let changed = false;
  const clean = (input: string): string => secrets.reduce((text, secret) => {
    if (!text.includes(secret)) return text;
    changed = true;
    return text.split(secret).join(marker);
  }, input);
  const truncated = `${marker}${clean('[truncated]')}${marker}`;
  changed = false;
  const ancestors = new WeakSet<object>();
  const maxNodes = 10_000;
  const maxText = 1_048_576;
  let nodes = 0;
  let textSize = 0;
  let exhausted = false;
  let wasTruncated = false;
  const readText = (input: string): string => {
    textSize += input.length;
    if (textSize > maxText) {
      exhausted = true;
      wasTruncated = true;
      return truncated;
    }
    return clean(input);
  };

  // Collision names use two characters absent from every token. This keeps
  // generated names safe even if a token itself contains digits or the marker.
  let alphabet: string[] | undefined;
  const collisionAlphabet = (): string[] => {
    if (alphabet) return alphabet;
    alphabet = [];
    for (let offset = 0; offset < 0xffff && alphabet.length < 2; offset++) {
      const code = ((0xe000 - 1 + offset) % 0xffff) + 1;
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCharCode(code);
      if (secrets.every((secret) => !secret.includes(character))) alphabet.push(character);
    }
    return alphabet;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > maxNodes) { exhausted = true; wasTruncated = true; return truncated; }
    if (typeof input === 'string') return readText(input);
    if (input === null || typeof input !== 'object') return input;
    if (depth > 256) { wasTruncated = true; return clean('[redaction-depth-limit]'); }
    if (ancestors.has(input)) { wasTruncated = true; return clean('[circular]'); }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const result: unknown[] = [];
        for (const entry of input) {
          result.push(visit(entry, depth + 1));
          if (exhausted) break;
        }
        return result;
      }
      if (input instanceof Date) return new Date(input.getTime());
      if (input instanceof Error) {
        return visit({ name: input.name, message: input.message,
          ...(input.stack ? { stack: input.stack } : {}),
          ...(input.cause === undefined ? {} : { cause: input.cause }) }, depth + 1);
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let sequence = 0;
      const collisionName = (): string | null => {
        const chars = collisionAlphabet();
        if (chars.length < 2) return null;
        let name: string;
        do {
          let number = ++sequence;
          let encoded = '';
          while (number > 0) {
            encoded = chars[number % 2]! + encoded;
            number = Math.floor(number / 2);
          }
          name = marker + encoded + marker;
        } while (Object.hasOwn(result, name));
        return name;
      };
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        const base = readText(key);
        if (exhausted) {
          const name = collisionName();
          if (name === null) { wasTruncated = true; return truncated; }
          result[name] = truncated;
          break;
        }
        const name = Object.hasOwn(result, base) ? collisionName() : base;
        if (name === null) { wasTruncated = true; return truncated; }
        result[name] = visit((input as Record<string, unknown>)[key], depth + 1);
        if (exhausted) break;
      }
      return result;
    } catch {
      wasTruncated = true;
      return clean('[redaction-unavailable]');
    } finally {
      ancestors.delete(input);
    }
  };
  const result = visit(value, 0);
  return { value: result, truncated: wasTruncated, changed };
}

export function redactExactTokens(value: unknown, tokens: readonly string[]): unknown {
  return redactStructured(value, tokens).value;
}

/**
 * Redact required event fields independently of optional payload content.
 * The caller must select required fields for the event's schema and reconstruct
 * its output. A truncated or redacted required envelope fails closed to avoid
 * silently changing event identities. The caller must validate its schema.
 */
export function redactExactTokenEnvelope(
  envelope: unknown,
  payload: unknown,
  tokens: readonly string[],
): { ok: true; envelope: unknown; payload: unknown; payloadTruncated: boolean }
  | { ok: false; reason: 'required-envelope-unavailable' } {
  const required = redactStructured(envelope, tokens);
  if (required.truncated || required.changed) return { ok: false, reason: 'required-envelope-unavailable' };
  const optional = redactStructured(payload, tokens);
  return { ok: true, envelope: required.value, payload: optional.value, payloadTruncated: optional.truncated };
}

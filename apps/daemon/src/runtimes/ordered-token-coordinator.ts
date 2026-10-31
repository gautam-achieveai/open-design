import { redactExactTokenEnvelope, redactExactTokens } from './exact-token-redaction.js';

type Output =
  | { type: 'text'; channel: string; text: string; metadata: unknown; truncated: boolean }
  | { type: 'event'; event: unknown; truncated: boolean };
type TextItem = Extract<Output, { type: 'text' }>;
type EventItem = Extract<Output, { type: 'event' }>;
type Entry = { tag: number; item: Output; pieces: string[]; units: number; empty: boolean };
type Emit = (tag: number, value: string) => void;
const MAX_INPUT_TEXT_UNITS = 4096;
const MAX_STRUCTURED_UNITS = 16_384;
const MAX_STRUCTURED_NODES = 1024;

/** Preflight before cloning/redacting so large structured values cannot amplify work. */
function structuredWithinBudget(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let units = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > MAX_STRUCTURED_NODES || depth > 64) return false;
    if (typeof item === 'string') { units += item.length; return units <= MAX_STRUCTURED_UNITS; }
    if (item === null || typeof item !== 'object') return true;
    if (seen.has(item)) return false;
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        for (const entry of item) if (!visit(entry, depth + 1)) return false;
        return true;
      }
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        units += key.length;
        if (units > MAX_STRUCTURED_UNITS || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
      }
      return true;
    } finally { seen.delete(item); }
  };
  try { return visit(value, 0); } catch { return false; }
}

/** One logical character stream. The pending suffix is at most one token long. */
class Matcher {
  private pending = '';
  private tags: number[] = [];
  constructor(private readonly tokens: readonly string[], private readonly marker: string) {}
  get oldest(): number | undefined { return this.tags[0]; }
  get size(): number { return this.pending.length; }
  push(value: string, tag: number, emit: Emit): void {
    for (let i = 0; i < value.length; i++) {
      if (!this.pending) {
        let next = value.length;
        for (const token of this.tokens) {
          const found = value.indexOf(token[0]!, i);
          if (found >= 0 && found < next) next = found;
        }
        if (next > i) { emit(tag, value.slice(i, next)); i = next - 1; continue; }
      }
      this.pending += value[i]!;
      this.tags.push(tag);
      this.drain(false, emit);
    }
  }
  flush(emit: Emit): void { this.drain(true, emit); }
  mask(emit: Emit): void {
    for (const tag of new Set(this.tags)) emit(tag, this.marker);
    this.pending = '';
    this.tags = [];
  }
  private drain(final: boolean, emit: Emit): void {
    while (this.pending) {
      if (!final && this.tokens.some(token => token.length > this.pending.length && token.startsWith(this.pending))) return;
      let match = '';
      for (const token of this.tokens) if (token.length > match.length && this.pending.startsWith(token)) match = token;
      const consumed = match.length || 1;
      if (match) {
        // Every affected entry needs a separator. Otherwise removing text from
        // a different channel can join its remaining pieces into a token.
        for (const tag of new Set(this.tags.slice(0, consumed))) emit(tag, this.marker);
      } else emit(this.tags[0]!, this.pending[0]!);
      this.pending = this.pending.slice(consumed);
      this.tags.splice(0, consumed);
    }
  }
}

/** A single ordered queue; logical streams either have independent or shared matchers. */
class Stage {
  private readonly matchers = new Map<string, Matcher>();
  private readonly entries: Entry[] = [];
  private nextTag = 0;
  private retainedUnits = 0;
  constructor(private readonly tokens: readonly string[], private readonly marker: string,
    private readonly maxEntries: number, private readonly maxUnits: number, private readonly shared: boolean) {}
  private emit: Emit = (tag, value) => {
    const entry = this.entries.find(candidate => candidate.tag === tag);
    if (!entry || entry.item.type !== 'text') throw new Error('invalid redaction ordering state');
    entry.pieces.push(value);
    entry.units += value.length;
    this.retainedUnits += value.length;
  };
  private mask(): void {
    for (const matcher of this.matchers.values()) matcher.mask((tag, value) => {
      const entry = this.entries.find(candidate => candidate.tag === tag);
      if (entry) entry.item.truncated = true;
      this.emit(tag, value);
    });
    this.matchers.clear();
  }
  private bufferedUnits(): number {
    return this.retainedUnits + [...this.matchers.values()].reduce((sum, matcher) => sum + matcher.size, 0);
  }
  private release(): Output[] {
    const output: Output[] = [];
    const pending = [...this.matchers.values()].map(m => m.oldest).filter((tag): tag is number => tag !== undefined);
    const oldest = pending.length ? Math.min(...pending) : undefined;
    while (this.entries.length && (oldest === undefined || this.entries[0]!.tag < oldest)) {
      const entry = this.entries.shift()!;
      this.retainedUnits -= entry.units;
      if (entry.item.type === 'event') output.push(entry.item);
      else {
        const text = entry.pieces.join('');
        if (text || entry.empty) output.push({ ...entry.item, text });
      }
    }
    const first = this.entries[0];
    if (oldest !== undefined && first?.tag === oldest && first.item.type === 'text' && first.pieces.length) {
      const text = first.pieces.join('');
      output.push({ ...first.item, text });
      first.pieces = [];
      first.units -= text.length;
      this.retainedUnits -= text.length;
    }
    return output;
  }
  push(item: Output, units: number): Output[] {
    let output: Output[] = [];
    if (this.entries.length && (this.entries.length >= this.maxEntries || this.bufferedUnits() + units > this.maxUnits)) {
      this.mask();
      output = this.release();
    }
    const entry: Entry = { tag: this.nextTag++, item: item.type === 'text' ? { ...item, text: '' } : item,
      pieces: [], units, empty: item.type === 'text' && item.text.length === 0 };
    this.entries.push(entry);
    this.retainedUnits += units;
    if (item.type === 'text') {
      const key = this.shared ? '' : item.channel;
      let matcher = this.matchers.get(key);
      if (!matcher) { matcher = new Matcher(this.tokens, this.marker); this.matchers.set(key, matcher); }
      matcher.push(item.text, entry.tag, this.emit);
      if (matcher.oldest === undefined) this.matchers.delete(key);
    }
    output = output.concat(this.release());
    if (this.entries.length > this.maxEntries || this.bufferedUnits() > this.maxUnits) {
      this.mask();
      output = output.concat(this.release());
    }
    return output;
  }
  flush(): Output[] {
    for (const matcher of this.matchers.values()) matcher.flush(this.emit);
    this.matchers.clear();
    return this.release();
  }
}

/**
 * Standalone per-attempt guard. It does not integrate with runtime sinks.
 * Metadata and structured events are cloned and sanitized; callers must
 * validate required fields and expose the `truncated` flag to consumers.
 * Text is returned as a lazy iterator of bounded chunks. Drain each iterator
 * before the next operation; abandoning it fails closed for the attempt.
 * Oversized structured payloads are explicitly truncated.
 */
export function createOrderedTokenCoordinator(tokens: readonly string[], options: {
  maxBufferedEvents?: number; maxBufferedUnits?: number;
} = {}) {
  const secrets = [...new Set(tokens.filter(token => typeof token === 'string' && token.length > 0))];
  if (secrets.length > 64 || secrets.some(token => token.length > 4096)) throw new RangeError('exact-token redaction limits exceeded');
  const maxEntries = options.maxBufferedEvents ?? 128;
  const maxUnits = options.maxBufferedUnits ?? 1_048_576;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 128 || !Number.isInteger(maxUnits) || maxUnits < 256 || maxUnits > 1_048_576) throw new RangeError('redaction queue limit is invalid');
  const marker = secrets.length ? redactExactTokens(secrets[0], secrets) as string : '[redacted-token]';
  // Matching cost increases with the number and lengths of possible prefixes.
  const prefixCost = Math.max(1, secrets.reduce((sum, secret) => sum + secret.length, 0));
  const maxInput = Math.max(64, Math.min(MAX_INPUT_TEXT_UNITS, maxUnits, Math.floor(262_144 / prefixCost)));
  const channels = new Stage(secrets, marker, maxEntries, maxUnits, false);
  const combined = new Stage(secrets, marker, maxEntries, maxUnits, true);
  let closed = false;
  let active = false;
  let abandoned = false;
  const clean = (value: unknown) => {
    const withinBudget = structuredWithinBudget(value);
    const result = redactExactTokenEnvelope({}, withinBudget ? value : '[structured output truncated]', secrets);
    if (!result.ok) throw new Error('redaction metadata unavailable');
    return { value: result.payload, truncated: !withinBudget || result.payloadTruncated };
  };
  const sizeCache = new WeakMap<object, number>();
  const size = (value: unknown): number => {
    try {
      if (value && typeof value === 'object') {
        const cached = sizeCache.get(value);
        if (cached !== undefined) return cached;
        const length = JSON.stringify(value)?.length ?? 4;
        sizeCache.set(value, length);
        return length;
      }
      return JSON.stringify(value)?.length ?? 4;
    } catch { throw new Error('redaction metadata unavailable'); }
  };
  const next = (items: Output[]): Output[] => items.flatMap(item => combined.push(item, item.type === 'text' ? size(item.metadata) + item.channel.length : size(item.event)));
  const checkReady = () => {
    if (closed || abandoned) throw new Error('redaction coordinator is closed');
    if (active) throw new Error('redaction text iterator must be drained first');
  };
  return {
    pushText(channel: string, text: string, metadata: unknown = null): IterableIterator<Output> {
      checkReady();
      if (!channel || channel.length > 1024 || redactExactTokens(channel, secrets) !== channel) throw new Error('invalid redaction channel');
      const cleanMetadata = clean(metadata);
      active = true;
      return (function* () {
        let complete = false;
        try {
          let offset = 0;
          do {
            let end = Math.min(text.length, offset + maxInput);
            if (end < text.length && end > offset && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
            const item: TextItem = { type: 'text', channel, text: text.slice(offset, end), metadata: cleanMetadata.value, truncated: cleanMetadata.truncated };
            yield* next(channels.push(item, size(item.metadata) + channel.length));
            offset = end;
          } while (offset < text.length);
          complete = true;
        } finally {
          active = false;
          if (!complete) abandoned = true;
        }
      })();
    },
    pushEvent(event: unknown): Output[] {
      checkReady();
      const cleaned = clean(event);
      const item: EventItem = { type: 'event', event: cleaned.value, truncated: cleaned.truncated };
      return next(channels.push(item, size(item.event)));
    },
    flush(): Output[] {
      if (closed) return [];
      checkReady();
      closed = true;
      return next(channels.flush()).concat(combined.flush());
    },
  };
}

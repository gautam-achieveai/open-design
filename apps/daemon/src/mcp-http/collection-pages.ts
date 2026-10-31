import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Leave ample space under the registry's 32,000 UTF-16 character cap after
// JSON escaping and pagination metadata. Cursors contain no inventory values.
const MAX_DATA_CHARS = 24_000;
const MAX_ITEMS = 50;
const CURSOR = /^v1\.(0|[1-9][0-9]{0,9})\.([a-f0-9]{32})\.([a-f0-9]{32})$/;
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;
const cursorKey = randomBytes(32);
const mac = (value: string) => createHmac('sha256', cursorKey).update(value).digest('hex').slice(0, 32);
const cursorSignature = (domain: string, offset: number, snapshot: string) => mac(JSON.stringify(['cursor-v1', domain, offset, snapshot]));

export type CollectionPageResult =
  | { ok: true; data: Record<string, unknown>; truncated: boolean }
  | { ok: false; code: 'INVALID_CURSOR' | 'INVENTORY_CHANGED' | 'COLLECTION_ITEM_TOO_LARGE' | 'COLLECTION_ITEM_SENSITIVE' };

/**
 * Stateless cursor: each page re-enumerates and rejects a changed snapshot.
 * Digesting serializes the complete inventory on every call. This bounds only
 * the returned page, not enumeration, hashing work, or upstream memory.
 */
export function collectionPage<T>(options: {
  entries: readonly T[];
  domain: string;
  scope: unknown;
  cursor?: string | undefined;
  limit?: number | undefined;
  token?: string | null | undefined;
  render: (entries: readonly T[]) => Record<string, unknown>;
  compact: (entry: T) => T | null;
}): CollectionPageResult {
  const digest = mac(JSON.stringify(['inventory-v1', options.domain, options.scope, options.entries]));
  let offset = 0;
  if (options.cursor !== undefined) {
    const parsed = CURSOR.exec(options.cursor);
    if (!parsed) return { ok: false, code: 'INVALID_CURSOR' };
    offset = Number(parsed[1]);
    const signature = cursorSignature(options.domain, offset, parsed[2]!);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(parsed[3]!, 'hex'))) return { ok: false, code: 'INVALID_CURSOR' };
    if (parsed[2] !== digest) return { ok: false, code: 'INVENTORY_CHANGED' };
    if (!Number.isSafeInteger(offset) || offset > options.entries.length) return { ok: false, code: 'INVALID_CURSOR' };
  }
  const maxItems = options.limit ?? MAX_ITEMS;
  const selected: T[] = [];
  let compacted = false;
  let i = offset;
  for (; i < options.entries.length && selected.length < maxItems; i++) {
    let candidate: T = options.entries[i] as T;
    let rendered = options.render([...selected, candidate]);
    if (JSON.stringify(rendered).length > MAX_DATA_CHARS) {
      if (selected.length > 0) break;
      const fallback = options.compact(candidate);
      if (fallback === null) return { ok: false, code: 'COLLECTION_ITEM_TOO_LARGE' };
      candidate = fallback;
      rendered = options.render([candidate]);
      if (JSON.stringify(rendered).length > MAX_DATA_CHARS) return { ok: false, code: 'COLLECTION_ITEM_TOO_LARGE' };
      compacted = true;
    }
    const serialized = JSON.stringify(rendered);
    if (TOKEN.test(serialized) || (options.token && serialized.includes(options.token))) return { ok: false, code: 'COLLECTION_ITEM_SENSITIVE' };
    selected.push(candidate);
  }
  const hasMore = i < options.entries.length;
  const data = options.render(selected);
  if (hasMore || compacted || options.cursor !== undefined || options.limit !== undefined) {
    data.page = { hasMore, ...(hasMore ? { nextCursor: `v1.${i}.${digest}.${cursorSignature(options.domain, i, digest)}` } : {}),
      truncated: hasMore || compacted, consistency: 'restart_if_inventory_changes' };
  }
  return { ok: true, data, truncated: hasMore || compacted };
}

export const collectionPageSchema = {
  cursor: { maxLength: 100 },
  maxItems: MAX_ITEMS,
};

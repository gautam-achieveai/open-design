// Mode B authentication: user-managed local MCP credentials.
//
// A credential is an opaque bearer token (`odmcp_…`) created from Settings
// or `od mcp token create`, bound to an allowlist of operation tags, stored
// under the daemon data root. The plaintext token is shown exactly once at
// creation; only its SHA-256 hash is persisted. Intended for external agent
// CLIs (Claude Code, Codex, …) connecting from another workspace over the
// loopback HTTP MCP endpoint.
//
// Plan: specs/current/http-first-mcp-implementation-plan.md §5.2.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MCP_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface McpCredentialPublic {
  id: string;
  name: string;
  allowedOperations: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

interface StoredMcpCredential extends McpCredentialPublic {
  tokenHash: string;
}

export type McpCredentialValidation =
  | { ok: true; credential: McpCredentialPublic }
  | {
      ok: false;
      code: 'MCP_CREDENTIAL_INVALID' | 'MCP_CREDENTIAL_EXPIRED';
      message: string;
    };

export interface CreateMcpCredentialInput {
  name: string;
  /** Operation tags or prefix globs, e.g. `['browser/*', 'mcp:ping']`.
   *  Defaults to unrestricted (`['*']`) — callers should prefer a narrow list. */
  allowedOperations?: string[];
  /** TTL in milliseconds; null/omitted uses the 30-day default. */
  ttlMs?: number | null;
}

export interface McpCredentialStoreOptions {
  filePath: string;
  now?: () => number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toPublic(stored: StoredMcpCredential): McpCredentialPublic {
  const { tokenHash: _tokenHash, ...credential } = stored;
  return credential;
}

export function createMcpCredentialStore(options: McpCredentialStoreOptions): McpCredentialStore {
  return new McpCredentialStore(options);
}

export class McpCredentialStore {
  readonly #filePath: string;
  readonly #now: () => number;
  #records = new Map<string, StoredMcpCredential>();
  #loaded = false;

  constructor(options: McpCredentialStoreOptions) {
    this.#filePath = options.filePath;
    this.#now = options.now ?? (() => Date.now());
  }

  create(input: CreateMcpCredentialInput): { credential: McpCredentialPublic; token: string } {
    const name = input.name.trim();
    if (!name) throw new Error('credential name is required');
    if (name.length > 120) throw new Error('credential name is too long');
    const allowedOperations = (input.allowedOperations ?? ['*']).map((op) => op.trim()).filter(Boolean);
    if (allowedOperations.length === 0) throw new Error('allowedOperations must not be empty');

    const ttlMs = input.ttlMs ?? DEFAULT_MCP_CREDENTIAL_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive');

    this.#load();
    const nowMs = this.#now();
    const stored: StoredMcpCredential = {
      id: randomUUID(),
      name,
      allowedOperations,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      lastUsedAt: null,
      tokenHash: '',
    };
    const token = `odmcp_${randomBytes(32).toString('base64url')}`;
    stored.tokenHash = hashToken(token);
    this.#records.set(stored.id, stored);
    this.#persist();
    return { credential: toPublic(stored), token };
  }

  validateToken(token: string | null | undefined): McpCredentialValidation {
    if (!token) {
      return { ok: false, code: 'MCP_CREDENTIAL_INVALID', message: 'credential token is required' };
    }
    this.#load();
    const stored = [...this.#records.values()].find((record) => record.tokenHash === hashToken(token));
    if (!stored) {
      return { ok: false, code: 'MCP_CREDENTIAL_INVALID', message: 'credential token is invalid or revoked' };
    }
    if (stored.expiresAt !== null && this.#now() >= Date.parse(stored.expiresAt)) {
      this.#records.delete(stored.id);
      this.#persist();
      return { ok: false, code: 'MCP_CREDENTIAL_EXPIRED', message: 'credential token expired' };
    }
    // lastUsedAt is updated in memory and flushed by the next mutation;
    // per-use disk writes would churn on every tool call.
    stored.lastUsedAt = new Date(this.#now()).toISOString();
    return { ok: true, credential: toPublic(stored) };
  }

  list(): McpCredentialPublic[] {
    this.#load();
    return [...this.#records.values()].map(toPublic);
  }

  revoke(id: string): boolean {
    this.#load();
    const existed = this.#records.delete(id);
    if (existed) this.#persist();
    return existed;
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.#filePath, 'utf8');
    } catch {
      return; // no file yet — empty store
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file — start empty rather than crash the daemon
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { credentials?: unknown }).credentials)) {
      return;
    }
    for (const entry of (parsed as { credentials: unknown[] }).credentials) {
      const stored = parseStoredCredential(entry);
      if (stored) this.#records.set(stored.id, stored);
    }
  }

  #persist(): void {
    const payload = JSON.stringify({ version: 1, credentials: [...this.#records.values()] }, null, 2);
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, this.#filePath);
  }
}

function parseStoredCredential(entry: unknown): StoredMcpCredential | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (
    typeof record.id !== 'string'
    || typeof record.name !== 'string'
    || typeof record.tokenHash !== 'string'
    || !Array.isArray(record.allowedOperations)
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    allowedOperations: record.allowedOperations.filter((op): op is string => typeof op === 'string'),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
    tokenHash: record.tokenHash,
  };
}

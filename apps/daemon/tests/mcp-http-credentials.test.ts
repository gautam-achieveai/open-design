import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpCredentialStore } from '../src/mcp-http/credentials.js';

describe('McpCredentialStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-mcp-creds-'));
    filePath = path.join(dir, 'mcp-credentials.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a credential and validates its token, exposing the plaintext only once', () => {
    const store = new McpCredentialStore({ filePath });
    const { credential, token } = store.create({ name: 'laptop' });

    expect(token).toMatch(/^odmcp_/);
    expect(credential.name).toBe('laptop');
    expect(credential).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(credential)).not.toContain(token.slice('odmcp_'.length));

    const validation = store.validateToken(token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.credential.id).toBe(credential.id);
      expect(validation.credential.allowedOperations).toEqual(['*']);
    }
  });

  it('honors scoped operation allowlists', () => {
    const store = new McpCredentialStore({ filePath });
    const { credential, token } = store.create({
      name: 'scoped',
      allowedOperations: ['browser/*', 'mcp:ping'],
    });
    expect(credential.allowedOperations).toEqual(['browser/*', 'mcp:ping']);
    expect(store.validateToken(token).ok).toBe(true);
  });

  it('rejects unknown, revoked, and expired tokens', () => {
    let now = 10_000;
    const store = new McpCredentialStore({ filePath, now: () => now });
    const { credential, token } = store.create({ name: 'temp', ttlMs: 1_000 });

    expect(store.validateToken('odmcp_bogus').ok).toBe(false);

    now += 5_000; // still valid (issued at 10s, ttl 1s → wait, expires at 11s)
    expect(store.validateToken(token).ok).toBe(false); // expired at 11s < 15s

    const fresh = store.create({ name: 'fresh' });
    expect(store.revoke(fresh.credential.id)).toBe(true);
    expect(store.validateToken(fresh.token).ok).toBe(false);
    // The expired credential was deleted when first validated as expired.
    expect(store.revoke(credential.id)).toBe(false);
    expect(store.revoke('missing')).toBe(false);
  });

  it('persists across store instances (daemon restart)', () => {
    const first = new McpCredentialStore({ filePath });
    const { credential, token } = first.create({ name: 'persisted' });

    const second = new McpCredentialStore({ filePath });
    expect(second.list().map((entry) => entry.id)).toEqual([credential.id]);
    expect(second.validateToken(token).ok).toBe(true);
    expect(second.revoke(credential.id)).toBe(true);

    const third = new McpCredentialStore({ filePath });
    expect(third.list()).toEqual([]);
  });

  it('survives a corrupt credentials file', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    const store = new McpCredentialStore({ filePath });
    expect(store.list()).toEqual([]);
    expect(() => store.create({ name: 'recovery' })).not.toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it('validates input', () => {
    const store = new McpCredentialStore({ filePath });
    expect(() => store.create({ name: '  ' })).toThrow(/name is required/);
    expect(() => store.create({ name: 'x', allowedOperations: [] })).toThrow(/allowedOperations/);
    expect(() => store.create({ name: 'x', ttlMs: 0 })).toThrow(/ttlMs/);
  });

  it('updates lastUsedAt on validation without per-use disk churn', () => {
    const store = new McpCredentialStore({ filePath });
    const { credential, token } = store.create({ name: 'audited' });
    expect(credential.lastUsedAt).toBeNull();
    const validation = store.validateToken(token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.credential.lastUsedAt).not.toBeNull();
    }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSafeId } from '../src/projects.js';
import { createUnboundProjectDetail } from '../src/services/unbound-project-detail.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { registerProjectFileMcpTools } from '../src/mcp-http/project-file-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(operations = ['project/files:list', 'project/files:read', 'project/files:search']) {
  const root = mkdtempSync(path.join(tmpdir(), 'od-external-file-tools-'));
  const tokens = new ToolTokenRegistry();
  cleanups.push(() => { tokens.clear(); rmSync(root, { recursive: true, force: true }); });
  const state = { now: 1000, binding: null as string | null, locations: ['visible'], deleted: false, allowed: true,
    metadata: undefined as any, snapshotWait: undefined as Promise<void> | undefined, snapshotEntered: undefined as (() => void) | undefined };
  const credentials = new McpCredentialStore({ filePath: path.join(root, 'credentials.json'), now: () => state.now });
  const created = credentials.create({ name: 'synthetic', allowedOperations: operations, ttlMs: 1000 });
  const grant: McpAuthGrant = { kind: 'external', runId: null, projectId: null, credentialId: created.credential.id,
    name: 'synthetic', allowedOperations: ['*'] };
  const getProject = (id: string) => id === 'p' && !state.deleted ? { id: 'p', metadata: state.metadata } : null;
  const detail = createUnboundProjectDetail({ isSafeId, getProject, getBinding: () => state.binding,
    loadLocations: async () => [...state.locations], currentLocations: () => [...state.locations],
    visibleAtLocations: (_project, locations) => locations.includes('visible'), resolveDir: () => root });
  const read = vi.fn(async () => ({ buffer: Buffer.from('private-text'), name: 'alpha.txt', size: 12, mime: 'text/plain' }));
  const list = vi.fn(async () => [{ name: 'alpha.txt', path: 'alpha.txt', mime: 'text/plain', kind: 'text' as const, size: 12, mtime: 1 }]);
  const search = vi.fn(async () => [{ file: 'alpha.txt', line: 1, snippet: 'private-text' }]);
  const getRun = vi.fn(() => null);
  const registry = new McpToolRegistry();
  registerProjectFileMcpTools(registry, { tokenRegistry: tokens, credentialStore: credentials, projectsRoot: root,
    getProject, getRun, getProjectWorkspaceId: () => state.binding,
    decideProjectRequest: () => state.allowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' },
    readUnboundProjectDetail: async id => { const value = await detail(id); state.snapshotEntered?.(); await state.snapshotWait; return value; },
    listFiles: list, readProjectFile: read, searchProjectFiles: search });
  const headers: Record<string, string> = {};
  let token = created.token;
  const request = { headers, get: (name: string) => name.toLowerCase() === 'authorization'
    ? `Bearer ${token}` : headers[name.toLowerCase()] } as Request;
  const abort = new AbortController();
  const call = (name: string, args: unknown) => registry.call(name, args, grant, abort.signal, request);
  return { state, credentials, created, grant, registry, headers, abort, call, read, list, search, getRun,
    setToken: (value: string) => { token = value; } };
}

describe('exact unbound external project files', () => {
  it('shares list/read/search while requiring an explicit exact visible project and no workspace headers', async () => {
    const f = fixture();
    expect((await f.call('list_files', { project: 'p' })).structuredContent).toMatchObject({ ok: true, data: { files: [{ name: 'alpha.txt' }] } });
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: true, data: { content: 'private-text' } });
    expect((await f.call('search_files', { project: 'p', query: 'private' })).structuredContent).toMatchObject({ ok: true, data: { matches: [{ file: 'alpha.txt' }] } });
    f.read.mockClear(); f.list.mockClear(); f.search.mockClear();
    for (const project of [undefined, 'Friendly name', '../p', 'unknown']) {
      expect((await f.call('get_file', { ...(project === undefined ? {} : { project }), path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false });
    }
    f.headers['x-od-workspace-anything'] = 'unsupported';
    expect((await f.call('list_files', { project: 'p' })).structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_SCOPE_UNSUPPORTED' } });
    delete f.headers['x-od-workspace-anything'];
    f.state.binding = 'workspace';
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false });
    f.state.binding = null; f.state.locations = [];
    expect((await f.call('search_files', { project: 'p', query: 'private' })).structuredContent).toMatchObject({ ok: false });
    expect(f.read).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled();
    expect(f.getRun).not.toHaveBeenCalled();
  });

  it('checks live operation, credential identity, expiry and revoked-mirror policy before I/O', async () => {
    const f = fixture(['project/files:read']);
    expect((await f.call('search_files', { project: 'p', query: 'private' })).structuredContent).toMatchObject({ ok: false });
    f.state.metadata = { teamMirrorRevokedAt: 'now' };
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false });
    f.state.metadata = undefined;
    const other = f.credentials.create({ name: 'other-principal', allowedOperations: ['project/files:read'] });
    f.setToken(other.token);
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false });
    f.setToken(f.created.token); f.state.now += 1000;
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false });
    expect(f.read).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled();
  });

  it.each(['binding', 'location', 'credential', 'expiry'] as const)('does not begin filesystem work when %s changes during project discovery', async change => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.state.snapshotEntered = entered;
    f.state.snapshotWait = new Promise<void>(resolve => { release = resolve; });
    const pending = f.call('list_files', { project: 'p' });
    await started;
    if (change === 'binding') f.state.binding = 'workspace';
    if (change === 'location') f.state.locations = [];
    if (change === 'credential') f.credentials.revoke(f.created.credential.id);
    if (change === 'expiry') f.state.now += 1000;
    release();
    expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(['list_files', 'get_file', 'search_files'] as const)('withholds %s after its credential is revoked during I/O', async name => {
    const f = fixture();
    const revoke = () => f.credentials.revoke(f.created.credential.id);
    f.list.mockImplementation(async () => { revoke(); return [{ name: 'private.txt', path: 'private.txt', mime: 'text/plain', kind: 'text', size: 12, mtime: 1 }]; });
    f.read.mockImplementation(async () => { revoke(); return { buffer: Buffer.from('private-text'), name: 'alpha.txt', size: 12, mime: 'text/plain' }; });
    f.search.mockImplementation(async () => { revoke(); return [{ file: 'private.txt', line: 1, snippet: 'private-text' }]; });
    const args = name === 'get_file' ? { project: 'p', path: 'alpha.txt' }
      : name === 'search_files' ? { project: 'p', query: 'private' } : { project: 'p' };
    const result = await f.call(name, args);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(JSON.stringify(result)).not.toContain('private-text');
    expect(JSON.stringify(result)).not.toContain('private.txt');
  });

  it.each(['metadata', 'permission', 'mirror', 'abort'] as const)('withholds a file after current %s changes during I/O', async change => {
    const f = fixture();
    f.read.mockImplementation(async () => {
      if (change === 'metadata') f.state.metadata = { baseDir: 'changed-root' };
      if (change === 'permission') f.state.allowed = false;
      if (change === 'mirror') f.state.metadata = { teamMirrorRevokedAt: 'now' };
      if (change === 'abort') f.abort.abort();
      return { buffer: Buffer.from('private-text'), name: 'alpha.txt', size: 12, mime: 'text/plain' };
    });
    expect((await f.call('get_file', { project: 'p', path: 'alpha.txt' })).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
  });
});

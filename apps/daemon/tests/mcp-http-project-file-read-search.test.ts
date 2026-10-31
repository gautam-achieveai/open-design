import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { registerProjectFileMcpTools } from '../src/mcp-http/project-file-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import type { ProjectFileContent } from '../src/services/project-file-read.js';

const registries: ToolTokenRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.clear(); });

function fixture(operations = ['project/files:read', 'project/files:search']) {
  const tokens = new ToolTokenRegistry();
  registries.push(tokens);
  const token = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: operations }).token;
  const grant: McpAuthGrant = { kind: 'run', runId: 'run', projectId: 'p', credentialId: null, name: null, allowedOperations: ['*'] };
  const run = { id: 'run', projectId: 'p', status: 'running', cancelRequested: false, workspaceScope: null };
  const state: { binding: string | null; metadata?: any; allowed: boolean; file: ProjectFileContent } = {
    binding: null, allowed: true,
    file: { buffer: Buffer.from('one\ntwo\nthree'), name: 'text.txt', mime: 'text/plain', size: 13 },
  };
  const read = vi.fn(async () => state.file);
  const search = vi.fn(async () => [{ file: 'text.txt', line: 2, snippet: 'two' }]);
  const registry = new McpToolRegistry();
  registerProjectFileMcpTools(registry, { tokenRegistry: tokens, projectsRoot: 'root',
    getRun: () => run, getProject: () => ({ id: 'p', metadata: state.metadata }),
    getProjectWorkspaceId: () => state.binding,
    decideProjectRequest: () => state.allowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' },
    listFiles: async () => [], readProjectFile: read, searchProjectFiles: search });
  const request = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
  return { tokens, token, grant, run, state, read, search, registry,
    call: (name: string, args: unknown, options?: { grant?: McpAuthGrant; signal?: AbortSignal }) =>
      registry.call(name, args, options?.grant ?? grant, options?.signal, request) };
}

describe('run project text reads and search', () => {
  it('bounds candidate serialization before rejecting a multi-megabyte line and preserves ordinary continuation', async () => {
    const f = fixture();
    f.state.file = { ...f.state.file, buffer: Buffer.from('x'.repeat(3_000_000)) };
    const stringify = JSON.stringify;
    let largestSerialization = 0;
    const observe = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const encoded = stringify(value, replacer as never, space);
      if (typeof encoded === 'string') largestSerialization = Math.max(largestSerialization, Buffer.byteLength(encoded, 'utf8'));
      return encoded;
    });
    try {
      const oversized = await f.call('get_file', { path: 'text.txt' });
      f.state.file = { ...f.state.file, buffer: Buffer.from(Array(2000).fill('😀你好'.repeat(20)).join('\n')) };
      const ordinary = await f.call('get_file', { path: 'text.txt' });
      expect(largestSerialization).toBeLessThan(250_000);
      expect(oversized.structuredContent).toMatchObject({ ok: false, error: { code: 'FILE_WINDOW_TOO_LARGE' } });
      expect(ordinary.structuredContent).toMatchObject({ ok: true, meta: { truncated: true } });
      if (ordinary.structuredContent.ok) {
        const data = ordinary.structuredContent.data as { content: string; returnedLines: number; nextOffset: number };
        expect(data.returnedLines).toBeGreaterThan(0);
        expect(data.nextOffset).toBe(data.returnedLines);
        expect(data.content.split('\n')).toHaveLength(data.returnedLines);
      }
    } finally {
      observe.mockRestore();
    }
  });

  it('preserves line windows and literal query options, caps UTF-8 results and rejects binary or oversized individual lines', async () => {
    const f = fixture();
    const window = await f.call('get_file', { path: 'text.txt', offset: 1, limit: 1 });
    expect(window.structuredContent).toMatchObject({ ok: true, data: { content: 'two', offset: 1, returnedLines: 1,
      totalLines: 3, nextOffset: 2 }, meta: { truncated: true } });
    expect(f.read).toHaveBeenCalledWith('root', 'p', 'text.txt', undefined);
    const found = await f.call('search_files', { query: 't.o', pattern: '*.txt', max: 2 });
    expect(found.structuredContent).toMatchObject({ ok: true, data: { matches: [{ file: 'text.txt', line: 2, snippet: 'two' }] } });
    expect(f.search).toHaveBeenCalledWith('root', 'p', 't.o', { max: 2, pattern: '*.txt', metadata: undefined });
    f.state.file = { ...f.state.file, buffer: Buffer.from(Array(2000).fill('😀你好'.repeat(20)).join('\n')) };
    const bounded = await f.call('get_file', { path: 'text.txt' });
    expect(bounded.structuredContent).toMatchObject({ ok: true, meta: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(32_000);
    if (bounded.structuredContent.ok) expect((bounded.structuredContent.data as any).nextOffset).toBeGreaterThan(0);
    f.state.file = { ...f.state.file, buffer: Buffer.from('😀'.repeat(20_000)) };
    expect((await f.call('get_file', { path: 'text.txt' })).structuredContent).toMatchObject({ ok: false, error: { code: 'FILE_WINDOW_TOO_LARGE' } });
    f.state.file = { ...f.state.file, mime: 'image/png' };
    expect((await f.call('get_file', { path: 'text.txt' })).structuredContent).toMatchObject({ ok: false, error: { code: 'FILE_BINARY_UNSUPPORTED' } });
  });

  it('requires exact live operation and run-project authority before any filesystem operation', async () => {
    const f = fixture(['project/files:read']);
    expect((await f.call('search_files', { query: 'x' })).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_OPERATION_DENIED' } });
    expect((await f.call('get_file', { path: 'text.txt', project: 'other' })).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect((await f.call('get_file', { path: '.file-versions/private.txt' })).structuredContent).toMatchObject({ ok: false });
    expect((await f.call('get_file', { path: 'text.txt' }, { grant: { ...f.grant, kind: 'external', runId: null, projectId: null, credentialId: 'external' } })).structuredContent).toMatchObject({ ok: false });
    f.state.metadata = { teamMirrorRevokedAt: 'now' };
    expect((await f.call('get_file', { path: 'text.txt' })).structuredContent).toMatchObject({ ok: false });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });

  it.each(['get_file', 'search_files'] as const)('withholds %s output after credential revocation while I/O is pending', async (name) => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    if (name === 'get_file') f.read.mockImplementation(async () => { entered(); await barrier; return f.state.file; });
    else f.search.mockImplementation(async () => { entered(); await barrier; return [{ file: 'secret.txt', line: 1, snippet: 'withhold-private' }]; });
    const pending = f.call(name, name === 'get_file' ? { path: 'text.txt' } : { query: 'x' });
    await started;
    f.tokens.revokeToken(f.token);
    release();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(JSON.stringify(result)).not.toContain('withhold-private');
  });

  it.each(['binding', 'metadata', 'cancel', 'permission', 'mirror', 'abort'])('withholds a read after current authority changes: %s', async (change) => {
    const f = fixture();
    const abort = new AbortController();
    f.read.mockImplementation(async () => {
      if (change === 'binding') f.state.binding = 'new-workspace';
      if (change === 'metadata') f.state.metadata = { baseDir: 'different-root' };
      if (change === 'cancel') f.run.cancelRequested = true;
      if (change === 'permission') f.state.allowed = false;
      if (change === 'mirror') f.state.metadata = { teamMirrorRevokedAt: 'now' };
      if (change === 'abort') abort.abort();
      return f.state.file;
    });
    expect((await f.call('get_file', { path: 'text.txt' }, { signal: abort.signal })).structuredContent)
      .toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
  });

  it('caps search output in UTF-8 and marks an exact max-sized page conservatively truncated', async () => {
    const f = fixture();
    f.search.mockImplementation(async () => Array.from({ length: 1000 }, (_, index) => ({
      file: `file-${index}.txt`, line: 1, snippet: '😀你好'.repeat(100),
    })));
    const result = await f.call('search_files', { query: 'x', max: 1000 });
    expect(result.structuredContent).toMatchObject({ ok: true, meta: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(32_000);
    if (result.structuredContent.ok) expect((result.structuredContent.data as any).matches.length).toBeLessThan(1000);
  });
});

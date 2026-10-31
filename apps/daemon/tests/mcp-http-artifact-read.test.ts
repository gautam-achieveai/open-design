import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerArtifactReadMcpTool } from '../src/mcp-http/artifact-read-tools.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import type { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const registries: ToolTokenRegistry[] = [];
afterEach(() => { for (const tokens of registries.splice(0)) tokens.clear(); });

function fixture(external = false) {
  const tokens = new ToolTokenRegistry();
  registries.push(tokens);
  const minted = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['project/artifact:read'] });
  const state: { metadata: { kind: 'prototype'; entryFile?: string }; valid: boolean; bound: boolean } = {
    metadata: { kind: 'prototype', entryFile: 'index.html' }, valid: true, bound: false };
  const files = new Map<string, { mime: string; buffer: Buffer }>([
    ['index.html', { mime: 'text/html', buffer: Buffer.from('<script src="app.js"></script><img src="pixel.png"><link href="missing.css">') }],
    ['app.js', { mime: 'application/javascript', buffer: Buffer.from('import "./dep.js";') }],
    ['dep.js', { mime: 'application/javascript', buffer: Buffer.from('import "./deep.js";') }],
    ['deep.js', { mime: 'application/javascript', buffer: Buffer.from('depth-three-marker') }],
    ['pixel.png', { mime: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) }],
  ]);
  const read = vi.fn(async (_root: string, _project: string, name: string) => {
    const file = files.get(name);
    if (!file) throw new Error('synthetic missing file');
    return { name, mime: file.mime, buffer: file.buffer, size: file.buffer.byteLength };
  });
  const list = vi.fn(async () => [...files.entries()].map(([name, file]) => ({ name, path: name, mime: file.mime,
    kind: 'code' as const, size: file.buffer.byteLength, mtime: 1 })));
  const registry = new McpToolRegistry();
  const project = () => ({ id: 'p', name: 'Synthetic', metadata: state.metadata });
  const credentials = { validateToken: (token: string) => token === 'synthetic-artifact' && state.valid
    ? { ok: true, credential: { id: 'credential', name: 'synthetic', allowedOperations: ['project/artifact:read'] } }
    : { ok: false, code: 'MCP_CREDENTIAL_INVALID', message: 'denied' } } as unknown as McpCredentialStore;
  registerArtifactReadMcpTool(registry, { tokenRegistry: tokens, credentialStore: credentials, projectsRoot: 'root',
    getRun: () => ({ id: 'run', projectId: 'p', status: 'running', workspaceScope: null }),
    getProject: () => project(), getProjectWorkspaceId: () => state.bound ? 'workspace' : null,
    decideProjectRequest: () => ({ ok: true }), readUnboundProjectDetail: async id => id === 'p' && !state.bound
      ? { payload: { project: project() }, revalidate: () => !state.bound } : null,
    readProjectFile: read, listFiles: list });
  const grant: McpAuthGrant = { kind: external ? 'external' : 'run', runId: external ? null : 'run',
    projectId: external ? null : 'p', credentialId: external ? 'credential' : null, name: null,
    allowedOperations: ['project/artifact:read'] };
  const request = { headers: {}, get: (name: string) => name.toLowerCase() === 'authorization'
    ? `Bearer ${external ? 'synthetic-artifact' : minted.token}` : undefined } as Request;
  const call = (args: unknown = {}) => registry.call('get_artifact', args, grant, undefined, request);
  return { tokens, minted, state, files, read, list, call };
}

describe('HTTP artifact bundles', () => {
  it('shares default entry, depth-three traversal, binary metadata, skip facts and include modes', async () => {
    const f = fixture();
    const auto = await f.call();
    expect(auto.structuredContent).toMatchObject({ ok: true, data: { entryFile: 'index.html', projectId: 'p', projectName: 'Synthetic',
      truncated: false, skippedFileCount: 1, manifest: { entryFile: 'index.html' } } });
    if (auto.structuredContent.ok) {
      const files = (auto.structuredContent.data as any).files;
      expect(files.map((file: any) => file.name)).toEqual(['index.html', 'app.js', 'pixel.png', 'dep.js']);
      expect(files.find((file: any) => file.name === 'pixel.png')).toEqual({ name: 'pixel.png', mime: 'image/png', size: 4, content: null, binary: true });
    }
    const shallow = await f.call({ include: 'shallow' });
    expect(shallow.structuredContent).toMatchObject({ ok: true, data: { files: [{ name: 'index.html' }], skippedFileCount: 0 } });
    const all = await f.call({ include: 'all' });
    expect(all.structuredContent).toMatchObject({ ok: true, data: { files: expect.arrayContaining([expect.objectContaining({ name: 'deep.js' })]) } });
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it('marks dependency byte skips separately, allows a binary entry, and rejects absent entry before I/O', async () => {
    const f = fixture();
    const entryBytes = f.files.get('index.html')!.buffer.byteLength;
    const partial = await f.call({ maxBytes: entryBytes + 1 });
    expect(partial.structuredContent).toMatchObject({ ok: true, meta: { truncated: true },
      data: { truncated: true, skippedFileCount: 1, files: [{ name: 'index.html' }, { name: 'pixel.png', binary: true, content: null }] } });
    expect((await f.call({ entry: 'pixel.png', include: 'shallow', maxBytes: 1 })).structuredContent).toMatchObject({ ok: true,
      data: { files: [{ name: 'pixel.png', binary: true, content: null }] } });
    f.read.mockClear(); delete f.state.metadata.entryFile;
    expect((await f.call()).structuredContent).toMatchObject({ ok: false, error: { code: 'ARTIFACT_ENTRY_REQUIRED' } });
    expect(f.read).not.toHaveBeenCalled();
  });

  it('rejects a multi-megabyte required entry without serializing it', async () => {
    const f = fixture();
    f.files.set('large.html', { mime: 'text/html', buffer: Buffer.from('x'.repeat(3_000_000)) });
    const stringify = JSON.stringify;
    let largestSerialization = 0;
    const observe = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const encoded = stringify(value, replacer as never, space);
      if (typeof encoded === 'string') largestSerialization = Math.max(largestSerialization, Buffer.byteLength(encoded, 'utf8'));
      return encoded;
    });
    try {
      expect((await f.call({ entry: 'large.html', include: 'shallow', maxBytes: 3_000_000 })).structuredContent)
        .toMatchObject({ ok: false, error: { code: 'ARTIFACT_ENTRY_TOO_LARGE' } });
      expect(largestSerialization).toBeLessThan(250_000);
    } finally { observe.mockRestore(); }
  });

  it('preflights large inventories before candidate serialization and caps both UTF-8 result representations', async () => {
    const f = fixture();
    f.files.clear();
    for (let index = 0; index < 250; index++) f.files.set(`${'😀'.repeat(400)}-${index}.txt`, { mime: 'text/plain', buffer: Buffer.from('small') });
    const stringify = JSON.stringify;
    let largestSerialization = 0;
    const observe = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const encoded = stringify(value, replacer as never, space);
      if (typeof encoded === 'string') largestSerialization = Math.max(largestSerialization, Buffer.byteLength(encoded, 'utf8'));
      return encoded;
    });
    try {
      const result = await f.call({ include: 'all' });
      expect(result.structuredContent).toMatchObject({ ok: true, meta: { truncated: true }, data: { truncated: true } });
      expect(Buffer.byteLength(stringify(result), 'utf8')).toBeLessThan(32_000);
      expect(largestSerialization).toBeLessThan(250_000);
      expect(f.read).toHaveBeenCalledTimes(200);
    } finally { observe.mockRestore(); }
  });

  it.each(['run', 'external'] as const)('withholds the complete bundle if %s access is revoked during a dependency read', async kind => {
    const f = fixture(kind === 'external');
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {
      const file = await read(...args);
      if (args[2] === 'app.js') {
        if (kind === 'run') f.tokens.revokeToken(f.minted.token);
        else f.state.valid = false;
      }
      return file;
    });
    const result = await f.call(kind === 'external' ? { project: 'p' } : {});
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(JSON.stringify(result)).not.toContain('app.js');
    expect(f.read.mock.calls.map(call => call[2])).toEqual(['index.html', 'app.js']);
  });
});

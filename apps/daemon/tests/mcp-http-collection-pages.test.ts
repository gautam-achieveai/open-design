import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { collectionPage } from '../src/mcp-http/collection-pages.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerProjectFileMcpTools } from '../src/mcp-http/project-file-tools.js';
import { registerLiveArtifactMcpTools } from '../src/mcp-http/live-artifact-tools.js';
import { registerConnectorMcpTools } from '../src/mcp-http/connector-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

function fixture() {
  const tokens = new ToolTokenRegistry();
  const ops = ['project/files:list', 'live-artifacts:list', 'connectors:list'];
  const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp', '/api/tools/live-artifacts/list', '/api/tools/connectors/list'], allowedOperations: ops }).token;
  const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
  const grant = { kind: 'run' as const, runId: 'r', projectId: 'p', credentialId: null, name: null, allowedOperations: ops };
  const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false, workspaceScope: null };
  const authority = { getRun: () => run as never, getProjectWorkspaceId: () => null, projectExists: () => true, decideProjectRequest: () => ({ ok: true as const }) };
  const registry = new McpToolRegistry();
  const files = Array.from({ length: 350 }, (_, i) => ({ name: `design/file-${i}.html`, path: `design/file-${i}.html`, type: 'file', size: 100, mtime: 1, kind: 'html', mime: 'text/html' }));
  const artifacts = Array.from({ length: 180 }, (_, i) => ({ id: `la-${i}`, projectId: 'p', title: `Artifact ${i}`, slug: `artifact-${i}`, status: 'active', pinned: false, preview: { type: 'html', entry: 'index.html' }, refreshStatus: 'idle', createdAt: '2026-01-01', updatedAt: '2026-01-01', schemaVersion: 1, hasDocument: true }));
  const tools = Array.from({ length: 120 }, (_, i) => ({ name: `docs.search_${i}`, title: `Search ${i}`, description: 'x'.repeat(200), requiredScopes: ['docs:read'], safety: { sideEffect: 'read', approval: 'auto', reason: 'fixture' }, refreshEligible: true }));
  const definition = { id: 'docs', name: 'Docs', provider: 'fixture', category: 'docs', authentication: 'none', minimumApproval: 'auto', tools, allowedToolNames: tools.map((tool) => tool.name) };
  const service = { listFastDefinitions: () => [definition], listConnectorStatuses: () => ({ docs: { status: 'connected' } }), getStatus: () => ({ status: 'connected' }) };
  registerProjectFileMcpTools(registry, { ...authority, tokenRegistry: tokens, projectsRoot: 'unused', getProject: () => ({ id: 'p' }), listFiles: async () => files as never });
  registerLiveArtifactMcpTools(registry, { ...authority, tokenRegistry: tokens, projectsRoot: 'unused', authorizeProjectTool: async () => true, authorizeProjectToolWrite: async () => true,
    listLiveArtifacts: async () => artifacts as never, createLiveArtifact: async () => ({} as never), updateLiveArtifact: async () => ({} as never), refreshLiveArtifact: async () => ({} as never), emitLiveArtifactEvent: () => {}, emitLiveArtifactRefreshEvent: () => {} });
  registerConnectorMcpTools(registry, { ...authority, tokenRegistry: tokens, projectsRoot: 'unused', service: service as never });
  const call = (name: string, args: object = {}, caller = grant) => registry.call(name, args, caller, undefined, req);
  return { tokens, token, grant, run, files, artifacts, tools, definition, call };
}

describe('bounded MCP collection pages', () => {
  it.each([['list_files', 350], ['live_artifacts_list', 180], ['connectors_list', 120]] as const)('enumerates every %s entry without generic previews', async (name, expected) => {
    const f = fixture();
    let cursor: string | undefined;
    const ids: string[] = [];
    let pages = 0;
    do {
      const result = await f.call(name, cursor ? { cursor } : {});
      expect(result.structuredContent.ok).toBe(true);
      if (!result.structuredContent.ok) throw new Error(result.structuredContent.error.code);
      const data = result.structuredContent.data as any;
      expect(data.preview).toBeUndefined();
      expect(JSON.stringify(data).length).toBeLessThan(32_000);
      expect(JSON.stringify(result)).not.toContain(f.token);
      if (name === 'list_files') ids.push(...data.files.map((item: any) => item.name));
      if (name === 'live_artifacts_list') ids.push(...data.artifacts.map((item: any) => item.id));
      if (name === 'connectors_list') ids.push(...data.connectors.flatMap((connector: any) => connector.tools.map((tool: any) => `${connector.id}:${tool.name}`)));
      cursor = data.page?.nextCursor;
      if (cursor) {
        expect(data.page.truncated).toBe(true);
        expect(cursor).not.toContain('design/');
        expect(cursor).not.toContain('docs.');
      }
      pages++;
      expect(pages).toBeLessThan(50);
    } while (cursor);
    expect(ids).toHaveLength(expected);
    expect(new Set(ids).size).toBe(expected);
    f.tokens.clear();
  });

  it.each(['list_files', 'live_artifacts_list', 'connectors_list'])('rejects changed inventory, invalid cursor and lost authority on each %s page', async (name) => {
    const f = fixture();
    const first = await f.call(name, { limit: 1 });
    if (!first.structuredContent.ok) throw new Error('missing page');
    const cursor = (first.structuredContent.data as any).page.nextCursor as string;
    expect((await f.call(name, { cursor: 'invalid' })).structuredContent).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    expect((await f.call(name, { cursor }, { ...f.grant, projectId: 'other' })).structuredContent).toMatchObject({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    f.run.cancelRequested = true;
    expect((await f.call(name, { cursor })).structuredContent).toMatchObject({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    f.run.cancelRequested = false;
    if (name === 'list_files') f.files.reverse();
    if (name === 'live_artifacts_list') f.artifacts.reverse();
    if (name === 'connectors_list') f.tools.reverse();
    expect((await f.call(name, { cursor })).structuredContent).toMatchObject({ error: { code: 'INVENTORY_CHANGED' } });
    f.tokens.revokeToken(f.token);
    expect((await f.call(name, { cursor })).structuredContent.ok).toBe(false);
    f.tokens.clear();
  });

  it('compacts an oversized file entry while preserving identifiers and marks it partial', async () => {
    const f = fixture();
    (f.files[0] as any).artifactManifest = { description: '"'.repeat(30_000) };
    const result = await f.call('list_files', { limit: 1 });
    expect(result.structuredContent).toMatchObject({ ok: true, meta: { truncated: true }, data: { files: [{ name: 'design/file-0.html', path: 'design/file-0.html', entryTruncated: true }] } });
    expect(JSON.stringify(result)).not.toContain('preview');
    f.tokens.clear();
  });

  it('compacts an oversized artifact while preserving its ID and marks it partial', async () => {
    const f = fixture();
    (f.artifacts[0] as any).extra = 'x'.repeat(50_000);
    const result = await f.call('live_artifacts_list', { limit: 1 });
    expect(result.structuredContent).toMatchObject({ ok: true, meta: { truncated: true }, data: { artifacts: [{ id: 'la-0', projectId: 'p', entryTruncated: true }] } });
    expect(JSON.stringify(result)).not.toContain('"preview":');
    f.tokens.clear();
  });

  it('paginates an oversized single connector and preserves each nested tool name', async () => {
    const f = fixture();
    f.tools[0]!.description = 'x'.repeat(60_000);
    const result = await f.call('connectors_list', { limit: 1 });
    expect(result.structuredContent).toMatchObject({ ok: true, meta: { truncated: true }, data: { connectors: [{ id: 'docs', tools: [{ name: 'docs.search_0', entryTruncated: true }] }] } });
    if (!result.structuredContent.ok) throw new Error('missing page');
    const cursor = (result.structuredContent.data as any).page.nextCursor;
    const next = await f.call('connectors_list', { cursor, limit: 1 });
    expect(next.structuredContent).toMatchObject({ ok: true, data: { connectors: [{ id: 'docs', tools: [{ name: 'docs.search_1' }] }] } });
    f.tokens.clear();
  });

  it('fails safely for an oversized identifier or embedded bearer and does not echo it', async () => {
    const f = fixture();
    f.files[0]!.name = 'x'.repeat(40_000);
    const oversized = await f.call('list_files');
    expect(oversized.structuredContent).toMatchObject({ error: { code: 'COLLECTION_ITEM_TOO_LARGE' } });
    expect(JSON.stringify(oversized).length).toBeLessThan(500);
    f.files[0]!.name = `file-${f.token}`;
    const sensitive = await f.call('list_files');
    expect(sensitive.structuredContent).toMatchObject({ error: { code: 'COLLECTION_ITEM_SENSITIVE' } });
    expect(JSON.stringify(sensitive)).not.toContain(f.token);
    f.tokens.clear();
  });

  it.each(['live_artifacts_list', 'connectors_list'])('does not return embedded bearer content in %s entries', async (name) => {
    const f = fixture();
    if (name === 'live_artifacts_list') f.artifacts[0]!.title = `sensitive ${f.token}`;
    else f.tools[0]!.description = `sensitive ${f.token}`;
    const result = await f.call(name);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'COLLECTION_ITEM_SENSITIVE' } });
    expect(JSON.stringify(result)).not.toContain(f.token);
    f.tokens.clear();
  });

  it('keeps escaped JSON within the registry budget and detects scoped cursor reuse', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, title: '\u0001"\\'.repeat(100) }));
    const params = { entries, domain: 'test', scope: { projectId: 'p' }, render: (items: readonly typeof entries[number][]) => ({ items }), compact: () => null };
    const first = collectionPage(params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(JSON.stringify(first.data).length).toBeLessThan(32_000);
    const cursor = (first.data.page as { nextCursor: string }).nextCursor;
    const tampered = cursor.replace(/^v1\.\d+\./, 'v1.7.');
    expect(collectionPage({ ...params, cursor: tampered })).toEqual({ ok: false, code: 'INVALID_CURSOR' });
    expect(cursor).not.toContain('n-');
    expect(cursor).not.toContain('projectId');
    const changedScope = collectionPage({ ...params, scope: { projectId: 'other' }, cursor });
    expect(changedScope).toEqual({ ok: false, code: 'INVENTORY_CHANGED' });
  });
});

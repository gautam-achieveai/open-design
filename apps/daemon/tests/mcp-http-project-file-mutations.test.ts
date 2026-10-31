import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProjectFile, writeProjectFile, deleteProjectFile, sanitizePath, isSafeId } from '../src/projects.js';
import { createProjectFileMutationOperations } from '../src/services/project-file-mutations.js';
import { createUnboundProjectDetail } from '../src/services/unbound-project-detail.js';
import { getProjectFileVersionRootStats, listProjectFileVersions } from '../src/project-file-versions.js';
import { registerProjectFileMutationMcpTools } from '../src/mcp-http/project-file-mutation-tools.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import type { ProjectMetadata } from '@open-design/contracts';
import type { ProjectFileWriteOptions } from '../src/services/project-file-mutation-hooks.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(external = false, operations = ['project/files:write', 'project/files:delete', 'project/artifact:create']) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'od-mcp-file-mutation-'));
  const root = path.join(fixtureRoot, 'projects');
  const tokens = new ToolTokenRegistry();
  cleanups.push(async () => { tokens.clear(); await rm(fixtureRoot, { recursive: true, force: true }); });
  const minted = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: operations });
  const state = { allowed: true, bound: false, metadata: { kind: 'prototype' } as ProjectMetadata,
    beforeWrite: undefined as undefined | (() => void | Promise<void>), afterContent: undefined as undefined | (() => void) };
  const credentials = new McpCredentialStore({ filePath: path.join(fixtureRoot, 'credentials.json') });
  const credential = credentials.create({ name: 'synthetic', allowedOperations: operations });
  const tombstone = vi.fn();
  const commands = createProjectFileMutationOperations({ projectsRoot: root, sanitizePath, readProjectFile, deleteProjectFile,
    writeProjectFile: async (dir, id, name, body, options: ProjectFileWriteOptions, metadata) => {
      await state.beforeWrite?.();
      return writeProjectFile(dir, id, name, body, { ...options, mutationHooks: { ...options.mutationHooks,
        contentCommitted: receipt => { options.mutationHooks?.contentCommitted?.(receipt); state.afterContent?.(); },
      } }, metadata);
    }, latestProjectPrompt: () => ({ prompt: null }), tombstoneWorkspaceArtifact: tombstone, reportDeleteBookkeepingWarning: () => {} });
  const getProject = (id: string) => id === 'p' ? { id: 'p', metadata: state.metadata } : null;
  const detail = createUnboundProjectDetail({ isSafeId, getProject, getBinding: () => state.bound ? 'workspace' : null,
    loadLocations: async () => ['p'], currentLocations: () => ['p'], visibleAtLocations: (project, locations) => locations.includes(project.id), resolveDir: () => root });
  const decision = vi.fn((_request: unknown, _id: string, options: unknown) => state.allowed
    ? { ok: true as const } : { ok: false as const, status: 403, code: 'DENIED', message: 'denied' });
  const registry = new McpToolRegistry();
  registerProjectFileMutationMcpTools(registry, { tokenRegistry: tokens, credentialStore: credentials, operations: commands,
    getProject, getProjectWorkspaceId: () => state.bound ? 'workspace' : null,
    getRun: () => ({ id: 'run', projectId: 'p', status: 'running', workspaceScope: null }), decideProjectRequest: decision,
    readUnboundProjectDetail: detail });
  const grant: McpAuthGrant = { kind: external ? 'external' : 'run', runId: external ? null : 'run', projectId: external ? null : 'p',
    credentialId: external ? credential.credential.id : null, name: null, allowedOperations: operations };
  const headers: Record<string, string> = {};
  const request = { headers, get: (name: string) => name.toLowerCase() === 'authorization'
    ? `Bearer ${external ? credential.token : minted.token}` : headers[name.toLowerCase()] } as Request;
  const call = (name: string, args: unknown) => registry.call(name, args, grant, undefined, request);
  const exists = async (name: string) => { try { await access(path.join(root, 'p', name)); return true; } catch { return false; } };
  return { fixtureRoot, root, state, credentials, credential, tokens, minted, headers, commands, tombstone, decision, call, exists };
}

describe('shared MCP project file mutations', () => {
  it('writes actual normalized bytes/hash, captures artifact history, rejects overwrite and tombstones deletion', async () => {
    const f = await fixture();
    const result = await f.call('write_file', { path: 'nested/first draft.txt', content: Buffer.from('你好').toString('base64'), encoding: 'base64' });
    const saved = await readProjectFile(f.root, 'p', 'nested/first-draft.txt');
    expect(result.structuredContent).toMatchObject({ ok: true, data: { path: 'nested/first-draft.txt', bytes: saved.buffer.byteLength,
      sha256: createHash('sha256').update(saved.buffer).digest('hex'), committed: true, partial: false } });
    const artifact = await f.call('create_artifact', { name: 'report.html', content: '<html>real report</html>' });
    expect(artifact.structuredContent).toMatchObject({ ok: true, data: { versionId: expect.any(String), partial: false } });
    expect(JSON.parse(await readFile(path.join(f.root, 'p', 'report.html.artifact.json'), 'utf8')).kind).toBe('html');
    expect(await listProjectFileVersions(f.root, 'p', 'report.html')).toHaveLength(1);
    expect((await f.call('create_artifact', { name: 'report.html', content: 'replacement' })).structuredContent).toMatchObject({ ok: false, error: { code: 'FILE_EXISTS' } });
    expect((await readProjectFile(f.root, 'p', 'report.html')).buffer.toString('utf8')).toBe('<html>real report</html>');
    expect((await f.call('delete_file', { path: 'report.html' })).structuredContent).toMatchObject({ ok: true, data: { path: 'report.html', deleted: true, partial: false } });
    expect(await f.exists('report.html')).toBe(false);
    const stats = await getProjectFileVersionRootStats(f.root, 'p', 'report.html');
    expect(JSON.parse(await readFile(path.join(stats.root, 'manifest.json'), 'utf8')).deletedAt).toBeGreaterThan(0);
    expect(f.tombstone).toHaveBeenCalledWith('p', 'report.html');
    expect(f.decision.mock.calls.every(call => JSON.stringify(call[2]) === JSON.stringify({ mode: 'write', capability: 'writeFiles' }))).toBe(true);
  });

  it('preserves committed-file receipts when HTML history cannot be captured', async () => {
    const f = await fixture();
    const stats = await getProjectFileVersionRootStats(f.root, 'p', 'warning.html');
    await mkdir(path.dirname(stats.root), { recursive: true }); await writeFile(stats.root, 'blocker');
    const result = await f.call('write_file', { path: 'warning.html', content: '<html>written</html>' });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { committed: true, partial: true,
      path: 'warning.html', historyWarning: 'PROJECT_FILE_VERSION_CAPTURE_FAILED', checkStateBeforeRetry: true } });
    expect((await readProjectFile(f.root, 'p', 'warning.html')).buffer.toString('utf8')).toBe('<html>written</html>');
  });

  it('denies read-only, wrong-project, bound-external and reserved paths before writing', async () => {
    const readOnly = await fixture(true, ['project/files:read']);
    expect((await readOnly.call('write_file', { project: 'p', path: 'denied.txt', content: 'deny' })).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_OPERATION_DENIED' } });
    expect(await readOnly.exists('denied.txt')).toBe(false);
    const f = await fixture();
    expect((await f.call('write_file', { project: 'other', path: 'denied.txt', content: 'deny' })).structuredContent.ok).toBe(false);
    f.state.allowed = false;
    expect((await f.call('write_file', { path: 'denied.txt', content: 'deny' })).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    f.state.allowed = true;
    expect((await f.call('write_file', { path: '.file-versions/private.txt', content: 'deny' })).structuredContent.ok).toBe(false);
    expect(await f.exists('denied.txt')).toBe(false);
    const external = await fixture(true); external.state.bound = true;
    expect((await external.call('write_file', { project: 'p', path: 'denied.txt', content: 'deny' })).structuredContent.ok).toBe(false);
    expect(await external.exists('denied.txt')).toBe(false);
  });

  it.each(['run', 'external'] as const)('rechecks %s authority after async preparation before any mutation', async kind => {
    const f = await fixture(kind === 'external');
    f.state.beforeWrite = () => { if (kind === 'run') f.tokens.revokeToken(f.minted.token); else f.credentials.revoke(f.credential.credential.id); };
    const result = await f.call('write_file', { ...(kind === 'external' ? { project: 'p' } : {}), path: 'pending.txt', content: 'deny' });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(await f.exists('pending.txt')).toBe(false);
  });

  it.each(['failure', 'revoke'] as const)('reports a partial outcome after committed content: %s', async change => {
    const f = await fixture();
    f.state.afterContent = () => { if (change === 'failure') throw new Error('synthetic post-write failure'); f.tokens.revokeToken(f.minted.token); };
    const result = await f.call('write_file', { path: 'committed.txt', content: 'already written' });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_FILE_MUTATION_PARTIAL' } });
    expect((await readProjectFile(f.root, 'p', 'committed.txt')).buffer.toString('utf8')).toBe('already written');
  });

  it('blocks existing outside and hidden imported aliases while preserving their target bytes', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, 'p'), { recursive: true });
    const outside = path.join(f.fixtureRoot, 'outside.txt'); await writeFile(outside, 'outside');
    await symlink(outside, path.join(f.root, 'p', 'outside-alias.txt'), 'file');
    expect((await f.call('write_file', { path: 'outside-alias.txt', content: 'deny' })).structuredContent.ok).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    const imported = path.join(f.fixtureRoot, 'imported'); await mkdir(path.join(imported, '.hidden'), { recursive: true });
    const hidden = path.join(imported, '.hidden', 'private.txt'); await writeFile(hidden, 'hidden');
    await symlink(hidden, path.join(imported, 'hidden-alias.txt'), 'file');
    f.state.metadata = { kind: 'prototype', importedFrom: 'folder', baseDir: imported };
    expect((await f.call('write_file', { path: 'hidden-alias.txt', content: 'deny' })).structuredContent.ok).toBe(false);
    expect(await readFile(hidden, 'utf8')).toBe('hidden');
    expect((await f.call('delete_file', { path: 'hidden-alias.txt' })).structuredContent.ok).toBe(false);
    expect(await readFile(hidden, 'utf8')).toBe('hidden');
  });
});

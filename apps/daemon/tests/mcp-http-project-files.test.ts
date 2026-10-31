import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { ProjectFile } from '@open-design/contracts';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerProjectFileMcpTools } from '../src/mcp-http/project-file-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

describe('run-scoped MCP project file list', () => {
  it.each(['rebind', 'deleted', 'mirror revoked', 'cancelled', 'token revoked'])(
    'does not publish a listing when authority changes during the filesystem read: %s',
    async (change) => {
      const tokens = new ToolTokenRegistry();
      const token = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['project/files:list'] }).token;
      const grant = { kind: 'run' as const, runId: 'run', projectId: 'p', credentialId: null, name: null, allowedOperations: ['project/files:list'] };
      const run = { id: 'run', projectId: 'p', status: 'running', cancelRequested: false,
        workspaceScope: { schemaVersion: 1 as const, source: 'persisted_project_binding' as const, projectId: 'p', workspaceId: 'w', workspaceMemberId: 'm' } };
      let binding = 'w';
      let deleted = false;
      let revoked = false;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const registry = new McpToolRegistry();
      registerProjectFileMcpTools(registry, {
        tokenRegistry: tokens, projectsRoot: 'fixture', getRun: () => run,
        getProject: () => deleted ? null : { id: 'p', ...(revoked ? { metadata: { teamMirrorRevokedAt: 'now' } as never } : {}) },
        getProjectWorkspaceId: () => binding, decideProjectRequest: () => ({ ok: true }),
        listFiles: async () => { started(); await barrier; return [{ name: 'private.txt' } as ProjectFile]; },
      });
      const request = { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
      const call = registry.call('list_files', {}, grant, undefined, request);
      await entered;
      if (change === 'rebind') binding = 'other';
      if (change === 'deleted') deleted = true;
      if (change === 'mirror revoked') revoked = true;
      if (change === 'cancelled') run.cancelRequested = true;
      if (change === 'token revoked') tokens.revokeToken(token);
      release();
      expect((await call).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      tokens.clear();
    },
  );

  it('uses pinned project and scope, matches the shared listing, and denies stale or mismatched authority', async () => {
    const tokens = new ToolTokenRegistry();
    const token = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['project/files:list'] }).token;
    const grant = { kind: 'run' as const, runId: 'run', projectId: 'p', credentialId: null, name: null, allowedOperations: ['project/files:list'] };
    let run: any = { id: 'run', projectId: 'p', status: 'running', workspaceScope: { schemaVersion: 1, source: 'persisted_project_binding', projectId: 'p', workspaceId: 'w', workspaceMemberId: 'm' } };
    let binding: string | null = 'w';
    let revoked = false;
    let permitted = true;
    const file = { name: 'file.txt', size: 4, mtime: 1, kind: 'text', mime: 'text/plain' } as ProjectFile;
    const list = vi.fn(async () => [file]);
    const decide = vi.fn((request: { get: (name: string) => string | undefined }) => {
      expect(request.get('x-od-workspace-id')).toBe('w');
      expect(request.get('x-od-workspace-member-id')).toBe('m');
      return permitted ? { ok: true as const } : { ok: false as const, status: 403, code: 'DENIED', message: 'denied' };
    });
    const registry = new McpToolRegistry();
    registerProjectFileMcpTools(registry, {
      tokenRegistry: tokens, projectsRoot: 'fixture', getRun: () => run,
      getProject: () => ({ id: 'p', ...(revoked ? { metadata: { teamMirrorRevokedAt: 'now' } as never } : {}) }),
      getProjectWorkspaceId: () => binding, decideProjectRequest: decide, listFiles: list,
    });
    const request = (headers: Record<string, string> = {}) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : headers[name.toLowerCase()] }) as Request;
    const call = (args: unknown = {}, req = request()) => registry.call('list_files', args, grant, undefined, req);
    expect((await call({ since: 12 })).structuredContent).toMatchObject({ ok: true, data: { files: [file] } });
    expect(list).toHaveBeenCalledWith('fixture', 'p', { since: 12, metadata: undefined });
    expect((await call({ project: 'other' })).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect((await call({}, request({ 'x-od-workspace-id': 'else', 'x-od-workspace-member-id': 'm' }))).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    binding = 'different';
    expect((await call()).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    binding = 'w'; run.cancelRequested = true;
    expect((await call()).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    run.cancelRequested = false; permitted = false;
    expect((await call()).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    permitted = true; revoked = true;
    expect((await call()).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
    expect(list).toHaveBeenCalledTimes(1);
    tokens.revokeToken(token);
    expect((await call()).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_TOKEN_INVALID' } });
    tokens.clear();
  });

  it('passes imported-folder metadata and enforces endpoint, operation and token expiry', async () => {
    const tokens = new ToolTokenRegistry();
    const registry = new McpToolRegistry();
    const metadata = { importedFrom: 'folder', baseDir: 'synthetic-import-root' } as never;
    const list = vi.fn(async () => []);
    registerProjectFileMcpTools(registry, {
      tokenRegistry: tokens, projectsRoot: 'fixture',
      getRun: () => ({ id: 'run', projectId: 'p', status: 'running', workspaceScope: null }),
      getProject: () => ({ id: 'p', metadata }), getProjectWorkspaceId: () => null,
      decideProjectRequest: () => ({ ok: true }), listFiles: list,
    });
    const grant = { kind: 'run' as const, runId: 'run', projectId: 'p', credentialId: null, name: null, allowedOperations: ['*'] };
    const call = (token: string) => registry.call('list_files', {}, grant, undefined,
      { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request);
    const good = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['project/files:list'] });
    expect((await call(good.token)).structuredContent).toMatchObject({ ok: true, data: { files: [] } });
    expect(list).toHaveBeenCalledWith('fixture', 'p', { since: undefined, metadata });
    const wrongEndpoint = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/other'], allowedOperations: ['project/files:list'] });
    expect((await call(wrongEndpoint.token)).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_ENDPOINT_DENIED' } });
    const wrongOperation = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot'] });
    expect((await call(wrongOperation.token)).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_OPERATION_DENIED' } });
    const expired = tokens.mint({ runId: 'run', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['project/files:list'], ttlMs: 1, nowMs: 1 });
    expect((await call(expired.token)).structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_TOKEN_EXPIRED' } });
    expect(list).toHaveBeenCalledTimes(1);
    tokens.clear();
  });
});

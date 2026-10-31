import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ACTIVE_CONTEXT_TTL_MS } from '../src/constants.js';
import { registerActiveContextMcpTool } from '../src/mcp-http/active-context-tools.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

function fixture() {
  const tokens = new ToolTokenRegistry();
  const p = tokens.mint({ runId: 'r1', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['context/active:read'] });
  const q = tokens.mint({ runId: 'r2', projectId: 'q', allowedEndpoints: ['/mcp'], allowedOperations: ['context/active:read'] });
  const req = (token: string) => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined }) as Request;
  const grant = (runId: string, projectId: string): McpAuthGrant => ({ kind: 'run', runId, projectId, credentialId: null, name: null, allowedOperations: ['context/active:read'] });
  const store: { current: { projectId: string; fileName: string | null; ts: number } | null } = { current: { projectId: 'p', fileName: 'index.html', ts: 2000 } };
  let now = 2500;
  let workspace: string | null = null;
  let exists = true;
  const runs = { r1: { id: 'r1', projectId: 'p', status: 'running', cancelRequested: false, workspaceScope: null },
    r2: { id: 'r2', projectId: 'q', status: 'running', cancelRequested: false, workspaceScope: null } };
  const registry = new McpToolRegistry();
  registerActiveContextMcpTool(registry, { tokenRegistry: tokens, store, now: () => now,
    getProject: (id) => exists ? { name: `Project ${id}` } : null,
    getRun: (id) => runs[id as keyof typeof runs], getProjectWorkspaceId: () => workspace, decideProjectRequest: () => ({ ok: true }) });
  return { tokens, p, q, req, grant, store, runs, registry,
    get now() { return now; }, set now(value: number) { now = value; },
    get workspace() { return workspace; }, set workspace(value: string | null) { workspace = value; },
    get exists() { return exists; }, set exists(value: boolean) { exists = value; } };
}

describe('run-scoped active context', () => {
  it('matches REST data for the active project and denies a concurrent other-project run', async () => {
    const f = fixture();
    try {
      const [allowed, denied] = await Promise.all([
        f.registry.call('get_active_context', {}, f.grant('r1', 'p'), undefined, f.req(f.p.token)),
        f.registry.call('get_active_context', {}, f.grant('r2', 'q'), undefined, f.req(f.q.token)),
      ]);
      expect(allowed.structuredContent).toMatchObject({ ok: true, data: { active: true, projectId: 'p', projectName: 'Project p', fileName: 'index.html', ts: 2000, ageMs: 500 } });
      expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(JSON.stringify(denied)).not.toContain('index.html');
    } finally { f.tokens.clear(); }
  });

  it('preserves the inclusive TTL boundary, clearing, and the inactive hint', async () => {
    const f = fixture();
    try {
      f.now = 2000 + ACTIVE_CONTEXT_TTL_MS;
      const at = await f.registry.call('get_active_context', {}, f.grant('r1', 'p'), undefined, f.req(f.p.token));
      expect(at.structuredContent).toMatchObject({ ok: true, data: { active: true } });
      f.now++;
      const after = await f.registry.call('get_active_context', {}, f.grant('r1', 'p'), undefined, f.req(f.p.token));
      expect(after.structuredContent).toMatchObject({ ok: true, data: { active: false, hint: expect.stringContaining('5 minutes') } });
      expect(f.store.current).toBeNull();
    } finally { f.tokens.clear(); }
  });

  it('rejects stale run, rebinding, deleted project, wrong audience/operation and external credentials', async () => {
    const f = fixture();
    try {
      const call = (bearer = f.p.token, grant = f.grant('r1', 'p')) => f.registry.call('get_active_context', {}, grant, undefined, f.req(bearer));
      f.runs.r1.cancelRequested = true; expect((await call()).structuredContent.ok).toBe(false); f.runs.r1.cancelRequested = false;
      f.runs.r1.status = 'succeeded'; expect((await call()).structuredContent.ok).toBe(false); f.runs.r1.status = 'running';
      f.workspace = 'later-binding'; expect((await call()).structuredContent.ok).toBe(false); f.workspace = null;
      f.exists = false; expect((await call()).structuredContent.ok).toBe(false); f.exists = true;
      for (const endpoint of ['/other', '/mcp']) {
        const wrong = f.tokens.mint({ runId: 'r1', projectId: 'p', allowedEndpoints: [endpoint], allowedOperations: [endpoint === '/mcp' ? 'browser/snapshot' : 'context/active:read'] });
        expect((await call(wrong.token)).structuredContent.ok).toBe(false);
      }
      expect((await call(f.p.token, { ...f.grant('r1', 'p'), kind: 'external', credentialId: 'e' })).structuredContent.ok).toBe(false);
      f.tokens.revokeToken(f.p.token); expect((await call()).structuredContent.ok).toBe(false);
    } finally { f.tokens.clear(); }
  });

  it('does not disclose bearer-shaped or oversized active filenames and rejects attribution', async () => {
    const f = fixture();
    try {
      for (const filename of [`synthetic-${f.p.token}`, 'x'.repeat(5000)]) {
        f.store.current = { projectId: 'p', fileName: filename, ts: 2000 };
        const result = await f.registry.call('get_active_context', {}, f.grant('r1', 'p'), undefined, f.req(f.p.token));
        expect(result.structuredContent.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain(filename);
      }
      const attributed = await f.registry.call('get_active_context', { pluginWorkflowId: 'anything' }, f.grant('r1', 'p'), undefined, f.req(f.p.token));
      expect(attributed.structuredContent).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_ARGUMENT' } });
    } finally { f.tokens.clear(); }
  });
});

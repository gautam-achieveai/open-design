import { describe, expect, it } from 'vitest';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerSkillCatalogMcpTool } from '../src/mcp-http/skill-catalog-tools.js';
import { readSkillCatalog } from '../src/services/skill-catalog.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import type { SkillInfo } from '../src/skills.js';

function fixture() {
  const tokens = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/skills:list'] });
  const grant = { kind: 'run' as const, runId: 'r', projectId: 'p', credentialId: null, name: null, allowedOperations: ['catalog/skills:list'] };
  const req = (t = token.token, headers: Record<string, string> = {}) => ({ get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${t}` : headers[key.toLowerCase()] }) as never;
  const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false,
    workspaceScope: { projectId: 'p', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' } };
  const f = { tokens, token, grant, req, run, registry, workspace: 'w1', exists: true,
    skills: [{ id: 'a', name: 'A', body: 'body', dir: 'dir' }, { id: 'b', name: 'B', body: '', dir: 'dir' }] as SkillInfo[],
    scopes: [] as unknown[], wait: undefined as Promise<void> | undefined };
  registerSkillCatalogMcpTool(registry, { tokenRegistry: tokens, projectExists: () => f.exists,
    getRun: () => run as never, getProjectWorkspaceId: () => f.workspace,
    decideProjectRequest: (r) => ({ ok: r.get('x-od-workspace-id') === 'w1' && r.get('x-od-workspace-member-id') === 'alice' }) as never,
    listSkillsSnapshot: async (scope) => { f.scopes.push(scope); await f.wait; return { entries: f.skills, revalidate: () => true }; } });
  return Object.assign(f, { call: (args: unknown = {}, bearer = token.token, headers: Record<string, string> = {}) => registry.call('list_skills', args, grant, undefined, req(bearer, headers)) });
}

describe('HTTP MCP skill catalog', () => {
  it('shares REST projection with pinned scope and explicit pages', async () => {
    const f = fixture(); try {
      const result = await f.call({ limit: 1 });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { skills: [{ id: 'a', hasBody: true }], nextOffset: 1 }, meta: { truncated: true } });
      expect(f.scopes).toEqual([{ workspaceId: 'w1', workspaceMemberId: 'alice' }]);
      const expected = await readSkillCatalog(async () => f.skills, { workspaceId: 'w1', workspaceMemberId: 'alice' });
      const second = await f.call({ offset: 1 });
      expect(second.structuredContent).toMatchObject({ ok: true, data: { skills: [expected[1]] } });
      expect(JSON.stringify(result)).not.toContain('"body"'); expect(JSON.stringify(result)).not.toContain('"dir"');
    } finally { f.tokens.clear(); }
  });
  it('fails closed before and after asynchronous discovery', async () => {
    const f = fixture(); try {
      f.run.cancelRequested = true; expect((await f.call()).structuredContent.ok).toBe(false); f.run.cancelRequested = false;
      f.workspace = 'w2'; expect((await f.call()).structuredContent.ok).toBe(false); f.workspace = 'w1';
      f.exists = false; expect((await f.call()).structuredContent.ok).toBe(false); f.exists = true;
      expect((await f.call({}, f.token.token, { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'bob' })).structuredContent.ok).toBe(false);
      let release!: () => void; f.wait = new Promise<void>(resolve => { release = resolve; });
      const pending = f.call(); await Promise.resolve(); f.tokens.revokeToken(f.token.token); release();
      expect((await pending).structuredContent.ok).toBe(false);
    } finally { f.tokens.clear(); }
  });
  it('bounds escaped output, keeps complete identifiers, and rejects unsafe entries and attribution', async () => {
    const f = fixture(); try {
      f.skills = Array.from({ length: 40 }, (_, i) => ({ id: `skill-${i}`, name: '"\\😀'.repeat(150), body: '', dir: '' })) as SkillInfo[];
      const result = await f.call(); expect(result.structuredContent.ok).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(32_000);
      if (result.structuredContent.ok) {
        const data = result.structuredContent.data as { skills: Array<{ id: string }>; nextOffset: number };
        expect(data.nextOffset).toBeGreaterThan(0); expect(data.skills.map(x => x.id)).toEqual(f.skills.slice(0, data.nextOffset).map(x => x.id));
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(data);
      }
      f.skills = [{ id: 'unsafe', name: `prefix-${f.token.token}`, body: '', dir: '' }] as SkillInfo[];
      const secret = await f.call(); expect(secret.structuredContent.ok).toBe(false); expect(JSON.stringify(secret)).not.toContain(f.token.token);
      f.skills = [{ id: 'too-big', name: 'x'.repeat(9000), body: '', dir: '' }] as SkillInfo[];
      expect((await f.call()).structuredContent.ok).toBe(false);
      expect((await f.call({ pluginWorkflowId: 'synthetic' })).structuredContent).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_ARGUMENT' } });
    } finally { f.tokens.clear(); }
  });
});

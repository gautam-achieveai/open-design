import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerPluginCatalogMcpTool } from '../src/mcp-http/plugin-catalog-tools.js';
import { projectPluginCatalog } from '../src/services/plugin-catalog.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

function fixture() {
  const tokens = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/plugins:list'] });
  const grant = { kind: 'run' as const, runId: 'r', projectId: 'p', credentialId: null, name: null, allowedOperations: ['catalog/plugins:list'] };
  const req = (t = token.token) => ({ get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${t}` : undefined }) as never;
  const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false,
    workspaceScope: { projectId: 'p', source: 'persisted_project_binding', workspaceId: 'w', workspaceMemberId: 'm' } };
  const item = (id: string) => ({ id, title: id, manifest: { name: id, title: id, description: 'fixture', od: { kind: 'scenario' }, tags: ['demo'] }, fsPath: 'private path' }) as InstalledPluginRecord;
  const f = { tokens, registry, token, grant, run, workspace: 'w', records: [item('a'), item('b')], scope: [] as unknown[], selected: [] as number[], valid: true, wait: undefined as Promise<void> | undefined };
  registerPluginCatalogMcpTool(registry, { tokenRegistry: tokens, projectExists: () => true,
    getRun: () => run as never, getProjectWorkspaceId: () => f.workspace,
    decideProjectRequest: (r) => ({ ok: r.get('x-od-workspace-id') === 'w' && r.get('x-od-workspace-member-id') === 'm' }) as never,
    listPluginSnapshot: async (scope) => { f.scope.push(scope); await f.wait; return { entries: f.records, revalidate: indices => { f.selected = [...indices]; return f.valid; } }; } });
  return Object.assign(f, { item, call: (args: unknown = {}) => registry.call('list_plugins', args, grant, undefined, req()) });
}

describe('HTTP MCP plugin catalog', () => {
  it('projects legacy fields and checks selected provenance indices', async () => {
    const f=fixture(); try {
      const first=await f.call({limit:1});
      expect(first.structuredContent).toMatchObject({ok:true,data:{plugins:[projectPluginCatalog(f.records)[0]],nextOffset:1},meta:{truncated:true}});
      expect(f.selected).toEqual([0]); expect(f.scope).toEqual([{workspaceId:'w',workspaceMemberId:'m'}]);
      const second=await f.call({offset:1}); expect(second.structuredContent).toMatchObject({ok:true,data:{plugins:[projectPluginCatalog(f.records)[1]]}});
      expect(f.selected).toEqual([1]); expect(JSON.stringify(first)).not.toContain('private path');
    } finally { f.tokens.clear(); }
  });
  it('denies revoked source, changed project or token during discovery', async () => {
    const f=fixture(); try {
      f.valid=false; expect((await f.call()).structuredContent).toMatchObject({ok:false,error:{code:'PROJECT_SCOPE_DENIED'}});
      f.valid=true; f.workspace='other'; expect((await f.call()).structuredContent.ok).toBe(false); f.workspace='w';
      let release!:()=>void; f.wait=new Promise<void>(resolve=>release=resolve); const pending=f.call(); await Promise.resolve();
      f.tokens.revokeToken(f.token.token); release(); expect((await pending).structuredContent.ok).toBe(false);
    } finally { f.tokens.clear(); }
  });
  it('returns bounded pages and fails closed for unsafe content and unsupported attribution', async () => {
    const f=fixture(); try {
      f.records=Array.from({length:40},(_,i)=>{const r=f.item(`plugin-${i}`);r.manifest.description='"\\😀'.repeat(150);return r;});
      const result=await f.call(); expect(result.structuredContent.ok).toBe(true); expect(JSON.stringify(result).length).toBeLessThan(32000);
      if (result.structuredContent.ok) { const d=result.structuredContent.data as {plugins:Array<{id:string}>,nextOffset:number}; expect(d.nextOffset).toBeGreaterThan(0); expect(d.plugins.map(x=>x.id)).toEqual(f.records.slice(0,d.nextOffset).map(x=>x.id)); expect(JSON.parse((result.content[0] as {text:string}).text)).toEqual(d); }
      const unsafe=f.item('unsafe'); unsafe.manifest.description=f.token.token; f.records=[unsafe];
      const secret=await f.call(); expect(secret.structuredContent.ok).toBe(false); expect(JSON.stringify(secret)).not.toContain(f.token.token);
      unsafe.manifest.description='x'.repeat(9000); expect((await f.call()).structuredContent.ok).toBe(false);
      expect((await f.call({pluginWorkflowId:'synthetic'})).structuredContent).toMatchObject({ok:false,error:{code:'UNSUPPORTED_ARGUMENT'}});
    } finally { f.tokens.clear(); }
  });
});

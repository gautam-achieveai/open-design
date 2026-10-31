import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeWorkspaceScopedTeamResource } from '../src/collab/team-resource-materialization.js';
import { workspaceTeamPluginBindingResourceId } from '../src/plugins/registry.js';
import { readNonAdoptingTeamPlugin } from '../src/services/plugin-catalog-discovery.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerPluginCatalogMcpTool } from '../src/mcp-http/plugin-catalog-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true}); });
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'od-plugin-read-test-')); roots.push(root);
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE workspace_resources (resource_type TEXT,resource_id TEXT,workspace_id TEXT,visibility TEXT,resource_state TEXT,created_by_workspace_member_id TEXT,updated_by_workspace_member_id TEXT,resource_hub_resource_id TEXT,cloud_tombstoned_at INTEGER,sync_state TEXT,version INTEGER,created_at INTEGER,updated_at INTEGER)`);
  await materializeWorkspaceScopedTeamResource({kindRoot:root,storageName:'p',identity:{kind:'plugin',workspaceId:'w',resourceId:'p',hubResourceId:'hub-old'},pullInto:async dir=>{await fs.writeFile(path.join(dir,'SKILL.md'),'---\nname: p\ndescription: fixture\n---\n# p\n');},verifyWorkspaceScope:async()=>true,verifyStillShared:async()=>true});
  const key=workspaceTeamPluginBindingResourceId('w','p');
  const bind=()=>db.prepare(`INSERT INTO workspace_resources(resource_type,resource_id,workspace_id,visibility,resource_state,resource_hub_resource_id,updated_at) VALUES('plugin',?,'w','team','active','hub-old',1)`).run(key);
  return {db,root,key,bind,read:()=>readNonAdoptingTeamPlugin(db,root,'w','p')};
}
describe('non-adopting Team plugin reader',()=>{
  it('fails closed without adopting and rejects a mismatched marker identity',async()=>{
    const f=await fixture(); try {
      expect((await f.read()).status).toBe('incomplete'); expect((f.db.prepare('SELECT count(*) AS n FROM workspace_resources').get() as {n:number}).n).toBe(0);
      f.bind(); expect((await f.read()).status).toBe('observed');
      f.db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id='hub-new' WHERE resource_id=?`).run(f.key);
      expect((await f.read()).status).toBe('incomplete');
      f.db.prepare(`UPDATE workspace_resources SET resource_state='deleted' WHERE resource_id=?`).run(f.key);
      expect((await f.read()).status).toBe('absent');
    } finally {f.db.close();}
  });
  it('rejects a binding identity change during the actual file read',async()=>{
    const f=await fixture(); try {
      f.bind(); const original=fs.readFile.bind(fs); let changed=false;
      vi.spyOn(fs,'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>)=>{
        const content=await original(...args);
        if (String(args[0]).endsWith('SKILL.md') && !changed) {changed=true;f.db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id='hub-new' WHERE resource_id=?`).run(f.key);}
        return content;
      }) as typeof fs.readFile);
      expect((await f.read()).status).toBe('incomplete'); expect(changed).toBe(true);
    } finally {f.db.close();}
  });
  it('withholds a real materialization after token revocation during discovery', async () => {
    const f=await fixture(), tokens=new ToolTokenRegistry(), registry=new McpToolRegistry();
    try {
      f.bind(); const token=tokens.mint({runId:'r',projectId:'project',allowedEndpoints:['/mcp'],allowedOperations:['catalog/plugins:list']});
      const grant={kind:'run' as const,runId:'r',projectId:'project',credentialId:null,name:null,allowedOperations:['catalog/plugins:list']};
      const request={get:(name:string)=>name.toLowerCase()==='authorization' ? `Bearer ${token.token}` : undefined} as never;
      let entered!:()=>void, resume!:()=>void; const reached=new Promise<void>(r=>entered=r), pause=new Promise<void>(r=>resume=r);
      registerPluginCatalogMcpTool(registry,{tokenRegistry:tokens,projectExists:()=>true,
        getRun:()=>({id:'r',projectId:'project',status:'running',workspaceScope:{projectId:'project',source:'persisted_project_binding',workspaceId:'w',workspaceMemberId:'m'}}) as never,
        getProjectWorkspaceId:()=> 'w',decideProjectRequest:()=>({ok:true}) as never,
        listPluginSnapshot:async()=>{const result=await f.read(); if(result.status!=='observed') throw new Error('fixture'); entered(); await pause; return {entries:[result.record],revalidate:()=>true};}});
      const pending=registry.call('list_plugins',{},grant,undefined,request); await reached;
      tokens.revokeToken(token.token); resume(); const result=await pending;
      expect(result.structuredContent).toMatchObject({ok:false,error:{code:'PROJECT_SCOPE_DENIED'}});
      expect(JSON.stringify(result)).not.toContain('fixture');
    } finally {tokens.clear();f.db.close();}
  });
});

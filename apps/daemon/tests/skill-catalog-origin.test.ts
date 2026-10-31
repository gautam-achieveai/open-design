import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesignSystemServerServices } from '../src/design-systems/server-services.js';
import { materializeWorkspaceScopedTeamResource } from '../src/collab/team-resource-materialization.js';
import { workspaceTeamSkillBindingResourceId } from '../src/skills/workspace-team-binding.js';
import { listSkills, skillCatalogBindingFence, skillCatalogBindingStillVisible } from '../src/skills.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('od-skill-origin-')) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('skill catalog private origin revalidation', () => {
  it('rechecks exact Team marker identity and ordinary bindings with real SQLite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-skill-origin-')); roots.push(root);
    const userRoot = path.join(root, 'user'); await fs.mkdir(userRoot);
    const workspace = 'workspace-1', logical = 'user:design';
    const materialized = await materializeWorkspaceScopedTeamResource({ kindRoot: userRoot, storageName: 'design',
      identity: { kind: 'skill', workspaceId: workspace, resourceId: logical, hubResourceId: 'synthetic-hub-id' },
      pullInto: (dir) => fs.writeFile(path.join(dir, 'SKILL.md'), 'synthetic'), verifyWorkspaceScope: async () => true, verifyStillShared: async () => true });
    expect(materialized.status).toBe('committed'); if (materialized.status !== 'committed') throw new Error('fixture');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE workspace_resources (resource_type TEXT,resource_id TEXT,workspace_id TEXT,visibility TEXT,resource_state TEXT,created_by_workspace_member_id TEXT,updated_by_workspace_member_id TEXT,resource_hub_resource_id TEXT,cloud_tombstoned_at INTEGER,sync_state TEXT,version INTEGER,created_at INTEGER,updated_at INTEGER)`);
    const insert = db.prepare(`INSERT INTO workspace_resources (resource_type,resource_id,workspace_id,visibility,resource_state,created_by_workspace_member_id) VALUES ('skill',?,?,?,?,'alice')`);
    const teamKey = workspaceTeamSkillBindingResourceId(workspace, logical);
    insert.run(teamKey, workspace, 'team', 'active'); insert.run('personal', workspace, 'personal', 'active');
    await fs.mkdir(path.join(userRoot, 'personal'));
    await fs.writeFile(path.join(userRoot, 'personal', 'SKILL.md'), '---\nname: personal\ndescription: Synthetic\n---\n\nBody');
    const realWitnesses = new Map<string, string>();
    await listSkills([userRoot], { db, workspaceId: workspace, workspaceMemberId: 'alice', onBindingSnapshot: (id, fence) => realWitnesses.set(id, fence) });
    expect(realWitnesses.get('personal')).toBe(skillCatalogBindingFence(db, 'personal'));
    const team = [{ id: logical, dir: materialized.targetDir, source: 'user', body: '' },
      { id: `${logical}:example`, dir: materialized.targetDir, source: 'user', body: '' }];
    const ordinary = [{ id: logical, dir: 'builtin', source: 'built-in', body: '' },
      { id: 'personal', dir: 'personal', source: 'user', body: '' },
      { id: 'personal:example', dir: 'personal', source: 'user', body: '' }];
    let mutateTeamDuringRead = false, mutatePersonalDuringRead = false;
    const services = createDesignSystemServerServices({ getDb: () => db, roots: { SKILL_ROOTS: [userRoot], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
      paths: { PROJECTS_DIR: root, DESIGN_SYSTEMS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root },
      skills: { listSkills: async (paths, options) => {
        if (paths[0] === userRoot) {
          for (const entry of ordinary) options?.onBindingSnapshot?.(entry.id, skillCatalogBindingFence(db, entry.id));
          if (mutatePersonalDuringRead) queueMicrotask(() => db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id='changed' WHERE resource_id='personal'`).run());
          return ordinary;
        }
        if (mutateTeamDuringRead) queueMicrotask(() => db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id='changed' WHERE resource_id=?`).run(teamKey));
        return team;
      }, findSkillById: () => undefined },
      designSystems: {} as never, projects: {} as never });
    try {
      const snap = await services.listAllSkillsSnapshot({ workspaceId: workspace, workspaceMemberId: 'alice' });
      expect(snap.entries.map(x => x.id)).toEqual([logical, `${logical}:example`, 'personal', 'personal:example']);
      expect(snap.entries[0]).toMatchObject({ source: 'user', teamSynced: true });
      expect(snap.revalidate(snap.entries.map(x => x.id))).toBe(true);
      mutateTeamDuringRead = true;
      const duringTeamRead = await services.listAllSkillsSnapshot({ workspaceId: workspace, workspaceMemberId: 'alice' });
      expect(duringTeamRead.revalidate([logical, `${logical}:example`])).toBe(false);
      mutateTeamDuringRead = false;
      db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id=NULL WHERE resource_id=?`).run(teamKey);
      mutatePersonalDuringRead = true;
      const duringPersonalRead = await services.listAllSkillsSnapshot({ workspaceId: workspace, workspaceMemberId: 'alice' });
      expect(duringPersonalRead.revalidate(['personal', 'personal:example'])).toBe(false);
      mutatePersonalDuringRead = false;
      db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id=NULL WHERE resource_id='personal'`).run();
      db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id='replacement' WHERE resource_id=?`).run(teamKey);
      expect(snap.revalidate([logical])).toBe(false); expect(snap.revalidate([`${logical}:example`])).toBe(false);
      db.prepare(`UPDATE workspace_resources SET resource_hub_resource_id=NULL WHERE resource_id=?`).run(teamKey);
      db.prepare(`UPDATE workspace_resources SET resource_state='deleted' WHERE resource_id=?`).run(teamKey);
      expect(snap.revalidate([logical])).toBe(false); expect(snap.revalidate([`${logical}:example`])).toBe(false);
      expect(snap.revalidate(['personal'])).toBe(false);
      const freshPersonal = await services.listAllSkillsSnapshot({ workspaceId: workspace, workspaceMemberId: 'alice' });
      expect(freshPersonal.revalidate(['personal', 'personal:example'])).toBe(true);
      db.prepare(`UPDATE workspace_resources SET workspace_id='other' WHERE resource_id='personal'`).run();
      expect(snap.revalidate(['personal'])).toBe(false); expect(snap.revalidate(['personal:example'])).toBe(false);
      db.prepare(`UPDATE workspace_resources SET workspace_id=?, visibility='team' WHERE resource_id='personal'`).run(workspace);
      expect(skillCatalogBindingStillVisible(db, { id: 'personal:example', source: 'user', teamSynced: true }, workspace, 'alice')).toBe(true);
      db.prepare(`UPDATE workspace_resources SET visibility='personal' WHERE resource_id='personal'`).run();
      expect(skillCatalogBindingStillVisible(db, { id: 'personal:example', source: 'user', teamSynced: true }, workspace, 'alice')).toBe(false);
      const after = await services.listAllSkillsSnapshot({ workspaceId: workspace, workspaceMemberId: 'alice' });
      expect(after.entries.find(x => x.id === logical)?.source).toBe('built-in');
    } finally { db.close(); }
  });
});

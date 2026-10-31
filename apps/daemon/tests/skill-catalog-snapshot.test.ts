import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createDesignSystemServerServices } from '../src/design-systems/server-services.js';
import { materializeWorkspaceScopedTeamResource } from '../src/collab/team-resource-materialization.js';
import { workspaceTeamSkillBindingResourceId } from '../src/skills/workspace-team-binding.js';
import { listSkills, findSkillById, type SkillInfo } from '../src/skills.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { registerSkillCatalogMcpTool } from '../src/mcp-http/skill-catalog-tools.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const owned: Array<{ root: string; db: Database.Database }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const { root, db } of owned.splice(0)) {
    if (db.open) db.close();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
      || !path.basename(root).startsWith('od-skill-snapshot-')) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-skill-snapshot-'));
  const db = new Database(':memory:');
  owned.push({ root, db });
  db.exec(`CREATE TABLE workspace_resources (
    resource_type TEXT,resource_id TEXT,workspace_id TEXT,visibility TEXT,resource_state TEXT,
    created_by_workspace_member_id TEXT,updated_by_workspace_member_id TEXT,resource_hub_resource_id TEXT,
    cloud_tombstoned_at INTEGER,sync_state TEXT,version INTEGER,created_at INTEGER,updated_at INTEGER,
    PRIMARY KEY(resource_type,resource_id));
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT)`);
  const userRoot = path.join(root, 'user'), builtInRoot = path.join(root, 'built-in');
  await fs.mkdir(userRoot); await fs.mkdir(builtInRoot);
  const config: Omit<Parameters<typeof createDesignSystemServerServices>[0], 'getDb'> = {
    roots: { SKILL_ROOTS: [userRoot, builtInRoot], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
    paths: { PROJECTS_DIR: root, DESIGN_SYSTEMS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root },
    skills: { listSkills: async (roots, options) => (await listSkills(roots, options)).map(entry => ({ ...entry })),
      findSkillById: (entries, id) => { const entry = findSkillById(entries, id); return entry ? { ...entry } : undefined; } },
    designSystems: {} as never, projects: {} as never };
  const services = createDesignSystemServerServices({ ...config, getDb: () => db });
  const scope = { workspaceId: 'w1', workspaceMemberId: 'alice' };
  const bind = (id: string, workspace = 'w1', member = 'alice', visibility = 'personal', state = 'active', type = 'skill') => {
    db.prepare(`INSERT INTO workspace_resources VALUES (?,?,?,?,?,?,?,'old-hub',NULL,'synced',1,1,1)`)
      .run(type, id, workspace, visibility, state, member, member);
  };
  const write = async (id: string, builtIn = false) => {
    const dir = path.join(builtIn ? builtInRoot : userRoot, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(id)}\ndescription: Old synthetic description\n---\nOld synthetic body`);
    return dir;
  };
  const team = async (id: string, workspace = 'w1', state = 'active') => {
    bind(workspaceTeamSkillBindingResourceId(workspace, id), workspace, 'bob', 'team', state);
    const result = await materializeWorkspaceScopedTeamResource({ kindRoot: userRoot, storageName: id.replace(/^user:/, '').replace(/[^a-z0-9-]/g, '-'),
      identity: { kind: 'skill', workspaceId: workspace, resourceId: id, hubResourceId: 'old-hub' },
      pullInto: (dir) => fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(id)}\ndescription: Old synthetic description\n---\nTeam body`),
      verifyWorkspaceScope: async () => true, verifyStillShared: async () => true });
    if (result.status !== 'committed') throw new Error('fixture materialization failed');
    return result.targetDir;
  };
  return { root, db, services, scope, bind, write, team, withoutDb: () => createDesignSystemServerServices(config) };
}

// Hold actual bytes before the real parser receives them. No fake listSkills.
function holdSkillRead(file: string) {
  const read = fs.readFile;
  let obtained!: () => void, release!: () => void, used = false;
  const reached = new Promise<void>(resolve => { obtained = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const raw = await read(...args);
    if (!used && String(args[0]) === file) {
      used = true;
      expect(String(raw)).toContain('Old synthetic description');
      obtained();
      await held;
    }
    return raw;
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  return { reached, release, restore: () => { release(); spy.mockRestore(); syncBuiltinESMExports(); } };
}

describe('skill catalog pre-discovery binding inventory', () => {
  it.each(['personal', 'team'])('denies %s binding changes after real old bytes were read', async (kind) => {
    const f = await fixture();
    const dir = kind === 'team' ? await f.team('user:team') : await f.write('personal');
    const id = kind === 'team' ? 'user:team' : 'personal';
    if (kind === 'personal') f.bind(id);
    const control = await f.services.listAllSkillsSnapshot(f.scope);
    expect(control.revalidate([id])).toBe(true);
    const barrier = holdSkillRead(path.join(dir, 'SKILL.md'));
    try {
      const pending = f.services.listAllSkillsSnapshot(f.scope);
      await barrier.reached;
      f.db.prepare("UPDATE workspace_resources SET resource_hub_resource_id='replacement' WHERE resource_type='skill'").run();
      barrier.release();
      const changed = await pending;
      expect(changed.entries.find(entry => entry.id === id)?.description).toBe('Old synthetic description');
      expect(changed.revalidate([id])).toBe(false);
      expect(changed.revalidate([])).toBe(false);
      const fresh = await f.services.listAllSkillsSnapshot(f.scope);
      expect(fresh.revalidate([id])).toBe(true);
    } finally { barrier.restore(); }
  });

  const changes = [
    ['resource_type', "'plugin'"], ['resource_id', "'changed'"], ['workspace_id', "'other'"],
    ['visibility', "'team'"], ['resource_state', "'deleted'"], ['created_by_workspace_member_id', "'bob'"],
    ['updated_by_workspace_member_id', "'bob'"], ['resource_hub_resource_id', "'replacement'"],
    ['cloud_tombstoned_at', '2'], ['sync_state', "'changed'"], ['version', '2'], ['created_at', '2'], ['updated_at', '2'],
  ];
  it.each(changes)('captures full stored column %s, including an empty page', async (column, value) => {
    const f = await fixture(); f.bind('unrelated');
    const snapshot = await f.services.listAllSkillsSnapshot(f.scope);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.revalidate([])).toBe(true);
    f.db.exec(`UPDATE workspace_resources SET ${column}=${value}`);
    expect(snapshot.revalidate([])).toBe(false);
    expect((await f.services.listAllSkillsSnapshot(f.scope)).revalidate([])).toBe(true);
  });

  it.each([
    { change: 'insert', kind: 'ordinary' }, { change: 'delete', kind: 'ordinary' },
    { change: 'insert', kind: 'Team' }, { change: 'delete', kind: 'Team' },
  ])('detects $kind skill row $change during real discovery', async ({ change, kind }) => {
    const f = await fixture(); await f.write('personal'); f.bind('personal');
    const id = kind === 'Team' ? workspaceTeamSkillBindingResourceId('w1', 'unrelated') : 'unrelated';
    const add = () => f.bind(id, 'w1', 'alice', kind === 'Team' ? 'team' : 'personal');
    if (change === 'delete') add();
    const pending = f.services.listAllSkillsSnapshot(f.scope);
    if (change === 'insert') add();
    else f.db.prepare('DELETE FROM workspace_resources WHERE resource_id=?').run(id);
    const snapshot = await pending;
    expect(snapshot.revalidate(['personal'])).toBe(false);
    expect(snapshot.revalidate([])).toBe(false);
    expect((await f.services.listAllSkillsSnapshot(f.scope)).revalidate(['personal'])).toBe(true);
  });

  it('ignores row insertion order and unrelated project, run and resource writes', async () => {
    const f = await fixture(); await f.write('personal'); f.bind('personal'); f.bind('Z'); f.bind('a');
    const snapshot = await f.services.listAllSkillsSnapshot(f.scope);
    f.db.exec("DELETE FROM workspace_resources WHERE resource_id IN ('Z','a')");
    f.bind('a'); f.bind('Z');
    f.bind('other-plugin', 'w1', 'alice', 'personal', 'active', 'plugin');
    f.db.exec("UPDATE workspace_resources SET resource_hub_resource_id='other' WHERE resource_type='plugin'; INSERT INTO projects VALUES ('p','Changed'); INSERT INTO runs VALUES ('r','running')");
    expect(snapshot.revalidate(['personal'])).toBe(true);
    expect(snapshot.revalidate([])).toBe(true);
    f.db.exec("UPDATE workspace_resources SET resource_hub_resource_id='other' WHERE resource_id='a'");
    expect(snapshot.revalidate(['personal'])).toBe(false);
    expect((await f.services.listAllSkillsSnapshot(f.scope)).revalidate(['personal'])).toBe(true);
  });

  it('compares exact SQLite integers and fails closed on DB errors', async () => {
    const f = await fixture(); f.bind('large-version');
    f.db.exec('UPDATE workspace_resources SET version=9007199254740992');
    const snapshot = await f.services.listAllSkillsSnapshot(f.scope);
    f.db.exec('UPDATE workspace_resources SET version=9007199254740993');
    expect(snapshot.revalidate([])).toBe(false);
    const fresh = await f.services.listAllSkillsSnapshot(f.scope);
    f.db.close();
    expect(fresh.revalidate([])).toBe(false);
    await expect(f.services.listAllSkillsSnapshot(f.scope)).rejects.toThrow();
    expect((await f.withoutDb().listAllSkillsSnapshot(f.scope)).revalidate([])).toBe(false);
  });

  it('preserves real built-in, creator, Team, derived and explicit-null visibility', async () => {
    const f = await fixture();
    const personal = await f.write('personal'); f.bind('personal');
    await fs.mkdir(path.join(personal, 'examples'));
    await fs.writeFile(path.join(personal, 'examples/card.html'), '<html>Synthetic</html>');
    await f.write('private'); f.bind('private', 'w1', 'bob');
    await f.write('private', true); await f.write('bundled', true); await f.write('unbound');
    await f.team('user:team'); await f.team('foreign', 'w2'); await f.team('tombstone', 'w1', 'deleted');
    const snapshot = await f.services.listAllSkillsSnapshot(f.scope);
    const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    expect([...entries.keys()].sort()).toEqual(['bundled', 'personal', 'personal:card', 'private', 'user:team']);
    expect(entries.get('private')?.source).toBe('built-in');
    expect(entries.get('user:team')?.teamSynced).toBe(true);
    expect(snapshot.revalidate([...entries.keys()])).toBe(true);
    const other = await f.services.listAllSkillsSnapshot({ workspaceId: 'w1', workspaceMemberId: 'bob' });
    expect(other.entries.find(entry => entry.id === 'private')?.source).toBe('user');
    expect(other.entries.some(entry => entry.id.startsWith('personal'))).toBe(false);
    const signedOut = await f.services.listAllSkillsSnapshot({ workspaceId: null, workspaceMemberId: null });
    expect(signedOut.entries.map(entry => entry.id).sort()).toEqual(['bundled', 'private', 'unbound']);
    expect(signedOut.revalidate(signedOut.entries.map(entry => entry.id))).toBe(true);
    const legacy = await f.services.listAllSkillsSnapshot();
    expect(legacy.entries.some(entry => entry.id === 'personal')).toBe(true);
    expect(legacy.entries.find(entry => entry.id === 'private')?.source).toBe('user');
    expect(legacy.revalidate([])).toBe(false);
  });

  it.each(['skill binding', 'bearer', 'project binding'])('MCP withholds real parsed data after a changed %s', async (change) => {
    const f = await fixture(); const dir = await f.write('personal'); f.bind('personal');
    const tokens = new ToolTokenRegistry(), registry = new McpToolRegistry();
    const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/skills:list'] });
    const grant = { kind: 'run' as const, runId: 'r', projectId: 'p', credentialId: null, name: null, allowedOperations: ['catalog/skills:list'] };
    const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false,
      workspaceScope: { projectId: 'p', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' } };
    let projectWorkspace = 'w1';
    registerSkillCatalogMcpTool(registry, { tokenRegistry: tokens, projectExists: () => true,
      getRun: () => run as never, getProjectWorkspaceId: () => projectWorkspace,
      decideProjectRequest: request => ({ ok: request.get('x-od-workspace-id') === 'w1' && request.get('x-od-workspace-member-id') === 'alice' }) as never,
      listSkillsSnapshot: async scope => {
        const snapshot = await f.services.listAllSkillsSnapshot(scope);
        return { ...snapshot, entries: snapshot.entries as unknown as SkillInfo[] };
      } });
    const request = { get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${token.token}` : undefined } as never;
    const call = () => registry.call('list_skills', {}, grant, undefined, request);
    const barrier = holdSkillRead(path.join(dir, 'SKILL.md'));
    try {
      const pending = call(); await barrier.reached;
      if (change === 'skill binding') f.db.exec("UPDATE workspace_resources SET resource_hub_resource_id='changed'");
      else if (change === 'bearer') tokens.revokeToken(token.token);
      else projectWorkspace = 'w2';
      barrier.release();
      const denied = await pending;
      expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(JSON.stringify(denied)).not.toContain('Old synthetic');
      expect(denied.structuredContent).not.toHaveProperty('data');
      if (change === 'skill binding') {
        const fresh = await call();
        expect(fresh.structuredContent).toMatchObject({ ok: true, data: { skills: [{ id: 'personal', hasBody: true }] } });
        expect(JSON.stringify(fresh)).not.toContain('"body"');
        expect(JSON.stringify(fresh)).not.toContain('"dir"');
      }
    } finally { barrier.restore(); tokens.clear(); }
  });
});

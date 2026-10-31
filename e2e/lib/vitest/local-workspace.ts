import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { requestJson } from './http.ts';

export function localWorkspaceHeaders(workspaceId = 'local-personal', type = 'personal'): Record<string, string> {
  return {
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-member-id': `${workspaceId}-owner`,
    'x-od-workspace-type': type,
    'x-od-workspace-role': 'owner',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
  };
}

export async function createLocalProject(webUrl: string, name: string, headers?: Record<string, string>) {
  return requestJson<{ project: { id: string; name: string }; conversationId: string }>(webUrl, '/api/projects', {
    method: 'POST', ...(headers ? { headers } : {}),
    body: { id: randomUUID(), name, metadata: { kind: 'prototype' }, designSystemId: null, skillId: null, pendingPrompt: null },
  });
}

type FixtureDatabase = {
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
  close(): void;
};
// Use the daemon's installed SQLite driver to seed only this suite's isolated
// data root. No removed Cloud endpoint is used to manufacture legacy state.
const requireDaemon = createRequire(new URL('../../../apps/daemon/package.json', import.meta.url));
function withDatabase<T>(dataDir: string, action: (db: FixtureDatabase) => T): T {
  const Database = requireDaemon('better-sqlite3') as new (path: string) => FixtureDatabase;
  const db = new Database(join(dataDir, 'app.sqlite'));
  try { return action(db); } finally { db.close(); }
}

export function seedLegacyTeamProject(dataDir: string, projectId: string, workspaceId = 'legacy-team') {
  withDatabase(dataDir, db => db.prepare(`INSERT OR REPLACE INTO workspace_projects
    (project_id, workspace_id, visibility, resource_state, created_by_workspace_member_id, created_at, updated_at)
    VALUES (?, ?, 'team', 'active', 'legacy-owner', 1, 1)`).run(projectId, workspaceId));
  return readProjectSnapshot(dataDir, projectId);
}

export function readProjectSnapshot(dataDir: string, projectId: string) {
  return withDatabase(dataDir, db => ({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId),
    binding: db.prepare('SELECT * FROM workspace_projects WHERE project_id = ?').get(projectId),
  }));
}

export function seedLegacyTeamResource(dataDir: string, type: string, id: string) {
  withDatabase(dataDir, db => db.prepare(`INSERT OR REPLACE INTO workspace_resources
    (resource_type, resource_id, workspace_id, visibility, resource_state, created_at, updated_at)
    VALUES (?, ?, 'legacy-resource-team', 'team', 'active', 1, 1)`).run(type, id));
  return readResourceBinding(dataDir, type, id);
}

export function readResourceBinding(dataDir: string, type: string, id: string) {
  return withDatabase(dataDir, db => db.prepare(
    'SELECT * FROM workspace_resources WHERE resource_type = ? AND resource_id = ?',
  ).get(type, id));
}

export function readInstalledPlugin(dataDir: string, id: string) {
  return withDatabase(dataDir, db => db.prepare(
    'SELECT * FROM installed_plugins WHERE id = ?',
  ).get(id)) as { fs_path: string } & Record<string, unknown>;
}

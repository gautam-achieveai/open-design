import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { expect, it } from 'vitest';
import { teamResourceWorkspaceRoot } from '../src/collab/team-resource-materialization.js';
import * as designSystems from '../src/design-systems/index.js';
import { createDesignSystemServerServices } from '../src/design-systems/server-services.js';
import { workspaceTeamDesignSystemBindingResourceId } from '../src/design-systems/workspace-team-binding.js';
import type { ApprovalRun } from '../src/mcp-http/approval-principal.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { createMcpHttpResources } from '../src/mcp-http/resources.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

it('does not substitute another member’s same-id Personal body when the observed Team file disappears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'od-resource-team-isolation-'));
  const db = new Database(':memory:');
  const tokenRegistry = new ToolTokenRegistry();
  try {
    const workspaceId = 'workspace', workspaceMemberId = 'alice', id = 'user:same-id';
    const userRoot = path.join(root, 'user');
    const teamRoot = teamResourceWorkspaceRoot(userRoot, workspaceId);
    db.exec(`CREATE TABLE workspace_resources(resource_type TEXT,resource_id TEXT,workspace_id TEXT,visibility TEXT,resource_state TEXT,
      created_by_workspace_member_id TEXT,updated_by_workspace_member_id TEXT,resource_hub_resource_id TEXT,cloud_tombstoned_at INTEGER,
      sync_state TEXT,version INTEGER,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(resource_type,resource_id))`);
    const insert = db.prepare('INSERT INTO workspace_resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('design_system', id, workspaceId, 'personal', 'active', 'bob', 'bob', null, null, 'synced', 1, 1, 1);
    insert.run('design_system', workspaceTeamDesignSystemBindingResourceId(workspaceId, id), workspaceId, 'team', 'active', 'bob', 'bob', null, null, 'synced', 1, 1, 1);
    for (const [directory, body] of [[userRoot, '# Personal\n\nPRIVATE_PERSONAL_BOB'], [teamRoot, '# Team\n\nPUBLIC_TEAM_COPY']] as const) {
      await mkdir(path.join(directory, 'same-id'), { recursive: true });
      await writeFile(path.join(directory, 'same-id', 'metadata.json'), JSON.stringify({ title: 'Same id', workspaceId }));
      await writeFile(path.join(directory, 'same-id', 'DESIGN.md'), body);
    }
    const services = createDesignSystemServerServices({ getDb: () => db,
      roots: { SKILL_ROOTS: [], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
      paths: { PROJECTS_DIR: root, DESIGN_SYSTEMS_DIR: path.join(root, 'builtin'), USER_DESIGN_SYSTEMS_DIR: userRoot },
      skills: { listSkills: async () => [], findSkillById: () => undefined },
      designSystems: { ...designSystems,
        LEGACY_DESIGN_SYSTEM_ARTIFACTS: designSystems.LEGACY_DESIGN_SYSTEM_ARTIFACTS.map(item =>
          ({ ...item, replacementPaths: [...item.replacementPaths] })),
        listDesignSystems: (directory, options) =>
        designSystems.listDesignSystems(directory, options as Parameters<typeof designSystems.listDesignSystems>[1]) },
      projects: {} as never });
    const run: ApprovalRun = { id: 'run', projectId: 'project', status: 'running', workspaceScope: {
      schemaVersion: 1, projectId: 'project', source: 'persisted_project_binding', workspaceId, workspaceMemberId,
    } };
    const minted = tokenRegistry.mint({ runId: run.id, projectId: 'project', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/design-systems:read'] });
    const request = { headers: {}, get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${minted.token}` : undefined } as Request;
    let snapshot: Awaited<ReturnType<typeof services.listAllDesignSystemsSnapshot>> | undefined;
    const resources = createMcpHttpResources(new McpToolRegistry(), { tokenRegistry,
      getRun: () => run, projectExists: () => true, getProjectWorkspaceId: () => workspaceId, decideProjectRequest: () => ({ ok: true }),
      listSkillsSnapshot: async () => ({ entries: [], revalidate: () => true }),
      listDesignSystemsSnapshot: async scope => {
        snapshot = await services.listAllDesignSystemsSnapshot(scope);
        // Model a file disappearing after discovery without any binding-row change.
        await unlink(path.join(teamRoot, 'same-id', 'DESIGN.md'));
        return snapshot;
      },
      readDesignSystem: async (designId, scope, exactTeam) =>
        (await services.readAvailableDesignSystem(designId, { ...scope, exactTeam })) ?? null,
    });
    await expect(resources.read('od://design-systems/user%3Asame-id/DESIGN.md', {
      grant: { kind: 'run', runId: run.id, projectId: 'project', credentialId: null, name: null, allowedOperations: ['catalog/design-systems:read'] },
      request, signal: undefined,
    })).rejects.toThrow('Resource unavailable for this credential');
    expect(snapshot?.entries).toEqual([expect.objectContaining({ id, teamSynced: true })]);
    expect(snapshot?.revalidate([id])).toBe(true);
  } finally {
    tokenRegistry.clear(); db.close();
    await rm(root, { recursive: true, force: true });
  }
});

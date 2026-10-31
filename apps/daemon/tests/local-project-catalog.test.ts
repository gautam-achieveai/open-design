import { afterAll, expect, it } from 'vitest';
import * as dbApi from '../src/db.js';
import { closeProjectRunFixturePool, createProjectRunCommandFixture } from './fixtures/project-run-command-fixture.js';

afterAll(closeProjectRunFixturePool);

it('discovers readable Personal projects locally without broadening external unbound discovery', async () => {
  const fixture = await createProjectRunCommandFixture({ localCatalog: true });
  try {
    for (const id of ['local', 'personal', 'team', 'deleted', 'revoked', 'removed-location']) {
      dbApi.insertProject(fixture.db, {
        id, name: id, createdAt: 1, updatedAt: 1,
        metadata: {
          ...(id === 'revoked' ? { teamMirrorRevokedAt: 1 } : {}),
          ...(id === 'removed-location' ? { projectLocationId: 'removed' } : {}),
        },
      });
    }
    for (const id of ['personal', 'team', 'deleted']) {
      dbApi.ensureWorkspaceProject(fixture.db, {
        projectId: id, workspaceId: `${id}-workspace`,
        visibility: id === 'team' ? 'team' : 'personal',
        resourceState: id === 'deleted' ? 'deleted' : 'active',
        createdByWorkspaceMemberId: 'owner',
      });
    }
    const bindings = fixture.db.prepare('SELECT * FROM workspace_projects ORDER BY project_id').all();
    const response = await fetch(`${fixture.base}/api/projects`);
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const body = JSON.parse(responseText) as { projects: Array<{ id: string; workspaceId: string | null }> };
    expect(body.projects.map(project => project.id).sort()).toEqual(['local', 'personal']);
    expect(body.projects.find(project => project.id === 'personal')?.workspaceId).toBe('personal-workspace');
    expect(body.projects.find(project => project.id === 'local')?.workspaceId).toBeNull();

    const external = await fixture.project.readUnboundProjectCatalog();
    expect(external.entries.every(project => project.workspaceId === null)).toBe(true);
    expect(external.entries.map(project => project.id)).not.toContain('personal');
    expect(external.entries.map(project => project.id)).not.toContain('team');
    expect(external.entries.map(project => project.id)).not.toContain('removed-location');
    expect(await fixture.project.readUnboundProjectDetail('personal')).toBeNull();
    expect(external.revalidate(external.entries.map((_, index) => index))).toBe(true);
    expect(fixture.db.prepare('SELECT * FROM workspace_projects ORDER BY project_id').all()).toEqual(bindings);
  } finally {
    await fixture.close();
  }
});

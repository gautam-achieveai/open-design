// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { createLocalProject, localWorkspaceHeaders, readProjectSnapshot, seedLegacyTeamProject } from '@/vitest/local-workspace';

test('[P0] retired Team catalog and materialization cannot replace local stored data', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('retired-team-catalog');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const legacy = await createLocalProject(webUrl, 'Legacy catalog project');
    const before = seedLegacyTeamProject(suite.dataDir, legacy.project.id);
    for (const path of ['/api/workspace/projects/team', '/api/workspaces/legacy-team/projects?view=all']) {
      const response = await fetch(new URL(path, webUrl));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    }
    const statusUrl = new URL(`/api/projects/${legacy.project.id}/collab/status`, webUrl);
    const unscoped = await fetch(statusUrl);
    expect(unscoped.status).toBe(400);
    expect(await unscoped.json()).toMatchObject({ error: 'WORKSPACE_CONTEXT_REQUIRED' });
    const scoped = await fetch(statusUrl, { headers: localWorkspaceHeaders('legacy-team') });
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toMatchObject({ error: 'WORKSPACE_UNAVAILABLE',
      message: 'Team resources are unavailable because Cloud support has been removed. Stored data has been preserved.' });
    expect(readProjectSnapshot(suite.dataDir, legacy.project.id)).toEqual(before);
  });
});

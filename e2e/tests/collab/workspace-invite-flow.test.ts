// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject, localWorkspaceHeaders } from '@/vitest/local-workspace';

test('[P0] stale invitations cannot bind or move a local project', { timeout: 240_000 }, async () => {
  const suite = await createSmokeSuite('retired-invitation');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const project = await createLocalProject(webUrl, 'Invitation-safe local project');
    for (const path of ['/api/workspace/invite', '/api/workspace/invite/continue']) {
      const response = await fetch(new URL(path, webUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', ...localWorkspaceHeaders('old-team', 'team') },
        body: JSON.stringify({ projectId: project.project.id, continuation: 'stale-invite', workspaceId: 'old-team' }),
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    }
    const scope = await requestJson<{ scope: { kind: string; workspaceId: string | null } }>(
      webUrl, `/api/projects/${project.project.id}/workspace-scope`);
    expect(scope.scope).toMatchObject({ kind: 'unbound', workspaceId: null });
  });
});

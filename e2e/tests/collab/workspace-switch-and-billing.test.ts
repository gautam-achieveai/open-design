// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject, localWorkspaceHeaders, readProjectSnapshot } from '@/vitest/local-workspace';

test('[P0] a disabled Team switch cannot replace explicit Personal project attribution', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('retired-team-switch');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const headers = localWorkspaceHeaders();
    const project = await createLocalProject(webUrl, 'Personal home', headers);
    const before = readProjectSnapshot(suite.dataDir, project.project.id);
    const response = await fetch(new URL('/api/workspace/active', webUrl), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'retired-team', workspaceMemberId: 'old-member' }),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    expect(readProjectSnapshot(suite.dataDir, project.project.id)).toEqual(before);
    const scope = await requestJson<{ scope: { kind: string; workspaceId: string } }>(
      webUrl, `/api/projects/${project.project.id}/workspace-scope`, { headers });
    expect(scope.scope).toMatchObject({ kind: 'personal', workspaceId: 'local-personal' });
  });
});

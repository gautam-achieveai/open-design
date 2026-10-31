// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject, localWorkspaceHeaders, readProjectSnapshot, seedLegacyTeamProject } from '@/vitest/local-workspace';

test('[P0] restart preserves Personal project homes and keeps legacy Team data unavailable', { timeout: 360_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'od-workspace-restart-'));
  const dataDir = join(root, 'data');
  let personalId = '';
  let teamId = '';
  let legacySnapshot: ReturnType<typeof readProjectSnapshot>;
  let passed = false;
  const headers = localWorkspaceHeaders();
  const assertHomes = async (webUrl: string) => {
    const listed = await requestJson<{ projects: Array<{ id: string }> }>(webUrl, '/api/projects');
    expect(listed.projects.map(project => project.id)).toContain(personalId);
    expect(listed.projects.map(project => project.id)).not.toContain(teamId);
    const scope = await requestJson<{ scope: { kind: string; workspaceId: string } }>(
      webUrl, `/api/projects/${personalId}/workspace-scope`, { headers });
    expect(scope.scope).toMatchObject({ kind: 'personal', workspaceId: 'local-personal' });
    const team = await fetch(new URL(`/api/projects/${teamId}`, webUrl));
    expect(team.status).toBe(403);
    expect(await team.json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    expect(readProjectSnapshot(dataDir, teamId)).toEqual(legacySnapshot);
  };
  try {
    const first = await createSmokeSuite('local-home-first', { dataDir });
    await first.with.toolsDev(async ({ webUrl }) => {
      personalId = (await createLocalProject(webUrl, 'Personal survives restart', headers)).project.id;
      teamId = (await createLocalProject(webUrl, 'Preserved legacy Team')).project.id;
      legacySnapshot = seedLegacyTeamProject(dataDir, teamId);
      await assertHomes(webUrl);
    });
    const restarted = await createSmokeSuite('local-home-restarted', { dataDir });
    await restarted.with.toolsDev(({ webUrl }) => assertHomes(webUrl));
    passed = true;
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error('Restart fixture retained:', root);
  }
});

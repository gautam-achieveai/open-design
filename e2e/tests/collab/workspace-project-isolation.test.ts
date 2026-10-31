// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject, localWorkspaceHeaders, readProjectSnapshot, seedLegacyTeamProject } from '@/vitest/local-workspace';

test('[P0] legacy Team data stays hidden and unchanged under spoofed local authority', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('legacy-team-isolation');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const personal = await createLocalProject(webUrl, 'Available Personal', localWorkspaceHeaders());
    const legacy = await createLocalProject(webUrl, 'Preserved Team');
    const before = seedLegacyTeamProject(suite.dataDir, legacy.project.id);
    for (const headers of [{}, localWorkspaceHeaders('legacy-team'), localWorkspaceHeaders('legacy-team', 'team'), localWorkspaceHeaders()]) {
      const list = await requestJson<{ projects: Array<{ id: string }> }>(webUrl, '/api/projects');
      expect(list.projects.map(project => project.id)).not.toContain(legacy.project.id);
      for (const [method, suffix, body] of [
        ['GET', '', undefined],
        ['PATCH', '', { name: 'Must not rename' }],
        ['POST', '/duplicate', { name: 'Must not copy' }],
        ['DELETE', '', undefined],
      ] as const) {
        const response = await fetch(new URL(`/api/projects/${legacy.project.id}${suffix}`, webUrl), {
          method, headers: { 'content-type': 'application/json', ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status, `${method} ${suffix}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
      }
    }
    expect(readProjectSnapshot(suite.dataDir, legacy.project.id)).toEqual(before);
    const personalBefore = readProjectSnapshot(suite.dataDir, personal.project.id);
    for (const headers of [localWorkspaceHeaders('different-personal'), {
      ...localWorkspaceHeaders(), 'x-od-workspace-member-id': 'different-member',
    }]) {
      const denied = await fetch(new URL(`/api/projects/${personal.project.id}`, webUrl), {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Foreign overwrite' }),
      });
      expect(denied.status).toBe(403);
      expect(readProjectSnapshot(suite.dataDir, personal.project.id)).toEqual(personalBefore);
    }
    const rename = await requestJson<{ project: { name: string } }>(webUrl, `/api/projects/${personal.project.id}`, {
      method: 'PATCH', headers: localWorkspaceHeaders(), body: { name: 'Personal still works' },
    });
    expect(rename.project.name).toBe('Personal still works');
    const listed = await requestJson<{ projects: Array<{ id: string }> }>(webUrl, '/api/projects');
    expect(listed.projects.map(project => project.id)).toContain(personal.project.id);
  });
});

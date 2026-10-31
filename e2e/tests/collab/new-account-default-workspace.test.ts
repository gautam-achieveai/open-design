// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject } from '@/vitest/local-workspace';

test('[P0] a fresh install creates a usable local project without account provisioning', { timeout: 240_000 }, async () => {
  const suite = await createSmokeSuite('local-default-workspace');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const created = await createLocalProject(webUrl, 'My first local project');
    const scope = await requestJson<{ scope: { kind: string; workspaceId: string | null } }>(
      webUrl, `/api/projects/${created.project.id}/workspace-scope`);
    expect(scope.scope).toMatchObject({ kind: 'unbound', workspaceId: null });
    const listed = await requestJson<{ projects: Array<{ id: string }> }>(webUrl, '/api/projects');
    expect(listed.projects.map(project => project.id)).toContain(created.project.id);
    const readBack = await requestJson<{ project: { name: string } }>(webUrl, `/api/projects/${created.project.id}`);
    expect(readBack.project.name).toBe('My first local project');
    const billing = await fetch(new URL('/api/workspace/billing?scope=account', webUrl));
    expect(billing.status).toBe(410);
    expect(await billing.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
  });
});

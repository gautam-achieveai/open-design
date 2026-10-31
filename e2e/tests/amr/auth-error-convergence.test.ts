// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { createLocalProject } from '@/vitest/local-workspace';
import { listMessages } from '@/vitest/messages';

test('[P0] a retired Cloud run is rejected before creating an assistant turn', { timeout: 180_000 }, async () => {
  const suite = await createSmokeSuite('cloud-admission-no-turn');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const project = await createLocalProject(webUrl, 'Rejected Cloud turn');
    const before = await listMessages(webUrl, project.project.id, project.conversationId);
    const response = await fetch(new URL('/api/runs', webUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'amr', projectId: project.project.id, conversationId: project.conversationId,
        assistantMessageId: 'rejected-assistant', clientRequestId: 'rejected-cloud-request', message: 'Old Cloud request' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE', message: expect.stringContaining('removed') } });
    expect(await listMessages(webUrl, project.project.id, project.conversationId)).toEqual(before);
  });
});

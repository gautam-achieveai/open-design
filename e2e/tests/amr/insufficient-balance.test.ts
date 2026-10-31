// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { createLocalProject } from '@/vitest/local-workspace';

test('[P1] obsolete Cloud selection directs users to local agents rather than recharge', { timeout: 180_000 }, async () => {
  const suite = await createSmokeSuite('cloud-no-recharge');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const project = await createLocalProject(webUrl, 'No recharge path');
    const response = await fetch(new URL('/api/runs', webUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'amr', projectId: project.project.id, conversationId: project.conversationId,
        message: 'Stale paid Cloud model', model: 'deepseek-v4-flash' }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE', message: expect.stringContaining('local agent') } });
    expect(JSON.stringify(body)).not.toMatch(/https?:|AMR_INSUFFICIENT_BALANCE|recharge|checkout/i);
  });
});

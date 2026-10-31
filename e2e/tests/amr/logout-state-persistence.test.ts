// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';

test('[P1] obsolete login and logout requests cannot alter local provider configuration', { timeout: 180_000 }, async () => {
  const suite = await createSmokeSuite('retired-login-local-config');
  await suite.with.toolsDev(async ({ webUrl }) => {
    await requestJson(webUrl, '/api/app-config', { method: 'PUT', body: {
      agentId: 'codex', onboardingCompleted: true,
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    } });
    const before = await requestJson(webUrl, '/api/app-config');
    for (const path of ['/api/integrations/vela/login', '/api/integrations/vela/logout']) {
      const response = await fetch(new URL(path, webUrl), { method: 'POST' });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    }
    expect(await requestJson(webUrl, '/api/app-config')).toEqual(before);
  });
});

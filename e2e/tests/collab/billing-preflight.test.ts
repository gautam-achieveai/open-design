// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { localWorkspaceHeaders } from '@/vitest/local-workspace';

test('[P0] retired billing cannot return a wallet, preflight authorization, or checkout link', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('retired-billing');
  await suite.with.toolsDev(async ({ webUrl }) => {
    for (const [method, path] of [
      ['GET', '/api/workspace/billing?scope=account'],
      ['GET', '/api/workspace/billing?scope=workspace&workspaceId=local-personal&model=default'],
      ['GET', '/api/workspace/billing?scope=workspace&workspaceId=foreign'],
      ['POST', '/api/workspace/billing/checkout'],
    ] as const) {
      const response = await fetch(new URL(path!, webUrl), { method, headers: localWorkspaceHeaders() });
      expect(response.status, path).toBe(410);
      const body = await response.json();
      expect(body).toEqual({ error: { code: 'CLOUD_FEATURES_DISABLED', message: expect.stringContaining('Cloud support has been removed') } });
      expect(body).not.toHaveProperty('preflight');
      expect(body).not.toHaveProperty('checkoutUrl');
    }
  });
});

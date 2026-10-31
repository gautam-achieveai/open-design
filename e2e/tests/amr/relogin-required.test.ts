// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';

test('[P1] saved Cloud credentials and feature flags cannot restore the runtime catalog', { timeout: 180_000 }, async () => {
  const suite = await createSmokeSuite('stale-cloud-credentials');
  const home = join(suite.scratchDir, 'old-amr-home');
  await mkdir(home, { recursive: true });
  const file = join(home, 'config.json');
  const saved = JSON.stringify({ profiles: { local: { runtimeKey: 'fixture-only-runtime', controlKey: 'fixture-only-control' } } });
  await writeFile(file, saved);
  await suite.with.toolsDev(async ({ webUrl }) => {
    await requestJson(webUrl, '/api/app-config', { method: 'PUT', body: {
      agentId: 'amr', cloudFeatures: true,
      agentCliEnv: { amr: { AMR_HOME: home, VELA_PROFILE: 'local' } },
    } });
    const catalog = await requestJson<{ agents: Array<{ id: string }> }>(webUrl, '/api/agents');
    expect(catalog.agents.map(agent => agent.id)).not.toContain('amr');
    const status = await fetch(new URL('/api/integrations/vela/status', webUrl));
    expect(status.status).toBe(410);
    expect(await status.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    expect(await readFile(file, 'utf8')).toBe(saved);
  }, { env: { AMR_HOME: home, OPEN_DESIGN_AMR_PROFILE: 'local' } });
});

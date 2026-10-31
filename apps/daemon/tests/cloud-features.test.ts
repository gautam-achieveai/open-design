import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { cloudFeaturesGate, offeredAgents } from '../src/cloud-features.js';

describe('retired OpenDesign Cloud surfaces', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function call(cloudFeatures: boolean | undefined, method: string, route: string) {
    const app = express();
    app.use('/api', cloudFeaturesGate(async () => (cloudFeatures === undefined ? {} : { cloudFeatures })));
    app.use('/api', (_req, res) => { res.json({ reached: true }); });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method });
    return { status: response.status, body: await response.json() as any };
  }

  it.each([
    ['POST', '/api/integrations/vela/login'],
    ['GET', '/api/amr/models'],
    ['POST', '/api/workspace/invite'],
    ['GET', '/api/workspace/billing?scope=account'],
  ])('refuses %s %s after Cloud retirement', async (method, route) => {
    const { status, body } = await call(undefined, method, route);
    expect(status).toBe(410);
    expect(body.error.code).toBe('CLOUD_FEATURES_DISABLED');
  });

  it('does not restore Cloud when old config has the feature enabled', async () => {
    expect((await call(true, 'POST', '/api/integrations/vela/login')).status).toBe(410);
  });

  it.each([
    ['GET', '/api/workspace/context'],
    ['GET', '/api/agents'],
  ])('leaves local routes alone: %s %s', async (method, route) => {
    expect((await call(false, method, route)).body).toEqual({ reached: true });
  });

  it('never offers the retired runtime', () => {
    const agents = [{ id: 'amr' }, { id: 'claude' }];
    expect(offeredAgents(agents, {}).map((agent) => agent.id)).toEqual(['claude']);
    expect(offeredAgents(agents, { cloudFeatures: true }).map((agent) => agent.id)).toEqual(['claude']);
  });
});

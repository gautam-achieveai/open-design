import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCollabContextRoutes } from '../src/routes/collab-context.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

describe('retired Cloud context boundary', () => {
  it.each([
    ['GET', '/api/workspace/context', 200, { context: null }],
    ['GET', '/api/workspace/directory', 200, { items: [] }],
    ['PUT', '/api/workspace/context', 404, null],
    ['PUT', '/api/workspace/active', 404, null],
    ['GET', '/api/workspace/billing', 404, null],
    ['PUT', '/api/workspace/billing/interests/renderer-1', 404, null],
    ['GET', '/api/workspace/billing/catalog', 404, null],
    ['POST', '/api/workspace/billing/checkout', 404, null],
    ['POST', '/api/workspace/invite', 404, null],
    ['POST', '/api/workspace/invite/continue', 404, null],
    ['GET', '/api/workspace/members', 404, null],
  ] as const)('%s %s never uses legacy account authority', async (method, route, status, body) => {
    const calls = { current: vi.fn(async () => null), directory: vi.fn(async () => ({ ok: true as const, items: [] })),
      billing: vi.fn(async () => null), createInvite: vi.fn(), consumeInvite: vi.fn(), switched: vi.fn() };
    const app = express(); app.use(express.json());
    registerCollabContextRoutes(app, { workspaceContext: { current: calls.current }, fetchWorkspaceDirectory: calls.directory,
      fetchBilling: calls.billing, createInvite: calls.createInvite, consumeInvite: calls.consumeInvite, onWorkspaceSwitched: calls.switched });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const response = await fetch('http://127.0.0.1:' + address.port + route, { method,
      headers: { 'content-type': 'application/json', 'x-od-workspace-id': 'legacy-team', 'x-od-workspace-member-id': 'legacy-member', 'x-od-workspace-type': 'team' },
      ...(method === 'GET' ? {} : { body: JSON.stringify({ workspaceId: 'legacy-team', nonce: 'private-nonce', planId: 'team_plus' }) }),
    });
    expect(response.status).toBe(status);
    if (body) expect(await response.json()).toEqual(body);
    for (const callback of Object.values(calls)) expect(callback).not.toHaveBeenCalled();
  });
});

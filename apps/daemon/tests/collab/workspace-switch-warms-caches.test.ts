import express from 'express';
import { expect, it, vi } from 'vitest';
import { registerCollabContextRoutes } from '../../src/routes/collab-context.js';

it('does not register a retired workspace switch or warm caches from legacy identity', async () => {
  const app = express(); app.use(express.json());
  const switched = vi.fn();
  const directory = vi.fn(async () => ({ ok: true as const, items: [] }));
  const current = vi.fn(async () => null);
  registerCollabContextRoutes(app, { workspaceContext: { current }, fetchWorkspaceDirectory: directory, onWorkspaceSwitched: switched });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  try {
    const base = 'http://127.0.0.1:' + address.port;
    const response = await fetch(base + '/api/workspace/active', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'legacy-team', workspaceMemberId: 'member' }) });
    expect(response.status).toBe(404);
    expect(await (await fetch(base + '/api/workspace/directory')).json()).toEqual({ items: [] });
    expect(await (await fetch(base + '/api/workspace/context')).json()).toEqual({ context: null });
    expect(switched).not.toHaveBeenCalled(); expect(directory).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

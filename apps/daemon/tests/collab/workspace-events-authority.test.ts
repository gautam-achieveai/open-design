import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { emitWorkspaceEventToAllScopes, emitWorkspaceEventToScope, registerCollabContextRoutes, type WorkspaceEventSinksByWorkspace } from '../../src/routes/collab-context.js';

describe('retired workspace subscription and retained scoped delivery', () => {
  it('registers no event subscription and does not acquire authority or sinks', () => {
    const app = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const directory = vi.fn(async () => ({ ok: true as const, items: [] }));
    const sinks: WorkspaceEventSinksByWorkspace = new Map();
    const createSseResponse = vi.fn();
    registerCollabContextRoutes(app as unknown as express.Express, { workspaceContext: { current: async () => null }, fetchWorkspaceDirectory: directory, workspaceEventSinks: sinks, createSseResponse });
    expect(app.get.mock.calls.map(call => call[0])).toEqual(['/api/workspace/context', '/api/workspace/directory']);
    expect(directory).not.toHaveBeenCalled(); expect(createSseResponse).not.toHaveBeenCalled(); expect(sinks.size).toBe(0);
  });

  it('retains exact workspace partitioning for already-owned local sinks', () => {
    const a = vi.fn(), b = vi.fn();
    const sinks: WorkspaceEventSinksByWorkspace = new Map([['a', new Set([a])], ['b', new Set([b])]]);
    const event = { type: 'members-changed' as const, at: 1 };
    expect(emitWorkspaceEventToScope(sinks, 'a', event)).toBe(true);
    expect(a).toHaveBeenCalledExactlyOnceWith(event); expect(b).not.toHaveBeenCalled();
    expect(emitWorkspaceEventToScope(sinks, 'foreign', event)).toBe(false);
    const dirty = { type: 'workspace-directory-changed' as const, at: 2 };
    expect(emitWorkspaceEventToAllScopes(sinks, dirty)).toBe(true);
    expect(a).toHaveBeenLastCalledWith(dirty); expect(b).toHaveBeenCalledExactlyOnceWith(dirty);
  });
});

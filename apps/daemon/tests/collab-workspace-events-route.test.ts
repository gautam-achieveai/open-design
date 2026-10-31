import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Response } from 'express';
import {
  emitWorkspaceEventToAllScopes,
  emitWorkspaceEventToScope,
  registerCollabContextRoutes,
  type WorkspaceEventSinksByWorkspace,
} from '../src/routes/collab-context.js';
import { createDevWorkspaceContextProvider } from '../src/collab/workspace-context.js';

// A minimal `createSseResponse` matching the daemon contract the route relies on
// (text/event-stream headers + `send(event, data)` writing one SSE frame). Keeps
// this route test independent of the full server bootstrap.
function makeSseResponse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders?.();
  return {
    send(event: string, data: unknown): boolean {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
  };
}

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
});

async function startServer(
  workspaceEventSinks: WorkspaceEventSinksByWorkspace,
  retainWorkspaceEventInterest?: (workspaceId: string) => () => void,
) {
  const app = express();
  app.use(express.json());
  registerCollabContextRoutes(app, {
    workspaceContext: createDevWorkspaceContextProvider(),
    fetchWorkspaceDirectory: async () => ({
      ok: true,
      items: [{
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        workspaceType: 'team',
        workspaceMemberId: 'member-a',
        role: 'member',
        memberStatus: 'active',
        lifecycleState: 'active',
      }],
    }),
    createSseResponse: (res) => makeSseResponse(res as Response),
    workspaceEventSinks,
    ...(retainWorkspaceEventInterest ? { retainWorkspaceEventInterest } : {}),
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP port');
  return `http://127.0.0.1:${address.port}`;
}

/** Read from an SSE body reader until `predicate(accumulated)` is true. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(buffer)) return buffer;
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  if (!predicate(buffer)) throw new Error(`timed out; buffer so far:\n${buffer}`);
  return buffer;
}

describe('GET /api/workspace/events', () => {
  it("does not expose retired SSE: keeps private quota notifications inside the verified member scope", async () => {
    const sinks: WorkspaceEventSinksByWorkspace = new Map();
    const retainInterest = vi.fn(() => vi.fn());
    const base = await startServer(sinks, retainInterest);
    const response = await fetch(base + '/api/workspace/events?workspaceId=workspace-a&workspaceMemberId=member-a');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(sinks.size).toBe(0);
    expect(retainInterest).not.toHaveBeenCalled();
  });
  it("does not expose retired SSE: registers a sink, streams a pushed thin event, and drops the sink on disconnect", async () => {
    const sinks: WorkspaceEventSinksByWorkspace = new Map();
    const retainInterest = vi.fn(() => vi.fn());
    const base = await startServer(sinks, retainInterest);
    const response = await fetch(base + '/api/workspace/events?workspaceId=workspace-a&workspaceMemberId=member-a');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(sinks.size).toBe(0);
    expect(retainInterest).not.toHaveBeenCalled();
  });

  it('404-free no-op: the route is simply absent when the SSE seams are omitted', async () => {
    // Without createSseResponse + workspaceEventSinks the route is never
    // registered, so a request 404s instead of throwing.
    const app = express();
    app.use(express.json());
    registerCollabContextRoutes(app, { workspaceContext: createDevWorkspaceContextProvider() });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP port');
    const resp = await fetch(`http://127.0.0.1:${address.port}/api/workspace/events`);
    expect(resp.status).toBe(404);
  });
});

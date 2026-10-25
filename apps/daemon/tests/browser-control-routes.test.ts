import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBrowserControlRoutes } from '../src/routes/browser-control.js';
import { createBrowserCommandBroker } from '../src/services/browser-command-broker.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';
import { sendApiError } from '../src/http/api-errors.js';

describe('embedded browser control routes', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it.each([
    { command: { operation: 'snapshot' }, result: { operation: 'snapshot', snapshot: { role: 'document' } } },
    { command: { operation: 'snapshot', depth: 30, target: { selector: '#app' } },
      result: { operation: 'snapshot', snapshot: { document: { nodeName: 'MAIN' }, truncated: false } } },
    { command: { operation: 'evaluate', approved: true, expression: 'document.title' },
      result: { operation: 'evaluate', value: 'Example', type: 'string', truncated: false } },
    { command: { operation: 'viewport', preset: 'mobile' }, result: { operation: 'viewport', preset: 'mobile', width: 390, height: 600 } },
    { command: { operation: 'style', approved: true, target: { selector: 'h1' }, styles: { color: 'red' } },
      result: { operation: 'style', applied: true, inspection: { selector: 'h1', position: { x: 1, y: 2, width: 160, height: 30 }, style: { color: 'red' } } } },
  ])('registers, selects, polls, and completes $command.operation over the shared HTTP contract', async ({ command, result: operationResult }) => {
    const broker = createBrowserCommandBroker({ cleanupIntervalMs: 60_000 });
    const app = express();
    app.use(express.json());
    registerBrowserControlRoutes(app, {
      db: {},
      http: {
        requireLocalDaemonRequest,
        sendApiError,
      },
      projectStore: {
        getProject: (_db: unknown, id: string) => id === 'p1' ? { id } : null,
      },
      browserControl: broker,
      authorizeProjectRequest: async () => true,
    } as never);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const registration = await fetch(`${base}/api/projects/p1/browser/tabs/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        tabId: 'tab-a',
        url: 'https://example.com/',
        title: 'Example',
      }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { leaseId: string };
    const selected = await fetch(`${base}/api/projects/p1/browser/active-tab`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: 'tab-a' }),
    });
    expect(selected.status).toBe(200);

    const execute = fetch(`${base}/api/projects/p1/browser/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command,
        timeoutMs: 5_000,
      }),
    });
    const next = await fetch(`${base}/api/projects/p1/browser/tabs/tab-a/commands/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: registered.leaseId, timeoutMs: 1_000 }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json() as { command: { commandId: string } };

    if (command.operation === 'style') {
      for (const result of [{ operation: 'style', applied: false, inspection: operationResult.inspection },
        { operation: 'style', applied: true, inspection: null }, { operation: 'style', applied: true, inspection: {} }]) {
        const rejected = await fetch(`${base}/api/projects/p1/browser/tabs/tab-a/commands/${nextBody.command.commandId}/result`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ leaseId: registered.leaseId, ok: true, result }),
        });
        expect(rejected.status).toBe(400);
      }
    }

    const submitted = await fetch(
      `${base}/api/projects/p1/browser/tabs/tab-a/commands/${nextBody.command.commandId}/result`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leaseId: registered.leaseId,
          ok: true,
          result: operationResult,
        }),
      },
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ accepted: true });

    const result = await execute;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      tab: { projectId: 'p1', tabId: 'tab-a' },
      result: operationResult,
    });

    const tabs = await fetch(`${base}/api/projects/p1/browser/tabs`);
    expect(await tabs.json()).toMatchObject({
      activeTabId: 'tab-a',
      tabs: [{ tabId: 'tab-a', active: true }],
    });
    broker.shutdown();
  });

  it('rejects non-loopback origins through the local daemon guard', async () => {
    const broker = createBrowserCommandBroker({ cleanupIntervalMs: 60_000 });
    const app = express();
    app.use(express.json());
    registerBrowserControlRoutes(app, {
      db: {},
      http: { requireLocalDaemonRequest, sendApiError },
      projectStore: { getProject: () => ({ id: 'p1' }) },
      browserControl: broker,
      authorizeProjectRequest: async () => true,
    } as never);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/projects/p1/browser/tabs`, {
      headers: { origin: 'https://example.com' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    broker.shutdown();
  });

  it('rejects raw unapproved consequential commands before they reach the renderer', async () => {
    const broker = createBrowserCommandBroker({ cleanupIntervalMs: 60_000 });
    const app = express();
    app.use(express.json());
    registerBrowserControlRoutes(app, {
      db: {},
      http: { requireLocalDaemonRequest, sendApiError },
      projectStore: { getProject: () => ({ id: 'p1' }) },
      browserControl: broker,
      authorizeProjectRequest: async () => true,
    } as never);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const registration = await fetch(`${base}/api/projects/p1/browser/tabs/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        tabId: 'tab-a',
        url: 'https://example.com/',
        title: 'Example',
      }),
    });
    const { leaseId } = await registration.json() as { leaseId: string };
    const commands = [
      { operation: 'click', target: { selector: '#buy' } },
      { operation: 'style', target: { selector: 'h1' }, styles: { color: 'red' } },
      {
        operation: 'type',
        target: { selector: '#email' },
        text: 'person@example.com',
      },
      { operation: 'scroll', deltaX: 0, deltaY: 500 },
      { operation: 'navigate', url: 'https://example.com/next' },
      { operation: 'evaluate', expression: 'document.title' },
    ];

    for (const command of commands) {
      const response = await fetch(`${base}/api/projects/p1/browser/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, timeoutMs: 100 }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: expect.stringContaining('command.approved'),
        },
      });
    }

    for (const styles of [{}, { color: '' }, { arbitraryCss: 'red' }, JSON.parse('{"__proto__":"red"}'), { width: 123 }]) {
      const rejected = await fetch(`${base}/api/projects/p1/browser/commands`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: { operation: 'style', approved: true, target: { selector: 'h1' }, styles }, timeoutMs: 100 }),
      });
      expect(rejected.status).toBe(400);
    }

    const next = await fetch(`${base}/api/projects/p1/browser/tabs/tab-a/commands/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId, timeoutMs: 0 }),
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ command: null });
    broker.shutdown();
  });

  it('requires write authority for consequential commands and read authority otherwise', async () => {
    const broker = createBrowserCommandBroker({ cleanupIntervalMs: 60_000 });
    const authorizeProjectRequest = vi.fn(async (
      _req: unknown,
      res: { status(code: number): { json(value: unknown): void } },
    ) => {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return false;
    });
    const app = express();
    app.use(express.json());
    registerBrowserControlRoutes(app, {
      db: {},
      http: { requireLocalDaemonRequest, sendApiError },
      projectStore: { getProject: () => ({ id: 'p1' }) },
      browserControl: broker,
      authorizeProjectRequest,
    } as never);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await fetch(`${base}/api/projects/p1/browser/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: {
          operation: 'click',
          approved: true,
          target: { selector: '#buy' },
        },
      }),
    });
    expect(authorizeProjectRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'p1',
      { mode: 'write', capability: 'writeFiles' },
    );

    await fetch(`${base}/api/projects/p1/browser/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { operation: 'style', approved: true, target: { selector: 'h1' }, styles: { color: 'red' } } }),
    });
    expect(authorizeProjectRequest).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'p1',
      { mode: 'write', capability: 'writeFiles' });

    await fetch(`${base}/api/projects/p1/browser/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { operation: 'evaluate', approved: true, expression: 'document.title' } }),
    });
    expect(authorizeProjectRequest).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'p1',
      { mode: 'write', capability: 'writeFiles' });

    await fetch(`${base}/api/projects/p1/browser/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { operation: 'snapshot' } }),
    });
    expect(authorizeProjectRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'p1',
      { mode: 'read' },
    );
    broker.shutdown();
  });
});

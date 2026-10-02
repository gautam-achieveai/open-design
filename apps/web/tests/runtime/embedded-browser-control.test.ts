import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDED_BROWSER_CONTROL_ROUTES,
  createEmbeddedBrowserControlSession,
  executeEmbeddedBrowserOperation,
  listEmbeddedBrowserTargets,
  readBrowserControlMetadata,
  setActiveEmbeddedBrowserTarget,
  withBrowserControlMetadata,
  type EmbeddedBrowserTarget,
} from '../../src/runtime/embedded-browser-control';

const target: EmbeddedBrowserTarget = {
  active: true,
  projectId: 'project-1',
  tabId: 'browser-1',
  title: 'Example',
  url: 'https://example.com/',
  webContentsId: 42,
};

describe('embedded browser control relay', () => {
  it('executes a browser operation against the selected tab', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      commandId: 'command-direct',
      tab: {
        projectId: target.projectId,
        tabId: target.tabId,
        title: target.title,
        url: target.url,
      },
      result: {
        operation: 'network-list',
        entries: [{ method: 'GET', url: 'https://example.com/api' }],
      },
    }));

    await expect(executeEmbeddedBrowserOperation(
      target.projectId,
      { operation: 'network-list', limit: 50 },
      {
        fetchImpl,
        headers: { 'x-workspace-user-id': 'user-1' },
        tabId: target.tabId,
        timeoutMs: 10_000,
      },
    )).resolves.toMatchObject({
      commandId: 'command-direct',
      result: { operation: 'network-list' },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      EMBEDDED_BROWSER_CONTROL_ROUTES.execute(target.projectId),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-workspace-user-id': 'user-1',
        }),
        body: JSON.stringify({
          command: { operation: 'network-list', limit: 50 },
          tabId: target.tabId,
          timeoutMs: 10_000,
        }),
      }),
    );
  });

  it('registers the exact webview target, routes a command, renews metadata, and cleans up', async () => {
    let nextPoll = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.register(target.projectId)) {
        return jsonResponse({ leaseId: 'lease-1' });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.active(target.projectId)) {
        return jsonResponse({ activeTabId: target.tabId });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.nextCommand(target.projectId, target.tabId)) {
        nextPoll += 1;
        if (nextPoll === 1) {
          return jsonResponse({
            command: {
              commandId: 'command-1',
              expiresAt: 5_000,
              request: { operation: 'console', limit: 5 },
            },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, 'command-1')) {
        return jsonResponse({ accepted: true });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.renew(target.projectId, target.tabId)) {
        return jsonResponse({ ok: true });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.unregister(target.projectId, target.tabId)) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const hostBridge = {
      registerTarget: vi.fn(async () => ({ ok: true })),
      unregisterTarget: vi.fn(async () => ({ ok: true })),
      execute: vi.fn(async () => ({
        ok: true as const,
        operation: 'console' as const,
        tabId: target.tabId,
        value: { entries: [{ level: 'info', source: 'console', text: 'ready', timestamp: 1 }] },
      })),
    };
    const statuses: string[] = [];

    const session = createEmbeddedBrowserControlSession({
      fetchImpl,
      hostBridge,
      onStatus: (status) => statuses.push(status),
      target,
    });

    await expect(session.ready).resolves.toBe(true);
    await vi.waitFor(() => expect(hostBridge.execute).toHaveBeenCalledTimes(1));
    expect(hostBridge.registerTarget).toHaveBeenCalledWith({
      projectId: target.projectId,
      tabId: target.tabId,
      title: target.title,
      url: target.url,
      webContentsId: target.webContentsId,
    });
    expect(hostBridge.execute).toHaveBeenCalledWith({
      expiresAt: 5_000,
      tabId: target.tabId,
      operation: { kind: 'console', limit: 5 },
    });
    expect(requestBody(fetchImpl, EMBEDDED_BROWSER_CONTROL_ROUTES.register(target.projectId))).toEqual({
      projectId: target.projectId,
      tabId: target.tabId,
      title: target.title,
      url: target.url,
    });
    expect(requestBody(
      fetchImpl,
      EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, 'command-1'),
    )).toEqual({
      leaseId: 'lease-1',
      ok: true,
      result: {
        operation: 'console',
        entries: [{ level: 'info', source: 'console', text: 'ready', timestamp: 1 }],
      },
    });

    const updatedTarget = {
      ...target,
      active: false,
      title: 'Docs',
      url: 'https://example.com/docs',
    };
    session.updateTarget(updatedTarget);
    await vi.waitFor(() => {
      expect(requestBody(
        fetchImpl,
        EMBEDDED_BROWSER_CONTROL_ROUTES.renew(target.projectId, target.tabId),
      )).toEqual({
        leaseId: 'lease-1',
        title: updatedTarget.title,
        url: updatedTarget.url,
      });
    });

    await session.stop();
    expect(hostBridge.unregisterTarget).toHaveBeenCalledWith({ tabId: updatedTarget.tabId });
    expect(requestBody(
      fetchImpl,
      EMBEDDED_BROWSER_CONTROL_ROUTES.unregister(target.projectId, target.tabId),
      'DELETE',
    )).toEqual({
      leaseId: 'lease-1',
    });
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('returns unavailable without registering or polling when the host bridge is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const statuses: string[] = [];
    const session = createEmbeddedBrowserControlSession({
      fetchImpl,
      hostBridge: null,
      onStatus: (status) => statuses.push(status),
      target,
    });

    await expect(session.ready).resolves.toBe(false);
    await session.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statuses).toEqual(['unavailable']);
  });

  it('retries host registration while Electron finishes attaching the guest', async () => {
    let nextPoll = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.register(target.projectId)) {
        return jsonResponse({ leaseId: 'lease-retry' });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.active(target.projectId)) {
        return jsonResponse({ activeTabId: target.tabId });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.nextCommand(target.projectId, target.tabId)) {
        nextPoll += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return jsonResponse({ ok: true });
    });
    const registerTarget = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'browser target is not an attached approved Design Browser guest',
      })
      .mockResolvedValueOnce({ ok: true });
    const session = createEmbeddedBrowserControlSession({
      fetchImpl,
      hostBridge: {
        registerTarget,
        unregisterTarget: async () => ({ ok: true }),
        execute: async () => ({ ok: false, reason: 'not used' }),
      },
      target,
    });

    await expect(session.ready).resolves.toBe(true);
    expect(registerTarget).toHaveBeenCalledTimes(2);
    expect(nextPoll).toBe(1);
    await session.stop();
  });

  it('posts a structured command failure instead of a success-shaped fallback', async () => {
    let nextPoll = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.register(target.projectId)) {
        return jsonResponse({ leaseId: 'lease-failure' });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.active(target.projectId)) {
        return jsonResponse({ activeTabId: target.tabId });
      }
      if (url === EMBEDDED_BROWSER_CONTROL_ROUTES.nextCommand(target.projectId, target.tabId)) {
        nextPoll += 1;
        if (nextPoll === 1) {
          return jsonResponse({
            command: {
              commandId: 'command-failure',
              expiresAt: 5_000,
              request: { operation: 'click', target: { selector: '#submit' } },
            },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return jsonResponse({ ok: true });
    });
    const session = createEmbeddedBrowserControlSession({
      fetchImpl,
      hostBridge: {
        registerTarget: async () => ({ ok: true }),
        unregisterTarget: async () => ({ ok: true }),
        execute: async () => {
          throw new Error('target detached');
        },
      },
      target,
    });

    await session.ready;
    await vi.waitFor(() => {
      expect(requestBody(
        fetchImpl,
        EMBEDDED_BROWSER_CONTROL_ROUTES.result(
          target.projectId,
          target.tabId,
          'command-failure',
        ),
      )).toEqual({
        leaseId: 'lease-failure',
        ok: false,
        error: {
          code: 'BROWSER_COMMAND_FAILED',
          message: 'target detached',
        },
      });
    });
    await session.stop();
  });

  it('carries exact tab identity in extensible annotation metadata and accepts older shapes', () => {
    const annotated = withBrowserControlMetadata({ selector: '#hero' }, target);

    expect(annotated).toEqual({
      selector: '#hero',
      metadata: {
        browser: {
          tabId: 'browser-1',
          webContentsId: 42,
        },
      },
    });
    expect(readBrowserControlMetadata(annotated)).toEqual(annotated.metadata);
    expect(readBrowserControlMetadata({ selector: '#legacy' })).toBeNull();
  });

  it('lists only valid registered browser targets', async () => {
    const invalid = { ...target, webContentsId: 0 };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      activeTabId: target.tabId,
      tabs: [target, invalid],
    }));

    await expect(listEmbeddedBrowserTargets(target.projectId, fetchImpl)).resolves.toEqual({
      activeTabId: target.tabId,
      tabs: [target, invalid],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      EMBEDDED_BROWSER_CONTROL_ROUTES.list(target.projectId),
      { cache: 'no-store' },
    );
  });

  it('clears the active browser target when the workspace leaves browser mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ activeTabId: null }));

    await setActiveEmbeddedBrowserTarget(target.projectId, null, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      EMBEDDED_BROWSER_CONTROL_ROUTES.active(target.projectId),
      expect.objectContaining({
        body: JSON.stringify({ tabId: null }),
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        method: 'PUT',
      }),
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(value === null ? '' : JSON.stringify(value), {
    status: value === null ? 204 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(
  fetchImpl: ReturnType<typeof vi.fn>,
  url: string,
  method?: string,
): unknown {
  const call = fetchImpl.mock.calls.find(([input, init]) => (
    String(input) === url && (!method || init?.method === method)
  ));
  const body = call?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : null;
}

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
  it.each([false, true])('terminates rejected registration updates after the bounded policy (transient=%s)', async (transient) => {
    vi.useFakeTimers();
    const states: string[] = [];
    const hostBridge = {
      registerTarget: vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false,
        reason: transient ? 'browser target URL does not match the attached guest' : 'browser guest is already registered to another tab' }),
      unregisterTarget: vi.fn(async () => ({ ok: true })), execute: vi.fn(),
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/commands/next')) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-rejected' } : { accepted: true });
    });
    const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge, onStatus: (status) => states.push(status) });
    try {
      await session.ready;
      session.updateTarget({ ...target, url: 'https://example.com/next' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(states).toEqual(['connecting', 'connected', 'error']);
      expect(hostBridge.registerTarget).toHaveBeenCalledTimes(transient ? 21 : 2);
      expect(hostBridge.unregisterTarget).toHaveBeenCalledTimes(1);
    } finally { await session.stop(); vi.useRealTimers(); }
  });
  it('keeps its lease across a transient navigation URL mismatch and registers the latest target', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const seen: Array<{ url: string; active?: boolean }> = [];
    const hostBridge = {
      registerTarget: vi.fn(async (value: { url: string; active?: boolean }) => {
        seen.push(value);
        return seen.length === 2 ? { ok: false, reason: 'browser target URL does not match the attached guest' } : { ok: true };
      }),
      unregisterTarget: vi.fn(async () => ({ ok: true })), execute: vi.fn(),
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/commands/next')) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-navigation' } : { accepted: true });
    });
    const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge, onStatus: (status) => states.push(status) });
    try {
      await session.ready;
      session.updateTarget({ ...target, url: 'https://example.com/next', active: false });
      await vi.advanceTimersByTimeAsync(0);
      session.updateTarget({ ...target, url: 'https://example.com/redirected', active: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(states).toEqual(['connecting', 'connected']);
      expect(hostBridge.unregisterTarget).not.toHaveBeenCalled();
      expect(seen.slice(2)).toEqual([
        expect.objectContaining({ url: 'https://example.com/redirected', active: false }),
        expect.objectContaining({ url: 'https://example.com/redirected', active: true }),
      ]);
    } finally { await session.stop(); vi.useRealTimers(); }
  });
  it('forwards every rapid inactive and active transition to the host', async () => {
    const seen: unknown[] = [];
    const hostBridge = {
      registerTarget: vi.fn(async (value: unknown) => { seen.push(value); return { ok: true }; }),
      unregisterTarget: vi.fn(async () => ({ ok: true })), execute: vi.fn(),
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/commands/next')) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-visibility' } : { accepted: true });
    });
    const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge });
    await session.ready;
    try {
      session.updateTarget({ ...target, active: false });
      session.updateTarget({ ...target, active: true });
      await vi.waitFor(() => expect(seen).toHaveLength(3));
      expect(seen).toEqual([
        expect.objectContaining({ active: true }),
        expect.objectContaining({ active: false }),
        expect.objectContaining({ active: true }),
      ]);
    } finally { await session.stop(); }
  });
  it.each(['applied', 'failed', 'unmeasured', 'expired', 'unapproved', 'missing'] as const)(
    'handles %s typed style patches without host page execution', async (outcome) => {
      let polls = 0;
      const expiresAt = outcome === 'expired' ? 0 : Date.now() + 10_000;
      const request = { operation: 'style' as const, approved: outcome !== 'unapproved',
        target: { selector: 'h1' }, styles: { color: 'red' } };
      const inspection = { selector: 'h1', position: { x: 1, y: 2, width: 160, height: 30 }, style: { color: 'red' } };
      const applyStyle = vi.fn(async () => {
        if (outcome === 'failed') throw new Error('Browser style target is no longer available');
        return outcome === 'unmeasured' ? null : inspection;
      });
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).endsWith('/commands/next')) {
          if (++polls === 1) return jsonResponse({ command: { commandId: 'style-1', expiresAt, request } });
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        }
        return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-1' } : { accepted: true });
      });
      const hostBridge = { registerTarget: vi.fn(async () => ({ ok: true })), unregisterTarget: vi.fn(async () => ({ ok: true })), execute: vi.fn() };
      const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge,
        ...(outcome === 'missing' ? {} : { applyStyle }) });
      await session.ready;
      const resultUrl = EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, 'style-1');
      await vi.waitFor(() => expect(requestBody(fetchImpl, resultUrl)).not.toBeNull());
      expect(requestBody(fetchImpl, resultUrl)).toMatchObject(outcome === 'applied'
        ? { ok: true, result: { operation: 'style', applied: true, inspection } }
        : { ok: false, error: { code: 'BROWSER_COMMAND_FAILED' } });
      expect(applyStyle).toHaveBeenCalledTimes(['expired', 'unapproved', 'missing'].includes(outcome) ? 0 : 1);
      if (outcome === 'applied') expect(applyStyle).toHaveBeenCalledWith(request, expiresAt);
      expect(hostBridge.execute).not.toHaveBeenCalled();
      await session.stop();
    });

  it.each(['applied', 'parked', 'expired'] as const)('handles %s viewport selection in the existing lease without host page execution', async (outcome) => {
    let polls = 0;
    const expiresAt = outcome === 'expired' ? 0 : Date.now() + 10_000;
    const applyViewport = vi.fn(async () => {
      if (outcome === 'parked') throw new Error('Activate this browser tab before changing its viewport');
      return { preset: 'mobile' as const, width: 390, height: 600 };
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/commands/next')) {
        if (++polls === 1) return jsonResponse({ command: { commandId: 'viewport-1', expiresAt,
          request: { operation: 'viewport', preset: 'mobile' } } });
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      }
      return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-1' } : { accepted: true });
    });
    const hostBridge = { registerTarget: vi.fn(async () => ({ ok: true })), unregisterTarget: vi.fn(async () => ({ ok: true })), execute: vi.fn() };
    const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge, applyViewport });
    await session.ready;
    const resultUrl = EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, 'viewport-1');
    await vi.waitFor(() => expect(requestBody(fetchImpl, resultUrl)).not.toBeNull());
    expect(requestBody(fetchImpl, resultUrl)).toMatchObject(outcome === 'applied'
      ? { ok: true, result: { operation: 'viewport', preset: 'mobile', width: 390, height: 600 } }
      : { ok: false, error: { code: 'BROWSER_COMMAND_FAILED', message: expect.stringContaining(outcome === 'parked' ? 'Activate' : 'expired') } });
    expect(applyViewport).toHaveBeenCalledTimes(outcome === 'expired' ? 0 : 1);
    if (outcome !== 'expired') expect(applyViewport).toHaveBeenCalledWith('mobile', expiresAt);
    expect(hostBridge.execute).not.toHaveBeenCalled();
    expect(hostBridge.registerTarget).toHaveBeenCalledTimes(1);
    await session.stop();
  });
  it.each([
    {
      request: { operation: 'evaluate' as const, approved: true as const, expression: 'document.title' },
      host: { kind: 'evaluate', approved: true, expression: 'document.title' },
      hostResult: { ok: true, operation: 'evaluate', tabId: 'browser-1', value: { truncated: false, type: 'string', value: 'Example' } },
      result: { operation: 'evaluate', truncated: false, type: 'string', value: 'Example' },
    },
    {
      request: { operation: 'devtools' as const, action: 'force-state' as const, approved: true as const, params: { selector: 'a', states: ['hover'] } },
      host: { action: 'force-state', approved: true, kind: 'devtools', params: { selector: 'a', states: ['hover'] } },
      hostResult: { ok: true, operation: 'devtools', tabId: 'browser-1', value: { action: 'force-state', result: { states: ['hover'] } } },
      result: { action: 'force-state', operation: 'devtools', result: { states: ['hover'] } },
    },
    {
      request: { operation: 'devtools' as const, action: 'a11y' as const },
      host: { action: 'a11y', kind: 'devtools', params: {} },
      hostResult: { ok: true, operation: 'devtools', tabId: 'browser-1', value: { action: 'a11y', result: { nodes: 3 } } },
      result: { action: 'a11y', operation: 'devtools', result: { nodes: 3 } },
    },
    {
      request: { operation: 'snapshot' as const, depth: 30, target: { selector: '#app' } },
      host: { kind: 'snapshot', depth: 30, selector: '#app' },
      hostResult: { ok: true, operation: 'snapshot', tabId: 'browser-1', value: { document: { nodeName: 'MAIN' }, truncated: false } },
      result: { operation: 'snapshot', snapshot: { document: { nodeName: 'MAIN' }, truncated: false } },
    },
  ])('relays $request.operation to the host and maps its result back', async ({ request, host, hostResult, result }) => {
    let polls = 0;
    const expiresAt = Date.now() + 10_000;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/commands/next')) {
        if (++polls === 1) return jsonResponse({ command: { commandId: 'cmd-1', expiresAt, request } });
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      }
      return jsonResponse(String(input).endsWith('/register') ? { leaseId: 'lease-1' } : { accepted: true });
    });
    const hostBridge = { registerTarget: vi.fn(async () => ({ ok: true })), unregisterTarget: vi.fn(async () => ({ ok: true })),
      execute: vi.fn(async () => hostResult) };
    const session = createEmbeddedBrowserControlSession({ target, fetchImpl, hostBridge: hostBridge as never });
    await session.ready;
    const resultUrl = EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, 'cmd-1');
    await vi.waitFor(() => expect(requestBody(fetchImpl, resultUrl)).not.toBeNull());
    expect(hostBridge.execute).toHaveBeenCalledWith({ expiresAt, operation: host, tabId: target.tabId });
    expect(requestBody(fetchImpl, resultUrl)).toMatchObject({ ok: true, result });
    await session.stop();
  });

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
      active: target.active,
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

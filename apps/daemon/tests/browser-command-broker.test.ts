import { describe, expect, it } from 'vitest';

import {
  BrowserBrokerError,
  createBrowserCommandBroker,
} from '../src/services/browser-command-broker.js';

function createBroker() {
  let clock = 1_000;
  let sequence = 0;
  const broker = createBrowserCommandBroker({
    now: () => clock,
    randomId: () => `id-${++sequence}`,
    leaseTtlMs: 100,
    cleanupIntervalMs: 60_000,
  });
  return {
    broker,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('browser command broker', () => {
  it('dispatches a command to the exact registered tab and resolves its typed result', async () => {
    const { broker } = createBroker();
    const registration = broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/',
      title: 'Example',
    });
    expect(broker.listTabs('p1').activeTabId).toBeNull();
    broker.selectActiveTab('p1', 'tab-a');

    const executing = broker.execute('p1', undefined, { operation: 'snapshot' }, 5_000);
    const command = await broker.nextCommand(
      'p1',
      'tab-a',
      registration.leaseId,
      0,
    );

    expect(command).toMatchObject({
      tab: {
        projectId: 'p1',
        tabId: 'tab-a',
        url: 'https://example.com/',
        title: 'Example',
      },
      request: { operation: 'snapshot' },
    });

    broker.submitResult('p1', 'tab-a', command!.commandId, {
      leaseId: registration.leaseId,
      ok: true,
      result: { operation: 'snapshot', snapshot: { role: 'document' } },
    });

    await expect(executing).resolves.toMatchObject({
      commandId: command!.commandId,
      result: { operation: 'snapshot', snapshot: { role: 'document' } },
    });
    broker.shutdown();
  });

  it('prevents another renderer from claiming or completing a live lease', async () => {
    const { broker } = createBroker();
    const registration = broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/',
      title: 'Example',
    });

    expect(() => broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://attacker.invalid/',
      title: 'Other renderer',
    })).toThrowError(expect.objectContaining({ code: 'BROWSER_LEASE_CONFLICT' }));

    const executing = broker.execute('p1', 'tab-a', { operation: 'console' }, 5_000);
    const command = await broker.nextCommand('p1', 'tab-a', registration.leaseId, 0);
    expect(() => broker.submitResult('p1', 'tab-a', command!.commandId, {
      leaseId: 'another-lease',
      ok: true,
      result: { operation: 'console', entries: [] },
    })).toThrowError(expect.objectContaining({ code: 'BROWSER_LEASE_CONFLICT' }));

    broker.submitResult('p1', 'tab-a', command!.commandId, {
      leaseId: registration.leaseId,
      ok: true,
      result: { operation: 'console', entries: [] },
    });
    await executing;
    broker.shutdown();
  });

  it('expires stale leases, cancels their commands, and permits a fresh renderer lease', async () => {
    const { broker, advance } = createBroker();
    broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/',
      title: 'Example',
    });
    const executing = broker.execute(
      'p1',
      'tab-a',
      { operation: 'inspect', target: { selector: '#hero' } },
      5_000,
    );

    advance(101);
    broker.sweep();

    await expect(executing).rejects.toMatchObject({ code: 'BROWSER_LEASE_EXPIRED' });
    expect(broker.listTabs('p1')).toEqual({ tabs: [], activeTabId: null });
    expect(broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/new',
      title: 'Replacement',
    }).tab.title).toBe('Replacement');
    expect(broker.listTabs('p1').activeTabId).toBeNull();
    broker.shutdown();
  });

  it('surfaces bounded timeout and caller cancellation explicitly', async () => {
    const { broker } = createBroker();
    broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/',
      title: 'Example',
    });

    await expect(
      broker.execute('p1', 'tab-a', { operation: 'network-failures' }, 5),
    ).rejects.toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT' });

    const abort = new AbortController();
    const canceled = broker.execute(
      'p1',
      'tab-a',
      { operation: 'snapshot' },
      5_000,
      abort.signal,
    );
    abort.abort();
    await expect(canceled).rejects.toEqual(expect.any(BrowserBrokerError));
    await expect(canceled).rejects.toMatchObject({ code: 'BROWSER_COMMAND_CANCELED' });
    broker.shutdown();
  });

  it('does not revoke a command after the renderer has claimed it', async () => {
    const { broker } = createBroker();
    const registration = broker.registerTab({
      projectId: 'p1',
      tabId: 'tab-a',
      url: 'https://example.com/',
      title: 'Example',
    });
    const abort = new AbortController();
    const executing = broker.execute(
      'p1',
      'tab-a',
      { operation: 'snapshot' },
      5_000,
      abort.signal,
    );
    const command = await broker.nextCommand('p1', 'tab-a', registration.leaseId, 0);

    abort.abort();
    broker.submitResult('p1', 'tab-a', command!.commandId, {
      leaseId: registration.leaseId,
      ok: true,
      result: { operation: 'snapshot', snapshot: { role: 'document' } },
    });

    await expect(executing).resolves.toMatchObject({
      result: { operation: 'snapshot' },
    });
    broker.shutdown();
  });
});

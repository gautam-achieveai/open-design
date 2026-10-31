import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

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

function fingerprint(projectId: string, tabId: string, leaseId: string, url: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  return { projectId, tabId, leaseDigest: digest(leaseId), urlDigest: digest(url), location: 'safe' };
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

  it('keeps an approved target fixed when the active tab changes and consumes only once', async () => {
    const { broker } = createBroker();
    const first = broker.registerTab({ projectId: 'p1', tabId: 'a', url: 'https://example.invalid/a?state=synthetic', title: 'A' });
    const second = broker.registerTab({ projectId: 'p1', tabId: 'b', url: 'https://example.invalid/b', title: 'B' });
    broker.selectActiveTab('p1', 'a');
    const target = broker.captureApprovalTarget('p1', undefined, fingerprint);
    expect(JSON.stringify(target)).not.toContain(first.leaseId);
    expect(JSON.stringify(target)).not.toContain('synthetic');
    broker.selectActiveTab('p1', 'b');
    let consumed = false;
    const consume = () => { if (consumed) throw new Error('already consumed'); consumed = true; return undefined; };
    const request = { operation: 'click' as const, approved: true as const, target: { selector: '#go' } };
    const pending = broker.enqueueIfCurrent({ target, fingerprint, authorizeAndConsume: consume, request, expiresAtMs: 1_050 });
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, authorizeAndConsume: consume, request, expiresAtMs: 1_050 })).toThrow('already consumed');
    expect(await broker.nextCommand('p1', 'b', second.leaseId, 0)).toBeNull();
    const command = await broker.nextCommand('p1', 'a', first.leaseId, 0);
    expect(command?.tab.tabId).toBe('a');
    broker.submitResult('p1', 'a', command!.commandId, { leaseId: first.leaseId, ok: true, result: { operation: 'click', clicked: true } });
    await expect(pending.result).resolves.toMatchObject({ tab: { tabId: 'a' }, result: { clicked: true } });
    broker.shutdown();
  });

  it('denies a changed URL, replaced lease and expired approval before consuming', async () => {
    const { broker, advance } = createBroker();
    const first = broker.registerTab({ projectId: 'p1', tabId: 'a', url: 'https://example.invalid/a', title: 'A' });
    const target = broker.captureApprovalTarget('p1', 'a', fingerprint);
    const request = { operation: 'snapshot' as const };
    let calls = 0;
    const consume = () => { calls++; return undefined; };
    broker.renewLease('p1', 'a', { leaseId: first.leaseId, url: 'https://example.invalid/b', title: 'A' });
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, authorizeAndConsume: consume, request, expiresAtMs: 1_050 })).toThrowError(expect.objectContaining({ code: 'BROWSER_LEASE_CONFLICT' }));
    broker.releaseLease('p1', 'a', first.leaseId);
    const replacement = broker.registerTab({ projectId: 'p1', tabId: 'a', url: 'https://example.invalid/a', title: 'Replacement' });
    expect(broker.isApprovalTargetCurrent(target, fingerprint)).toBe(false);
    const newTarget = broker.captureApprovalTarget('p1', 'a', fingerprint);
    advance(51);
    expect(() => broker.enqueueIfCurrent({ target: newTarget, fingerprint, authorizeAndConsume: consume, request, expiresAtMs: 1_050 })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(calls).toBe(0);
    expect(await broker.nextCommand('p1', 'a', replacement.leaseId, 0)).toBeNull();
    broker.shutdown();
  });

  it('does not enqueue when authorization changes the target, expires, aborts, or yields', async () => {
    const { broker, advance } = createBroker();
    const tab = broker.registerTab({ projectId: 'p1', tabId: 'a', url: 'https://example.invalid/a', title: 'A' });
    const target = broker.captureApprovalTarget('p1', 'a', fingerprint);
    const request = { operation: 'snapshot' as const };
    const abort = new AbortController();
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, request, expiresAtMs: 1_050, signal: abort.signal,
      authorizeAndConsume: () => { abort.abort(); return undefined; } })).toThrowError(expect.objectContaining({ code: 'BROWSER_COMMAND_CANCELED' }));
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, request, expiresAtMs: 1_050,
      authorizeAndConsume: () => { broker.renewLease('p1', 'a', { leaseId: tab.leaseId, url: 'https://example.invalid/changed', title: 'A' }); return undefined; } })).toThrowError(expect.objectContaining({ code: 'BROWSER_LEASE_CONFLICT' }));
    broker.renewLease('p1', 'a', { leaseId: tab.leaseId, url: 'https://example.invalid/a', title: 'A' });
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, request, expiresAtMs: 1_050,
      authorizeAndConsume: () => { advance(51); return undefined; } })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    const yielding = (() => Promise.resolve()) as unknown as () => undefined;
    expect(() => broker.enqueueIfCurrent({ target, fingerprint, request, expiresAtMs: 2_000, authorizeAndConsume: yielding })).toThrow('must be synchronous');
    expect(await broker.nextCommand('p1', 'a', tab.leaseId, 0)).toBeNull();
    broker.shutdown();
  });

  it('cancels an approved queued command but lets a claimed command finish', async () => {
    const { broker } = createBroker();
    const tab = broker.registerTab({ projectId: 'p1', tabId: 'a', url: 'https://example.invalid/a', title: 'A' });
    const target = broker.captureApprovalTarget('p1', 'a', fingerprint);
    const before = new AbortController();
    const queued = broker.enqueueIfCurrent({ target, fingerprint, authorizeAndConsume: () => undefined,
      request: { operation: 'snapshot' }, expiresAtMs: 1_050, signal: before.signal });
    const rejected = expect(queued.result).rejects.toMatchObject({ code: 'BROWSER_COMMAND_CANCELED' });
    before.abort();
    await rejected;
    expect(await broker.nextCommand('p1', 'a', tab.leaseId, 0)).toBeNull();
    const after = new AbortController();
    const claimed = broker.enqueueIfCurrent({ target, fingerprint, authorizeAndConsume: () => undefined,
      request: { operation: 'snapshot' }, expiresAtMs: 1_050, signal: after.signal });
    const command = await broker.nextCommand('p1', 'a', tab.leaseId, 0);
    after.abort();
    broker.submitResult('p1', 'a', command!.commandId, { leaseId: tab.leaseId, ok: true, result: { operation: 'snapshot', snapshot: null } });
    await expect(claimed.result).resolves.toMatchObject({ result: { operation: 'snapshot' } });
    broker.shutdown();
  });
});

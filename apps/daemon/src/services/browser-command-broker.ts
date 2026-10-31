import { randomUUID } from 'node:crypto';
import type {
  BrowserCommand,
  BrowserOperationRequest,
  BrowserOperationResult,
  BrowserTab,
  BrowserTabIdentity,
  RegisterBrowserTabRequest,
  SubmitBrowserCommandResultRequest,
} from '@open-design/contracts';
import type { ApiErrorCode, JsonValue } from '@open-design/contracts';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const MAX_POLL_TIMEOUT_MS = 30_000;

interface BrowserTabRecord extends BrowserTabIdentity {
  leaseId: string;
  registeredAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
}

interface PendingCommand {
  command: BrowserCommand;
  claimedByLeaseId: string | null;
  resolve: (value: BrowserOperationResult) => void;
  reject: (error: BrowserBrokerError) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface CommandWaiter {
  resolve: (command: BrowserCommand | null) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export class BrowserBrokerError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'BrowserBrokerError';
  }
}

export interface BrowserCommandBrokerOptions {
  now?: () => number;
  randomId?: () => string;
  leaseTtlMs?: number;
  commandTimeoutMs?: number;
  cleanupIntervalMs?: number;
}

/** Internal approval identity. Lease and page URL must never appear here. */
export interface BrowserApprovalTarget {
  projectId: string;
  tabId: string;
  leaseDigest: string;
  urlDigest: string;
}

/** Trusted in-process adapter, normally the approval store's keyed digester. */
export type BrowserApprovalFingerprinter<T extends BrowserApprovalTarget> = (
  projectId: string,
  tabId: string,
  leaseId: string,
  url: string,
) => T;

export function createBrowserCommandBroker(options: BrowserCommandBrokerOptions = {}) {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const defaultCommandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const tabs = new Map<string, BrowserTabRecord>();
  const activeTabs = new Map<string, string>();
  const commands = new Map<string, PendingCommand>();
  const queuedByTab = new Map<string, string[]>();
  const waitersByTab = new Map<string, CommandWaiter[]>();

  const keyFor = (projectId: string, tabId: string) => `${projectId}\u0000${tabId}`;

  function publicTab(tab: BrowserTabRecord): BrowserTab {
    return {
      projectId: tab.projectId,
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      active: activeTabs.get(tab.projectId) === tab.tabId,
      registeredAt: tab.registeredAt,
      updatedAt: tab.updatedAt,
      leaseExpiresAt: tab.leaseExpiresAt,
    };
  }

  function detachPending(command: PendingCommand): void {
    clearTimeout(command.timer);
    if (command.abortSignal && command.abortListener) {
      command.abortSignal.removeEventListener('abort', command.abortListener);
    }
    commands.delete(command.command.commandId);
    const key = keyFor(command.command.tab.projectId, command.command.tab.tabId);
    const queue = queuedByTab.get(key);
    if (queue) {
      const index = queue.indexOf(command.command.commandId);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) queuedByTab.delete(key);
    }
  }

  function rejectPending(command: PendingCommand, error: BrowserBrokerError): void {
    detachPending(command);
    command.reject(error);
  }

  function expireTab(tab: BrowserTabRecord): void {
    const key = keyFor(tab.projectId, tab.tabId);
    tabs.delete(key);
    if (activeTabs.get(tab.projectId) === tab.tabId) activeTabs.delete(tab.projectId);
    const waiters = waitersByTab.get(key) ?? [];
    waitersByTab.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (waiter.abortSignal && waiter.abortListener) {
        waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.resolve(null);
    }
    for (const command of [...commands.values()]) {
      if (command.command.tab.projectId === tab.projectId && command.command.tab.tabId === tab.tabId) {
        rejectPending(command, new BrowserBrokerError(
          'BROWSER_LEASE_EXPIRED',
          `browser tab lease expired: ${tab.tabId}`,
          409,
        ));
      }
    }
  }

  function sweep(): void {
    const at = now();
    for (const tab of [...tabs.values()]) {
      if (tab.leaseExpiresAt <= at) expireTab(tab);
    }
    for (const command of [...commands.values()]) {
      if (command.command.expiresAt <= at) {
        rejectPending(command, new BrowserBrokerError(
          'BROWSER_COMMAND_TIMEOUT',
          `browser command timed out: ${command.command.commandId}`,
          504,
          { commandId: command.command.commandId },
        ));
      }
    }
  }

  function requireTab(projectId: string, tabId: string): BrowserTabRecord {
    sweep();
    const tab = tabs.get(keyFor(projectId, tabId));
    if (!tab) {
      throw new BrowserBrokerError(
        'BROWSER_TAB_NOT_FOUND',
        `browser tab is not registered: ${tabId}`,
        404,
      );
    }
    return tab;
  }

  function requireLease(projectId: string, tabId: string, leaseId: string): BrowserTabRecord {
    const tab = requireTab(projectId, tabId);
    if (tab.leaseId !== leaseId) {
      throw new BrowserBrokerError(
        'BROWSER_LEASE_CONFLICT',
        `browser tab lease is owned by another renderer: ${tabId}`,
        409,
      );
    }
    return tab;
  }

  function touchLease(tab: BrowserTabRecord, minimumExpiresAt = 0): void {
    tab.updatedAt = now();
    tab.leaseExpiresAt = Math.max(tab.updatedAt + leaseTtlMs, minimumExpiresAt);
  }

  function notifyCommandWaiter(projectId: string, tabId: string): void {
    const key = keyFor(projectId, tabId);
    const waiter = waitersByTab.get(key)?.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.abortSignal && waiter.abortListener) {
      waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
    }
    const command = claimQueuedCommand(projectId, tabId);
    waiter.resolve(command);
    if ((waitersByTab.get(key)?.length ?? 0) === 0) waitersByTab.delete(key);
  }

  function claimQueuedCommand(projectId: string, tabId: string): BrowserCommand | null {
    const tab = requireTab(projectId, tabId);
    const key = keyFor(projectId, tabId);
    const queue = queuedByTab.get(key) ?? [];
    while (queue.length > 0) {
      const commandId = queue.shift();
      if (!commandId) continue;
      const pending = commands.get(commandId);
      if (!pending) continue;
      pending.claimedByLeaseId = tab.leaseId;
      if (pending.abortSignal && pending.abortListener) {
        pending.abortSignal.removeEventListener('abort', pending.abortListener);
        delete pending.abortSignal;
        delete pending.abortListener;
      }
      touchLease(tab, pending.command.expiresAt + 5_000);
      if (queue.length === 0) queuedByTab.delete(key);
      return pending.command;
    }
    queuedByTab.delete(key);
    return null;
  }

  function registerTab(input: RegisterBrowserTabRequest) {
    sweep();
    const key = keyFor(input.projectId, input.tabId);
    const existing = tabs.get(key);
    if (existing) {
      if (!input.leaseId || input.leaseId !== existing.leaseId) {
        throw new BrowserBrokerError(
          'BROWSER_LEASE_CONFLICT',
          `browser tab lease is owned by another renderer: ${input.tabId}`,
          409,
        );
      }
      existing.url = input.url;
      existing.title = input.title;
      touchLease(existing);
      return { tab: publicTab(existing), leaseId: existing.leaseId };
    }
    const registeredAt = now();
    const tab: BrowserTabRecord = {
      projectId: input.projectId,
      tabId: input.tabId,
      url: input.url,
      title: input.title,
      leaseId: randomId(),
      registeredAt,
      updatedAt: registeredAt,
      leaseExpiresAt: registeredAt + leaseTtlMs,
    };
    tabs.set(key, tab);
    return { tab: publicTab(tab), leaseId: tab.leaseId };
  }

  function renewLease(
    projectId: string,
    tabId: string,
    input: { leaseId: string; url: string; title: string },
  ) {
    const tab = requireLease(projectId, tabId, input.leaseId);
    tab.url = input.url;
    tab.title = input.title;
    touchLease(tab);
    return { tab: publicTab(tab), leaseId: tab.leaseId };
  }

  function releaseLease(projectId: string, tabId: string, leaseId: string): boolean {
    const tab = requireLease(projectId, tabId, leaseId);
    expireTab(tab);
    return true;
  }

  function listTabs(projectId: string) {
    sweep();
    const projectTabs = [...tabs.values()]
      .filter((tab) => tab.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(publicTab);
    const activeTabId = activeTabs.get(projectId);
    return {
      tabs: projectTabs,
      activeTabId: projectTabs.some((tab) => tab.tabId === activeTabId) ? activeTabId ?? null : null,
    };
  }

  function selectActiveTab(projectId: string, tabId: string | null): string | null {
    sweep();
    if (tabId === null) {
      activeTabs.delete(projectId);
      return null;
    }
    requireTab(projectId, tabId);
    activeTabs.set(projectId, tabId);
    return tabId;
  }

  async function nextCommand(
    projectId: string,
    tabId: string,
    leaseId: string,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<BrowserCommand | null> {
    const tab = requireLease(projectId, tabId, leaseId);
    touchLease(tab);
    const queued = claimQueuedCommand(projectId, tabId);
    if (queued) return queued;
    if (signal?.aborted) return null;
    const boundedTimeout = Math.min(Math.max(timeoutMs, 0), MAX_POLL_TIMEOUT_MS);
    if (boundedTimeout === 0) return null;
    return await new Promise((resolve) => {
      const key = keyFor(projectId, tabId);
      let waiter: CommandWaiter;
      const finish = (command: BrowserCommand | null) => {
        clearTimeout(waiter.timer);
        if (waiter.abortSignal && waiter.abortListener) {
          waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
        }
        const waiters = waitersByTab.get(key);
        if (waiters) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) waitersByTab.delete(key);
        }
        resolve(command);
      };
      waiter = {
        resolve: finish,
        timer: setTimeout(() => finish(null), boundedTimeout),
      };
      if (signal) {
        waiter.abortSignal = signal;
        waiter.abortListener = () => finish(null);
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      const waiters = waitersByTab.get(key) ?? [];
      waiters.push(waiter);
      waitersByTab.set(key, waiters);
    });
  }

  function enqueueCommand(
    tab: BrowserTabRecord,
    request: BrowserOperationRequest,
    timeoutMs = defaultCommandTimeoutMs,
    signal?: AbortSignal,
  ): Promise<{ commandId: string; tab: BrowserTabIdentity; result: BrowserOperationResult }> {
    const { projectId, tabId } = tab;
    const createdAt = now();
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1), MAX_COMMAND_TIMEOUT_MS);
    const command: BrowserCommand = {
      commandId: randomId(),
      tab: {
        projectId: tab.projectId,
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
      },
      request,
      createdAt,
      expiresAt: createdAt + boundedTimeout,
    };
    const result = new Promise<BrowserOperationResult>((resolve, reject) => {
      const pending: PendingCommand = {
        command,
        claimedByLeaseId: null,
        resolve,
        reject,
        timer: setTimeout(() => {
          rejectPending(pending, new BrowserBrokerError(
            'BROWSER_COMMAND_TIMEOUT',
            `browser command timed out: ${command.commandId}`,
            504,
            { commandId: command.commandId },
          ));
        }, boundedTimeout),
      };
      if (signal) {
        pending.abortSignal = signal;
        pending.abortListener = () => rejectPending(pending, new BrowserBrokerError(
          'BROWSER_COMMAND_CANCELED',
          `browser command canceled: ${command.commandId}`,
          499,
          { commandId: command.commandId },
        ));
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      commands.set(command.commandId, pending);
      const key = keyFor(projectId, tabId);
      const queue = queuedByTab.get(key) ?? [];
      queue.push(command.commandId);
      queuedByTab.set(key, queue);
      notifyCommandWaiter(projectId, tabId);
    });
    return result.then((value) => ({ commandId: command.commandId, tab: command.tab, result: value }));
  }

  function resolveTarget(projectId: string, tabId?: string): BrowserTabRecord {
    sweep();
    const selectedTabId = tabId || activeTabs.get(projectId);
    if (!selectedTabId) {
      throw new BrowserBrokerError('BROWSER_TAB_NOT_FOUND', 'no active browser tab is registered for this project', 404);
    }
    return requireTab(projectId, selectedTabId);
  }

  function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new BrowserBrokerError('BROWSER_COMMAND_CANCELED', 'browser command canceled before dispatch', 499);
    }
  }

  async function execute(
    projectId: string,
    tabId: string | undefined,
    request: BrowserOperationRequest,
    timeoutMs = defaultCommandTimeoutMs,
    signal?: AbortSignal,
  ): Promise<{ commandId: string; tab: BrowserTabIdentity; result: BrowserOperationResult }> {
    sweep();
    assertNotAborted(signal);
    const tab = resolveTarget(projectId, tabId);
    return await enqueueCommand(tab, request, timeoutMs, signal);
  }

  /** Capture a fixed target through a trusted keyed digester; only digests escape. */
  function captureApprovalTarget<T extends BrowserApprovalTarget>(
    projectId: string,
    tabId: string | undefined,
    fingerprint: BrowserApprovalFingerprinter<T>,
  ): T {
    const tab = resolveTarget(projectId, tabId);
    const leaseId = tab.leaseId;
    const url = tab.url;
    const target = fingerprint(tab.projectId, tab.tabId, leaseId, url);
    if (!target || target.projectId !== tab.projectId || target.tabId !== tab.tabId
      || typeof target.leaseDigest !== 'string' || typeof target.urlDigest !== 'string'
      || tabs.get(keyFor(projectId, tab.tabId)) !== tab || tab.leaseId !== leaseId || tab.url !== url
      || now() >= tab.leaseExpiresAt) {
      throw new BrowserBrokerError('BAD_REQUEST', 'invalid browser target fingerprint', 400);
    }
    return target;
  }

  function isApprovalTargetCurrent<T extends BrowserApprovalTarget>(
    target: T,
    fingerprint: BrowserApprovalFingerprinter<T>,
  ): boolean {
    sweep();
    const tab = tabs.get(keyFor(target.projectId, target.tabId));
    if (!tab) return false;
    const leaseId = tab.leaseId;
    const url = tab.url;
    const current = fingerprint(tab.projectId, tab.tabId, leaseId, url);
    return !!current && current.projectId === target.projectId && current.tabId === target.tabId
      && current.leaseDigest === target.leaseDigest && current.urlDigest === target.urlDigest
      && tabs.get(keyFor(target.projectId, target.tabId)) === tab
      && tab.leaseId === leaseId && tab.url === url && now() < tab.leaseExpiresAt;
  }

  /**
   * Check target, expiry and authorization and insert the command without an
   * await. A callback failure after consuming an approval must remain consumed.
   */
  function enqueueIfCurrent<T extends BrowserApprovalTarget>(input: {
    target: T;
    fingerprint: BrowserApprovalFingerprinter<T>;
    authorizeAndConsume: () => undefined;
    request: BrowserOperationRequest;
    expiresAtMs: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): { result: Promise<{ commandId: string; tab: BrowserTabIdentity; result: BrowserOperationResult }> } {
    const check = () => {
      assertNotAborted(input.signal);
      if (!Number.isFinite(input.expiresAtMs) || now() >= input.expiresAtMs) {
        throw new BrowserBrokerError('FORBIDDEN', 'browser approval has expired', 403);
      }
      if (!isApprovalTargetCurrent(input.target, input.fingerprint)) {
        throw new BrowserBrokerError('BROWSER_LEASE_CONFLICT', 'browser target changed before dispatch', 409);
      }
    };
    check();
    const returned: unknown = input.authorizeAndConsume();
    if (returned !== undefined) {
      if (returned && typeof (returned as { then?: unknown }).then === 'function') {
        void Promise.resolve(returned).catch(() => {});
      }
      throw new BrowserBrokerError('FORBIDDEN', 'browser approval validation must be synchronous', 403);
    }
    // A trusted callback can still synchronously change the target or clock.
    // Recheck after it and never enqueue if it did; consumption is not undone.
    check();
    const tab = tabs.get(keyFor(input.target.projectId, input.target.tabId));
    if (!tab) throw new BrowserBrokerError('BROWSER_TAB_NOT_FOUND', 'browser tab is not registered', 404);
    return { result: enqueueCommand(tab, input.request, input.timeoutMs, input.signal) };
  }

  function submitResult(
    projectId: string,
    tabId: string,
    commandId: string,
    input: SubmitBrowserCommandResultRequest,
  ): void {
    requireLease(projectId, tabId, input.leaseId);
    const pending = commands.get(commandId);
    if (!pending || pending.command.tab.projectId !== projectId || pending.command.tab.tabId !== tabId) {
      throw new BrowserBrokerError(
        'BROWSER_COMMAND_NOT_FOUND',
        `browser command is not pending: ${commandId}`,
        404,
      );
    }
    if (!pending.claimedByLeaseId) {
      throw new BrowserBrokerError(
        'BROWSER_COMMAND_NOT_FOUND',
        `browser command was not claimed by the renderer: ${commandId}`,
        409,
      );
    }
    if (pending.claimedByLeaseId !== input.leaseId) {
      throw new BrowserBrokerError(
        'BROWSER_LEASE_CONFLICT',
        `browser command belongs to another renderer lease: ${commandId}`,
        409,
      );
    }
    if (input.ok && input.result.operation !== pending.command.request.operation) {
      throw new BrowserBrokerError(
        'BAD_REQUEST',
        `browser result operation does not match command ${pending.command.request.operation}`,
        400,
      );
    }
    detachPending(pending);
    if (input.ok) {
      pending.resolve(input.result);
      return;
    }
    pending.reject(new BrowserBrokerError(
      'BROWSER_COMMAND_FAILED',
      input.error.message,
      502,
      {
        commandId,
        rendererError: {
          code: input.error.code,
          message: input.error.message,
          details: input.error.details ?? null,
          retryable: input.error.retryable ?? false,
        },
      },
    ));
  }

  function shutdown(): void {
    clearInterval(cleanupTimer);
    for (const tab of [...tabs.values()]) expireTab(tab);
  }

  const cleanupTimer = setInterval(sweep, options.cleanupIntervalMs ?? 5_000);
  cleanupTimer.unref?.();

  return {
    registerTab,
    renewLease,
    releaseLease,
    listTabs,
    selectActiveTab,
    nextCommand,
    execute,
    captureApprovalTarget,
    isApprovalTargetCurrent,
    enqueueIfCurrent,
    submitResult,
    sweep,
    shutdown,
  };
}

export type BrowserCommandBroker = ReturnType<typeof createBrowserCommandBroker>;

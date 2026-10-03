import type {
  ExecuteBrowserCommandResponse,
  BrowserOperationRequest,
  BrowserOperationResult,
  BrowserTabsResponse,
  BrowserViewportId,
  JsonValue,
} from '@open-design/contracts';
import { isBrowserStylePatch, isBrowserStyleInspection } from '@open-design/contracts';
import {
  getOpenDesignHost,
  type OpenDesignHostBrowserExecuteResult,
  type OpenDesignHostBrowserOperation,
} from '@open-design/host';

export const EMBEDDED_BROWSER_CONTROL_ROUTES = {
  active: (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/active-tab`,
  execute: (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/commands`,
  list: (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs`,
  nextCommand: (projectId: string, tabId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/${encodeURIComponent(tabId)}/commands/next`,
  register: (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/register`,
  renew: (projectId: string, tabId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/${encodeURIComponent(tabId)}/lease`,
  result: (projectId: string, tabId: string, commandId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/${encodeURIComponent(tabId)}/commands/${encodeURIComponent(commandId)}/result`,
  unregister: (projectId: string, tabId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/${encodeURIComponent(tabId)}/lease`,
} as const;

export interface EmbeddedBrowserTarget {
  active: boolean;
  projectId: string;
  tabId: string;
  title: string;
  url: string;
  webContentsId: number;
}

export interface EmbeddedBrowserControlMetadata {
  browser: {
    tabId: string;
    webContentsId: number;
  };
}

export type EmbeddedBrowserControlStatus =
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'error';

export interface EmbeddedBrowserCommand {
  commandId: string;
  expiresAt: number;
  request: BrowserOperationRequest;
}

type HostBrowserControlBridge = {
  execute(request: {
    expiresAt?: number;
    operation: OpenDesignHostBrowserOperation;
    tabId: string;
  }): Promise<OpenDesignHostBrowserExecuteResult>;
  registerTarget(target: {
    projectId: string;
    tabId: string;
    title?: string;
    url: string;
    webContentsId: number;
  }): Promise<unknown>;
  unregisterTarget(target: { tabId: string }): Promise<unknown>;
};

export interface EmbeddedBrowserControlSession {
  ready: Promise<boolean>;
  stop(): Promise<void>;
  updateTarget(target: EmbeddedBrowserTarget): void;
}

export interface EmbeddedBrowserControlSessionOptions {
  applyStyle?: (request: Extract<BrowserOperationRequest, { operation: 'style' }>, expiresAt?: number) => Promise<JsonValue>;
  applyViewport?: (preset: BrowserViewportId, expiresAt?: number) => Promise<{ preset: BrowserViewportId; width: number; height: number }>;
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  hostBridge?: HostBrowserControlBridge | null;
  onStatus?: (status: EmbeddedBrowserControlStatus) => void;
  target: EmbeddedBrowserTarget;
}

export function browserControlMetadata(
  target: Pick<EmbeddedBrowserTarget, 'tabId' | 'webContentsId'>,
): EmbeddedBrowserControlMetadata {
  return {
    browser: {
      tabId: target.tabId,
      webContentsId: target.webContentsId,
    },
  };
}

export function readBrowserControlMetadata(value: unknown): EmbeddedBrowserControlMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const browser = (metadata as { browser?: unknown }).browser;
  if (!browser || typeof browser !== 'object') return null;
  const tabId = (browser as { tabId?: unknown }).tabId;
  const webContentsId = (browser as { webContentsId?: unknown }).webContentsId;
  if (typeof tabId !== 'string' || !tabId || !isPositiveInteger(webContentsId)) return null;
  return { browser: { tabId, webContentsId } };
}

export function withBrowserControlMetadata<T extends object>(
  value: T,
  target: Pick<EmbeddedBrowserTarget, 'tabId' | 'webContentsId'> | null,
): T & { metadata?: EmbeddedBrowserControlMetadata } {
  if (!target) return value;
  return {
    ...value,
    metadata: browserControlMetadata(target),
  };
}

export async function listEmbeddedBrowserTargets(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  headers?: HeadersInit,
): Promise<BrowserTabsResponse> {
  const response = await fetchImpl(EMBEDDED_BROWSER_CONTROL_ROUTES.list(projectId), {
    cache: 'no-store',
    ...(headers ? { headers } : {}),
  });
  if (!response.ok) {
    throw new Error(`browser target list failed (${response.status})`);
  }
  return await response.json() as BrowserTabsResponse;
}

export async function setActiveEmbeddedBrowserTarget(
  projectId: string,
  tabId: string | null,
  fetchImpl: typeof fetch = fetch,
  headers?: HeadersInit,
): Promise<void> {
  await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.active(projectId),
    'PUT',
    { tabId },
    undefined,
    headers,
  );
}

export async function executeEmbeddedBrowserOperation(
  projectId: string,
  command: BrowserOperationRequest,
  options: {
    fetchImpl?: typeof fetch;
    headers?: HeadersInit;
    tabId?: string;
    timeoutMs?: number;
  } = {},
): Promise<ExecuteBrowserCommandResponse> {
  const value = await requestJson(
    options.fetchImpl ?? fetch,
    EMBEDDED_BROWSER_CONTROL_ROUTES.execute(projectId),
    'POST',
    {
      command,
      ...(options.tabId ? { tabId: options.tabId } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
    undefined,
    options.headers,
  );
  if (!isRecord(value) || !isRecord(value.result) || typeof value.commandId !== 'string') {
    throw new Error('browser command returned an invalid response');
  }
  return value as unknown as ExecuteBrowserCommandResponse;
}

export function createEmbeddedBrowserControlSession(
  options: EmbeddedBrowserControlSessionOptions,
): EmbeddedBrowserControlSession {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = options.headers;
  const host = options.hostBridge ?? readHostBrowserControlBridge();
  const controller = new AbortController();
  let currentTarget = options.target;
  let hostRegistered = false;
  let leaseId: string | null = null;
  let stopped = false;
  let cleanupPromise: Promise<void> | null = null;
  let updateChain = Promise.resolve();

  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;
    stopped = true;
    controller.abort();
    const target = currentTarget;
    const activeLeaseId = leaseId;
    cleanupPromise = Promise.allSettled([
      ...(host && hostRegistered ? [host.unregisterTarget({ tabId: target.tabId })] : []),
      ...(activeLeaseId
        ? [releaseBrowserTarget(fetchImpl, activeLeaseId, target, headers)]
        : []),
    ]).then(() => undefined);
    return cleanupPromise;
  };

  const fail = async () => {
    if (stopped) return;
    options.onStatus?.('error');
    await cleanup();
  };

  const relayCommands = async () => {
    while (!stopped && leaseId) {
      const command = await nextBrowserCommand(
        fetchImpl,
        leaseId,
        currentTarget,
        controller.signal,
        headers,
      );
      if (stopped || !command) continue;
      const result = await executeBrowserCommand(
        host!,
        currentTarget.tabId,
        command.request,
        command.expiresAt,
        options.applyViewport,
        options.applyStyle,
      );
      await submitBrowserCommandResult(
        fetchImpl,
        leaseId,
        currentTarget,
        command.commandId,
        result,
        controller.signal,
        headers,
      );
    }
  };

  const registerHostTarget = async () => {
    if (!host) return false;
    for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) {
      const result = await host.registerTarget(hostTarget(currentTarget));
      if (!isRecord(result) || result.ok !== false) return true;
      const reason = typeof result.reason === 'string' ? result.reason : '';
      const transient = reason.includes('not an attached approved Design Browser guest')
        || reason.includes('URL does not match the attached guest');
      if (!transient || attempt === 19) assertHostSuccess(result, 'register target');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    return false;
  };

  const ready = (async () => {
    if (!host) {
      options.onStatus?.('unavailable');
      return false;
    }
    options.onStatus?.('connecting');
    try {
      if (!await registerHostTarget()) return false;
      hostRegistered = true;
      if (stopped) {
        await host.unregisterTarget({ tabId: currentTarget.tabId });
        return false;
      }
      const registration = await registerBrowserTarget(
        fetchImpl,
        currentTarget,
        controller.signal,
        headers,
      );
      leaseId = registration.leaseId;
      if (currentTarget.active) {
        await selectActiveBrowserTarget(fetchImpl, currentTarget, controller.signal, headers);
      }
      if (stopped) {
        await cleanup();
        return false;
      }
      options.onStatus?.('connected');
      void relayCommands().catch((error) => {
        if (!isAbortError(error)) void fail();
      });
      return true;
    } catch (error) {
      if (!isAbortError(error)) await fail();
      return false;
    }
  })();

  return {
    ready,
    stop: cleanup,
    updateTarget(target) {
      currentTarget = target;
      if (stopped) return;
      updateChain = updateChain.then(async () => {
        if (stopped || !host || !hostRegistered || !leaseId) return;
        try {
          assertHostSuccess(await host.registerTarget(hostTarget(currentTarget)), 'update target');
          await renewBrowserTarget(
            fetchImpl,
            leaseId,
            currentTarget,
            controller.signal,
            headers,
          );
          if (currentTarget.active) {
            await selectActiveBrowserTarget(
              fetchImpl,
              currentTarget,
              controller.signal,
              headers,
            );
          }
        } catch (error) {
          if (!isAbortError(error)) await fail();
        }
      });
    },
  };
}

function readHostBrowserControlBridge(): HostBrowserControlBridge | null {
  const browser = getOpenDesignHost()?.browser;
  if (
    !browser
    || typeof browser.registerTarget !== 'function'
    || typeof browser.unregisterTarget !== 'function'
    || typeof browser.execute !== 'function'
  ) {
    return null;
  }
  return {
    execute: browser.execute.bind(browser),
    registerTarget: browser.registerTarget.bind(browser),
    unregisterTarget: browser.unregisterTarget.bind(browser),
  };
}

function hostTarget(target: EmbeddedBrowserTarget) {
  return {
    projectId: target.projectId,
    tabId: target.tabId,
    title: target.title,
    url: target.url,
    webContentsId: target.webContentsId,
  };
}

async function registerBrowserTarget(
  fetchImpl: typeof fetch,
  target: EmbeddedBrowserTarget,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<{ leaseId: string }> {
  const payload = await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.register(target.projectId),
    'POST',
    {
      projectId: target.projectId,
      tabId: target.tabId,
      title: target.title,
      url: target.url,
    },
    signal,
    headers,
  );
  const leaseId = readLeaseId(payload);
  if (!leaseId) throw new Error('browser target registration returned no lease id');
  return { leaseId };
}

async function renewBrowserTarget(
  fetchImpl: typeof fetch,
  leaseId: string,
  target: EmbeddedBrowserTarget,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<void> {
  await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.renew(target.projectId, target.tabId),
    'POST',
    { leaseId, title: target.title, url: target.url },
    signal,
    headers,
  );
}

async function selectActiveBrowserTarget(
  fetchImpl: typeof fetch,
  target: EmbeddedBrowserTarget,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<void> {
  await requestJson(fetchImpl, EMBEDDED_BROWSER_CONTROL_ROUTES.active(target.projectId), 'PUT', {
    tabId: target.tabId,
  }, signal, headers);
}

async function releaseBrowserTarget(
  fetchImpl: typeof fetch,
  leaseId: string,
  target: EmbeddedBrowserTarget,
  headers?: HeadersInit,
): Promise<void> {
  await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.unregister(target.projectId, target.tabId),
    'DELETE',
    { leaseId },
    undefined,
    headers,
  );
}

async function nextBrowserCommand(
  fetchImpl: typeof fetch,
  leaseId: string,
  target: EmbeddedBrowserTarget,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<EmbeddedBrowserCommand | null> {
  const payload = await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.nextCommand(target.projectId, target.tabId),
    'POST',
    { leaseId, timeoutMs: 25_000 },
    signal,
    headers,
  );
  if (!isRecord(payload) || payload.command === null) return null;
  const command = payload.command;
  if (
    !isRecord(command)
    || typeof command.commandId !== 'string'
    || !isRecord(command.request)
    || typeof command.expiresAt !== 'number'
    || !Number.isFinite(command.expiresAt)
  ) {
    throw new Error('browser command poll returned an invalid command');
  }
  return {
    commandId: command.commandId,
    expiresAt: command.expiresAt,
    request: command.request as unknown as BrowserOperationRequest,
  };
}

async function submitBrowserCommandResult(
  fetchImpl: typeof fetch,
  leaseId: string,
  target: EmbeddedBrowserTarget,
  commandId: string,
  result: BrowserCommandExecution,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<void> {
  await requestJson(
    fetchImpl,
    EMBEDDED_BROWSER_CONTROL_ROUTES.result(target.projectId, target.tabId, commandId),
    'POST',
    result.ok
      ? { leaseId, ok: true, result: result.result }
      : { leaseId, ok: false, error: result.error },
    signal,
    headers,
  );
}

type BrowserCommandExecution =
  | { ok: true; result: BrowserOperationResult }
  | {
      ok: false;
      error: {
        code: 'BROWSER_COMMAND_FAILED';
        message: string;
      };
    };

let viewportFailureDiagnostics = 0;
const VIEWPORT_DIAGNOSTIC_REASONS = new Set([
  'Browser viewport is not ready',
  'Browser viewport is no longer available',
  'Activate this browser tab before changing its viewport',
  'Browser viewport changed while applying the preset; retry the command',
  'Browser viewport has no visible frame',
  'Browser command expired before execution.',
  'Native popup support is unavailable',
  'Native popup did not apply the requested viewport bounds',
  'invalid popup presentation',
  'popup presentation was superseded',
  'invalid popup bounds',
]);

async function executeBrowserCommand(
  host: HostBrowserControlBridge,
  tabId: string,
  request: BrowserOperationRequest,
  expiresAt: number,
  applyViewport?: EmbeddedBrowserControlSessionOptions['applyViewport'],
  applyStyle?: EmbeddedBrowserControlSessionOptions['applyStyle'],
): Promise<BrowserCommandExecution> {
  try {
    if (request.operation === 'style') {
      if (Date.now() >= expiresAt) return browserCommandFailure('Browser command expired before execution.');
      if (request.approved !== true || !isBrowserStylePatch(request.styles)
        || typeof request.target?.selector !== 'string' || !request.target.selector.trim()
        || request.target.selector.length > 8_192) return browserCommandFailure('Browser style command requires approval, a target and allowed styles.');
      if (!applyStyle) return browserCommandFailure('This browser tab does not support style editing.');
      const inspection = await applyStyle(request, expiresAt);
      if (Date.now() >= expiresAt) return browserCommandFailure('Browser command expired before completion.');
      if (!isBrowserStyleInspection(inspection) || (inspection as { selector: string }).selector !== request.target.selector.trim()) {
        return browserCommandFailure('Browser style command returned no measured target.');
      }
      return { ok: true, result: { operation: 'style', applied: true, inspection } };
    }
    if (request.operation === 'viewport') {
      if (Date.now() >= expiresAt) return browserCommandFailure('Browser command expired before execution.');
      if (!applyViewport) return browserCommandFailure('This browser tab does not support viewport selection.');
      return { ok: true, result: { operation: 'viewport', ...await applyViewport(request.preset, expiresAt) } };
    }
    const operation = hostOperationFromCommand(request);
    const result = await host.execute({ expiresAt, operation, tabId });
    if (!result.ok) {
      return browserCommandFailure(result.reason);
    }
    return {
      ok: true,
      result: browserOperationResultFromHost(request, result),
    };
  } catch (error) {
    if (request.operation === 'viewport' && viewportFailureDiagnostics++ < 40) {
      const message = error instanceof Error ? error.message : '';
      console.warn(JSON.stringify({ logger: 'browser.viewport.command', event: 'failed', preset: request.preset,
        reason: VIEWPORT_DIAGNOSTIC_REASONS.has(message) ? message : 'unclassified-viewport-failure' }));
    }
    return browserCommandFailure(
      error instanceof Error ? error.message : 'Browser command failed.',
    );
  }
}

function hostOperationFromCommand(request: Exclude<BrowserOperationRequest, { operation: 'viewport' | 'style' }>): OpenDesignHostBrowserOperation {
  switch (request.operation) {
    case 'snapshot':
      return { kind: 'snapshot' };
    case 'inspect':
      return { kind: 'inspect', selector: selectorTarget(request.target) };
    case 'screenshot':
      return {
        kind: 'screenshot',
        ...(request.fullPage === undefined ? {} : { fullPage: request.fullPage }),
        ...(request.format === undefined ? {} : { format: request.format }),
        ...(request.quality === undefined ? {} : { quality: request.quality }),
      };
    case 'click':
      return {
        approved: request.approved,
        kind: 'click',
        selector: selectorTarget(request.target),
        ...(request.button === undefined ? {} : { button: request.button }),
        ...(request.clickCount === undefined ? {} : { clickCount: request.clickCount }),
      };
    case 'type':
      return {
        approved: request.approved,
        kind: 'type',
        selector: selectorTarget(request.target),
        text: request.text,
        ...(request.clear === undefined ? {} : { clear: request.clear }),
      };
    case 'scroll':
      return {
        approved: request.approved,
        deltaX: request.deltaX,
        deltaY: request.deltaY,
        kind: 'scroll',
        ...(request.target === undefined
          ? {}
          : { selector: selectorTarget(request.target) }),
      };
    case 'navigate':
      return {
        approved: request.approved,
        kind: 'navigate',
        url: request.url,
        ...(request.waitUntil === undefined ? {} : { waitUntil: request.waitUntil }),
      };
    case 'console':
      return {
        kind: 'console',
        ...(request.level === undefined ? {} : { level: request.level }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      };
    case 'network-list':
      return {
        kind: 'network',
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.resourceType === undefined ? {} : { resourceType: request.resourceType }),
      };
    case 'network-get':
      return { kind: 'network', requestId: request.requestId };
    case 'network-failures':
      return {
        failuresOnly: true,
        kind: 'network',
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      };
  }
}

function browserOperationResultFromHost(
  request: Exclude<BrowserOperationRequest, { operation: 'viewport' | 'style' }>,
  result: Extract<OpenDesignHostBrowserExecuteResult, { ok: true }>,
): BrowserOperationResult {
  switch (request.operation) {
    case 'snapshot':
      if (result.operation !== 'snapshot') throw mismatchedHostResult(request, result.operation);
      return { operation: 'snapshot', snapshot: result.value as never };
    case 'inspect':
      if (result.operation !== 'inspect') throw mismatchedHostResult(request, result.operation);
      return { operation: 'inspect', inspection: result.value as never };
    case 'screenshot': {
      if (result.operation !== 'screenshot') throw mismatchedHostResult(request, result.operation);
      return {
        operation: 'screenshot',
        data: result.value.dataUrl,
        mimeType: result.value.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      };
    }
    case 'click':
      if (result.operation !== 'click') throw mismatchedHostResult(request, result.operation);
      return { operation: 'click', clicked: true, details: result.value as never };
    case 'type':
      if (result.operation !== 'type') throw mismatchedHostResult(request, result.operation);
      return { operation: 'type', typed: true, details: result.value as never };
    case 'scroll':
      if (result.operation !== 'scroll') throw mismatchedHostResult(request, result.operation);
      return { operation: 'scroll', scrolled: true, details: result.value as never };
    case 'navigate': {
      if (result.operation !== 'navigate') throw mismatchedHostResult(request, result.operation);
      return { operation: 'navigate', url: result.value.url };
    }
    case 'console': {
      if (result.operation !== 'console') throw mismatchedHostResult(request, result.operation);
      return { operation: 'console', entries: result.value.entries as never[] };
    }
    case 'network-list': {
      if (result.operation !== 'network') throw mismatchedHostResult(request, result.operation);
      return { operation: 'network-list', entries: result.value.requests as never[] };
    }
    case 'network-get': {
      if (result.operation !== 'network') throw mismatchedHostResult(request, result.operation);
      const entry = result.value.requests.find((item) => item.requestId === request.requestId);
      if (!entry) throw new Error(`Network request ${request.requestId} was not found.`);
      return { operation: 'network-get', entry: entry as never };
    }
    case 'network-failures': {
      if (result.operation !== 'network') throw mismatchedHostResult(request, result.operation);
      return {
        operation: 'network-failures',
        entries: result.value.requests.filter((item) => item.failed) as never[],
      };
    }
  }
}

function selectorTarget(target: { selector: string }): string {
  return target.selector;
}

function mismatchedHostResult(
  request: BrowserOperationRequest,
  operation: string,
): Error {
  return new Error(
    `Host returned ${operation} for ${request.operation} browser command.`,
  );
}

function browserCommandFailure(message: string): BrowserCommandExecution {
  return {
    ok: false,
    error: {
      code: 'BROWSER_COMMAND_FAILED',
      message,
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  method: 'DELETE' | 'POST' | 'PUT',
  body: unknown,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Promise<unknown> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Content-Type', 'application/json');
  const response = await fetchImpl(url, {
    method,
    headers: Object.fromEntries(requestHeaders.entries()),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} failed (${response.status})`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

function readLeaseId(value: unknown): string {
  return isRecord(value) && typeof value.leaseId === 'string' ? value.leaseId : '';
}

function assertHostSuccess(value: unknown, action: string): void {
  if (!isRecord(value) || value.ok !== false) return;
  const reason = typeof value.reason === 'string' ? value.reason : `${action} failed`;
  throw new Error(reason);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError')
  );
}

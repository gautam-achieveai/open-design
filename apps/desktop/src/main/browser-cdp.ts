import type { Session, WebContents } from "electron";
import type {
  OpenDesignHostActionResult,
  OpenDesignHostBrowserBoxModel,
  OpenDesignHostBrowserConsoleEntry,
  OpenDesignHostBrowserDomNode,
  OpenDesignHostBrowserExecuteRequest,
  OpenDesignHostBrowserExecuteResult,
  OpenDesignHostBrowserInspectedElement,
  OpenDesignHostBrowserListTargetsResult,
  OpenDesignHostBrowserNetworkRequest,
  OpenDesignHostBrowserOperation,
  OpenDesignHostBrowserRegisterTargetResult,
  OpenDesignHostBrowserTarget,
  OpenDesignHostBrowserTargetIdentity,
  OpenDesignHostBrowserTargetRegistration,
} from "@open-design/host";

export const DESIGN_BROWSER_PARTITION = "persist:open-design-design-browser";

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_REQUESTS = 200;
const MAX_NETWORK_BODY_BYTES = 64 * 1024;
const MAX_DOM_NODES = 2_000;
const MAX_TYPE_TEXT_LENGTH = 100_000;
const MAX_ID_LENGTH = 128;
const MAX_SELECTOR_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 8_192;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 3 * 1024 * 1024;
const REDACTED = "[redacted]";
const SENSITIVE_FIELD = /(?:authorization|cookie|credential|password|passwd|secret|session|token|api[_-]?key|access[_-]?key|client[_-]?secret)/i;

type UnknownRecord = Record<string, unknown>;

type AttachedGuest = {
  consoleEntries: OpenDesignHostBrowserConsoleEntry[];
  guest: WebContents;
  networkById: Map<string, OpenDesignHostBrowserNetworkRequest>;
  networkOrder: string[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function failure(reason: string, details?: unknown): OpenDesignHostExecuteFailure {
  return {
    ...(details === undefined ? {} : { details }),
    ok: false,
    reason,
  };
}

type OpenDesignHostExecuteFailure = Extract<OpenDesignHostBrowserExecuteResult, { ok: false }>;

export function isAllowedDesignBrowserUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:"
      || parsed.protocol === "https:"
      || (parsed.protocol === "about:" && parsed.pathname === "blank")
    );
  } catch {
    return false;
  }
}

function canonicalBrowserUrl(url: string): string | null {
  if (!isAllowedDesignBrowserUrl(url)) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export function redactBrowserHeaders(headers: unknown): Record<string, string> {
  if (!isRecord(headers)) return {};
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_FIELD.test(name)
      ? REDACTED
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  }
  return redacted;
}

export function redactBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_FIELD.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.href;
  } catch {
    return url.replace(
      /((?:authorization|credential|password|passwd|secret|session|token|api[_-]?key)=)[^&\s]*/gi,
      `$1${REDACTED}`,
    );
  }
}

function redactStructuredBody(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactStructuredBody(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactStructuredBody(entryValue, entryKey),
    ]),
  );
}

function boundBody(body: string): string {
  const bytes = Buffer.byteLength(body);
  if (bytes <= MAX_NETWORK_BODY_BYTES) return body;
  let end = Math.min(body.length, MAX_NETWORK_BODY_BYTES);
  while (end > 0 && Buffer.byteLength(body.slice(0, end)) > MAX_NETWORK_BODY_BYTES) end -= 1;
  return `${body.slice(0, end)}\n[truncated ${bytes - Buffer.byteLength(body.slice(0, end))} bytes]`;
}

export function redactBrowserBody(body: unknown, contentType = ""): string | undefined {
  if (typeof body !== "string" || body.length === 0) return undefined;
  const lowerContentType = contentType.toLowerCase();
  if (lowerContentType.includes("json") || /^[\s]*[\[{]/.test(body)) {
    try {
      return boundBody(JSON.stringify(redactStructuredBody(JSON.parse(body))));
    } catch {
      // Preserve malformed/non-JSON evidence after applying the generic pass.
    }
  }
  if (lowerContentType.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) {
      if (SENSITIVE_FIELD.test(key)) params.set(key, REDACTED);
    }
    return boundBody(params.toString());
  }
  return boundBody(body.replace(
    /((?:authorization|cookie|credential|password|passwd|secret|session|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)([^&,\s]+)/gi,
    `$1${REDACTED}`,
  ));
}

function pushBounded<T>(entries: T[], entry: T, max: number): void {
  entries.push(entry);
  if (entries.length > max) entries.splice(0, entries.length - max);
}

function attributesRecord(attributes: unknown): Record<string, string> {
  if (!Array.isArray(attributes)) return {};
  const output: Record<string, string> = {};
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = stringValue(attributes[index]);
    const value = stringValue(attributes[index + 1]);
    if (name !== undefined && value !== undefined) output[name] = value;
  }
  return output;
}

function mapDomNode(raw: unknown, budget: { remaining: number; truncated: boolean }): OpenDesignHostBrowserDomNode {
  const node = isRecord(raw) ? raw : {};
  budget.remaining -= 1;
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  const children: OpenDesignHostBrowserDomNode[] = [];
  for (const child of rawChildren) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    children.push(mapDomNode(child, budget));
  }
  return {
    attributes: attributesRecord(node.attributes),
    backendNodeId: safeInteger(node.backendNodeId) ?? 0,
    childNodeCount: safeInteger(node.childNodeCount) ?? rawChildren.length,
    ...(children.length > 0 ? { children } : {}),
    localName: stringValue(node.localName) ?? "",
    nodeName: stringValue(node.nodeName) ?? "",
    nodeType: safeInteger(node.nodeType) ?? 0,
    nodeValue: stringValue(node.nodeValue) ?? "",
  };
}

function boundedLimit(value: unknown, fallback = 100): number {
  const parsed = safeInteger(value);
  return parsed === undefined ? fallback : Math.max(1, Math.min(MAX_NETWORK_REQUESTS, parsed));
}

function parseTargetRegistration(value: unknown): OpenDesignHostBrowserTargetRegistration | null {
  if (!isRecord(value)) return null;
  const projectId = stringValue(value.projectId)?.trim();
  const tabId = stringValue(value.tabId)?.trim();
  const title = stringValue(value.title);
  const url = stringValue(value.url);
  const webContentsId = safeInteger(value.webContentsId);
  if (
    !projectId
    || projectId.length > MAX_ID_LENGTH
    || !tabId
    || tabId.length > MAX_ID_LENGTH
    || !url
    || url.length > MAX_URL_LENGTH
    || (title?.length ?? 0) > MAX_TITLE_LENGTH
    || webContentsId === undefined
    || webContentsId <= 0
  ) return null;
  return { projectId, tabId, ...(title === undefined ? {} : { title }), url, webContentsId };
}

function parseTargetIdentity(value: unknown): OpenDesignHostBrowserTargetIdentity | null {
  if (!isRecord(value)) return null;
  const tabId = stringValue(value.tabId)?.trim();
  return tabId && tabId.length <= MAX_ID_LENGTH ? { tabId } : null;
}

function parseOperation(value: unknown): OpenDesignHostBrowserOperation | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "snapshot":
      return { kind: "snapshot", ...(safeInteger(value.depth) === undefined ? {} : { depth: safeInteger(value.depth) }) };
    case "inspect": {
      const selector = stringValue(value.selector);
      return selector && selector.length <= MAX_SELECTOR_LENGTH ? { kind: "inspect", selector } : null;
    }
    case "screenshot": {
      const format = value.format === "jpeg" || value.format === "webp" ? value.format : "png";
      const quality = safeInteger(value.quality);
      return {
        kind: "screenshot",
        format,
        ...(value.fullPage === true ? { fullPage: true } : {}),
        ...(quality === undefined ? {} : { quality: Math.max(0, Math.min(100, quality)) }),
      };
    }
    case "click": {
      const selector = stringValue(value.selector);
      if (!selector || selector.length > MAX_SELECTOR_LENGTH || value.approved !== true) return null;
      const button = value.button === "middle" || value.button === "right" ? value.button : "left";
      const clickCount = Math.max(1, Math.min(3, safeInteger(value.clickCount) ?? 1));
      return { approved: true, button, clickCount, kind: "click", selector };
    }
    case "type": {
      const selector = stringValue(value.selector);
      const text = stringValue(value.text);
      if (
        !selector
        || selector.length > MAX_SELECTOR_LENGTH
        || text === undefined
        || text.length > MAX_TYPE_TEXT_LENGTH
        || value.approved !== true
      ) return null;
      return { approved: true, ...(value.clear === true ? { clear: true } : {}), kind: "type", selector, text };
    }
    case "scroll": {
      const deltaY = finiteNumber(value.deltaY);
      if (deltaY === undefined || value.approved !== true) return null;
      const deltaX = finiteNumber(value.deltaX);
      const selector = stringValue(value.selector);
      if (selector !== undefined && selector.length > MAX_SELECTOR_LENGTH) return null;
      return {
        approved: true,
        ...(deltaX === undefined ? {} : { deltaX }),
        deltaY,
        kind: "scroll",
        ...(selector === undefined ? {} : { selector }),
      };
    }
    case "navigate": {
      const url = stringValue(value.url);
      const waitUntil = value.waitUntil === "load"
        || value.waitUntil === "domcontentloaded"
        || value.waitUntil === "networkidle"
        ? value.waitUntil
        : undefined;
      return url && value.approved === true && isAllowedDesignBrowserUrl(url)
        ? { approved: true, kind: "navigate", url, ...(waitUntil ? { waitUntil } : {}) }
        : null;
    }
    case "console": {
      const level = value.level === "all"
        || value.level === "debug"
        || value.level === "info"
        || value.level === "warning"
        || value.level === "error"
        ? value.level
        : undefined;
      return {
        kind: "console",
        ...(level === undefined ? {} : { level }),
        limit: boundedLimit(value.limit),
      };
    }
    case "network":
      return {
        kind: "network",
        ...(value.failuresOnly === true ? { failuresOnly: true } : {}),
        limit: boundedLimit(value.limit),
        ...(stringValue(value.requestId) === undefined ? {} : { requestId: stringValue(value.requestId) }),
        ...(stringValue(value.resourceType) === undefined
          ? {}
          : { resourceType: stringValue(value.resourceType) }),
      };
    default:
      return null;
  }
}

function parseExecuteRequest(value: unknown): OpenDesignHostBrowserExecuteRequest | null {
  if (!isRecord(value)) return null;
  const tabId = stringValue(value.tabId)?.trim();
  const operation = parseOperation(value.operation);
  return tabId && tabId.length <= MAX_ID_LENGTH && operation ? { operation, tabId } : null;
}

function targetSnapshot(registration: OpenDesignHostBrowserTargetRegistration, guest: WebContents): OpenDesignHostBrowserTarget {
  return {
    ...registration,
    attached: guest.debugger.isAttached() && !guest.isDestroyed(),
    title: guest.getTitle() || registration.title || "",
    url: guest.getURL(),
  };
}

function guestHasApprovedIdentity(guest: WebContents, designBrowserSession: Session): boolean {
  return (
    !guest.isDestroyed()
    && guest.getType() === "webview"
    && guest.session === designBrowserSession
  );
}

async function queryNodeId(guest: WebContents, selector: string): Promise<number | null> {
  const document = await guest.debugger.sendCommand("DOM.getDocument", { depth: 0, pierce: true }) as UnknownRecord;
  const root = isRecord(document.root) ? document.root : {};
  const rootNodeId = safeInteger(root.nodeId);
  if (rootNodeId === undefined) return null;
  const result = await guest.debugger.sendCommand("DOM.querySelector", { nodeId: rootNodeId, selector }) as UnknownRecord;
  const nodeId = safeInteger(result.nodeId);
  return nodeId && nodeId > 0 ? nodeId : null;
}

function boxModelFromResult(value: unknown): OpenDesignHostBrowserBoxModel | undefined {
  if (!isRecord(value) || !isRecord(value.model)) return undefined;
  const model = value.model;
  const numberArray = (candidate: unknown): number[] =>
    Array.isArray(candidate) ? candidate.filter((entry): entry is number => typeof entry === "number") : [];
  return {
    border: numberArray(model.border),
    content: numberArray(model.content),
    height: finiteNumber(model.height) ?? 0,
    margin: numberArray(model.margin),
    padding: numberArray(model.padding),
    width: finiteNumber(model.width) ?? 0,
  };
}

function quadCenter(quad: number[]): { x: number; y: number } | null {
  if (quad.length < 8) return null;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

function remoteObjectText(value: unknown): string {
  if (!isRecord(value)) return String(value);
  if (value.value !== undefined) {
    try {
      return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
    } catch {
      return String(value.value);
    }
  }
  return stringValue(value.description) ?? stringValue(value.type) ?? "";
}

function requestContentType(request: OpenDesignHostBrowserNetworkRequest): string {
  const entry = Object.entries(request.responseHeaders ?? request.requestHeaders)
    .find(([name]) => name.toLowerCase() === "content-type");
  return entry?.[1] ?? "";
}

function waitForNavigationReadiness(
  guest: WebContents,
  waitUntil: "load" | "domcontentloaded" | "networkidle",
): { promise: Promise<void>; cancel(): void } {
  const event = waitUntil === "domcontentloaded"
    ? "dom-ready"
    : waitUntil === "networkidle"
      ? "did-stop-loading"
      : "did-finish-load";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const removeReadyListener = () => {
    if (event === "dom-ready") guest.off("dom-ready", onReady);
    else if (event === "did-stop-loading") guest.off("did-stop-loading", onReady);
    else guest.off("did-finish-load", onReady);
  };
  const addReadyListener = () => {
    if (event === "dom-ready") guest.once("dom-ready", onReady);
    else if (event === "did-stop-loading") guest.once("did-stop-loading", onReady);
    else guest.once("did-finish-load", onReady);
  };
  const cleanup = () => {
    removeReadyListener();
    guest.off("did-fail-load", onFailed);
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectReady(error);
    else resolveReady();
  };
  const onReady = () => finish();
  const onFailed = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    _validatedUrl: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) finish(new Error(`browser navigation failed (${errorCode}): ${errorDescription}`));
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    addReadyListener();
    guest.on("did-fail-load", onFailed);
    timer = setTimeout(() => finish(new Error(`browser navigation timed out waiting for ${waitUntil}`)), 30_000);
  });
  return { promise, cancel: cleanup };
}

export type DesignBrowserCdpController = {
  attachGuest(guest: WebContents): Promise<void>;
  attachPopup(guest: WebContents): Promise<void>;
  close(): void;
  execute(value: unknown): Promise<OpenDesignHostBrowserExecuteResult>;
  listTargets(): OpenDesignHostBrowserListTargetsResult;
  registerTarget(value: unknown): OpenDesignHostBrowserRegisterTargetResult;
  unregisterTarget(value: unknown): OpenDesignHostActionResult;
};

export function createDesignBrowserCdpController(
  designBrowserSession: Session,
): DesignBrowserCdpController {
  const trustedPopups = new Set<WebContents>();
  const approvedIdentity = (guest: WebContents) => guestHasApprovedIdentity(guest, designBrowserSession) || (trustedPopups.has(guest) && !guest.isDestroyed() && guest.session === designBrowserSession);
  const approved = (guest: WebContents) => approvedIdentity(guest) && isAllowedDesignBrowserUrl(guest.getURL() || "about:blank");
  const attached = new Map<number, AttachedGuest>();
  const registrations = new Map<string, OpenDesignHostBrowserTargetRegistration>();

  const removeGuest = (webContentsId: number): void => {
    const state = attached.get(webContentsId);
    attached.delete(webContentsId);
    if (state) trustedPopups.delete(state.guest);
    for (const [tabId, registration] of registrations) {
      if (registration.webContentsId === webContentsId) registrations.delete(tabId);
    }
    if (state && !state.guest.isDestroyed() && state.guest.debugger.isAttached()) {
      try {
        state.guest.debugger.detach();
      } catch {
        // Chromium may already have detached while the guest was being destroyed.
      }
    }
  };

  const attachGuest = async (guest: WebContents): Promise<void> => {
    if (
      !approvedIdentity(guest)
      || (guest.getURL() !== "" && !isAllowedDesignBrowserUrl(guest.getURL()))
    ) {
      throw new Error("embedded browser guest is not approved for CDP");
    }
    if (attached.has(guest.id)) return;
    const state: AttachedGuest = {
      consoleEntries: [],
      guest,
      networkById: new Map(),
      networkOrder: [],
    };
    attached.set(guest.id, state);
    guest.once("destroyed", () => removeGuest(guest.id));
    guest.debugger.on("detach", () => removeGuest(guest.id));
    guest.debugger.on("message", (_event, method, params) => {
      const payload = isRecord(params) ? params : {};
      if (method === "Runtime.consoleAPICalled") {
        const args = Array.isArray(payload.args) ? payload.args.map(remoteObjectText) : [];
        pushBounded(state.consoleEntries, {
          level: stringValue(payload.type) ?? "log",
          source: "console-api",
          text: args.join(" "),
          timestamp: finiteNumber(payload.timestamp) ?? Date.now(),
        }, MAX_CONSOLE_ENTRIES);
        return;
      }
      if (method === "Log.entryAdded" && isRecord(payload.entry)) {
        pushBounded(state.consoleEntries, {
          level: stringValue(payload.entry.level) ?? "info",
          source: stringValue(payload.entry.source) ?? "log",
          text: stringValue(payload.entry.text) ?? "",
          timestamp: finiteNumber(payload.entry.timestamp) ?? Date.now(),
        }, MAX_CONSOLE_ENTRIES);
        return;
      }
      if (method === "Network.requestWillBeSent" && isRecord(payload.request)) {
        const requestId = stringValue(payload.requestId);
        const url = stringValue(payload.request.url);
        const requestMethod = stringValue(payload.request.method);
        if (!requestId || !url || !requestMethod) return;
        const requestHeaders = redactBrowserHeaders(payload.request.headers);
        const contentType = Object.entries(requestHeaders)
          .find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
        const requestBody = redactBrowserBody(payload.request.postData, contentType);
        const request: OpenDesignHostBrowserNetworkRequest = {
          method: requestMethod,
          requestHeaders,
          requestId,
          ...(requestBody === undefined ? {} : { requestBody }),
          resourceType: stringValue(payload.type),
          startedAt: finiteNumber(payload.timestamp) ?? Date.now(),
          url: redactBrowserUrl(url),
        };
        state.networkById.set(requestId, request);
        state.networkOrder = state.networkOrder.filter((candidate) => candidate !== requestId);
        state.networkOrder.push(requestId);
        while (state.networkOrder.length > MAX_NETWORK_REQUESTS) {
          const evicted = state.networkOrder.shift();
          if (evicted) state.networkById.delete(evicted);
        }
        return;
      }
      if (method === "Network.responseReceived" && isRecord(payload.response)) {
        const requestId = stringValue(payload.requestId);
        const request = requestId ? state.networkById.get(requestId) : undefined;
        if (!request) return;
        request.responseHeaders = redactBrowserHeaders(payload.response.headers);
        request.responseStatus = finiteNumber(payload.response.status);
        request.responseStatusText = stringValue(payload.response.statusText);
        return;
      }
      if (method === "Network.loadingFailed") {
        const requestId = stringValue(payload.requestId);
        const request = requestId ? state.networkById.get(requestId) : undefined;
        if (!request) return;
        request.failed = {
          ...(stringValue(payload.blockedReason) === undefined ? {} : { blockedReason: stringValue(payload.blockedReason) }),
          canceled: payload.canceled === true,
          errorText: stringValue(payload.errorText) ?? "network request failed",
        };
        request.finishedAt = finiteNumber(payload.timestamp) ?? Date.now();
        return;
      }
      if (method === "Network.loadingFinished") {
        const requestId = stringValue(payload.requestId);
        const request = requestId ? state.networkById.get(requestId) : undefined;
        if (!request || !requestId) return;
        request.finishedAt = finiteNumber(payload.timestamp) ?? Date.now();
        void guest.debugger.sendCommand("Network.getResponseBody", { requestId })
          .then((result: unknown) => {
            if (!isRecord(result) || result.base64Encoded === true) return;
            const body = redactBrowserBody(result.body, requestContentType(request));
            if (body !== undefined) request.responseBody = body;
          })
          .catch(() => undefined);
      }
    });
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      await Promise.all([
        guest.debugger.sendCommand("Page.enable"),
        guest.debugger.sendCommand("Runtime.enable"),
        guest.debugger.sendCommand("DOM.enable"),
        guest.debugger.sendCommand("Network.enable", {
          maxPostDataSize: MAX_NETWORK_BODY_BYTES,
          maxResourceBufferSize: MAX_NETWORK_BODY_BYTES,
          maxTotalBufferSize: MAX_NETWORK_BODY_BYTES * 4,
        }),
        guest.debugger.sendCommand("Log.enable"),
      ]);
    } catch (error) {
      removeGuest(guest.id);
      throw error;
    }
  };

  const registerTarget = (value: unknown): OpenDesignHostBrowserRegisterTargetResult => {
    const registration = parseTargetRegistration(value);
    if (!registration) return failure("invalid browser target registration");
    const state = attached.get(registration.webContentsId);
    if (
      !state
      || !approved(state.guest)
      || !state.guest.debugger.isAttached()
    ) {
      return failure("browser target is not an attached approved Design Browser guest");
    }
    if (canonicalBrowserUrl(registration.url) !== canonicalBrowserUrl(state.guest.getURL())) {
      return failure("browser target URL does not match the attached guest");
    }
    const existingForGuest = [...registrations.values()]
      .find((candidate) => candidate.webContentsId === registration.webContentsId && candidate.tabId !== registration.tabId);
    if (existingForGuest) return failure("browser guest is already registered to another tab");
    const existing = registrations.get(registration.tabId);
    if (
      existing
      && (existing.projectId !== registration.projectId || existing.webContentsId !== registration.webContentsId)
    ) {
      return failure("browser tab registration identity does not match");
    }
    registrations.set(registration.tabId, registration);
    return { ok: true, target: targetSnapshot(registration, state.guest) };
  };

  const unregisterTarget = (value: unknown): OpenDesignHostActionResult => {
    const identity = parseTargetIdentity(value);
    if (!identity) return failure("invalid browser target identity");
    registrations.delete(identity.tabId);
    return { ok: true };
  };

  const listTargets = (): OpenDesignHostBrowserListTargetsResult => {
    const targets: OpenDesignHostBrowserTarget[] = [];
    for (const [tabId, registration] of registrations) {
      const state = attached.get(registration.webContentsId);
      if (
        !state
        || !approved(state.guest)
        || !state.guest.debugger.isAttached()
      ) {
        registrations.delete(tabId);
        continue;
      }
      targets.push(targetSnapshot(registration, state.guest));
    }
    return { ok: true, targets };
  };

  const execute = async (value: unknown): Promise<OpenDesignHostBrowserExecuteResult> => {
    const request = parseExecuteRequest(value);
    if (!request) return failure("invalid or unapproved browser operation");
    const registration = registrations.get(request.tabId);
    if (!registration) return failure("browser target is not registered");
    const state = attached.get(registration.webContentsId);
    if (
      !state
      || !approved(state.guest)
      || !state.guest.debugger.isAttached()
    ) {
      registrations.delete(request.tabId);
      return failure("browser target is no longer attached");
    }
    const { guest } = state;
    const { operation } = request;
    try {
      switch (operation.kind) {
        case "snapshot": {
          const depth = Math.max(1, Math.min(8, operation.depth ?? 4));
          const result = await guest.debugger.sendCommand("DOM.getDocument", { depth, pierce: true }) as UnknownRecord;
          const budget = { remaining: MAX_DOM_NODES, truncated: false };
          return {
            ok: true,
            operation: "snapshot",
            tabId: request.tabId,
            value: { document: mapDomNode(result.root, budget), truncated: budget.truncated },
          };
        }
        case "inspect": {
          const nodeId = await queryNodeId(guest, operation.selector);
          if (nodeId == null) {
            return { ok: true, operation: "inspect", tabId: request.tabId, value: null };
          }
          const described = await guest.debugger.sendCommand("DOM.describeNode", { nodeId, depth: 0 }) as UnknownRecord;
          const rawNode = isRecord(described.node) ? described.node : {};
          let boxModel: OpenDesignHostBrowserBoxModel | undefined;
          try {
            boxModel = boxModelFromResult(await guest.debugger.sendCommand("DOM.getBoxModel", { nodeId }));
          } catch {
            boxModel = undefined;
          }
          const inspected: OpenDesignHostBrowserInspectedElement = {
            attributes: attributesRecord(rawNode.attributes),
            backendNodeId: safeInteger(rawNode.backendNodeId) ?? 0,
            ...(boxModel === undefined ? {} : { boxModel }),
            childNodeCount: safeInteger(rawNode.childNodeCount) ?? 0,
            localName: stringValue(rawNode.localName) ?? "",
            nodeName: stringValue(rawNode.nodeName) ?? "",
            nodeValue: stringValue(rawNode.nodeValue) ?? "",
            selector: operation.selector,
          };
          return { ok: true, operation: "inspect", tabId: request.tabId, value: inspected };
        }
        case "screenshot": {
          const format = operation.format ?? "png";
          const params: UnknownRecord = {
            captureBeyondViewport: operation.fullPage === true,
            format,
            fromSurface: true,
          };
          if (format !== "png" && operation.quality !== undefined) params.quality = operation.quality;
          if (operation.fullPage) {
            const metrics = await guest.debugger.sendCommand("Page.getLayoutMetrics") as UnknownRecord;
            const contentSize = isRecord(metrics.cssContentSize) ? metrics.cssContentSize : metrics.contentSize;
            if (isRecord(contentSize)) {
              const width = Math.max(1, Math.min(10_000, finiteNumber(contentSize.width) ?? 1));
              const height = Math.max(1, Math.min(10_000, finiteNumber(contentSize.height) ?? 1));
              params.clip = { height, scale: 1, width, x: 0, y: 0 };
            }
          }
          const result = await guest.debugger.sendCommand("Page.captureScreenshot", params) as UnknownRecord;
          const data = stringValue(result.data);
          if (!data) return failure("browser screenshot did not return image data");
          const dataUrl = `data:image/${format};base64,${data}`;
          if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH) {
            return failure("browser screenshot exceeds the 3 MiB command result limit");
          }
          return {
            ok: true,
            operation: "screenshot",
            tabId: request.tabId,
            value: { dataUrl, format },
          };
        }
        case "click": {
          const nodeId = await queryNodeId(guest, operation.selector);
          if (nodeId == null) return failure("browser click selector did not match");
          await guest.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { nodeId });
          const model = boxModelFromResult(await guest.debugger.sendCommand("DOM.getBoxModel", { nodeId }));
          const point = quadCenter(model?.content ?? []);
          if (!point) return failure("browser click target has no visible box");
          const metrics = await guest.debugger.sendCommand("Page.getLayoutMetrics") as UnknownRecord;
          const viewport = isRecord(metrics.cssVisualViewport)
            ? metrics.cssVisualViewport
            : metrics.visualViewport;
          const width = isRecord(viewport) ? finiteNumber(viewport.clientWidth) : undefined;
          const height = isRecord(viewport) ? finiteNumber(viewport.clientHeight) : undefined;
          if (
            width !== undefined
            && height !== undefined
            && (point.x < 0 || point.y < 0 || point.x > width || point.y > height)
          ) {
            return failure("browser click target is outside the visible viewport");
          }
          await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
            button: operation.button ?? "left",
            clickCount: operation.clickCount ?? 1,
            type: "mousePressed",
            ...point,
          });
          await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
            button: operation.button ?? "left",
            clickCount: operation.clickCount ?? 1,
            type: "mouseReleased",
            ...point,
          });
          return { ok: true, operation: "click", tabId: request.tabId, value: point };
        }
        case "type": {
          const nodeId = await queryNodeId(guest, operation.selector);
          if (nodeId == null) return failure("browser type selector did not match");
          await guest.debugger.sendCommand("DOM.focus", { nodeId });
          if (operation.clear) {
            await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
              key: "a",
              modifiers: process.platform === "darwin" ? 4 : 2,
              type: "keyDown",
            });
            await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
              key: "a",
              modifiers: process.platform === "darwin" ? 4 : 2,
              type: "keyUp",
            });
            await guest.debugger.sendCommand("Input.dispatchKeyEvent", { key: "Backspace", type: "keyDown" });
            await guest.debugger.sendCommand("Input.dispatchKeyEvent", { key: "Backspace", type: "keyUp" });
          }
          await guest.debugger.sendCommand("Input.insertText", { text: operation.text });
          return {
            ok: true,
            operation: "type",
            tabId: request.tabId,
            value: { inserted: operation.text.length },
          };
        }
        case "scroll": {
          let x = 0;
          let y = 0;
          if (operation.selector) {
            const nodeId = await queryNodeId(guest, operation.selector);
            if (nodeId == null) return failure("browser scroll selector did not match");
            await guest.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { nodeId });
            const model = boxModelFromResult(await guest.debugger.sendCommand("DOM.getBoxModel", { nodeId }));
            const point = quadCenter(model?.content ?? []);
            if (point) ({ x, y } = point);
          }
          const deltaX = operation.deltaX ?? 0;
          await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
            deltaX,
            deltaY: operation.deltaY,
            type: "mouseWheel",
            x,
            y,
          });
          return {
            ok: true,
            operation: "scroll",
            tabId: request.tabId,
            value: { deltaX, deltaY: operation.deltaY },
          };
        }
        case "navigate": {
          const readiness = operation.waitUntil
            ? waitForNavigationReadiness(guest, operation.waitUntil)
            : null;
          const result = await guest.debugger.sendCommand("Page.navigate", { url: operation.url }) as UnknownRecord;
          if (stringValue(result.errorText)) {
            readiness?.cancel();
            return failure(`browser navigation failed: ${stringValue(result.errorText)}`);
          }
          await readiness?.promise;
          return {
            ok: true,
            operation: "navigate",
            tabId: request.tabId,
            value: {
              ...(stringValue(result.frameId) === undefined ? {} : { frameId: stringValue(result.frameId) }),
              url: operation.url,
            },
          };
        }
        case "console": {
          const limit = boundedLimit(operation.limit);
          const entries = operation.level && operation.level !== "all"
            ? state.consoleEntries.filter((entry) => entry.level === operation.level)
            : state.consoleEntries;
          return {
            ok: true,
            operation: "console",
            tabId: request.tabId,
            value: { entries: entries.slice(-limit) },
          };
        }
        case "network": {
          const limit = boundedLimit(operation.limit);
          const requests = state.networkOrder
            .map((requestId) => state.networkById.get(requestId))
            .filter((entry): entry is OpenDesignHostBrowserNetworkRequest => entry !== undefined)
            .filter((entry) => operation.requestId === undefined || entry.requestId === operation.requestId)
            .filter((entry) => operation.resourceType === undefined || entry.resourceType === operation.resourceType)
            .filter((entry) => operation.failuresOnly !== true || entry.failed !== undefined)
            .slice(-limit);
          return { ok: true, operation: "network", tabId: request.tabId, value: { requests } };
        }
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    attachGuest,
    attachPopup: async (guest) => {
      if (guest.session !== designBrowserSession || guest.isDestroyed()) throw new Error("unapproved popup session");
      trustedPopups.add(guest);
      try { await attachGuest(guest); } catch (error) { trustedPopups.delete(guest); throw error; }
    },
    close: () => {
      for (const webContentsId of [...attached.keys()]) removeGuest(webContentsId);
      registrations.clear();
    },
    execute,
    listTargets,
    registerTarget,
    unregisterTarget,
  };
}

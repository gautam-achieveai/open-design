import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeEdgeAnnotationScope, normalizeEdgeAnnotationAncestors, normalizeEdgeAnnotationStyle, normalizeEdgeAnnotationText } from '@open-design/contracts';
import { eligibleEdgeOrigin, reviewedEdgePageUrl } from './edge-annotation-url.js';
import type {
  CreateEdgeAnnotationGrantRequest,
  EdgeAnnotationGrant,
  EdgeAnnotationGrantSecret,
  EdgeAnnotationPairCode,
  EdgeAnnotationTarget,
  EdgeAnnotationScreenshot,
  EdgeInspectionRequest,
  EdgeInspectionResponse,
  EdgeInspectionResult,
  EdgeInspectionTask,
  CreateEdgeAnnotationPairRequest,
  RedeemEdgeAnnotationPairRequest,
  SubmitEdgeAnnotationRequest,
} from '@open-design/contracts';

const DEFAULT_TTL_MS = 8 * 60 * 60_000;
const PAIR_TTL_MS = 2 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;
const MAX_SCREENSHOT_BYTES = 256 * 1024;
const MAX_SCREENSHOT_PIXELS = 1_500_000;
const INSPECTION_TIMEOUT_MS = 12_000;
const INSPECTION_WORKER_STALE_MS = 5_000;
const MAX_INSPECTION_HTML_BYTES = 512 * 1024;
const MAX_INSPECTION_PNG_BYTES = 1024 * 1024;
const MAX_INSPECTION_SELECTOR_LENGTH = 512;
const INSPECTION_PNG_PREFIX = 'data:image/png;base64,';
const INSPECTION_PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type GrantState = {
  grant: EdgeAnnotationGrant;
  inspectionDocumentId: string;
  tokenDigest: Buffer;
  extensionOrigin: string;
  inspectionUrl?: string;
  inspectionSeenAt?: number;
};
type PendingInspection = {
  task: EdgeInspectionTask;
  projectId: string;
  conversationId: string;
  documentId: string;
  url: string;
  delivered: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: EdgeInspectionResponse) => void;
  reject: (error: EdgeAnnotationBrokerError) => void;
};
type PendingPair = {
  projectId: string;
  conversationId: string;
  extensionOrigin?: string;
  workspace?: { workspaceId: string; workspaceMemberId: string };
  codeDigest: Buffer;
  expiresAt: number;
  attempts: number;
};
export type AuthenticatedEdgeAnnotationSubmission = SubmitEdgeAnnotationRequest & { token: string };

export type EdgeAnnotationBrokerErrorCode =
  | 'INVALID_GRANT'
  | 'PAIR_NOT_FOUND'
  | 'PAIR_EXPIRED'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_EXPIRED'
  | 'GRANT_MISMATCH'
  | 'AUTH_PAGE_FORBIDDEN'
  | 'INVALID_ANNOTATION'
  | 'SENSITIVE_TARGET'
  | 'INSPECTION_BUSY'
  | 'INSPECTION_TIMEOUT'
  | 'INSPECTION_UNAVAILABLE'
  | 'INVALID_INSPECTION'
  | 'IDEMPOTENCY_CONFLICT';

export class EdgeAnnotationBrokerError extends Error {
  readonly code: EdgeAnnotationBrokerErrorCode;

  constructor(code: EdgeAnnotationBrokerErrorCode, message: string) {
    super(message);
    this.name = 'EdgeAnnotationBrokerError';
    this.code = code;
  }
}

export interface EdgeAnnotationBrokerOptions {
  now?: () => number;
  randomId?: () => string;
  randomToken?: () => string;
  ttlMs?: number;
  inspectionTimeoutMs?: number;
}

function invalid(code: EdgeAnnotationBrokerErrorCode, message: string): never {
  throw new EdgeAnnotationBrokerError(code, message);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function safeExtensionOrigin(value: string): string {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(value)) {
    return invalid('INVALID_GRANT', 'pairing caller is not an Edge extension origin');
  }
  return value;
}

function safeOrigin(value: string): string {
  if (eligibleEdgeOrigin(value) !== value) {
    return invalid('INVALID_GRANT', 'grant origin must be HTTPS or local loopback HTTP');
  }
  return value;
}

function safePage(urlValue: string, expectedOrigin: string): string {
  const reviewed = reviewedEdgePageUrl(urlValue, expectedOrigin);
  if (!reviewed || reviewed !== urlValue) {
    return invalid('GRANT_MISMATCH', 'page URL must be reviewed and free of credentials');
  }
  return reviewed;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Bounded-field check for a pin target supplied by the paired extension. */
export function validateEdgeAnnotationTarget(target: EdgeAnnotationTarget): EdgeAnnotationTarget {
  return validateTarget(target);
}

function validateTarget(target: EdgeAnnotationTarget): EdgeAnnotationTarget {
  if (!target || typeof target !== 'object') return invalid('INVALID_ANNOTATION', 'annotation target is required');
  const { selector, elementId, label, text, domOutline, position, htmlHint, ancestors, style, scope } = target;
  if (
    !bounded(selector, 4_096) || (elementId !== undefined && !bounded(elementId, 128))
    || !bounded(htmlHint, 120)
    || !position || ![position.x, position.y, position.width, position.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    || position.width < 0 || position.height < 0
  ) return invalid('INVALID_ANNOTATION', 'annotation target is malformed or exceeds the allowed size');
  if (
    /[<>]/.test(htmlHint)
    || /[<\u0000-\u001f]/.test(selector)
  ) return invalid('SENSITIVE_TARGET', 'annotation evidence contains sensitive or unsafe content');
  const normalizedScope = normalizeEdgeAnnotationScope(scope);
  if (scope !== undefined && (!normalizedScope || reviewedEdgePageUrl(normalizedScope.url, eligibleEdgeOrigin(normalizedScope.url) ?? '') !== normalizedScope.url)) {
    return invalid('INVALID_ANNOTATION', 'annotation scope is malformed or unsafe');
  }
  const safeStyle = normalizeEdgeAnnotationStyle(style);
  return {
    selector, elementId: elementId ?? selector.slice(0, 128),
    label: normalizeEdgeAnnotationText(label, 160), text: normalizeEdgeAnnotationText(text, 300),
    ...(domOutline === undefined ? {} : { domOutline: normalizeEdgeAnnotationText(domOutline, 1200, true) }),
    position: { ...position }, htmlHint,
    ...(normalizedScope ? { scope: normalizedScope } : {}),
    ...(ancestors === undefined ? {} : { ancestors: normalizeEdgeAnnotationAncestors(ancestors) }),
    ...(style === undefined ? {} : { style: safeStyle }),
  };
}

export function validateEdgeAnnotationScreenshot(dataUrl: string): { data: Buffer; metadata: EdgeAnnotationScreenshot } {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    return invalid('INVALID_ANNOTATION', 'a cropped PNG screenshot is required');
  }
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return invalid('INVALID_ANNOTATION', 'cropped screenshot is malformed or too large');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 45 || data.length > MAX_SCREENSHOT_BYTES
    || data.toString('base64') !== encoded
    || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR'
    || data.readUInt32BE(data.length - 12) !== 0
    || data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND') {
    return invalid('INVALID_ANNOTATION', 'cropped screenshot must be PNG');
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2_000 || height > 2_000
    || width * height > MAX_SCREENSHOT_PIXELS) {
    return invalid('INVALID_ANNOTATION', 'cropped screenshot dimensions are out of bounds');
  }
  return { data, metadata: { mimeType: 'image/png', bytes: data.length, width, height } };
}

function validateInspectionResult(value: unknown, operation: EdgeInspectionTask['operation'], url: string): EdgeInspectionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('INVALID_INSPECTION', 'inspection result is malformed');
  }
  const result = value as Record<string, unknown>;
  if (operation === 'screenshot') {
    if (Object.keys(result).some((key) => key !== 'dataUrl')) {
      return invalid('INVALID_INSPECTION', 'screenshot result has unexpected fields');
    }
    const dataUrl = result.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(INSPECTION_PNG_PREFIX)) {
      return invalid('INVALID_INSPECTION', 'screenshot must be PNG');
    }
    const encoded = dataUrl.slice(INSPECTION_PNG_PREFIX.length);
    if (!encoded || encoded.length > Math.ceil(MAX_INSPECTION_PNG_BYTES / 3) * 4 + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return invalid('INVALID_INSPECTION', 'screenshot exceeds 1 MiB or is malformed');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_INSPECTION_PNG_BYTES || bytes.length < 45
      || bytes.toString('base64') !== encoded
      || !bytes.subarray(0, 8).equals(INSPECTION_PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(bytes.length - 12) !== 0
      || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') {
      return invalid('INVALID_INSPECTION', 'screenshot must be a bounded PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
      return invalid('INVALID_INSPECTION', 'screenshot dimensions are invalid');
    }
    return { dataUrl };
  }
  if (Object.keys(result).some((key) => !['html', 'truncated', 'url', 'title'].includes(key))
    || typeof result.html !== 'string' || Buffer.byteLength(result.html, 'utf8') > MAX_INSPECTION_HTML_BYTES
    || typeof result.truncated !== 'boolean' || result.url !== url
    || typeof result.title !== 'string' || result.title.length > 256) {
    return invalid('INVALID_INSPECTION', 'document result is malformed or exceeds 512 KiB');
  }
  return { html: result.html, truncated: result.truncated, url, title: result.title };
}

export interface ValidatedEdgeAnnotationSubmission {
  grant: EdgeAnnotationGrant;
  eventId: string;
  url: string;
  title: string;
  note: string;
  target: EdgeAnnotationTarget;
  screenshot?: { data: Buffer; metadata: EdgeAnnotationScreenshot };
}

/** Owns short-lived pairing/grants. Reviewed submissions persist in the chat service. */
export function createEdgeAnnotationBroker(options: EdgeAnnotationBrokerOptions = {}) {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const inspectionTimeoutMs = options.inspectionTimeoutMs ?? INSPECTION_TIMEOUT_MS;
  const grants = new Map<string, GrantState>();
  const pendingPairs = new Map<string, PendingPair>();
  const inspections = new Map<string, PendingInspection>();

  function finishInspection(grantId: string, error: EdgeAnnotationBrokerError): void {
    const pending = inspections.get(grantId);
    if (!pending) return;
    clearTimeout(pending.timer);
    inspections.delete(grantId);
    pending.reject(error);
  }

  function removeGrant(grantId: string): boolean {
    finishInspection(grantId, new EdgeAnnotationBrokerError('INSPECTION_UNAVAILABLE', 'paired tab is no longer available'));
    return grants.delete(grantId);
  }

  function prune(): void {
    for (const [id, state] of grants) {
      if (state.grant.expiresAt <= now()) removeGrant(id);
    }
    for (const [id, pending] of pendingPairs) {
      if (pending.expiresAt <= now()) pendingPairs.delete(id);
    }
  }

  function createPendingPair(input: CreateEdgeAnnotationPairRequest): EdgeAnnotationPairCode {
    if (!bounded(input.projectId, 128) || !bounded(input.conversationId, 128)
      || (input.extensionId !== undefined && !/^[a-p]{32}$/.test(input.extensionId))) {
      return invalid('INVALID_GRANT', 'project and conversation are required; optional extension ID must be valid');
    }
    prune();
    const pairId = randomId();
    const secret = randomBytes(24).toString('base64url');
    const expiresAt = now() + PAIR_TTL_MS;
    pendingPairs.set(pairId, {
      projectId: input.projectId, conversationId: input.conversationId,
      ...(input.extensionId ? { extensionOrigin: `chrome-extension://${input.extensionId}` } : {}),
      ...(input.workspace ? { workspace: { ...input.workspace } } : {}),
      codeDigest: tokenDigest(secret), expiresAt, attempts: 0,
    });
    return { pairId, code: `${pairId}.${secret}`, expiresAt };
  }

  function redeemPair(input: RedeemEdgeAnnotationPairRequest): EdgeAnnotationGrantSecret {
    if (!bounded(input.code, 512)) return invalid('PAIR_NOT_FOUND', 'pairing code not found');
    const dot = input.code.indexOf('.');
    if (dot < 1) return invalid('PAIR_NOT_FOUND', 'pairing code not found');
    const pairId = input.code.slice(0, dot);
    const secret = input.code.slice(dot + 1);
    const pending = pendingPairs.get(pairId);
    if (pending && pending.expiresAt <= now()) {
      pendingPairs.delete(pairId);
      return invalid('PAIR_EXPIRED', 'pairing code expired');
    }
    if (!pending || !bounded(secret, 512)) return invalid('PAIR_NOT_FOUND', 'pairing code not found');
    pending.attempts += 1;
    if (pending.attempts >= MAX_PAIR_ATTEMPTS) pendingPairs.delete(pairId);
    if (!timingSafeEqual(pending.codeDigest, tokenDigest(secret))) {
      return invalid('PAIR_NOT_FOUND', 'pairing code not found');
    }
    // Verify browser tab and origin before consuming the one-use code.
    const origin = safeOrigin(input.origin);
    const extensionOrigin = safeExtensionOrigin(input.extensionOrigin);
    if (pending.extensionOrigin && extensionOrigin !== pending.extensionOrigin) {
      return invalid('PAIR_NOT_FOUND', 'pairing code is not for this extension');
    }
    if (!Number.isSafeInteger(input.tabId) || input.tabId < 1 || !bounded(input.documentId, 128)) {
      return invalid('INVALID_GRANT', 'browser tab or document is invalid');
    }
    pendingPairs.delete(pairId);
    return createGrant({
      projectId: pending.projectId, conversationId: pending.conversationId,
      tabId: input.tabId, documentId: input.documentId, origin,
      ...(pending.workspace ? { workspace: { ...pending.workspace } } : {}),
    }, extensionOrigin);
  }

  function createGrant(input: CreateEdgeAnnotationGrantRequest, extensionOrigin: string): EdgeAnnotationGrantSecret {
    if (
      !bounded(input.projectId, 128) || !bounded(input.conversationId, 128)
      || !Number.isSafeInteger(input.tabId) || input.tabId < 1
      || !bounded(input.documentId, 128) || !bounded(input.origin, 2_048)
    ) return invalid('INVALID_GRANT', 'grant fields are malformed');
    const origin = safeOrigin(input.origin);
    prune();
    invalidateTab(input.projectId, input.tabId);
    const token = randomToken();
    if (!bounded(token, 512)) return invalid('INVALID_GRANT', 'grant token generator failed');
    const createdAt = now();
    const grant: EdgeAnnotationGrant = {
      grantId: randomId(), projectId: input.projectId, conversationId: input.conversationId,
      tabId: input.tabId, documentId: input.documentId, origin, createdAt, expiresAt: createdAt + ttlMs,
      ...(input.workspace ? { workspace: { ...input.workspace } } : {}),
    };
    grants.set(grant.grantId, {
      grant, inspectionDocumentId: grant.documentId, tokenDigest: tokenDigest(token), extensionOrigin,
    });
    return { grant: { ...grant }, token };
  }

  function listGrants(projectId: string): EdgeAnnotationGrant[] {
    prune();
    return [...grants.values()]
      .filter(({ grant }) => grant.projectId === projectId)
      .map(({ grant }) => ({ ...grant }));
  }

  function submit(input: AuthenticatedEdgeAnnotationSubmission): ValidatedEdgeAnnotationSubmission {
    const state = grants.get(input.grantId);
    if (state && state.grant.expiresAt <= now()) {
      removeGrant(input.grantId);
      return invalid('GRANT_EXPIRED', 'Edge annotation grant expired');
    }
    if (!state || state.grant.projectId !== input.projectId || !bounded(input.token, 512)) {
      return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    }
    const supplied = tokenDigest(input.token);
    if (!timingSafeEqual(state.tokenDigest, supplied)) {
      return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    }
    const { grant } = state;
    if (state.extensionOrigin !== safeExtensionOrigin(input.extensionOrigin)) {
      return invalid('GRANT_MISMATCH', 'request came from another Edge extension');
    }
    if (grant.tabId !== input.tabId || grant.documentId !== input.documentId) {
      return invalid('GRANT_MISMATCH', 'tab or document changed since pairing');
    }
    if (!bounded(input.url, 8_192)) return invalid('GRANT_MISMATCH', 'page URL is invalid');
    const url = safePage(input.url, grant.origin);
    if (
      !bounded(input.note, 4_096) || typeof input.title !== 'string' || input.title.length > 512
      || !bounded(input.eventId, 128) || !/^[a-zA-Z0-9_-]+$/.test(input.eventId)
    ) return invalid('INVALID_ANNOTATION', 'annotation content is malformed');
    return {
      grant: { ...grant, ...(grant.workspace ? { workspace: { ...grant.workspace } } : {}) },
      eventId: input.eventId,
      url,
      title: input.title,
      target: validateTarget(input.target),
      ...(input.screenshotDataUrl === undefined ? {} : { screenshot: validateEdgeAnnotationScreenshot(input.screenshotDataUrl) }),
      note: input.note,
    };
  }

  function requireGrant(input: {
    grantId: string;
    token: string;
    extensionOrigin: string;
    tabId: number;
    documentId: string;
    url: string;
  }, options: { rebindDocument?: boolean } = {}): EdgeAnnotationGrant {
    const state = grants.get(input.grantId);
    if (!state || !bounded(input.token, 512)) return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    if (state.grant.expiresAt <= now()) {
      removeGrant(input.grantId);
      return invalid('GRANT_EXPIRED', 'Edge annotation grant expired');
    }
    if (!timingSafeEqual(state.tokenDigest, tokenDigest(input.token))) {
      return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    }
    if (
      state.extensionOrigin !== safeExtensionOrigin(input.extensionOrigin)
      || state.grant.tabId !== input.tabId
      || (!options.rebindDocument && state.grant.documentId !== input.documentId)
      || !bounded(input.documentId, 128)
    ) return invalid('GRANT_MISMATCH', 'paired Edge tab or extension changed');
    safePage(input.url, state.grant.origin);
    if (options.rebindDocument && state.grant.documentId !== input.documentId) {
      finishInspection(input.grantId, new EdgeAnnotationBrokerError('INSPECTION_UNAVAILABLE', 'paired document changed'));
      state.grant.documentId = input.documentId;
      delete state.inspectionUrl;
      delete state.inspectionSeenAt;
    }
    return { ...state.grant };
  }

  /** Worker proof of the paired document precedes every inspection request. */
  function pollInspection(input: {
    projectId: string;
    grantId: string;
    token: string;
    extensionOrigin: string;
    tabId: number;
    documentId: string;
    url: string;
  }): EdgeInspectionTask | null {
    const grant = requireGrant(input);
    if (grant.projectId !== input.projectId) return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    const state = grants.get(input.grantId)!;
    if (state.inspectionDocumentId !== input.documentId) {
      return invalid('GRANT_MISMATCH', 'paired document changed; reconnect to inspect it');
    }
    if (state.inspectionUrl && state.inspectionUrl !== input.url) {
      finishInspection(input.grantId, new EdgeAnnotationBrokerError('INSPECTION_UNAVAILABLE', 'paired page changed'));
    }
    state.inspectionUrl = input.url;
    state.inspectionSeenAt = now();
    const pending = inspections.get(input.grantId);
    if (!pending || pending.delivered || pending.documentId !== grant.documentId || pending.url !== input.url) return null;
    pending.delivered = true;
    return { ...pending.task };
  }

  function requestInspection(input: EdgeInspectionRequest & { projectId: string }): {
    requestId: string;
    url: string;
    promise: Promise<EdgeInspectionResponse>;
  } {
    const state = grants.get(input.grantId);
    if (!state || state.grant.projectId !== input.projectId
      || state.grant.conversationId !== input.conversationId) {
      return invalid('GRANT_NOT_FOUND', 'paired grant not found in this conversation');
    }
    if (state.grant.expiresAt <= now()) {
      removeGrant(input.grantId);
      return invalid('GRANT_EXPIRED', 'Edge annotation grant expired');
    }
    if (state.inspectionDocumentId !== state.grant.documentId) {
      return invalid('INSPECTION_UNAVAILABLE', 'paired document changed; reconnect to inspect it');
    }
    if (!state.inspectionUrl || state.inspectionSeenAt === undefined
      || now() - state.inspectionSeenAt > INSPECTION_WORKER_STALE_MS) {
      return invalid('INSPECTION_UNAVAILABLE', 'paired extension has not connected for inspection');
    }
    if (inspections.has(input.grantId)) return invalid('INSPECTION_BUSY', 'paired tab has an inspection in progress');
    if (!['snapshot', 'inspect', 'screenshot'].includes(input.operation)) {
      return invalid('INVALID_INSPECTION', 'unsupported browser inspection');
    }
    if (input.operation === 'inspect') {
      if (!bounded(input.selector, MAX_INSPECTION_SELECTOR_LENGTH)
        || /[\u0000-\u001f]/.test(input.selector)) {
        return invalid('INVALID_INSPECTION', 'a bounded CSS selector is required');
      }
    } else if (input.selector !== undefined) {
      return invalid('INVALID_INSPECTION', 'selector is only allowed for element inspection');
    }
    const task: EdgeInspectionTask = {
      requestId: randomId(), operation: input.operation,
      ...(input.operation === 'inspect' ? { selector: input.selector } : {}),
    };
    const promise = new Promise<EdgeInspectionResponse>((resolve, reject) => {
      const timer = setTimeout(() => finishInspection(input.grantId,
        new EdgeAnnotationBrokerError('INSPECTION_TIMEOUT', 'paired extension inspection timed out')),
      inspectionTimeoutMs);
      inspections.set(input.grantId, {
        task, projectId: input.projectId, conversationId: input.conversationId,
        documentId: state.grant.documentId, url: state.inspectionUrl!,
        delivered: false, timer, resolve, reject,
      });
    });
    return { requestId: task.requestId, url: state.inspectionUrl, promise };
  }

  function cancelInspection(grantId: string, requestId: string): void {
    if (inspections.get(grantId)?.task.requestId === requestId) {
      finishInspection(grantId, new EdgeAnnotationBrokerError('INSPECTION_UNAVAILABLE', 'inspection cancelled'));
    }
  }

  function inspectionStillPaired(projectId: string, grantId: string, conversationId: string,
    documentId: string, url: string): boolean {
    const state = grants.get(grantId);
    return Boolean(state && state.grant.expiresAt > now()
      && state.grant.projectId === projectId && state.grant.conversationId === conversationId
      && state.inspectionDocumentId === documentId
      && state.grant.documentId === documentId && state.inspectionUrl === url);
  }

  function submitInspectionResult(input: {
    projectId: string;
    grantId: string;
    token: string;
    extensionOrigin: string;
    tabId: number;
    documentId: string;
    url: string;
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: unknown;
  }): void {
    const grant = requireGrant(input);
    if (grant.projectId !== input.projectId) return invalid('GRANT_NOT_FOUND', 'Edge annotation grant not found');
    const pending = inspections.get(input.grantId);
    if (!pending || !pending.delivered || pending.task.requestId !== input.requestId
      || pending.projectId !== grant.projectId || pending.conversationId !== grant.conversationId
      || pending.documentId !== grant.documentId || pending.url !== input.url
      || grants.get(input.grantId)?.inspectionUrl !== input.url) {
      return invalid('INSPECTION_UNAVAILABLE', 'inspection request is no longer available');
    }
    if (typeof input.ok !== 'boolean') return invalid('INVALID_INSPECTION', 'inspection outcome is required');
    if (!input.ok) {
      finishInspection(input.grantId, new EdgeAnnotationBrokerError('INSPECTION_UNAVAILABLE',
        typeof input.error === 'string' && input.error.length <= 256
          ? input.error : 'paired tab could not be inspected'));
      return;
    }
    let result: EdgeInspectionResult;
    try {
      result = validateInspectionResult(input.result, pending.task.operation, pending.url);
    } catch (error) {
      finishInspection(input.grantId, new EdgeAnnotationBrokerError('INVALID_INSPECTION', 'paired extension returned invalid inspection data'));
      throw error;
    }
    clearTimeout(pending.timer);
    inspections.delete(input.grantId);
    pending.resolve({ ok: true, requestId: pending.task.requestId, result });
  }

  function revoke(projectId: string, grantId: string): boolean {
    const grant = grants.get(grantId)?.grant;
    if (!grant || grant.projectId !== projectId) return false;
    return removeGrant(grantId);
  }

  function invalidateTab(projectId: string, tabId: number): void {
    for (const [id, state] of grants) {
      if (state.grant.projectId === projectId && state.grant.tabId === tabId) removeGrant(id);
    }
  }

  function shutdown(): void {
    pendingPairs.clear();
    for (const id of grants.keys()) removeGrant(id);
  }

  return {
    createPendingPair, redeemPair, requireGrant, listGrants, submit,
    pollInspection, requestInspection, cancelInspection, inspectionStillPaired, submitInspectionResult,
    revoke, invalidateTab, shutdown,
  };
}

export type EdgeAnnotationBroker = ReturnType<typeof createEdgeAnnotationBroker>;

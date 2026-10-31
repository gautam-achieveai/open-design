import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BrowserPerformanceNativeChallenge, McpApprovalScope, McpApprovalView } from '@open-design/contracts';

/** These identities are derived from an authenticated grant, never MCP arguments. */
export interface ApprovalPrincipal {
  kind: 'run' | 'external' | 'local';
  id: string;
  projectId: string;
  scope: McpApprovalScope | null;
}

/** Digests are internal; neither the lease nor raw page URL are stored here. */
export interface ApprovalTarget {
  projectId: string;
  tabId: string;
  leaseDigest: string;
  urlDigest: string;
  location: string;
  locationPartial: boolean;
}

export interface ApprovalAction {
  principal: ApprovalPrincipal;
  target: ApprovalTarget;
  operation: string;
  /** Validated and normalized arguments, excluding approvalRequestId and tokens. */
  args: Record<string, unknown>;
}

type RecordEntry = { view: McpApprovalView; target: ApprovalTarget; fingerprint: string; captureThrottle?: { reportId: string; cpu: number } };
export const LOCAL_PERFORMANCE_PRINCIPAL_ID = 'local-performance-controls';
export type ApprovalOutcome =
  | { ok: true; approval: McpApprovalView }
  | { ok: false; code: 'NOT_FOUND' | 'EXPIRED' | 'CONFLICT' | 'TARGET_CHANGED' | 'MISMATCH' | 'CAPACITY' | 'APPROVAL_REQUIRED' | 'DENIED' | 'CONSUMED' | 'NATIVE_CONFIRMATION_REQUIRED' };

const MAX_TOTAL = 100;
const MAX_PRINCIPAL = 10;
const TTL_MS = 2 * 60_000;
const SECRET = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+|\bBearer\s+[^\s"'&,;]+|\b(?:password|passwd|secret|token|api[_-]?key|authorization|code|state)["']?\s*[:=]\s*["']?[^\s"'&,;]+/gi;
// Hide all URL query/fragment values in excerpts, including percent-encoded keys.
const URL_CREDENTIAL = /([?&#][^=&#\s"'<>]+)=([^&#\s"']+)/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s"'<>\/?#]+@/gi;

function safeText(value: unknown, max = 240): { text: string; partial: boolean } {
  if (typeof value !== 'string') return { text: '', partial: false };
  const cleaned = value.replace(URL_USERINFO, '$1[redacted]@').replace(SECRET, '[redacted]').replace(URL_CREDENTIAL, '$1=[redacted]');
  return { text: cleaned.slice(0, max), partial: cleaned !== value || cleaned.length > max };
}

function safeLocation(raw: string): { text: string; partial: boolean } {
  try {
    const url = new URL(raw);
    const path = (() => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } })();
    const result = safeText(`${url.origin}${path}`, 512);
    return { text: result.text, partial: result.partial || !!(url.username || url.password || url.search || url.hash) };
  } catch {
    // A malformed location cannot be displayed safely.
    return { text: '[location unavailable]', partial: true };
  }
}

// CSS selectors can encode arbitrary strings, including escaped URLs. Only
// display a single plain tag, id, or class; hide all other selector syntax.
function safeSelector(value: unknown): { text: string; partial: boolean } {
  if (typeof value !== 'string') return { text: '[target]', partial: true };
  if (!/^(?:[A-Za-z][A-Za-z0-9_-]*|[#.][A-Za-z_][A-Za-z0-9_-]*)$/.test(value)) {
    return { text: '[selector hidden]', partial: true };
  }
  const result = safeText(value, 160);
  return { text: result.text, partial: result.partial };
}

function safeStyleValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  // CSS values may contain URLs, arbitrary text, or secrets. Only display
  // familiar keywords, numeric dimensions, and hex colors.
  if (/^(?:none|block|inline|inline-block|flex|grid|hidden|visible|inherit|initial|unset|auto|transparent|red|blue|green|black|white|gray|grey)$/i.test(value)
    || /^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/i.test(value)
    || /^-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw)?$/i.test(value)) return value;
  return null;
}

function boundedPreview(text: string, partial: boolean): { text: string; partial: boolean } {
  const truncated = text.length > 680;
  return { text: `${text.slice(0, 680)}${partial || truncated ? ' [details hidden]' : ''}`, partial: partial || truncated };
}

function devtoolsPreview(args: Record<string, unknown>): { text: string; partial: boolean } {
  const action = safeText(args.action, 80);
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params as Record<string, unknown> : {};
  const shown = new Set<string>();
  const details: string[] = [];
  let partial = action.partial || !action.text || args.params === null || typeof args.params !== 'object' || Array.isArray(args.params);
  const add = (key: string, value: string) => { shown.add(key); details.push(`${key}: ${value}`); };
  if (action.text === 'cache-disable' && typeof params.disabled === 'boolean') add('disabled', String(params.disabled));
  if (action.text === 'storage-clear' && Array.isArray(params.types)) {
    const allowed = ['cookies', 'indexeddb', 'local-storage', 'session-storage', 'cache-storage', 'service-workers', 'all'];
    if (params.types.length > 0 && params.types.length <= 16 && params.types.every((type) => typeof type === 'string' && allowed.includes(type))) add('types', params.types.join(', '));
  }
  if (action.text === 'animation-rate' && typeof params.rate === 'number' && Number.isFinite(params.rate)) add('rate', String(params.rate));
  if (action.text === 'overlay') {
    for (const key of ['paint', 'shifts', 'fps']) if (typeof params[key] === 'boolean') add(key, String(params[key]));
    for (const key of ['grid', 'flex']) {
      if (params[key] === null) add(key, 'clear');
      else if (typeof params[key] === 'string') {
        const selector = safeSelector(params[key]); add(key, selector.text); partial ||= selector.partial;
      }
    }
  }
  if (action.text === 'force-state') {
    if (typeof params.selector === 'string') { const selector = safeSelector(params.selector); add('selector', selector.text); partial ||= selector.partial; }
    const states = ['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'target'];
    if (Array.isArray(params.states) && params.states.length <= states.length && params.states.every((state) => typeof state === 'string' && states.includes(state))) add('states', params.states.join(', ') || '(none)');
    if (!shown.has('selector') || !shown.has('states')) partial = true;
  }
  if (action.text === 'emulate' && (params.mediaType === null || params.mediaType === 'screen' || params.mediaType === 'print')) add('mediaType', params.mediaType === null ? 'clear' : params.mediaType);
  if (action.text === 'throttle') {
    if (typeof params.cpu === 'number' && Number.isFinite(params.cpu)) add('cpu', String(params.cpu));
    if (typeof params.network === 'string' && ['off', 'offline', 'slow-3g', 'fast-3g'].includes(params.network)) add('network', params.network);
  }
  if (['sw-restart', 'sw-update', 'sw-unregister'].includes(action.text) && typeof params.scope === 'string') {
    const scope = safeLocation(params.scope); add('scope', scope.text); partial ||= scope.partial;
  }
  partial ||= Object.keys(params).some((key) => !shown.has(key));
  if (['cache-disable', 'storage-clear', 'animation-rate'].includes(action.text) && !details.length) partial = true;
  return boundedPreview(`DevTools ${action.text || '[action]'}${details.length ? `: ${details.join('; ')}` : ''}`, partial);
}

function preview(operation: string, args: Record<string, unknown>): { text: string; partial: boolean } {
  const target = args.target && typeof args.target === 'object' && !Array.isArray(args.target)
    ? args.target as Record<string, unknown> : {};
  const selector = target.selector === undefined ? { text: '', partial: false } : safeSelector(target.selector);
  if (operation === 'evaluate' || operation === 'browser_evaluate') {
    const script = safeText(args.expression, 320);
    return { text: `Script: ${script.text}`, partial: script.partial };
  }
  if (operation === 'type' || operation === 'browser_type') {
    const length = typeof args.text === 'string' ? args.text.length : 0;
    return { text: `Type ${length} characters into ${selector.text || '[target]'} [text hidden]${selector.partial ? ' [details hidden]' : ''}`, partial: true };
  }
  if (operation === 'navigate' || operation === 'browser_navigate') {
    return { text: `Navigate to ${safeLocation(typeof args.url === 'string' ? args.url : '').text}`, partial: true };
  }
  if (operation === 'click' || operation === 'browser_click') {
    const button = args.button === 'left' || args.button === 'middle' || args.button === 'right' ? args.button : 'left';
    const count = typeof args.clickCount === 'number' && Number.isFinite(args.clickCount) ? args.clickCount : 1;
    return boundedPreview(`Click ${selector.text || '[target]'} (${button}, ${count})`, selector.partial);
  }
  if (operation === 'scroll' || operation === 'browser_scroll') {
    const x = typeof args.deltaX === 'number' && Number.isFinite(args.deltaX) ? args.deltaX : 0;
    const y = typeof args.deltaY === 'number' && Number.isFinite(args.deltaY) ? args.deltaY : 0;
    return boundedPreview(`Scroll ${x}, ${y}${selector.text ? ` at ${selector.text}` : ''}`, selector.partial);
  }
  if (operation === 'viewport' || operation === 'browser_viewport') {
    const preset = args.preset === 'desktop' || args.preset === 'tablet' || args.preset === 'mobile' ? args.preset : '[preset]';
    return { text: `Set viewport: ${preset}`, partial: preset === '[preset]' };
  }
  if (operation === 'style' || operation === 'browser_style') {
    const element = safeSelector(target.selector);
    const styles = args.styles && typeof args.styles === 'object' && !Array.isArray(args.styles) ? args.styles as Record<string, unknown> : {};
    const entries = Object.entries(styles);
    let partial = element.partial || !entries.length || entries.length > 8;
    const changes = entries.slice(0, 8).map(([name, value]) => {
      const property = safeText(name, 80);
      const display = safeStyleValue(value);
      partial ||= property.partial || display === null;
      return `${property.text}: ${display ?? '[value hidden]'}`;
    });
    return boundedPreview(`Style ${element.text}: ${changes.join('; ') || '[styles hidden]'}`, partial);
  }
  if (operation === 'devtools' || operation === 'browser_devtools') return devtoolsPreview(args);
  const action = safeText(args.action, 120);
  return { text: `${safeText(operation, 80).text}${action.text ? `: ${action.text}` : ''} [details hidden]`, partial: true };
}

/** Stable serialization for already-validated JSON data; rejects non-JSON values. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TypeError('approval arguments must be JSON values');
}

function copyView(view: McpApprovalView): McpApprovalView {
  return { ...view, principal: { ...view.principal }, scope: view.scope ? { ...view.scope } : null };
}

export class McpApprovalStore {
  readonly #key = randomBytes(32);
  readonly #records = new Map<string, RecordEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #id: () => string;
  readonly #timer: NodeJS.Timeout;

  constructor(options: { now?: () => number; ttlMs?: number; id?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? TTL_MS;
    this.#id = options.id ?? randomUUID;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) throw new RangeError('ttlMs must be positive');
    this.#timer = setInterval(() => this.#sweep(), Math.min(this.#ttlMs, 30_000));
    this.#timer.unref?.();
  }

  #digest(domain: string, value: unknown): string {
    return createHmac('sha256', this.#key).update(domain).update('\0').update(canonical(value)).digest('hex');
  }

  #fingerprint(action: ApprovalAction): string {
    return this.#digest('action-v1', { principal: action.principal, projectId: action.target.projectId,
      tabId: action.target.tabId, operation: action.operation, args: action.args });
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, record] of this.#records) if (now >= Date.parse(record.view.expiresAt)) this.#records.delete(id);
  }

  /** Broker calls this with private current values; only digests and safe location leave this method. */
  captureTarget(projectId: string, tabId: string, lease: string, url: string): ApprovalTarget {
    const location = safeLocation(url);
    return { projectId, tabId, leaseDigest: this.#digest('lease-v1', lease), urlDigest: this.#digest('url-v1', url), location: location.text, locationPartial: location.partial };
  }

  targetMatches(expected: ApprovalTarget, actual: ApprovalTarget): boolean {
    return expected.projectId === actual.projectId && expected.tabId === actual.tabId
      && equalDigest(expected.leaseDigest, actual.leaseDigest) && equalDigest(expected.urlDigest, actual.urlDigest);
  }

  create(action: ApprovalAction): ApprovalOutcome {
    this.#sweep();
    const native = action.operation === 'browser_devtools' && action.args.action === 'capture-throttle';
    let captureThrottle: RecordEntry['captureThrottle'];
    if (native) {
      const params = action.args.params as Record<string, unknown> | undefined;
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some((key) => key !== 'reportId' && key !== 'cpu')
        || typeof params.reportId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(params.reportId)
        || typeof params.cpu !== 'number' || !Number.isFinite(params.cpu) || params.cpu < 1 || params.cpu > 20) return { ok: false, code: 'MISMATCH' };
      captureThrottle = { reportId: params.reportId, cpu: params.cpu };
    }
    // Local HTTP authority is a distinct server-derived principal, never an
    // external credential fallback and never usable for legacy operations.
    if (!['run', 'external', 'local'].includes(action.principal.kind)
      || (action.principal.kind === 'local' && (!native || action.principal.id !== LOCAL_PERFORMANCE_PRINCIPAL_ID))) {
      return { ok: false, code: 'MISMATCH' };
    }
    if (action.principal.projectId !== action.target.projectId) return { ok: false, code: 'MISMATCH' };
    if (![action.principal.id, action.principal.projectId, action.target.tabId, action.operation].every((value) => typeof value === 'string' && value.trim().length > 0)) {
      return { ok: false, code: 'MISMATCH' };
    }
    if (action.principal.scope && (!action.principal.scope.workspaceId.trim() || !action.principal.scope.workspaceMemberId.trim())) {
      return { ok: false, code: 'MISMATCH' };
    }
    const identifiers = [action.principal.id, action.principal.projectId, action.target.tabId, action.operation,
      action.principal.scope?.workspaceId ?? '', action.principal.scope?.workspaceMemberId ?? ''];
    if (identifiers.some((value) => value.length > 8192 || (value && safeText(value, 8192).partial))) return { ok: false, code: 'MISMATCH' };
    const principalCount = [...this.#records.values()].filter((entry) => entry.view.principal.kind === action.principal.kind && entry.view.principal.id === action.principal.id).length;
    if (this.#records.size >= MAX_TOTAL || principalCount >= MAX_PRINCIPAL) return { ok: false, code: 'CAPACITY' };
    const now = this.#now();
    const id = this.#id();
    if (this.#records.has(id)) throw new Error('approval id collision');
    const detail = preview(action.operation, action.args);
    const location = safeLocation(action.target.location);
    const view: McpApprovalView = { id, principal: { kind: action.principal.kind, id: action.principal.id },
      projectId: action.principal.projectId, scope: action.principal.scope ? { ...action.principal.scope } : null,
      tabId: action.target.tabId, operation: action.operation, location: location.text,
      preview: detail.text, partial: detail.partial || location.partial || action.target.locationPartial, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(), status: 'pending',
        ...(native ? { nativeConfirmationRequired: true, preview: `Temporary CPU slowdown ${captureThrottle!.cpu}× for capture ${captureThrottle!.reportId}; restore only while owned.`, partial: location.partial || action.target.locationPartial } : {}) };
    this.#records.set(id, { view, target: { ...action.target, location: view.location }, fingerprint: this.#fingerprint(action),
      ...(captureThrottle ? { captureThrottle } : {}) });
    return { ok: true, approval: copyView(view) };
  }

  get(id: string): McpApprovalView | null {
    const record = this.#records.get(id);
    if (!record) return null;
    if (this.#now() >= Date.parse(record.view.expiresAt)) {
      this.#records.delete(id);
      return { ...copyView(record.view), status: 'expired' };
    }
    return copyView(record.view);
  }

  list(): McpApprovalView[] {
    this.#sweep();
    return [...this.#records.values()].filter((record) => record.view.status === 'pending').map((record) => copyView(record.view));
  }

  /** Internal only: broker uses these digests to verify current lease and URL. */
  getTarget(id: string): ApprovalTarget | null {
    const view = this.get(id);
    if (!view || view.status === 'expired') return null;
    const record = this.#records.get(id);
    return record ? { ...record.target } : null;
  }

  /** Digest is freshly derived from the immutable action and private target. */
  nativeChallenge(id: string): BrowserPerformanceNativeChallenge | null {
    const view = this.get(id);
    const record = this.#records.get(id);
    if (!view || view.status !== 'pending' || !record?.captureThrottle) return null;
    return { approvalId: id, projectId: view.projectId, tabId: view.tabId, location: view.location,
      expiresAt: view.expiresAt, ...record.captureThrottle,
      bindingDigest: this.#digest('capture-native-challenge-v1', [id, view.expiresAt, record.fingerprint,
        record.target.projectId, record.target.tabId, record.target.leaseDigest, record.target.urlDigest]) };
  }

  decide(id: string, decision: 'approve' | 'deny', targetCurrent: (target: ApprovalTarget) => boolean, nativeConfirmed = false): ApprovalOutcome {
    const view = this.get(id);
    if (!view) return { ok: false, code: 'NOT_FOUND' };
    if (view.status === 'expired') return { ok: false, code: 'EXPIRED' };
    const record = this.#records.get(id)!;
    if (record.captureThrottle && !nativeConfirmed) return { ok: false, code: 'NATIVE_CONFIRMATION_REQUIRED' };
    if (record.view.status !== 'pending') return { ok: false, code: 'CONFLICT' };
    if (targetCurrent({ ...record.target }) !== true) return { ok: false, code: 'TARGET_CHANGED' };
    if (this.#now() >= Date.parse(record.view.expiresAt)) {
      this.#records.delete(id);
      return { ok: false, code: 'EXPIRED' };
    }
    if (record.view.status !== 'pending') return { ok: false, code: 'CONFLICT' };
    record.view.status = decision === 'approve' ? 'approved' : 'denied';
    return { ok: true, approval: copyView(record.view) };
  }

  /** Call only inside the broker's synchronous authorization/enqueue boundary. */
  consume(id: string, action: ApprovalAction): ApprovalOutcome {
    const view = this.get(id);
    if (!view) return { ok: false, code: 'NOT_FOUND' };
    if (view.status === 'expired') return { ok: false, code: 'EXPIRED' };
    const record = this.#records.get(id)!;
    if (!this.targetMatches(record.target, action.target) || !equalDigest(record.fingerprint, this.#fingerprint(action))) {
      return { ok: false, code: 'MISMATCH' };
    }
    if (record.view.status === 'pending') return { ok: false, code: 'APPROVAL_REQUIRED' };
    if (record.view.status === 'denied') return { ok: false, code: 'DENIED' };
    if (record.view.status === 'consumed') return { ok: false, code: 'CONSUMED' };
    if (record.view.status !== 'approved') return { ok: false, code: 'CONFLICT' };
    record.view.status = 'consumed';
    return { ok: true, approval: copyView(record.view) };
  }

  invalidatePrincipal(kind: ApprovalPrincipal['kind'], id: string): void {
    for (const record of this.#records.values()) {
      if (record.view.principal.kind === kind && record.view.principal.id === id && (record.view.status === 'pending' || record.view.status === 'approved')) record.view.status = 'denied';
    }
  }

  /** Release the sweep timer on daemon shutdown. */
  close(): void {
    clearInterval(this.#timer);
    this.#records.clear();
  }
}

function equalDigest(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function createMcpApprovalStore(options?: ConstructorParameters<typeof McpApprovalStore>[0]): McpApprovalStore {
  return new McpApprovalStore(options);
}

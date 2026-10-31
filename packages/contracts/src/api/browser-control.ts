import type { JsonValue } from '../common.js';
import type { ApiError } from '../errors.js';
import type { PreviewAnnotationStyle } from './comments.js';
import { normalizeEdgeAnnotationStyle } from './edge-annotations.js';

export const BROWSER_OPERATION_NAMES = [
  'snapshot',
  'inspect',
  'style',
  'screenshot',
  'click',
  'type',
  'scroll',
  'navigate',
  'viewport',
  'console',
  'network-list',
  'network-get',
  'network-failures',
  'evaluate',
  'devtools',
] as const;

export type BrowserOperationName = (typeof BROWSER_OPERATION_NAMES)[number];

export interface BrowserTabIdentity {
  projectId: string;
  tabId: string;
  url: string;
  title: string;
}

export interface BrowserTab extends BrowserTabIdentity {
  active: boolean;
  registeredAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
}

export interface RegisterBrowserTabRequest extends BrowserTabIdentity {
  leaseId?: string;
}

export interface RegisterBrowserTabResponse {
  tab: BrowserTab;
  leaseId: string;
}

export interface RenewBrowserTabLeaseRequest {
  leaseId: string;
  url: string;
  title: string;
}

export interface BrowserTabLeaseResponse {
  tab: BrowserTab;
  leaseId: string;
}

export interface ReleaseBrowserTabLeaseRequest {
  leaseId: string;
}

export interface ReleaseBrowserTabLeaseResponse {
  released: boolean;
}

export interface BrowserTabsResponse {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

export interface SelectActiveBrowserTabRequest {
  tabId: string | null;
}

export interface SelectActiveBrowserTabResponse {
  activeTabId: string | null;
}

export type BrowserElementTarget = { selector: string };

/** Snapshot depth bound (the host defaults to 12). The host still caps the tree by node count. */
export const BROWSER_SNAPSHOT_MAX_DEPTH = 64;

export interface BrowserSnapshotOperation {
  operation: 'snapshot';
  /** Levels below the root to include (1..BROWSER_SNAPSHOT_MAX_DEPTH). */
  depth?: number;
  /** Snapshot this element's subtree instead of the whole document. */
  target?: BrowserElementTarget;
}
export type BrowserViewportId = 'desktop' | 'tablet' | 'mobile';
export interface BrowserViewportOperation {
  operation: 'viewport';
  preset: BrowserViewportId;
}
export function isBrowserViewportId(value: unknown): value is BrowserViewportId {
  return value === 'desktop' || value === 'tablet' || value === 'mobile';
}

export interface BrowserInspectOperation {
  operation: 'inspect';
  target: BrowserElementTarget;
}

export interface BrowserStyleOperation {
  operation: 'style';
  approved: true;
  target: BrowserElementTarget;
  styles: Partial<PreviewAnnotationStyle>;
}

/** Live patches use the same bounded property/value vocabulary as measured styles. */
export function isBrowserStylePatch(value: unknown): value is Partial<PreviewAnnotationStyle> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  const normalized = normalizeEdgeAnnotationStyle(value);
  const record = value as Record<string, unknown>;
  return keys.every((key) => Object.hasOwn(normalized, key)
    && typeof record[key] === 'string' && record[key].trim().length > 0
    && record[key] === normalized[key as keyof PreviewAnnotationStyle]);
}

/** A style mutation succeeds only with a current measured, styled element. */
export function isBrowserStyleInspection(value: unknown): value is JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const position = record.position;
  if (typeof record.selector !== 'string' || !record.selector.trim() || record.selector.length > 8_192
    || !position || typeof position !== 'object' || Array.isArray(position)
    || !Object.keys(normalizeEdgeAnnotationStyle(record.style)).length) return false;
  const rect = position as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
    && (rect.width as number) > 0 && (rect.height as number) > 0;
}

export interface BrowserScreenshotOperation {
  operation: 'screenshot';
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface BrowserClickOperation {
  operation: 'click';
  approved: true;
  target: BrowserElementTarget;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
}

export interface BrowserTypeOperation {
  operation: 'type';
  approved: true;
  target: BrowserElementTarget;
  text: string;
  clear?: boolean;
}

export interface BrowserScrollOperation {
  operation: 'scroll';
  approved: true;
  deltaX: number;
  deltaY: number;
  target?: BrowserElementTarget;
}

export interface BrowserNavigateOperation {
  operation: 'navigate';
  approved: true;
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface BrowserConsoleOperation {
  operation: 'console';
  level?: 'all' | 'debug' | 'info' | 'warning' | 'error';
  limit?: number;
}

export interface BrowserNetworkListOperation {
  operation: 'network-list';
  resourceType?: string;
  limit?: number;
}

export interface BrowserNetworkGetOperation {
  operation: 'network-get';
  requestId: string;
}

export interface BrowserNetworkFailuresOperation {
  operation: 'network-failures';
  limit?: number;
}

/** Upper bound on an evaluated script's source length. */
export const BROWSER_EVALUATE_MAX_EXPRESSION_LENGTH = 100_000;

/**
 * Runs a script in the page, as DevTools' console would. Consequential: a
 * script can change the page, so it carries the same approval as `click`.
 */
export interface BrowserEvaluateOperation {
  operation: 'evaluate';
  approved: true;
  /** A JavaScript expression; a returned promise is awaited. */
  expression: string;
}

/**
 * DevTools actions the agent may run against an in-app browser tab. Each is a
 * named, bounded use of the Chrome DevTools Protocol, not a raw passthrough.
 * `mutates` actions change what the page renders or stores, so they carry the
 * same approval, deadline and write authority as `click`; the rest only read.
 * The desktop host validates every action's params.
 */
export const BROWSER_DEVTOOLS_ACTIONS = {
  status: { mutates: false, summary: 'List the DevTools overrides active on the tab.' },
  reset: { mutates: true, summary: 'Turn off every override: emulation, overlays, forced states, throttling, cache, animation rate.' },
  'perf-metrics': { mutates: false, summary: 'Chrome counters plus page timings and web vitals.' },
  'render-start': { mutates: false, summary: 'Start recording rendering (frames, layout, paint, shifts, long tasks). params: { maxMs?, sampleCpu?: boolean } CPU sampling is opt-in and can affect timing.' },
  'render-stop': { mutates: false, summary: 'Stop recording and return the rendering report with verdicts.' },
  'capture-throttle': { mutates: true, summary: 'Temporarily set CPU slowdown for an active performance capture, with native confirmation. params: { reportId, cpu: 1-20 }. Restores the prior CPU setting when the capture stops unless another CPU change supersedes it.' },
  overlay: { mutates: true, summary: 'DevTools overlays that show in screenshots. params: { paint?, shifts?, fps?: boolean, grid?, flex?: css | null }' },
  emulate: { mutates: true, summary: 'Emulate media features, print, vision deficiency, timezone, locale. params: { media?: {feature: value}, mediaType?: screen|print, vision?, timezone?, locale? } (null clears one)' },
  'force-state': { mutates: true, summary: 'Force CSS states on an element. params: { selector, states: [hover|focus|focus-visible|focus-within|active|visited|target] }' },
  a11y: { mutates: false, summary: 'Accessibility tree plus page issues such as low contrast. params: { selector?, depth? }' },
  layout: { mutates: false, summary: 'Element boxes and key styles, plus overflow, clipping and small tap targets. params: { selector?, limit? }' },
  'animation-rate': { mutates: true, summary: 'Slow down or speed up page animations, and list them. params: { rate }' },
  'sw-list': { mutates: false, summary: 'List service worker registrations and versions.' },
  'sw-restart': { mutates: true, summary: 'Stop and start the service worker for a scope. params: { scope? }' },
  'sw-update': { mutates: true, summary: 'Check for a service worker update. params: { scope? }' },
  'sw-unregister': { mutates: true, summary: 'Unregister a service worker. params: { scope? }' },
  'storage-usage': { mutates: false, summary: "Storage use for the page's origin, by type." },
  'storage-clear': { mutates: true, summary: "Clear the page origin's data by type. params: { types: [cookies|indexeddb|local-storage|session-storage|cache-storage|service-workers|all] }" },
  'cache-clear': { mutates: true, summary: 'Clear the in-app browser HTTP cache (all sites; logins are kept).' },
  'cache-disable': { mutates: true, summary: 'Bypass the HTTP cache. params: { disabled: boolean }' },
  throttle: { mutates: true, summary: 'Throttle CPU and network. params: { cpu?: 1-20, network?: off|offline|slow-3g|fast-3g|{ latencyMs, downKbps, upKbps } }' },
} as const satisfies Record<string, { mutates: boolean; summary: string }>;

export type BrowserDevtoolsAction = keyof typeof BROWSER_DEVTOOLS_ACTIONS;

/** Upper bound on a devtools action's serialized params. */
export const BROWSER_DEVTOOLS_MAX_PARAMS_LENGTH = 16_384;

export function isBrowserDevtoolsAction(value: unknown): value is BrowserDevtoolsAction {
  return typeof value === 'string' && Object.hasOwn(BROWSER_DEVTOOLS_ACTIONS, value);
}

export function browserDevtoolsActionMutates(action: BrowserDevtoolsAction): boolean {
  return BROWSER_DEVTOOLS_ACTIONS[action].mutates;
}

export interface BrowserDevtoolsOperation {
  operation: 'devtools';
  action: BrowserDevtoolsAction;
  params?: { [key: string]: JsonValue };
  /** Required when the action mutates. */
  approved?: true;
}

export type BrowserOperationRequest =
  | BrowserViewportOperation
  | BrowserSnapshotOperation
  | BrowserInspectOperation
  | BrowserStyleOperation
  | BrowserScreenshotOperation
  | BrowserClickOperation
  | BrowserTypeOperation
  | BrowserScrollOperation
  | BrowserNavigateOperation
  | BrowserConsoleOperation
  | BrowserNetworkListOperation
  | BrowserNetworkGetOperation
  | BrowserNetworkFailuresOperation
  | BrowserEvaluateOperation
  | BrowserDevtoolsOperation;

export type BrowserOperationResult =
  | { operation: 'viewport'; preset: BrowserViewportId; width: number; height: number }
  | { operation: 'snapshot'; snapshot: JsonValue }
  | { operation: 'inspect'; inspection: JsonValue }
  | { operation: 'style'; applied: true; inspection: JsonValue }
  | {
      operation: 'screenshot';
      data: string;
      mimeType: 'image/png' | 'image/jpeg';
      width?: number;
      height?: number;
    }
  | { operation: 'click'; clicked: true; details?: JsonValue }
  | { operation: 'type'; typed: true; details?: JsonValue }
  | { operation: 'scroll'; scrolled: true; details?: JsonValue }
  | { operation: 'navigate'; url: string; title?: string; details?: JsonValue }
  | { operation: 'console'; entries: JsonValue[] }
  | { operation: 'network-list'; entries: JsonValue[] }
  | { operation: 'network-get'; entry: JsonValue }
  | { operation: 'network-failures'; entries: JsonValue[] }
  | {
      operation: 'evaluate';
      /** The script's return value, JSON-serialized by the page (null when not serializable). */
      value: JsonValue;
      /** The value's kind: its CDP subtype when it has one ('null', 'array', 'node'), else its `typeof`. */
      type: string;
      /** True when the serialized value exceeded the result size cap and was cut. */
      truncated: boolean;
    }
  | { operation: 'devtools'; action: BrowserDevtoolsAction; result: JsonValue };

export interface BrowserCommand {
  commandId: string;
  tab: BrowserTabIdentity;
  request: BrowserOperationRequest;
  createdAt: number;
  expiresAt: number;
}

export interface NextBrowserCommandRequest {
  leaseId: string;
  timeoutMs?: number;
}

export interface NextBrowserCommandResponse {
  command: BrowserCommand | null;
}

export type SubmitBrowserCommandResultRequest =
  | {
      leaseId: string;
      ok: true;
      result: BrowserOperationResult;
    }
  | {
      leaseId: string;
      ok: false;
      error: ApiError;
    };

export interface SubmitBrowserCommandResultResponse {
  accepted: true;
}

export interface ExecuteBrowserCommandRequest {
  tabId?: string;
  timeoutMs?: number;
  command: BrowserOperationRequest;
}

export interface ExecuteBrowserCommandResponse {
  commandId: string;
  tab: BrowserTabIdentity;
  result: BrowserOperationResult;
}

export function isBrowserOperationName(value: unknown): value is BrowserOperationName {
  return typeof value === 'string'
    && (BROWSER_OPERATION_NAMES as readonly string[]).includes(value);
}

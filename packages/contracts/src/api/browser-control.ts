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

export interface BrowserSnapshotOperation {
  operation: 'snapshot';
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
  | BrowserNetworkFailuresOperation;

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
  | { operation: 'network-failures'; entries: JsonValue[] };

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

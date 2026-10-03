import type { PreviewAnnotationStyle, PreviewCommentPosition } from './comments.js';

/** UI/CLI starts pairing without needing a browser tab ID. */
export interface CreateEdgeAnnotationPairRequest {
  projectId: string;
  conversationId: string;
  extensionId?: string;
  /** Server-verified workspace identity at pair creation, never extension-supplied. */
  workspace?: { workspaceId: string; workspaceMemberId: string };
}

/** Only returned to the trusted UI/CLI creating the pair. */
export interface EdgeAnnotationPairCode {
  pairId: string;
  code: string;
  expiresAt: number;
  connectionUrl?: string;
}

/** Redeemed by the paired Edge extension background, not website JavaScript. */
export interface RedeemEdgeAnnotationPairRequest {
  code: string;
  tabId: number;
  documentId: string;
  origin: string;
  /** HTTP Origin of the Edge extension background that redeemed the code. */
  extensionOrigin: string;
}

/** A human-approved association between one Edge document and one project. */
export interface CreateEdgeAnnotationGrantRequest {
  projectId: string;
  conversationId: string;
  tabId: number;
  documentId: string;
  origin: string;
  workspace?: { workspaceId: string; workspaceMemberId: string };
}

export interface EdgeAnnotationGrant extends CreateEdgeAnnotationGrantRequest {
  grantId: string;
  createdAt: number;
  expiresAt: number;
  /** Verified pairing identity, rechecked against project authority before chat writes. */
  workspace?: { workspaceId: string; workspaceMemberId: string };
}

/** Human-readable destination for a connection or committed message receipt. */
export interface EdgeAnnotationDestination {
  projectName?: string;
  conversationName?: string;
  chatUrl?: string;
}

/** Only the paired extension background receives the secret; never include it in status or lists. */
export interface EdgeAnnotationGrantSecret extends EdgeAnnotationDestination {
  grant: EdgeAnnotationGrant;
  token: string;
}

export interface EdgeAnnotationAncestor {
  /** Nearest ancestor first. No text, attribute values or HTML. */
  tag: string;
  selector: string;
  role?: string;
}

export function normalizeEdgeAnnotationAncestors(value: unknown): EdgeAnnotationAncestor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry): EdgeAnnotationAncestor[] => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const node = entry as Record<string, unknown>;
    const tag = node.tag;
    const selector = node.selector;
    const role = node.role;
    if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(tag)
      || typeof selector !== 'string' || selector.length < 1 || selector.length > 512
      || !/^[a-zA-Z0-9\s>:+\-().,#_\[\]]*$/.test(selector)
      || (role !== undefined && (typeof role !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)))) return [];
    return [{ tag, selector, ...(role === undefined ? {} : { role }) }];
  });
}

const ANNOTATION_STYLE_KEYS = [
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight',
  'fontFamily', 'textAlign', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'borderRadius',
  'opacity', 'borderColor', 'borderWidth', 'width', 'height',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
] as const satisfies readonly (keyof PreviewAnnotationStyle)[];
const ANNOTATION_CREDENTIAL_VALUE = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|session|credential|otp|one.time|auth.code|bearer)(?:\s*=\s*\S{6,}|\s*:\s*\S{6,}(?=\s*(?:$|[\n;,])))/i;

/** Keep ordinary design copy bounded; field values must be excluded by the collector. */
export function normalizeEdgeAnnotationText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || ANNOTATION_CREDENTIAL_VALUE.test(value)) return '';
  return value.replace(/[<>\u0000-\u0009\u000b-\u001f]/g, '')
    .replace(/\n/g, multiline ? '\n' : ' ').slice(0, max);
}

/** Optional measured styles may be omitted, but must never prevent a reviewed note. */
export function normalizeEdgeAnnotationStyle(value: unknown): PreviewAnnotationStyle {
  const style: PreviewAnnotationStyle = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return style;
  const input = value as Record<string, unknown>;
  for (const key of ANNOTATION_STYLE_KEYS) {
    const entry = input[key];
    if (typeof entry !== 'string' || entry.length > 160
      || !/^[a-zA-Z0-9 .,()#%/+\-'"_]*$/.test(entry)
      || ANNOTATION_CREDENTIAL_VALUE.test(entry)) continue;
    style[key] = entry;
  }
  return style;
}

/** Selectors and rectangles are local to this document/root, never top-page locators. */
export interface EdgeAnnotationScope {
  frame: 'top' | 'child';
  url: string;
  selectorRoot: 'document' | 'open-shadow';
  /** Outer host first; each bounded selector resolves in the preceding open root. */
  shadowHosts: string[];
  screenshot: 'not-supported';
}

export function normalizeEdgeAnnotationScope(value: unknown): EdgeAnnotationScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scope = value as Record<string, unknown>;
  if ((scope.frame !== 'top' && scope.frame !== 'child')
    || (scope.selectorRoot !== 'document' && scope.selectorRoot !== 'open-shadow')
    || scope.screenshot !== 'not-supported'
    || typeof scope.url !== 'string' || scope.url.length > 8192
    || !/^https?:\/\/[^\s/@?#]+(?:[/?#][^\s]*)?$/.test(scope.url)
    || /[<>\u0000-\u001f]|(?:[?&#])[^=&#]*(?:token|code|secret|password|key|credential|session|authorization)[^=&#]*=/i.test(scope.url)
    || !Array.isArray(scope.shadowHosts) || scope.shadowHosts.length > 8
    || scope.shadowHosts.some((host) => typeof host !== 'string' || !host || host.length > 512
      || !/^[a-zA-Z0-9\s>:+\-().,#_\[\]]*$/.test(host))
    || (scope.selectorRoot === 'open-shadow') !== (scope.shadowHosts.length > 0)) return undefined;
  return { frame: scope.frame, url: scope.url, selectorRoot: scope.selectorRoot,
    shadowHosts: [...scope.shadowHosts] as string[], screenshot: 'not-supported' };
}

export interface EdgeAnnotationTarget {
  selector: string;
  elementId?: string;
  label: string;
  /** Bounded visible direct text only; never form values or descendant textContent. */
  text: string;
  /** Bounded, text-only outline of safe descendant tags and direct text nodes. */
  domOutline?: string;
  position: PreviewCommentPosition;
  /** A tag hint, not HTML markup from an authenticated page. */
  htmlHint: string;
  ancestors?: EdgeAnnotationAncestor[];
  style?: PreviewAnnotationStyle;
  scope?: EdgeAnnotationScope;
}

/** Both browser sources capture the same chat-owned context, separate from the user's note. */
export interface BrowserAnnotationEvidence {
  url: string;
  title?: string;
  target?: EdgeAnnotationTarget;
  screenshot?: 'captured' | 'not-provided';
}

/** A reviewed browser annotation waiting for the user to send the conversation draft. */
export interface PendingBrowserAnnotation {
  id: string;
  projectId: string;
  conversationId: string;
  eventId: string;
  /** Legacy combined text, retained for drafts collected before structured evidence. */
  text: string;
  note?: string;
  evidence?: BrowserAnnotationEvidence;
  hasScreenshot: boolean;
  createdAt: number;
}

/** Native browser and CLI post directly to chat; no agent turn or pairing. */
export interface BrowserAnnotationPostRequest {
  conversationId: string;
  eventId: string;
  url: string;
  note: string;
  title?: string;
  target?: EdgeAnnotationTarget;
  screenshotDataUrl?: string;
}

export interface EdgeAnnotationScreenshot {
  mimeType: 'image/png';
  bytes: number;
  width: number;
  height: number;
}

/** Delivered by the paired Edge extension's background, never by page JavaScript. */
export interface SubmitEdgeAnnotationRequest {
  /** Request Origin, populated and validated by the HTTP route, not JSON supplied by the page. */
  extensionOrigin: string;
  projectId: string;
  grantId: string;
  tabId: number;
  documentId: string;
  url: string;
  title: string;
  target: EdgeAnnotationTarget;
  note: string;
  eventId: string;
  /** Optional cropped PNG; absence must not prevent posting feedback. */
  screenshotDataUrl?: string;
}

export interface EdgeAnnotationStatusResponse {
  grants: EdgeAnnotationGrant[];
  /** Direct loopback daemon origin accepted by Clipper, or null when unavailable. */
  daemonUrl: string | null;
}

export interface EdgeAnnotationSubmitResponse extends EdgeAnnotationDestination {
  projectId: string;
  conversationId: string;
  /** Pending draft evidence, not a transcript message. */
  id: string;
  replayed: boolean;
}

export interface EdgeAnnotationRevokeResponse {
  revoked: boolean;
}

/** The only read operations permitted on the specifically paired browser document. */
export type EdgeInspectionOperation = 'snapshot' | 'inspect' | 'screenshot';

/** Sent by an authorized project caller, not the extension or the inspected page. */
export interface EdgeInspectionRequest {
  conversationId: string;
  grantId: string;
  operation: EdgeInspectionOperation;
  selector?: string;
}

/** Returned to the paired extension worker; no JavaScript or page action is accepted. */
export interface EdgeInspectionTask {
  requestId: string;
  operation: EdgeInspectionOperation;
  selector?: string;
}

export interface EdgeInspectionDocument {
  html: string;
  truncated: boolean;
  url: string;
  title: string;
}

export interface EdgeInspectionScreenshot {
  dataUrl: string;
}

export type EdgeInspectionResult = EdgeInspectionDocument | EdgeInspectionScreenshot;

export interface EdgeInspectionResponse {
  ok: true;
  requestId: string;
  result: EdgeInspectionResult;
}

export interface EdgeInspectionWorkerPollResponse {
  ok: true;
  request: EdgeInspectionTask | null;
}

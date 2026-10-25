import type { ReleaseChannel } from "@open-design/release";

/**
 * @module protocol
 *
 * The OpenDesign renderer host-bridge wire contract: the injected-global name
 * and version, client/updater constant registries, and every request/result
 * type that crosses the host bridge — including the {@link OpenDesignHostBridge}
 * shape itself. Pure declarations only; depends on nothing else in the package.
 */

export const OPEN_DESIGN_HOST_GLOBAL = "__od__";
export const OPEN_DESIGN_HOST_VERSION = 2;

export const OPEN_DESIGN_HOST_CLIENT_TYPES = Object.freeze({
  DESKTOP: "desktop",
} as const);

export type OpenDesignHostClientType =
  (typeof OPEN_DESIGN_HOST_CLIENT_TYPES)[keyof typeof OPEN_DESIGN_HOST_CLIENT_TYPES];

export type OpenDesignHostClient = {
  // BCP-47 locale string (e.g. "zh-CN", "pt-BR") the host process read from
  // the OS at startup. The renderer uses this so the packaged desktop app
  // can follow the OS language even when Chromium's built-in
  // `navigator.language` would have defaulted to en-US.
  osLocale?: string;
  platform?: string;
  type: OpenDesignHostClientType;
};

export type OpenDesignHostFailure = {
  details?: unknown;
  ok: false;
  reason: string;
};

export type OpenDesignHostActionResult =
  | { ok: true }
  | OpenDesignHostFailure;

/**
 * The workspace attribution the renderer gives the host so a folder import
 * lands in the caller's current workspace instead of the host's ambient one.
 *
 * This is a deliberate structural subset of the daemon/web
 * `WorkspaceCollabContext`, redeclared here rather than imported: this package
 * is the renderer host-bridge wire contract and must stay independent of the
 * daemon/web contracts package (enforced by the "stays independent from
 * daemon/web contracts" test). A full `WorkspaceCollabContext` is structurally
 * assignable to this type, so callers pass theirs unchanged.
 *
 * Only the fields the host actually forwards are modelled, and the enum-like
 * fields stay `string` because the host treats them as opaque pass-through
 * values — the daemon remains the authority that parses and validates them.
 * Deliberately no index signature: an interface never satisfies one, so adding
 * it would reject the very `WorkspaceCollabContext` callers pass. Callers hand
 * over a variable, not a fresh literal, so the extra fields ride along fine.
 */
export type OpenDesignHostWorkspaceContext = {
  lifecycleState: string;
  memberStatus: string;
  permissions: {
    canShareProjects: boolean;
    canWriteSyncedFiles: boolean;
  };
  role: string;
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: string;
};

export type OpenDesignHostProjectImportInit = {
  designSystemId?: string | null;
  name?: string;
  skillId?: string | null;
  workspaceContext?: OpenDesignHostWorkspaceContext | null;
};

export type OpenDesignHostProjectImportSuccess = {
  conversationId: string;
  entryFile: string | null;
  ok: true;
  projectId: string;
};

export type OpenDesignHostProjectImportResult =
  | OpenDesignHostProjectImportSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostProjectReplaceWorkingDirSuccess = {
  baseDir: string;
  entryFile: string | null;
  ok: true;
};

export type OpenDesignHostProjectReplaceWorkingDirResult =
  | OpenDesignHostProjectReplaceWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostPickWorkingDirSuccess = {
  baseDir: string;
  ok: true;
  // Single-use HMAC token (minted by the host main process for `baseDir`)
  // that the renderer threads into POST /api/projects/:id/working-dir once
  // the project exists. Lets the Home flow pick a folder before the project
  // is created without exposing the daemon's desktop-auth gate.
  token: string;
};

export type OpenDesignHostPickWorkingDirResult =
  | OpenDesignHostPickWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostPdfPrintOptions = {
  deck?: boolean;
};

export type OpenDesignHostCaptureClip = { x: number; y: number; width: number; height: number };
export type OpenDesignHostCaptureOptions = { clip?: OpenDesignHostCaptureClip };
export type OpenDesignHostCaptureSuccess = {
  dataUrl: string; h: number; ok: true; w: number;
  /** Actual clipped pixel surface expressed in host renderer CSS coordinates. */
  capturedCssRect?: OpenDesignHostCaptureClip;
};
export type OpenDesignHostCaptureResult = OpenDesignHostCaptureSuccess | OpenDesignHostFailure;

export type OpenDesignHostPreviewNavigationFailure = {
  errorCode: number;
  eventId: number;
  frameName?: string;
  occurredAtMs: number;
  validatedUrl: string;
};

export type OpenDesignHostPreviewNavigationFailureListener = (
  failure: OpenDesignHostPreviewNavigationFailure,
) => void;

export type OpenDesignHostBrowserClearDataOptions = {
  cookies?: boolean;
  storage?: boolean;
};

export type OpenDesignHostBrowserTargetRegistration = {
  projectId: string;
  tabId: string;
  title?: string;
  url: string;
  webContentsId: number;
};

export type OpenDesignHostBrowserTargetIdentity = {
  tabId: string;
};

export type OpenDesignHostBrowserTarget = OpenDesignHostBrowserTargetRegistration & {
  attached: boolean;
  title: string;
};

export type OpenDesignHostBrowserRegisterTargetResult =
  | { ok: true; target: OpenDesignHostBrowserTarget }
  | OpenDesignHostFailure;

export type OpenDesignHostBrowserListTargetsResult =
  | { ok: true; targets: OpenDesignHostBrowserTarget[] }
  | OpenDesignHostFailure;

export type OpenDesignHostBrowserDomNode = {
  attributes: Record<string, string>;
  backendNodeId: number;
  childNodeCount: number;
  children?: OpenDesignHostBrowserDomNode[];
  localName: string;
  nodeName: string;
  nodeType: number;
  nodeValue: string;
};

export type OpenDesignHostBrowserBoxModel = {
  border: number[];
  content: number[];
  height: number;
  margin: number[];
  padding: number[];
  width: number;
};

export type OpenDesignHostBrowserInspectedElement = {
  attributes: Record<string, string>;
  backendNodeId: number;
  boxModel?: OpenDesignHostBrowserBoxModel;
  childNodeCount: number;
  localName: string;
  nodeName: string;
  nodeValue: string;
  selector: string;
};

export type OpenDesignHostBrowserConsoleEntry = {
  level: string;
  source: string;
  text: string;
  timestamp: number;
};

export type OpenDesignHostBrowserNetworkRequest = {
  failed?: {
    blockedReason?: string;
    canceled: boolean;
    errorText: string;
  };
  finishedAt?: number;
  method: string;
  requestBody?: string;
  requestHeaders: Record<string, string>;
  requestId: string;
  resourceType?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseStatus?: number;
  responseStatusText?: string;
  startedAt: number;
  url: string;
};

export type OpenDesignHostBrowserSnapshotOperation = {
  depth?: number;
  kind: "snapshot";
  /** Root the snapshot at this element instead of the document. */
  selector?: string;
};

export type OpenDesignHostBrowserEvaluateOperation = {
  approved: true;
  expression: string;
  kind: "evaluate";
};

export type OpenDesignHostBrowserInspectOperation = {
  kind: "inspect";
  selector: string;
};

export type OpenDesignHostBrowserScreenshotOperation = {
  format?: "jpeg" | "png" | "webp";
  fullPage?: boolean;
  kind: "screenshot";
  quality?: number;
};

export type OpenDesignHostBrowserClickOperation = {
  approved: true;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  kind: "click";
  selector: string;
};

export type OpenDesignHostBrowserTypeOperation = {
  approved: true;
  clear?: boolean;
  kind: "type";
  selector: string;
  text: string;
};

export type OpenDesignHostBrowserScrollOperation = {
  approved: true;
  deltaX?: number;
  deltaY: number;
  kind: "scroll";
  selector?: string;
};

export type OpenDesignHostBrowserNavigateOperation = {
  approved: true;
  kind: "navigate";
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
};

export type OpenDesignHostBrowserConsoleOperation = {
  kind: "console";
  level?: "all" | "debug" | "info" | "warning" | "error";
  limit?: number;
};

export type OpenDesignHostBrowserNetworkOperation = {
  failuresOnly?: boolean;
  kind: "network";
  limit?: number;
  requestId?: string;
  resourceType?: string;
};

export type OpenDesignHostBrowserOperation =
  | OpenDesignHostBrowserSnapshotOperation
  | OpenDesignHostBrowserInspectOperation
  | OpenDesignHostBrowserScreenshotOperation
  | OpenDesignHostBrowserClickOperation
  | OpenDesignHostBrowserTypeOperation
  | OpenDesignHostBrowserScrollOperation
  | OpenDesignHostBrowserNavigateOperation
  | OpenDesignHostBrowserConsoleOperation
  | OpenDesignHostBrowserNetworkOperation
  | OpenDesignHostBrowserEvaluateOperation;

export type OpenDesignHostBrowserExecuteRequest = {
  expiresAt?: number;
  operation: OpenDesignHostBrowserOperation;
  tabId: string;
};

export type OpenDesignHostBrowserExecuteSuccess =
  | { ok: true; operation: "snapshot"; tabId: string; value: { document: OpenDesignHostBrowserDomNode; truncated: boolean } | null }
  | { ok: true; operation: "inspect"; tabId: string; value: OpenDesignHostBrowserInspectedElement | null }
  | { ok: true; operation: "screenshot"; tabId: string; value: { dataUrl: string; format: "jpeg" | "png" | "webp" } }
  | { ok: true; operation: "click"; tabId: string; value: { x: number; y: number } }
  | { ok: true; operation: "type"; tabId: string; value: { inserted: number } }
  | { ok: true; operation: "scroll"; tabId: string; value: { deltaX: number; deltaY: number } }
  | { ok: true; operation: "navigate"; tabId: string; value: { frameId?: string; url: string } }
  | { ok: true; operation: "console"; tabId: string; value: { entries: OpenDesignHostBrowserConsoleEntry[] } }
  | { ok: true; operation: "network"; tabId: string; value: { requests: OpenDesignHostBrowserNetworkRequest[] } }
  | { ok: true; operation: "evaluate"; tabId: string; value: { truncated: boolean; type: string; value: unknown } };

export type OpenDesignHostBrowserExecuteResult =
  | OpenDesignHostBrowserExecuteSuccess
  | OpenDesignHostFailure;

/**
 * App theme values the renderer may pin the host window appearance to.
 * `light`/`dark` force the native window material (macOS under-window
 * vibrancy glass follows the OS appearance by default, which reads as a
 * muddy gray when the OS is dark but the app theme is explicitly light);
 * `system` restores following the OS.
 */
export const OPEN_DESIGN_HOST_APPEARANCE_THEMES = Object.freeze({
  DARK: "dark",
  LIGHT: "light",
  SYSTEM: "system",
} as const);

export type OpenDesignHostAppearanceTheme =
  (typeof OPEN_DESIGN_HOST_APPEARANCE_THEMES)[keyof typeof OPEN_DESIGN_HOST_APPEARANCE_THEMES];

export const OPEN_DESIGN_HOST_UPDATER_ACTIONS = Object.freeze({
  CHECK: "check",
  CLEAR_CACHE: "clear-cache",
  DOWNLOAD: "download",
  INSTALL: "install",
  QUIT: "quit",
  STATUS: "status",
} as const);

export type OpenDesignHostUpdaterAction =
  (typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS)[keyof typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS];

/** @internal Updater actions that return a status snapshot (every action except `quit`). */
export type OpenDesignHostUpdaterStatusAction = Exclude<
  OpenDesignHostUpdaterAction,
  typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS.QUIT
>;

export const OPEN_DESIGN_HOST_UPDATER_STATES = Object.freeze({
  AVAILABLE: "available",
  CHECKING: "checking",
  DOWNLOADED: "downloaded",
  DOWNLOADING: "downloading",
  ERROR: "error",
  IDLE: "idle",
  INSTALLING: "installing",
  NOT_AVAILABLE: "not-available",
  UNSUPPORTED: "unsupported",
} as const);

export type OpenDesignHostUpdaterState =
  (typeof OPEN_DESIGN_HOST_UPDATER_STATES)[keyof typeof OPEN_DESIGN_HOST_UPDATER_STATES];

export type OpenDesignHostUpdaterMode = "js-incremental" | "package-launcher";
export type OpenDesignHostUpdaterChannel = ReleaseChannel;

export type OpenDesignHostUpdaterActionOptions = {
  payload?: Record<string, unknown>;
};

export type OpenDesignHostUpdaterCapabilitySet = {
  canApplyInPlace: boolean;
  canDownload: boolean;
  canOpenInstaller: boolean;
  requiresManualInstall: boolean;
};

export type OpenDesignHostUpdaterPathSnapshot = {
  downloadRoot?: string;
  manifestPath?: string;
};

export type OpenDesignHostUpdaterChecksumSnapshot = {
  algorithm: "sha256" | "sha512";
  url?: string;
  value?: string;
};

export type OpenDesignHostUpdaterArtifactSnapshot = {
  name?: string;
  platformKey?: string;
  size?: number;
  type?: string;
  url: string;
};

export type OpenDesignHostUpdaterProgressSnapshot = {
  receivedBytes: number;
  totalBytes?: number;
};

export type OpenDesignHostUpdaterErrorSnapshot = {
  code: string;
  details?: unknown;
  message: string;
};

export type OpenDesignHostUpdaterInstallResult = {
  activeVersion?: string;
  artifactPath?: string;
  dryRun?: boolean;
  helperLogPath?: string;
  launcherRuntimePath?: string;
  launchPath?: string;
  openedAt: string;
  path: string;
};

export type OpenDesignHostUpdaterReleaseSnapshot = {
  arch: string;
  artifact: OpenDesignHostUpdaterArtifactSnapshot;
  checksum: OpenDesignHostUpdaterChecksumSnapshot;
  channel: OpenDesignHostUpdaterChannel;
  downloadedAt: string;
  key: string;
  metadata?: Record<string, unknown>;
  path: string;
  platformKey: string;
  version: string;
};

export type OpenDesignHostUpdaterIncomingSnapshot = {
  arch: string;
  artifact: OpenDesignHostUpdaterArtifactSnapshot;
  channel: OpenDesignHostUpdaterChannel;
  key?: string;
  metadata?: Record<string, unknown>;
  progress?: OpenDesignHostUpdaterProgressSnapshot;
  startedAt: string;
  version: string;
};

export type OpenDesignHostUpdaterCacheLifecycleTrigger = "cold-start" | "manual" | "next-version-ready";

export type OpenDesignHostUpdaterReleaseLifecycleState =
  | "cleanup-deferred"
  | "cleanup-removed"
  | "deprecated"
  | "retained"
  | "unknown";

export type OpenDesignHostUpdaterCacheLifecycleSummary = {
  lastRunAt?: string;
  lastTrigger?: OpenDesignHostUpdaterCacheLifecycleTrigger;
  platform: string;
  releases: {
    cleanupDeferred: number;
    cleanupRemoved: number;
    deprecated: number;
    errors: number;
    retained: number;
    total: number;
    unknown: number;
  };
};

export type OpenDesignHostUpdaterCacheSnapshot = {
  lifecycle?: OpenDesignHostUpdaterCacheLifecycleSummary;
};

export type OpenDesignHostUpdaterReinstallReason =
  | "launcher-schema"
  | "outer-below-min"
  | "outer-version-unreadable";

/**
 * Present when the release feed requires a full installer reinstall instead of
 * an in-place payload update. `installedVersion` is the physically installed
 * outer package version; `url` is an optional operator-supplied explanation
 * link.
 */
export type OpenDesignHostUpdaterReinstallSnapshot = {
  installedVersion?: string;
  minVersion?: string;
  reason: OpenDesignHostUpdaterReinstallReason;
  url?: string;
};

export type OpenDesignHostUpdaterStatusSnapshot = {
  active?: OpenDesignHostUpdaterReleaseSnapshot;
  arch: string;
  artifact?: OpenDesignHostUpdaterArtifactSnapshot;
  artifactUrl?: string;
  availableVersion?: string;
  cache?: OpenDesignHostUpdaterCacheSnapshot;
  capabilities: OpenDesignHostUpdaterCapabilitySet;
  channel: OpenDesignHostUpdaterChannel;
  checksum?: OpenDesignHostUpdaterChecksumSnapshot;
  currentVersion: string;
  downloadPath?: string;
  enabled: boolean;
  error?: OpenDesignHostUpdaterErrorSnapshot;
  incoming?: OpenDesignHostUpdaterIncomingSnapshot;
  installResult?: OpenDesignHostUpdaterInstallResult;
  lastCheckedAt?: string;
  metadata?: Record<string, unknown>;
  mode: OpenDesignHostUpdaterMode;
  paths?: OpenDesignHostUpdaterPathSnapshot;
  platform: string;
  progress?: OpenDesignHostUpdaterProgressSnapshot;
  reinstall?: OpenDesignHostUpdaterReinstallSnapshot;
  state: OpenDesignHostUpdaterState;
  supported: boolean;
};

export type OpenDesignHostUpdaterResult =
  | { ok: true; status: OpenDesignHostUpdaterStatusSnapshot }
  | OpenDesignHostFailure;

export type OpenDesignHostUpdaterStatusListener = (status: OpenDesignHostUpdaterStatusSnapshot) => void;

export type OpenDesignHostUpdaterMenuLabels = {
  check: string;
  checking: string;
  downloading: string;
  install: string;
  installing: string;
  restart: string;
};

export type OpenDesignHostUpdaterOpenDialogRequest = {
  source: string;
};

export type OpenDesignHostUpdaterOpenDialogListener = (request: OpenDesignHostUpdaterOpenDialogRequest) => void;

/** Transient native child context. Never persist its surface identifier. */
export type OpenDesignHostBrowserPopup = {
  surfaceId: string;
  projectId: string;
  openerTabId: string;
  ancestorTabIds: string[];
  tabId?: string;
  webContentsId: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  disposition: string;
};
export type OpenDesignHostBrowserPopupEvent = { kind: 'updated' | 'closed'; popup: OpenDesignHostBrowserPopup }
  | { kind: 'console'; popup: OpenDesignHostBrowserPopup; message: string };
export type OpenDesignHostBrowserPopupRequest = { projectId: string; surfaceId: string };
export type OpenDesignHostBrowserPopupCommand = OpenDesignHostBrowserPopupRequest & (
  | { kind: 'back' | 'forward' | 'reload' | 'reload-hard' | 'stop' | 'focus' | 'close' | 'capture' }
  | { kind: 'navigate'; url: string }
  | { kind: 'evaluate'; code: string; userGesture?: boolean }
);
export type OpenDesignHostBrowserPopupResult = { ok: true; value?: unknown } | OpenDesignHostFailure;

export type OpenDesignHostBridge = {
  // Optional so older host builds still satisfy the bridge shape; callers
  // must feature-detect before invoking.
  appearance?: {
    setTheme(theme: OpenDesignHostAppearanceTheme): void;
  };
  browser: {
    listPopups?(projectId: string): Promise<{ ok: true; popups: OpenDesignHostBrowserPopup[] } | OpenDesignHostFailure>;
    subscribePopups?(listener: (event: OpenDesignHostBrowserPopupEvent) => void): () => void;
    bindPopup?(request: OpenDesignHostBrowserPopupRequest & { tabId: string }): Promise<OpenDesignHostBrowserPopupResult>;
    presentPopup?(request: OpenDesignHostBrowserPopupRequest & { bounds: { x: number; y: number; width: number; height: number }; visible: boolean; revision: number }): Promise<OpenDesignHostBrowserPopupResult>;
    popupCommand?(request: OpenDesignHostBrowserPopupCommand): Promise<OpenDesignHostBrowserPopupResult>;
    closePopupProject?(projectId: string): Promise<OpenDesignHostActionResult>;
    clearData(options?: OpenDesignHostBrowserClearDataOptions): Promise<OpenDesignHostActionResult>;
    // Optional so version-2 web bundles continue to recognize older desktop
    // hosts; callers must feature-detect the shared embedded-browser control.
    execute?(request: OpenDesignHostBrowserExecuteRequest): Promise<OpenDesignHostBrowserExecuteResult>;
    listTargets?(): Promise<OpenDesignHostBrowserListTargetsResult>;
    registerTarget?(
      target: OpenDesignHostBrowserTargetRegistration,
    ): Promise<OpenDesignHostBrowserRegisterTargetResult>;
    unregisterTarget?(target: OpenDesignHostBrowserTargetIdentity): Promise<OpenDesignHostActionResult>;
  };
  capture: {
    page(options?: OpenDesignHostCaptureOptions): Promise<OpenDesignHostCaptureResult>;
  };
  client: OpenDesignHostClient;
  pdf: {
    print(html: string, nonce?: string, options?: OpenDesignHostPdfPrintOptions): Promise<OpenDesignHostActionResult>;
  };
  pet: {
    setVisible(visible: boolean): void;
  };
  // Optional so web builds and older desktop hosts keep the same contract.
  // Electron is the only layer that can observe a compositor-affecting
  // subframe navigation failure after the iframe DOM remains healthy.
  preview?: {
    getLatestNavigationFailure(): OpenDesignHostPreviewNavigationFailure | null;
    subscribeNavigationFailure(listener: OpenDesignHostPreviewNavigationFailureListener): () => void;
  };
  project: {
    pickAndImport(init?: OpenDesignHostProjectImportInit): Promise<OpenDesignHostProjectImportResult>;
    pickAndReplaceWorkingDir(projectId: string): Promise<OpenDesignHostProjectReplaceWorkingDirResult>;
    // Optional so older host builds still satisfy the bridge shape; callers
    // must feature-detect before invoking.
    pickWorkingDir?(): Promise<OpenDesignHostPickWorkingDirResult>;
  };
  shell: {
    openExternal(url: string): Promise<OpenDesignHostActionResult>;
    openPath(projectId: string): Promise<OpenDesignHostActionResult>;
  };
  // Desktop only. Absent in Web and old clients; callers must fail closed.
  updater: {
    check(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    "clear-cache"(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    download(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    install(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    quit(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostActionResult>;
    setMenuLabels(labels: OpenDesignHostUpdaterMenuLabels): Promise<OpenDesignHostActionResult>;
    status(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    subscribe(listener: OpenDesignHostUpdaterStatusListener): () => void;
    subscribeOpenDialog(listener: OpenDesignHostUpdaterOpenDialogListener): () => void;
  };
  version: typeof OPEN_DESIGN_HOST_VERSION;
};

export type OpenDesignHostGlobalScope = Record<string, unknown> & {
  window?: unknown;
};

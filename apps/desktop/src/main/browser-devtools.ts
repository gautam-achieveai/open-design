import {
  BROWSER_DEVTOOLS_MAX_PARAMS_LENGTH,
  browserDevtoolsActionMutates,
  isBrowserDevtoolsAction,
  type BrowserDevtoolsAction,
} from "@open-design/contracts";
import type { OpenDesignHostBrowserDevtoolsOperation } from "@open-design/host";
import type { WebContents } from "electron";

// Named DevTools actions for the in-app browser. Each one is a bounded use of
// CDP on the tab's existing debugger session: no raw passthrough, no new port.
// Params arrive untrusted from the daemon, so every action validates its own.

type UnknownRecord = Record<string, unknown>;
type Send = (method: string, params?: UnknownRecord) => Promise<UnknownRecord>;
type ActionResult = { ok: true; value: unknown } | { ok: false; reason: string };

const MAX_TRACE_EVENTS = 400_000;
const MAX_TRACKED_ANIMATIONS = 200;
const MAX_TRACKED_ISSUES = 200;
const MAX_A11Y_NODES = 2_000;
const MAX_LAYOUT_ELEMENTS = 1_500;
const DEFAULT_RENDER_MS = 15_000;
const MAX_RENDER_MS = 60_000;
const LONG_TASK_MS = 50;
const THRASH_LAYOUTS_PER_TASK = 10;
const MAX_SELECTOR_LENGTH = 4_096;

const MEDIA_FEATURES: Record<string, readonly string[]> = {
  "prefers-color-scheme": ["light", "dark"],
  "prefers-reduced-motion": ["reduce", "no-preference"],
  "prefers-reduced-transparency": ["reduce", "no-preference"],
  "prefers-contrast": ["more", "less", "custom", "no-preference"],
  "forced-colors": ["active", "none"],
  "color-gamut": ["srgb", "p3", "rec2020"],
};
const MEDIA_TYPES = ["screen", "print"] as const;
const VISION_DEFICIENCIES = [
  "none", "blurredVision", "reducedContrast", "achromatopsia", "deuteranopia", "protanopia", "tritanopia",
] as const;
const FORCEABLE_STATES = ["hover", "focus", "focus-visible", "focus-within", "active", "visited", "target"] as const;
const STORAGE_TYPES = ["cookies", "indexeddb", "local-storage", "session-storage", "cache-storage", "service-workers"] as const;
const NETWORK_PRESETS: Record<string, { latencyMs: number; downKbps: number; upKbps: number }> = {
  "slow-3g": { latencyMs: 2_000, downKbps: 400, upKbps: 400 },
  "fast-3g": { latencyMs: 563, downKbps: 1_440, upKbps: 675 },
};
// Animating anything but these makes the browser lay out or paint every frame.
const COMPOSITED_PROPERTIES = new Set(["transform", "opacity", "filter", "translate", "rotate", "scale", "offset-distance"]);
const FORCED_STATE_STYLES = [
  "color", "background-color", "border-color", "outline-color", "outline-style", "outline-width",
  "box-shadow", "text-decoration-line", "opacity", "transform", "cursor",
];
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "loading",
];

type ThrottleState = { cpu: number; network: string | { latencyMs: number; downKbps: number; upKbps: number } };

type TraceEvent = {
  name?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  ts?: number;
  dur?: number;
  args?: UnknownRecord;
};

type Recording = {
  startedAt: number;
  maxMs: number;
  visible: boolean;
  events: TraceEvent[];
  droppedEvents: number;
  complete: Promise<void>;
  markComplete: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  report: Promise<unknown> | null;
};

export type DevtoolsState = {
  enabled: Set<string>;
  emulation: { media: Record<string, string>; mediaType: string; vision: string; timezone: string; locale: string } | null;
  overlays: { paint: boolean; shifts: boolean; fps: boolean; grid: string | null; flex: string | null } | null;
  forcedStates: Map<string, string[]>;
  throttle: ThrottleState | null;
  cacheDisabled: boolean;
  animationRate: number;
  animations: Map<string, UnknownRecord>;
  issues: UnknownRecord[];
  registrations: Map<string, UnknownRecord>;
  versions: Map<string, UnknownRecord>;
  workerErrors: UnknownRecord[];
  recording: Recording | null;
  // A report the auto-stop finished before render-stop asked for it.
  lastReport: unknown;
};

export function createDevtoolsState(): DevtoolsState {
  return {
    animationRate: 1,
    animations: new Map(),
    cacheDisabled: false,
    emulation: null,
    enabled: new Set(),
    forcedStates: new Map(),
    issues: [],
    lastReport: null,
    overlays: null,
    recording: null,
    registrations: new Map(),
    throttle: null,
    versions: new Map(),
    workerErrors: [],
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pushBounded<T>(list: T[], value: T, max: number): void {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function invalid(reason: string): ActionResult {
  return { ok: false, reason: `invalid devtools params: ${reason}` };
}

function selectorParam(params: UnknownRecord, key: string): string | undefined | null {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && value.trim() && value.length <= MAX_SELECTOR_LENGTH ? value.trim() : undefined;
}

/** Stops timers when the guest goes away. */
export function disposeDevtoolsState(state: DevtoolsState): void {
  if (state.recording?.timer) clearTimeout(state.recording.timer);
  state.recording = null;
}

/** Collects the CDP events that devtools actions report on later. */
export function onDevtoolsEvent(state: DevtoolsState, method: string, payload: UnknownRecord): void {
  if (method === "Tracing.dataCollected") {
    const recording = state.recording;
    if (!recording || !Array.isArray(payload.value)) return;
    for (const event of payload.value) {
      if (recording.events.length >= MAX_TRACE_EVENTS) {
        recording.droppedEvents += 1;
        continue;
      }
      recording.events.push(event as TraceEvent);
    }
    return;
  }
  if (method === "Tracing.tracingComplete") {
    state.recording?.markComplete();
    return;
  }
  if (method === "Animation.animationStarted" && isRecord(payload.animation)) {
    const animation = summarizeAnimation(payload.animation);
    if (!animation) return;
    state.animations.set(String(animation.id), animation);
    while (state.animations.size > MAX_TRACKED_ANIMATIONS) {
      const oldest = state.animations.keys().next().value;
      if (oldest === undefined) break;
      state.animations.delete(oldest);
    }
    return;
  }
  if (method === "Audits.issueAdded" && isRecord(payload.issue)) {
    pushBounded(state.issues, payload.issue, MAX_TRACKED_ISSUES);
    return;
  }
  if (method === "ServiceWorker.workerRegistrationUpdated" && Array.isArray(payload.registrations)) {
    for (const registration of payload.registrations) {
      if (isRecord(registration) && typeof registration.registrationId === "string") {
        state.registrations.set(registration.registrationId, registration);
      }
    }
    return;
  }
  if (method === "ServiceWorker.workerVersionUpdated" && Array.isArray(payload.versions)) {
    for (const version of payload.versions) {
      if (isRecord(version) && typeof version.versionId === "string") state.versions.set(version.versionId, version);
    }
    return;
  }
  if (method === "ServiceWorker.workerErrorReported" && isRecord(payload.errorMessage)) {
    pushBounded(state.workerErrors, payload.errorMessage, 50);
  }
}

/** Validates the envelope; each action validates its own params when it runs. */
export function parseDevtoolsOperation(value: UnknownRecord): OpenDesignHostBrowserDevtoolsOperation | null {
  if (!isBrowserDevtoolsAction(value.action)) return null;
  const params = value.params === undefined ? {} : value.params;
  if (!isRecord(params)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    return null;
  }
  if (serialized.length > BROWSER_DEVTOOLS_MAX_PARAMS_LENGTH) return null;
  if (browserDevtoolsActionMutates(value.action) && value.approved !== true) return null;
  return {
    action: value.action,
    ...(value.approved === true ? { approved: true } : {}),
    kind: "devtools",
    params,
  };
}

export function devtoolsOperationMutates(operation: unknown): boolean {
  return isRecord(operation) && isBrowserDevtoolsAction(operation.action) && browserDevtoolsActionMutates(operation.action);
}

function summarizeAnimation(raw: UnknownRecord): UnknownRecord | null {
  const id = stringValue(raw.id);
  if (!id) return null;
  const source = isRecord(raw.source) ? raw.source : {};
  const keyframesRule = isRecord(source.keyframesRule) ? source.keyframesRule : {};
  const properties = new Set<string>();
  for (const keyframe of Array.isArray(keyframesRule.keyframes) ? keyframesRule.keyframes : []) {
    const style = isRecord(keyframe) ? stringValue(keyframe.style) : undefined;
    for (const declaration of (style ?? "").split(";")) {
      const property = declaration.split(":")[0]?.trim().toLowerCase();
      if (property) properties.add(property);
    }
  }
  return withCost({
    id,
    name: stringValue(raw.name) ?? "",
    type: stringValue(raw.type) ?? "",
    durationMs: finiteNumber(source.duration) ?? null,
    easing: stringValue(source.easing) ?? null,
    iterations: finiteNumber(source.iterations) ?? null,
    backendNodeId: finiteNumber(source.backendNodeId) ?? null,
    properties: [...properties],
  });
}

async function ensureDomain(send: Send, state: DevtoolsState, domain: string): Promise<void> {
  if (state.enabled.has(domain)) return;
  await send(`${domain}.enable`);
  state.enabled.add(domain);
}

async function queryNode(send: Send, selector: string): Promise<{ nodeId: number; backendNodeId: number } | null> {
  const document = await send("DOM.getDocument", { depth: 0, pierce: true });
  const root = isRecord(document.root) ? document.root : {};
  const rootNodeId = finiteNumber(root.nodeId);
  if (rootNodeId === undefined) return null;
  const result = await send("DOM.querySelector", { nodeId: rootNodeId, selector });
  const nodeId = finiteNumber(result.nodeId);
  if (!nodeId) return null;
  const described = await send("DOM.describeNode", { nodeId });
  const node = isRecord(described.node) ? described.node : {};
  return { backendNodeId: finiteNumber(node.backendNodeId) ?? 0, nodeId };
}

async function evaluateInPage(send: Send, expression: string): Promise<unknown> {
  const result = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (isRecord(result.exceptionDetails)) {
    const exception = isRecord(result.exceptionDetails.exception) ? result.exceptionDetails.exception : {};
    throw new Error(stringValue(exception.description) ?? stringValue(result.exceptionDetails.text) ?? "page script failed");
  }
  return isRecord(result.result) ? result.result.value : undefined;
}

function statusOf(state: DevtoolsState): UnknownRecord {
  return {
    animationRate: state.animationRate,
    cacheDisabled: state.cacheDisabled,
    emulation: state.emulation,
    forcedStates: [...state.forcedStates].map(([selector, states]) => ({ selector, states })),
    overlays: state.overlays,
    recording: state.recording
      ? { maxMs: state.recording.maxMs, runningMs: Date.now() - state.recording.startedAt, visible: state.recording.visible }
      : null,
    throttle: state.throttle,
  };
}

// --- in-page scripts (plain strings: bundlers may rewrite function bodies) ---

const PAGE_SELECTOR_HELPER = `
const __odSel = (node) => {
  if (!node || node.nodeType !== 1) return node ? node.nodeName.toLowerCase() : null;
  const parts = [];
  for (let el = node; el && el.nodeType === 1 && parts.length < 4; el = el.parentElement) {
    if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
    let part = el.localName;
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
    if (cls) part += cls;
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.localName === el.localName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    parts.unshift(part);
  }
  return parts.join(' > ');
};`;

const RENDER_OBSERVER_START = `(() => {
${PAGE_SELECTOR_HELPER}
  const prior = window.__odRender;
  if (prior) prior.observers.forEach((o) => o.disconnect());
  const data = { shifts: [], loaf: [], observers: [] };
  const watch = (type, fn) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => list.getEntries().forEach(fn));
    observer.observe({ type, buffered: false });
    data.observers.push(observer);
  };
  watch('layout-shift', (e) => data.shifts.length < 200 && data.shifts.push({
    atMs: Math.round(e.startTime), value: e.value, hadRecentInput: e.hadRecentInput,
    sources: (e.sources || []).map((s) => ({ element: __odSel(s.node),
      from: s.previousRect && [Math.round(s.previousRect.x), Math.round(s.previousRect.y), Math.round(s.previousRect.width), Math.round(s.previousRect.height)],
      to: s.currentRect && [Math.round(s.currentRect.x), Math.round(s.currentRect.y), Math.round(s.currentRect.width), Math.round(s.currentRect.height)] })),
  }));
  watch('long-animation-frame', (e) => data.loaf.length < 100 && data.loaf.push({
    atMs: Math.round(e.startTime), durationMs: Math.round(e.duration), blockingMs: Math.round(e.blockingDuration || 0),
    scripts: (e.scripts || []).slice(0, 5).map((s) => ({ invoker: s.invoker, source: s.sourceURL ? s.sourceURL.slice(0, 200) : '',
      fn: s.sourceFunctionName || '', durationMs: Math.round(s.duration), forcedLayoutMs: Math.round(s.forcedStyleAndLayoutDuration || 0) })),
  }));
  window.__odRender = data;
  return document.visibilityState === 'visible';
})()`;

// CDP only reports animations that start while it listens, so the page lists
// the ones already running.
const PAGE_ANIMATIONS = `
const __odAnimations = () => document.getAnimations().slice(0, 100).map((a) => {
  const effect = a.effect;
  const timing = effect && effect.getTiming ? effect.getTiming() : {};
  const properties = new Set();
  if (effect && effect.getKeyframes) for (const frame of effect.getKeyframes()) for (const key of Object.keys(frame)) {
    if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) properties.add(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  }
  return { name: a.animationName || a.transitionProperty || a.id || '', type: a.constructor.name, element: __odSel(effect && effect.target),
    durationMs: typeof timing.duration === 'number' ? Math.round(timing.duration) : null, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations ?? null,
    playState: a.playState, properties: [...properties] };
});`;

const RENDER_OBSERVER_STOP = `(() => {
${PAGE_SELECTOR_HELPER}
${PAGE_ANIMATIONS}
  const data = window.__odRender;
  const animations = __odAnimations();
  if (!data) return { shifts: [], loaf: [], animations };
  data.observers.forEach((o) => o.disconnect());
  delete window.__odRender;
  return { shifts: data.shifts, loaf: data.loaf, animations };
})()`;

const PAGE_ANIMATIONS_SCRIPT = `(() => {
${PAGE_SELECTOR_HELPER}
${PAGE_ANIMATIONS}
  return __odAnimations();
})()`;

function withCost(animation: UnknownRecord): UnknownRecord {
  const properties = Array.isArray(animation.properties) ? animation.properties.map(String) : [];
  const costly = properties.filter((property) => !COMPOSITED_PROPERTIES.has(property));
  return { ...animation, ...(costly.length > 0 ? { costlyProperties: costly } : {}) };
}

/** Page-listed animations first; CDP adds the ones that ended before the list was taken. */
function mergeAnimations(page: UnknownRecord[], fromEvents: UnknownRecord[]): UnknownRecord[] {
  const names = new Set(page.map((animation) => String(animation.name)));
  return [...page.map(withCost), ...fromEvents.filter((animation) => !names.has(String(animation.name)))];
}

const PAGE_PERF_SCRIPT = `(async () => {
${PAGE_SELECTOR_HELPER}
  const buffered = (type) => new Promise((resolve) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return resolve([]);
    const observer = new PerformanceObserver((list) => { observer.disconnect(); resolve(list.getEntries()); });
    observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
    setTimeout(() => { observer.disconnect(); resolve([]); }, 100);
  });
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
  const resources = performance.getEntriesByType('resource');
  const [lcp, shifts, events] = await Promise.all([buffered('largest-contentful-paint'), buffered('layout-shift'), buffered('event')]);
  const lastLcp = lcp[lcp.length - 1];
  const worstEvent = events.filter((e) => e.interactionId).sort((a, b) => b.duration - a.duration)[0];
  return {
    ttfbMs: nav ? Math.round(nav.responseStart) : null,
    fcpMs: paint['first-contentful-paint'] ?? null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadMs: nav ? Math.round(nav.loadEventEnd) : null,
    lcpMs: lastLcp ? Math.round(lastLcp.startTime) : null,
    lcpElement: lastLcp ? __odSel(lastLcp.element) : null,
    cls: Math.round(shifts.filter((e) => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0) * 1000) / 1000,
    inpMs: worstEvent ? Math.round(worstEvent.duration) : null,
    inpEvent: worstEvent ? worstEvent.name : null,
    requests: resources.length,
    transferKB: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
  };
})()`;

function layoutScript(selector: string | undefined, limit: number): string {
  return `(() => {
${PAGE_SELECTOR_HELPER}
  const root = ${selector === undefined ? "document.body" : `document.querySelector(${JSON.stringify(selector)})`};
  if (!root) return null;
  const limit = ${limit};
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const KEEP = ['display','position','z-index','font-size','font-weight','line-height','color','background-color','margin','padding','gap','overflow','opacity','flex-direction','justify-content','align-items','grid-template-columns'];
  const BORING = new Set(['auto','normal','none','0px','visible','static','1','rgba(0, 0, 0, 0)','row','start','stretch','400']);
  const elements = [], issues = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && elements.length < limit) {
    const el = queue.shift();
    seen++;
    for (const child of el.children) queue.push(child);
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    const styles = {};
    for (const p of KEEP) { const v = style.getPropertyValue(p); if (v && !BORING.has(v)) styles[p] = v; }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 60);
    const sel = __odSel(el);
    elements.push({ sel, tag: el.localName, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], ...(own ? { text: own } : {}), styles });
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && style.overflowX !== 'auto' && style.overflowX !== 'scroll' && style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
      issues.push({ kind: 'clipped-content', element: sel, scroll: [el.scrollWidth, el.scrollHeight], client: [el.clientWidth, el.clientHeight] });
    }
    if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) issues.push({ kind: 'truncated-text', element: sel, text: el.textContent.trim().slice(0, 80) });
    if (r.width > 0 && r.right > vw + 1 && style.position !== 'fixed') issues.push({ kind: 'overflows-viewport', element: sel, right: Math.round(r.right), viewportWidth: vw });
    const interactive = el.matches('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[tabindex]:not([tabindex="-1"])');
    if (interactive && r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) issues.push({ kind: 'small-tap-target', element: sel, size: [Math.round(r.width), Math.round(r.height)], minimum: 24 });
  }
  const pageOverflow = document.documentElement.scrollWidth > vw + 1;
  if (pageOverflow) issues.unshift({ kind: 'horizontal-page-scroll', scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw });
  return { viewport: { width: vw, height: vh, dpr: devicePixelRatio }, root: __odSel(root), count: elements.length, truncated: queue.length > 0, elements, issues: issues.slice(0, 200) };
})()`;
}

// --- render recording analysis ---

function mainRendererThread(events: TraceEvent[]): { pid: number; tid: number } | null {
  const mains = events.filter((event) => event.name === "thread_name" && isRecord(event.args) && event.args.name === "CrRendererMain");
  let best: { pid: number; tid: number; tasks: number } | null = null;
  for (const main of mains) {
    if (main.pid === undefined || main.tid === undefined) continue;
    const tasks = events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.name === "RunTask").length;
    if (!best || tasks > best.tasks) best = { pid: main.pid, tid: main.tid, tasks };
  }
  return best ? { pid: best.pid, tid: best.tid } : null;
}

function quadBox(clip: unknown): [number, number, number, number] | null {
  if (!Array.isArray(clip) || clip.length < 8 || !clip.every((n) => typeof n === "number")) return null;
  const xs = [clip[0], clip[2], clip[4], clip[6]] as number[];
  const ys = [clip[1], clip[3], clip[5], clip[7]] as number[];
  if ([...xs, ...ys].some((n) => Math.abs(n) > 1_000_000)) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [round(x), round(y), round(Math.max(...xs) - x), round(Math.max(...ys) - y)];
}

/** Turns a trace plus in-page observations into a rendering report. Exported for tests. */
export function analyzeRendering(input: {
  events: TraceEvent[];
  durationMs: number;
  visible: boolean;
  droppedEvents: number;
  page: { shifts: UnknownRecord[]; loaf: UnknownRecord[] };
  animations: UnknownRecord[];
}): UnknownRecord {
  const main = mainRendererThread(input.events);
  const onMain = (event: TraceEvent) => main !== null && event.pid === main.pid && event.tid === main.tid;
  const complete = (event: TraceEvent) => event.ph === "X" && typeof event.ts === "number" && typeof event.dur === "number";
  const mainEvents = input.events.filter((event) => onMain(event) && complete(event));
  const named = (name: string) => mainEvents.filter((event) => event.name === name);
  const totalMs = (list: TraceEvent[]) => round(list.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000, 1);

  const tasks = named("RunTask");
  const layouts = named("Layout");
  const longTasks = tasks
    .filter((task) => (task.dur ?? 0) / 1000 > LONG_TASK_MS)
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    .slice(0, 10)
    .map((task) => ({ durationMs: round((task.dur ?? 0) / 1000) }));
  const within = (outer: TraceEvent, inner: TraceEvent) =>
    (inner.ts ?? 0) >= (outer.ts ?? 0) && (inner.ts ?? 0) + (inner.dur ?? 0) <= (outer.ts ?? 0) + (outer.dur ?? 0);
  const thrash = tasks
    .map((task) => ({ task, layouts: layouts.filter((layout) => within(task, layout)).length }))
    .filter((entry) => entry.layouts >= THRASH_LAYOUTS_PER_TASK)
    .sort((a, b) => b.layouts - a.layouts)
    .slice(0, 5)
    .map((entry) => ({ taskMs: round((entry.task.dur ?? 0) / 1000, 1), layouts: entry.layouts }));
  const animationFrames = named("FireAnimationFrame");
  const framesWithLayout = animationFrames.filter((frame) => layouts.some((layout) => within(frame, layout))).length;

  const paints = input.events.filter((event) => event.name === "Paint" && main !== null && event.pid === main.pid && complete(event));
  const paintCounts = new Map<string, { box: [number, number, number, number]; count: number }>();
  for (const event of paints) {
    const box = quadBox(isRecord(event.args) && isRecord(event.args.data) ? event.args.data.clip : null);
    if (!box) continue;
    const key = box.join(",");
    const entry = paintCounts.get(key);
    if (entry) entry.count += 1;
    else paintCounts.set(key, { box, count: 1 });
  }
  const paintBoxes = [...paintCounts.values()]
    .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])
    .map(({ box, count }) => ({ box, count }));

  const frameEvents = input.events.filter((event) => main !== null && event.pid === main.pid);
  const drawn = frameEvents.filter((event) => event.name === "DrawFrame").map((event) => event.ts ?? 0).sort((a, b) => a - b);
  const intervals = drawn.slice(1).map((ts, index) => (ts - (drawn[index] ?? ts)) / 1000);
  const seconds = Math.max(input.durationMs / 1000, 0.001);
  const slowFrames = intervals.filter((ms) => ms > 33.4).length;
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const p95 = sortedIntervals.length > 0 ? sortedIntervals[Math.min(sortedIntervals.length - 1, Math.floor(sortedIntervals.length * 0.95))] ?? null : null;

  const shifts = input.page.shifts.filter((shift) => shift.hadRecentInput !== true);
  const cls = round(shifts.reduce((sum, shift) => sum + (finiteNumber(shift.value) ?? 0), 0), 4);
  const shiftedElements = [...new Set(shifts.flatMap((shift) =>
    (Array.isArray(shift.sources) ? shift.sources : []).map((source) => (isRecord(source) ? stringValue(source.element) : undefined)).filter(Boolean)))];

  const costlyAnimations = input.animations.filter((animation) => Array.isArray(animation.costlyProperties));
  const verdicts: string[] = [];
  if (!input.visible) verdicts.push("The tab was not visible, so frame and paint numbers are not meaningful. Show the tab and record again.");
  if (cls > 0.1) verdicts.push(`Layout shift: CLS ${cls} (needs work above 0.1, poor above 0.25). Moved: ${shiftedElements.slice(0, 5).join(", ") || "unknown"}.`);
  else if (cls > 0) verdicts.push(`Minor layout shift: CLS ${cls}. Moved: ${shiftedElements.slice(0, 5).join(", ")}.`);
  if (longTasks.length > 0) verdicts.push(`${longTasks.length} long task(s) over ${LONG_TASK_MS} ms, longest ${longTasks[0]?.durationMs} ms. The page cannot respond to input during these.`);
  if (thrash.length > 0) verdicts.push(`Layout thrash: one task ran ${thrash[0]?.layouts} layouts. Script is reading layout (offsetWidth, getBoundingClientRect) right after writing styles.`);
  if (framesWithLayout > 0) verdicts.push(`${framesWithLayout} animation frame(s) triggered layout. Animate transform or opacity instead of left, top, width or height.`);
  for (const animation of costlyAnimations.slice(0, 5)) {
    verdicts.push(`Animation "${String(animation.name || animation.id || "")}"${animation.element ? ` on ${String(animation.element)}` : ""} animates ${(animation.costlyProperties as string[]).join(", ")}, which repaints every frame. Prefer transform or opacity.`);
  }
  if (input.visible && intervals.length >= 10 && slowFrames / intervals.length > 0.1) {
    verdicts.push(`Jank: ${slowFrames} of ${intervals.length} frames took longer than 33 ms (below 30 fps).`);
  }
  if (input.droppedEvents > 0) verdicts.push(`The recording was cut after ${MAX_TRACE_EVENTS} trace events. Record a shorter interaction.`);
  if (verdicts.length === 0) verdicts.push("No rendering problems found during the recording.");

  return {
    verdicts,
    durationMs: Math.round(input.durationMs),
    visible: input.visible,
    frames: {
      drawn: drawn.length,
      fps: input.visible ? round(drawn.length / seconds, 1) : null,
      slowFrames,
      p95FrameMs: p95 === null ? null : round(p95, 1),
    },
    longTasks,
    layout: { count: layouts.length, totalMs: totalMs(layouts), thrash, animationFramesWithLayout: framesWithLayout },
    style: { recalcCount: named("UpdateLayoutTree").length, recalcMs: totalMs(named("UpdateLayoutTree")) },
    paint: { count: paints.length, totalMs: totalMs(paints), largest: paintBoxes.slice(0, 5) },
    script: { totalMs: totalMs([...named("FunctionCall"), ...named("EvaluateScript")]) },
    layoutShifts: { cls, entries: shifts.slice(0, 20) },
    longAnimationFrames: input.page.loaf.slice(0, 10),
    animations: input.animations.slice(0, 20),
  };
}

async function stopRecording(send: Send, state: DevtoolsState, recording: Recording): Promise<unknown> {
  if (recording.timer) clearTimeout(recording.timer);
  recording.timer = null;
  const durationMs = Date.now() - recording.startedAt;
  let page: { shifts: UnknownRecord[]; loaf: UnknownRecord[] } = { shifts: [], loaf: [] };
  let pageAnimations: UnknownRecord[] = [];
  try {
    const value = await evaluateInPage(send, RENDER_OBSERVER_STOP);
    if (isRecord(value)) {
      page = {
        loaf: Array.isArray(value.loaf) ? value.loaf.filter(isRecord) : [],
        shifts: Array.isArray(value.shifts) ? value.shifts.filter(isRecord) : [],
      };
      pageAnimations = Array.isArray(value.animations) ? value.animations.filter(isRecord) : [];
    }
  } catch {
    // The page may have navigated away; the trace still has the rendering work.
  }
  await send("Tracing.end");
  await Promise.race([recording.complete, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  const animations = mergeAnimations(pageAnimations, [...state.animations.values()]);
  if (state.recording === recording) state.recording = null;
  return (state.lastReport = analyzeRendering({
    animations,
    droppedEvents: recording.droppedEvents,
    durationMs,
    events: recording.events,
    page,
    visible: recording.visible,
  }));
}

async function renderStart(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  if (state.recording) return { ok: false, reason: "a rendering recording is already running; call render-stop first" };
  const requested = params.maxMs === undefined ? DEFAULT_RENDER_MS : finiteNumber(params.maxMs);
  if (requested === undefined || requested < 500 || requested > MAX_RENDER_MS) return invalid(`maxMs must be 500-${MAX_RENDER_MS}`);
  await ensureDomain(send, state, "Animation");
  state.animations.clear();
  const visible = (await evaluateInPage(send, RENDER_OBSERVER_START)) === true;
  let markComplete = () => {};
  const complete = new Promise<void>((resolve) => { markComplete = resolve; });
  const recording: Recording = {
    complete, droppedEvents: 0, events: [], markComplete, maxMs: requested, report: null,
    startedAt: Date.now(), timer: null, visible,
  };
  state.recording = recording;
  try {
    await send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: TRACE_CATEGORIES } });
  } catch (error) {
    state.recording = null;
    throw error;
  }
  // A forgotten recording must not trace forever: stop it and keep the report.
  recording.timer = setTimeout(() => {
    recording.report = stopRecording(send, state, recording).catch((error: unknown) => ({ error: String(error) }));
  }, requested);
  return {
    ok: true,
    value: {
      recording: true,
      maxMs: requested,
      visible,
      next: "Interact with the page (click, scroll, type, eval), then run render-stop.",
      ...(visible ? {} : { warning: "The tab is not visible; frame numbers will not be meaningful." }),
    },
  };
}

async function renderStop(send: Send, state: DevtoolsState): Promise<ActionResult> {
  const recording = state.recording;
  const report = recording?.report ? await recording.report : recording ? await stopRecording(send, state, recording) : state.lastReport;
  state.recording = null;
  state.lastReport = null;
  return report === null ? { ok: false, reason: "no rendering recording is running; call render-start first" } : { ok: true, value: report };
}

async function perfMetrics(send: Send, state: DevtoolsState): Promise<ActionResult> {
  await ensureDomain(send, state, "Performance");
  const raw = await send("Performance.getMetrics");
  const metrics: Record<string, number> = {};
  for (const metric of Array.isArray(raw.metrics) ? raw.metrics : []) {
    if (isRecord(metric) && typeof metric.name === "string" && typeof metric.value === "number") metrics[metric.name] = metric.value;
  }
  const mb = (bytes: number | undefined) => (bytes === undefined ? null : round(bytes / 1_048_576, 1));
  const ms = (seconds: number | undefined) => (seconds === undefined ? null : round(seconds * 1000, 1));
  const page = await evaluateInPage(send, PAGE_PERF_SCRIPT).catch((error: unknown) => ({ error: String(error) }));
  return {
    ok: true,
    value: {
      chrome: {
        jsHeapUsedMB: mb(metrics.JSHeapUsedSize),
        jsHeapTotalMB: mb(metrics.JSHeapTotalSize),
        domNodes: metrics.Nodes ?? null,
        documents: metrics.Documents ?? null,
        frames: metrics.Frames ?? null,
        jsEventListeners: metrics.JSEventListeners ?? null,
        layoutCount: metrics.LayoutCount ?? null,
        layoutMs: ms(metrics.LayoutDuration),
        styleRecalcCount: metrics.RecalcStyleCount ?? null,
        styleRecalcMs: ms(metrics.RecalcStyleDuration),
        scriptMs: ms(metrics.ScriptDuration),
        taskMs: ms(metrics.TaskDuration),
      },
      page,
      note: "Chrome counters are totals since the page loaded. Use render-start/render-stop to measure one interaction.",
    },
  };
}

async function overlay(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const next = state.overlays ?? { flex: null, fps: false, grid: null, paint: false, shifts: false };
  for (const key of ["paint", "shifts", "fps"] as const) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== "boolean") return invalid(`${key} must be true or false`);
    next[key] = params[key] as boolean;
  }
  for (const key of ["grid", "flex"] as const) {
    if (params[key] === undefined) continue;
    const selector = selectorParam(params, key);
    if (selector === undefined) return invalid(`${key} must be a CSS selector or null`);
    next[key] = selector;
  }
  await ensureDomain(send, state, "Overlay");
  await send("Overlay.setShowPaintRects", { result: next.paint });
  await send("Overlay.setShowLayoutShiftRegions", { result: next.shifts });
  await send("Overlay.setShowFPSCounter", { show: next.fps });
  const missing: string[] = [];
  const gridNode = next.grid ? await queryNode(send, next.grid) : null;
  if (next.grid && !gridNode) {
    missing.push(next.grid);
    next.grid = null;
  }
  await send("Overlay.setShowGridOverlays", {
    gridNodeHighlightConfigs: gridNode
      ? [{ nodeId: gridNode.nodeId, gridHighlightConfig: { showGridExtensionLines: true, showLineNumbers: true, gridBorderColor: { r: 147, g: 51, b: 234, a: 0.9 }, rowGapColor: { r: 147, g: 51, b: 234, a: 0.15 }, columnGapColor: { r: 147, g: 51, b: 234, a: 0.15 } } }]
      : [],
  });
  const flexNode = next.flex ? await queryNode(send, next.flex) : null;
  if (next.flex && !flexNode) {
    missing.push(next.flex);
    next.flex = null;
  }
  await send("Overlay.setShowFlexOverlays", {
    flexNodeHighlightConfigs: flexNode
      ? [{ nodeId: flexNode.nodeId, flexContainerHighlightConfig: { containerBorder: { color: { r: 147, g: 51, b: 234, a: 0.9 }, pattern: "dashed" }, itemSeparator: { color: { r: 147, g: 51, b: 234, a: 0.6 }, pattern: "dotted" }, mainDistributedSpace: { fillColor: { r: 147, g: 51, b: 234, a: 0.1 }, hatchColor: { r: 147, g: 51, b: 234, a: 0.4 } } } }]
      : [],
  });
  const active = next.paint || next.shifts || next.fps || next.grid !== null || next.flex !== null;
  state.overlays = active ? next : null;
  return {
    ok: true,
    value: {
      overlays: state.overlays,
      ...(missing.length > 0 ? { notFound: missing } : {}),
      next: "Take a screenshot to see the overlays. Paint flashing shows areas repainted since it was turned on.",
    },
  };
}

async function emulate(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const next = state.emulation ?? { locale: "", media: {}, mediaType: "", timezone: "", vision: "none" };
  const media = { ...next.media };
  if (params.media !== undefined) {
    if (!isRecord(params.media)) return invalid("media must be an object of feature: value");
    for (const [feature, value] of Object.entries(params.media)) {
      const allowed = MEDIA_FEATURES[feature];
      if (!allowed) return invalid(`unknown media feature ${feature}; use ${Object.keys(MEDIA_FEATURES).join(", ")}`);
      if (value === null) delete media[feature];
      else if (typeof value === "string" && allowed.includes(value)) media[feature] = value;
      else return invalid(`${feature} must be one of ${allowed.join(", ")} or null`);
    }
  }
  let mediaType = next.mediaType;
  if (params.mediaType !== undefined) {
    if (params.mediaType === null) mediaType = "";
    else if (typeof params.mediaType === "string" && (MEDIA_TYPES as readonly string[]).includes(params.mediaType)) mediaType = params.mediaType;
    else return invalid("mediaType must be screen, print or null");
  }
  let vision = next.vision;
  if (params.vision !== undefined) {
    if (params.vision === null) vision = "none";
    else if (typeof params.vision === "string" && (VISION_DEFICIENCIES as readonly string[]).includes(params.vision)) vision = params.vision;
    else return invalid(`vision must be one of ${VISION_DEFICIENCIES.join(", ")}`);
  }
  let timezone = next.timezone;
  if (params.timezone !== undefined) {
    if (params.timezone === null) timezone = "";
    else if (typeof params.timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(params.timezone)) timezone = params.timezone;
    else return invalid("timezone must be an IANA name such as Asia/Tokyo, or null");
  }
  let locale = next.locale;
  if (params.locale !== undefined) {
    if (params.locale === null) locale = "";
    else if (typeof params.locale === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(params.locale)) locale = params.locale;
    else return invalid("locale must be a BCP 47 tag such as ar-EG, or null");
  }
  await send("Emulation.setEmulatedMedia", {
    features: Object.entries(media).map(([name, value]) => ({ name, value })),
    media: mediaType,
  });
  await send("Emulation.setEmulatedVisionDeficiency", { type: vision });
  // CDP refuses a second override while one is active, so clear before setting.
  if (timezone !== next.timezone) {
    if (next.timezone) await send("Emulation.setTimezoneOverride", { timezoneId: "" });
    if (timezone) await send("Emulation.setTimezoneOverride", { timezoneId: timezone });
  }
  if (locale !== next.locale) {
    if (next.locale) await send("Emulation.setLocaleOverride", {});
    if (locale) await send("Emulation.setLocaleOverride", { locale });
  }
  const active = Object.keys(media).length > 0 || mediaType !== "" || vision !== "none" || timezone !== "" || locale !== "";
  state.emulation = active ? { locale, media, mediaType, timezone, vision } : null;
  const check = Object.keys(media).length === 0
    ? {}
    : await evaluateInPage(send, `(${JSON.stringify(Object.entries(media))}).reduce((out, [f, v]) => (out[f + ': ' + v] = matchMedia('(' + f + ': ' + v + ')').matches, out), {})`);
  return { ok: true, value: { emulation: state.emulation, pageSees: check } };
}

async function forceState(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const selector = selectorParam(params, "selector");
  if (!selector) return invalid("selector is required");
  if (!Array.isArray(params.states) || !params.states.every((value) => typeof value === "string" && (FORCEABLE_STATES as readonly string[]).includes(value))) {
    return invalid(`states must be a list of ${FORCEABLE_STATES.join(", ")} ([] clears)`);
  }
  const states = [...new Set(params.states as string[])];
  await ensureDomain(send, state, "CSS");
  const node = await queryNode(send, selector);
  if (!node) return { ok: false, reason: `no element matches ${selector}` };
  await send("CSS.forcePseudoState", { forcedPseudoClasses: states, nodeId: node.nodeId });
  if (states.length === 0) state.forcedStates.delete(selector);
  else state.forcedStates.set(selector, states);
  const computed = await send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
  const styles: Record<string, string> = {};
  for (const entry of Array.isArray(computed.computedStyle) ? computed.computedStyle : []) {
    if (isRecord(entry) && typeof entry.name === "string" && FORCED_STATE_STYLES.includes(entry.name)) styles[entry.name] = String(entry.value);
  }
  return {
    ok: true,
    value: { selector, states, styles, next: "Take a screenshot to see the state. Forced states stay until cleared or reset." },
  };
}

type AxNode = { nodeId: string; ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; description?: { value?: unknown }; properties?: Array<{ name: string; value?: { value?: unknown } }>; childIds?: string[]; parentId?: string; backendDOMNodeId?: number };

const AX_PROPERTIES = new Set(["focusable", "focused", "disabled", "checked", "pressed", "expanded", "selected", "level", "required", "invalid", "readonly", "hidden", "modal", "haspopup", "live"]);
const NAMED_ROLES = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "menuitem", "tab", "switch", "slider", "searchbox", "spinbutton", "image", "img"]);

function summarizeIssue(issue: UnknownRecord): UnknownRecord {
  const code = stringValue(issue.code) ?? "unknown";
  const details = isRecord(issue.details) ? issue.details : {};
  const contrast = isRecord(details.lowTextContrastIssueDetails) ? details.lowTextContrastIssueDetails : null;
  if (contrast) {
    return {
      code,
      element: contrast.violatingNodeSelector,
      contrastRatio: round(finiteNumber(contrast.contrastRatio) ?? 0, 2),
      requiredAA: contrast.thresholdAA,
      fontSize: contrast.fontSize,
      fontWeight: contrast.fontWeight,
    };
  }
  const text = JSON.stringify(details);
  return { code, details: text.length > 600 ? `${text.slice(0, 600)}…` : details };
}

async function a11y(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const selector = selectorParam(params, "selector");
  if (params.selector !== undefined && !selector) return invalid("selector must be a CSS selector");
  const depth = params.depth === undefined ? 30 : finiteNumber(params.depth);
  if (depth === undefined || !Number.isInteger(depth) || depth < 1 || depth > 100) return invalid("depth must be an integer 1-100");
  await ensureDomain(send, state, "Audits");
  // Report only what this check finds, not issues left from earlier calls.
  state.issues = [];
  await send("Audits.checkContrast", { reportAAA: false });
  const tree = await send("Accessibility.getFullAXTree", { depth });
  const nodes = (Array.isArray(tree.nodes) ? tree.nodes : []) as AxNode[];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let rootId = nodes.find((node) => !node.parentId)?.nodeId;
  if (selector) {
    const target = await queryNode(send, selector);
    if (!target) return { ok: false, reason: `no element matches ${selector}` };
    rootId = nodes.find((node) => node.backendDOMNodeId === target.backendNodeId)?.nodeId;
    if (!rootId) return { ok: false, reason: `${selector} has no accessibility node (it may be hidden or presentational)` };
  }
  const findings: UnknownRecord[] = [];
  let emitted = 0;
  const build = (id: string): UnknownRecord[] => {
    const node = byId.get(id);
    if (!node || emitted >= MAX_A11Y_NODES) return [];
    const children = (node.childIds ?? []).flatMap(build);
    const role = String(node.role?.value ?? "");
    if (node.ignored || role === "none" || role === "generic" && !node.name?.value && children.length <= 1) return children;
    emitted += 1;
    const name = String(node.name?.value ?? "");
    const props: Record<string, unknown> = {};
    for (const property of node.properties ?? []) {
      if (AX_PROPERTIES.has(property.name)) props[property.name] = property.value?.value;
    }
    if (NAMED_ROLES.has(role) && !name.trim()) findings.push({ kind: "unnamed-control", role, axNodeId: node.nodeId });
    return [{
      role,
      ...(name ? { name: name.slice(0, 200) } : {}),
      ...(node.value?.value !== undefined && node.value.value !== "" ? { value: String(node.value.value).slice(0, 200) } : {}),
      ...(node.description?.value ? { description: String(node.description.value).slice(0, 200) } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
      ...(children.length > 0 ? { children } : {}),
    }];
  };
  const built = rootId ? build(rootId) : [];
  // Contrast results arrive as Audits.issueAdded events shortly after the check.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const seen = new Set<string>();
  const issues = state.issues.map(summarizeIssue).filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: true,
    value: {
      tree: built.length === 1 ? built[0] : { role: "fragment", children: built },
      nodes: emitted,
      truncated: emitted >= MAX_A11Y_NODES,
      findings,
      issues,
    },
  };
}

async function layout(send: Send, params: UnknownRecord): Promise<ActionResult> {
  const selector = selectorParam(params, "selector");
  if (params.selector !== undefined && !selector) return invalid("selector must be a CSS selector");
  const limit = params.limit === undefined ? 400 : finiteNumber(params.limit);
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > MAX_LAYOUT_ELEMENTS) return invalid(`limit must be an integer 1-${MAX_LAYOUT_ELEMENTS}`);
  const value = await evaluateInPage(send, layoutScript(selector ?? undefined, limit));
  if (value === null) return { ok: false, reason: `no element matches ${selector}` };
  return { ok: true, value };
}

async function animationRate(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const rate = finiteNumber(params.rate);
  if (rate === undefined || rate < 0 || rate > 10) return invalid("rate must be 0-10 (0 pauses, 0.1 is slow motion, 1 is normal)");
  await ensureDomain(send, state, "Animation");
  await send("Animation.setPlaybackRate", { playbackRate: rate });
  state.animationRate = rate;
  const page = await evaluateInPage(send, PAGE_ANIMATIONS_SCRIPT);
  const animations = mergeAnimations(Array.isArray(page) ? page.filter(isRecord) : [], [...state.animations.values()]);
  return { ok: true, value: { rate, animations: animations.slice(0, 50) } };
}

function pageOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function serviceWorkers(send: Send, state: DevtoolsState): Promise<{ registrations: UnknownRecord[]; versions: UnknownRecord[] }> {
  if (!state.enabled.has("ServiceWorker")) {
    await ensureDomain(send, state, "ServiceWorker");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const registrations = [...state.registrations.values()].filter((registration) => registration.isDeleted !== true);
  const live = new Set(registrations.map((registration) => registration.registrationId));
  const versions = [...state.versions.values()].filter((version) => live.has(version.registrationId) && version.status !== "redundant");
  return { registrations, versions };
}

async function swList(send: Send, state: DevtoolsState, url: string): Promise<ActionResult> {
  const { registrations, versions } = await serviceWorkers(send, state);
  const origin = pageOrigin(url);
  return {
    ok: true,
    value: {
      origin,
      registrations: registrations.map((registration) => ({
        scope: registration.scopeURL,
        forThisPage: origin !== null && String(registration.scopeURL).startsWith(origin),
        versions: versions
          .filter((version) => version.registrationId === registration.registrationId)
          .map((version) => ({ versionId: version.versionId, script: version.scriptURL, running: version.runningStatus, status: version.status })),
      })),
      errors: state.workerErrors.slice(-10),
    },
  };
}

async function swScope(send: Send, state: DevtoolsState, params: UnknownRecord, url: string): Promise<{ scope: string; registrationId: string } | string> {
  const { registrations } = await serviceWorkers(send, state);
  if (params.scope !== undefined) {
    const match = registrations.find((registration) => registration.scopeURL === params.scope);
    return match ? { registrationId: String(match.registrationId), scope: String(match.scopeURL) } : `no service worker is registered for scope ${String(params.scope)}`;
  }
  const origin = pageOrigin(url);
  const mine = registrations.filter((registration) => origin !== null && String(registration.scopeURL).startsWith(origin));
  if (mine.length === 0) return `no service worker is registered for ${origin ?? url}`;
  if (mine.length > 1) return `several service workers are registered for ${origin}; pass scope: ${mine.map((r) => r.scopeURL).join(", ")}`;
  return { registrationId: String(mine[0]?.registrationId), scope: String(mine[0]?.scopeURL) };
}

async function swAction(send: Send, state: DevtoolsState, action: "sw-restart" | "sw-update" | "sw-unregister", params: UnknownRecord, url: string): Promise<ActionResult> {
  const target = await swScope(send, state, params, url);
  if (typeof target === "string") return { ok: false, reason: target };
  if (action === "sw-restart") {
    const running = [...state.versions.values()].filter((version) => version.registrationId === target.registrationId && version.runningStatus !== "stopped");
    for (const version of running) await send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await send("ServiceWorker.startWorker", { scopeURL: target.scope });
  } else if (action === "sw-update") {
    await send("ServiceWorker.updateRegistration", { scopeURL: target.scope });
  } else {
    await send("ServiceWorker.unregister", { scopeURL: target.scope });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await swList(send, state, url);
  return { ok: true, value: { action, scope: target.scope, after: after.ok ? after.value : null } };
}

async function storageUsage(send: Send, url: string): Promise<ActionResult> {
  const origin = pageOrigin(url);
  if (!origin) return { ok: false, reason: "storage actions need an http(s) page" };
  const quota = await send("Storage.getUsageAndQuota", { origin });
  const cookies = await send("Network.getCookies", { urls: [url] });
  const databases = await send("IndexedDB.requestDatabaseNames", { securityOrigin: origin }).catch(() => ({ databaseNames: [] }));
  const caches = await send("CacheStorage.requestCacheNames", { securityOrigin: origin }).catch(() => ({ caches: [] }));
  const webStorage = await evaluateInPage(send, `(() => { const size = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const k = s.key(i); n += k.length + (s.getItem(k) || '').length; } return n; };
    try { return { localStorage: { keys: localStorage.length, chars: size(localStorage) }, sessionStorage: { keys: sessionStorage.length, chars: size(sessionStorage) } }; } catch (e) { return { error: String(e) }; } })()`);
  return {
    ok: true,
    value: {
      origin,
      usageKB: round((finiteNumber(quota.usage) ?? 0) / 1024, 1),
      byType: (Array.isArray(quota.usageBreakdown) ? quota.usageBreakdown : [])
        .filter((entry) => isRecord(entry) && (finiteNumber(entry.usage) ?? 0) > 0)
        .map((entry) => ({ type: (entry as UnknownRecord).storageType, kb: round((finiteNumber((entry as UnknownRecord).usage) ?? 0) / 1024, 1) })),
      // Names only: cookie values are credentials.
      cookies: (Array.isArray(cookies.cookies) ? cookies.cookies : []).filter(isRecord).map((cookie) => ({ name: cookie.name, domain: cookie.domain, path: cookie.path })),
      indexedDB: Array.isArray(databases.databaseNames) ? databases.databaseNames : [],
      cacheStorage: (Array.isArray(caches.caches) ? caches.caches : []).filter(isRecord).map((cache) => cache.cacheName),
      webStorage,
    },
  };
}

async function storageClear(send: Send, params: UnknownRecord, url: string): Promise<ActionResult> {
  const origin = pageOrigin(url);
  if (!origin) return { ok: false, reason: "storage actions need an http(s) page" };
  if (!Array.isArray(params.types) || params.types.length === 0) return invalid(`types must list ${STORAGE_TYPES.join(", ")} or all`);
  const requested = new Set<string>();
  for (const type of params.types) {
    if (type === "all") STORAGE_TYPES.forEach((each) => requested.add(each));
    else if (typeof type === "string" && (STORAGE_TYPES as readonly string[]).includes(type)) requested.add(type);
    else return invalid(`unknown storage type ${String(type)}; use ${STORAGE_TYPES.join(", ")} or all`);
  }
  const cleared: string[] = [];
  if (requested.has("cookies")) {
    // Only cookies this page can see; the partition's other sites keep theirs.
    const cookies = await send("Network.getCookies", { urls: [url] });
    for (const cookie of (Array.isArray(cookies.cookies) ? cookies.cookies : []).filter(isRecord)) {
      await send("Network.deleteCookies", { domain: cookie.domain, name: cookie.name, path: cookie.path });
    }
    cleared.push("cookies");
  }
  const originTypes = [
    ["indexeddb", "indexeddb"], ["local-storage", "local_storage"], ["cache-storage", "cache_storage"], ["service-workers", "service_workers"],
  ].filter(([name]) => requested.has(name as string));
  if (originTypes.length > 0) {
    await send("Storage.clearDataForOrigin", { origin, storageTypes: originTypes.map(([, cdp]) => cdp).join(",") });
    cleared.push(...originTypes.map(([name]) => name as string));
  }
  if (requested.has("session-storage")) {
    await evaluateInPage(send, "sessionStorage.clear(), true");
    cleared.push("session-storage");
  }
  const after = await storageUsage(send, url);
  return { ok: true, value: { origin, cleared, after: after.ok ? after.value : null, note: "Reload the page so it stops using data it already read into memory." } };
}

async function throttle(send: Send, state: DevtoolsState, params: UnknownRecord): Promise<ActionResult> {
  const next: ThrottleState = state.throttle ? { ...state.throttle } : { cpu: 1, network: "off" };
  if (params.cpu !== undefined) {
    const cpu = finiteNumber(params.cpu);
    if (cpu === undefined || cpu < 1 || cpu > 20) return invalid("cpu must be a slowdown factor 1-20 (1 = off)");
    next.cpu = cpu;
  }
  if (params.network !== undefined) {
    const network = params.network;
    if (network === "off" || network === "offline" || (typeof network === "string" && NETWORK_PRESETS[network])) {
      next.network = network as string;
    } else if (isRecord(network)) {
      const latencyMs = finiteNumber(network.latencyMs);
      const downKbps = finiteNumber(network.downKbps);
      const upKbps = finiteNumber(network.upKbps);
      if (latencyMs === undefined || downKbps === undefined || upKbps === undefined || latencyMs < 0 || downKbps <= 0 || upKbps <= 0) {
        return invalid("custom network needs latencyMs >= 0, downKbps > 0, upKbps > 0");
      }
      next.network = { downKbps, latencyMs, upKbps };
    } else {
      return invalid(`network must be off, offline, ${Object.keys(NETWORK_PRESETS).join(", ")} or { latencyMs, downKbps, upKbps }`);
    }
  }
  await send("Emulation.setCPUThrottlingRate", { rate: next.cpu });
  const profile = typeof next.network === "string" ? NETWORK_PRESETS[next.network] : next.network;
  await send("Network.emulateNetworkConditions", next.network === "offline"
    ? { downloadThroughput: -1, latency: 0, offline: true, uploadThroughput: -1 }
    : profile
      ? { downloadThroughput: (profile.downKbps * 1000) / 8, latency: profile.latencyMs, offline: false, uploadThroughput: (profile.upKbps * 1000) / 8 }
      : { downloadThroughput: -1, latency: 0, offline: false, uploadThroughput: -1 });
  state.throttle = next.cpu === 1 && next.network === "off" ? null : next;
  return { ok: true, value: { throttle: state.throttle, presets: NETWORK_PRESETS } };
}

async function reset(send: Send, state: DevtoolsState): Promise<ActionResult> {
  const errors: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  if (state.recording) {
    const recording = state.recording;
    await attempt("recording", () => stopRecording(send, state, recording));
  }
  state.lastReport = null;
  if (state.emulation) {
    const { timezone, locale } = state.emulation;
    await attempt("media", () => send("Emulation.setEmulatedMedia", { features: [], media: "" }));
    await attempt("vision", () => send("Emulation.setEmulatedVisionDeficiency", { type: "none" }));
    if (timezone) await attempt("timezone", () => send("Emulation.setTimezoneOverride", { timezoneId: "" }));
    if (locale) await attempt("locale", () => send("Emulation.setLocaleOverride", {}));
  }
  if (state.overlays) {
    await attempt("overlays", async () => {
      await send("Overlay.setShowPaintRects", { result: false });
      await send("Overlay.setShowLayoutShiftRegions", { result: false });
      await send("Overlay.setShowFPSCounter", { show: false });
      await send("Overlay.setShowGridOverlays", { gridNodeHighlightConfigs: [] });
      await send("Overlay.setShowFlexOverlays", { flexNodeHighlightConfigs: [] });
    });
  }
  for (const selector of state.forcedStates.keys()) {
    await attempt(`force-state ${selector}`, async () => {
      const node = await queryNode(send, selector);
      if (node) await send("CSS.forcePseudoState", { forcedPseudoClasses: [], nodeId: node.nodeId });
    });
  }
  if (state.throttle) {
    await attempt("cpu", () => send("Emulation.setCPUThrottlingRate", { rate: 1 }));
    await attempt("network", () => send("Network.emulateNetworkConditions", { downloadThroughput: -1, latency: 0, offline: false, uploadThroughput: -1 }));
  }
  if (state.cacheDisabled) await attempt("cache", () => send("Network.setCacheDisabled", { cacheDisabled: false }));
  if (state.animationRate !== 1) await attempt("animation", () => send("Animation.setPlaybackRate", { playbackRate: 1 }));
  state.emulation = null;
  state.overlays = null;
  state.forcedStates.clear();
  state.throttle = null;
  state.cacheDisabled = false;
  state.animationRate = 1;
  return { ok: true, value: { status: statusOf(state), ...(errors.length > 0 ? { errors } : {}) } };
}

/** Runs one devtools action on an attached guest. */
export async function executeDevtoolsAction(
  guest: WebContents,
  state: DevtoolsState,
  operation: OpenDesignHostBrowserDevtoolsOperation,
): Promise<ActionResult> {
  const send: Send = (method, params) => guest.debugger.sendCommand(method, params) as Promise<UnknownRecord>;
  const params = operation.params;
  const url = guest.getURL();
  const action = operation.action as BrowserDevtoolsAction;
  switch (action) {
    case "status": return { ok: true, value: statusOf(state) };
    case "reset": return reset(send, state);
    case "perf-metrics": return perfMetrics(send, state);
    case "render-start": return renderStart(send, state, params);
    case "render-stop": return renderStop(send, state);
    case "overlay": return overlay(send, state, params);
    case "emulate": return emulate(send, state, params);
    case "force-state": return forceState(send, state, params);
    case "a11y": return a11y(send, state, params);
    case "layout": return layout(send, params);
    case "animation-rate": return animationRate(send, state, params);
    case "sw-list": return swList(send, state, url);
    case "sw-restart":
    case "sw-update":
    case "sw-unregister": return swAction(send, state, action, params, url);
    case "storage-usage": return storageUsage(send, url);
    case "storage-clear": return storageClear(send, params, url);
    case "cache-clear":
      await send("Network.clearBrowserCache");
      return { ok: true, value: { cleared: "http-cache", note: "Every site's HTTP cache in the in-app browser was cleared; cookies and logins were kept." } };
    case "cache-disable": {
      if (typeof params.disabled !== "boolean") return invalid("disabled must be true or false");
      await send("Network.setCacheDisabled", { cacheDisabled: params.disabled });
      state.cacheDisabled = params.disabled;
      return { ok: true, value: { cacheDisabled: state.cacheDisabled } };
    }
    case "throttle": return throttle(send, state, params);
  }
}

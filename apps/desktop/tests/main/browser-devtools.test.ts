import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { runInNewContext } from "node:vm";

import { analyzeRendering, createDevtoolsState, executeDevtoolsAction, disposeDevtoolsState, onDevtoolsEvent } from "../../src/main/browser-devtools.js";
import { addLoadEvidence, createLoadCapture, reconcileLoadSnapshot } from "../../src/main/browser-performance-load.js";
import { boundPerformanceReport, buildPerformanceReport } from "../../src/main/browser-performance.js";
import { addRenderingEvidence } from "../../src/main/browser-performance-rendering.js";
import { createPerformanceApprovalConfirmer } from "../../src/main/browser-performance-approval.js";

const main = { pid: 1, tid: 7 };
const task = (ts: number, durMs: number) => ({ name: "RunTask", ph: "X", ...main, ts, dur: durMs * 1000 });
const layout = (ts: number) => ({ name: "Layout", ph: "X", ...main, ts, dur: 10 });
const frame = (ts: number) => ({ name: "DrawFrame", ph: "I", pid: 1, tid: 9, ts });
const quiet = { animations: [], droppedEvents: 0, durationMs: 1_000, events: [], page: { loaf: [], shifts: [] } };
const measuredReport = () => buildPerformanceReport({ reportId: "capture", startedAt: 0, durationMs: 2_000,
  environment: { browserVersion: "1", viewport: null, visible: true, cpuThrottle: 1, network: "off", cacheDisabled: false,
    reducedMotion: false, animationRate: 1, documentId: "document-initial", timeOriginMs: 1_000 },
  events: [task(0, 1)], main, traceComplete: true, observerAvailable: true, retainedBytes: 1, droppedEvents: 0, reasons: new Set(),
});

async function cpuCapture(priorCpu = 1) {
  const state = createDevtoolsState();
  const cpuRates: number[] = [];
  const networkCalls: unknown[] = [];
  let cpuResponse: (rate: number) => Promise<Record<string, unknown>> = async () => ({});
  const guest = { getURL: () => "https://fixture/", debugger: { sendCommand: async (method: string, params?: Record<string, unknown>) => {
    if (method === "Runtime.evaluate") return { result: { value: { visible: true, timeOriginMs: 1000, observerAvailable: true, inputs: [], shifts: [], loaf: [], animations: [] } } };
    if (method === "Tracing.end") onDevtoolsEvent(state, "Tracing.tracingComplete", {});
    if (method === "Emulation.setCPUThrottlingRate") { const rate = Number(params?.rate); cpuRates.push(rate); return cpuResponse(rate); }
    if (method === "Network.emulateNetworkConditions") networkCalls.push(params);
    return {};
  } } } as unknown as WebContents;
  const run = (action: string, params: Record<string, unknown> = {}) => executeDevtoolsAction(guest, state, { kind: "devtools", action, params, approved: true });
  if (priorCpu !== 1) await run("throttle", { cpu: priorCpu });
  cpuRates.length = 0;
  await run("render-start");
  onDevtoolsEvent(state, "Tracing.dataCollected", { value: [task(0, 1)] });
  const reportId = state.recording!.reportId;
  return { state, run, cpuRates, networkCalls,
    override: () => run("capture-throttle", { reportId, cpu: 2 }),
    respond: (handler: typeof cpuResponse) => { cpuResponse = handler; },
    close: () => disposeDevtoolsState(state),
  };
}

describe("capture-owned CPU restoration", () => {
  it("restores the prior CPU once while preserving a network-only external change", async () => {
    const capture = await cpuCapture(3);
    try {
      expect(await capture.override()).toMatchObject({ ok: true });
      await capture.run("throttle", { network: "slow-3g" });
      const [first, repeated] = await Promise.all([capture.run("render-stop"), capture.run("render-stop")]);
      expect(first).toMatchObject({ ok: true, value: { performanceReport: { restoration: {
        status: "restored", priorCpu: 3, appliedCpu: 2, restoredCpu: 3, settingsChangedDuringCapture: true,
      } } } });
      expect(repeated).toEqual(first);
      expect(capture.cpuRates).toEqual([2, 3]);
      expect(capture.networkCalls).toHaveLength(1);
      expect(capture.state.throttle).toEqual({ cpu: 3, network: "slow-3g" });
    } finally { capture.close(); }
  });

  it.each([2, 4])("preserves an external CPU write of %s, including the same applied value", async (cpu) => {
    const capture = await cpuCapture();
    try {
      await capture.override();
      await capture.run("throttle", { cpu });
      expect(await capture.run("render-stop")).toMatchObject({ ok: true, value: { performanceReport: { restoration: {
        status: "conflict", reason: "cpu-changed-externally", restoredCpu: null,
      } } } });
      expect(capture.cpuRates).toEqual([2, cpu]);
      expect(capture.state.throttle?.cpu).toBe(cpu);
    } finally { capture.close(); }
  });

  it.each([false, true])("bounds a late apply and respects a newer CPU write=%s during cleanup", async (superseded) => {
    vi.useFakeTimers();
    const capture = await cpuCapture();
    let acknowledge!: (value: Record<string, unknown>) => void;
    capture.respond(async (rate) => rate === 2 ? new Promise((resolve) => { acknowledge = resolve; }) : {});
    try {
      const applied = capture.override();
      await vi.advanceTimersByTimeAsync(2001);
      expect(await applied).toMatchObject({ ok: false });
      const stopped = capture.run("render-stop");
      await vi.advanceTimersByTimeAsync(4001);
      expect(await stopped).toMatchObject({ ok: true, value: { performanceReport: { restoration: { status: "failed", reason: "apply-timeout" } } } });
      expect(await capture.run("render-start")).toMatchObject({ ok: false, reason: expect.stringContaining("CPU restoration is pending") });
      if (superseded) await capture.run("throttle", { cpu: 4 });
      acknowledge({});
      await vi.advanceTimersByTimeAsync(0);
      expect(capture.cpuRates).toEqual(superseded ? [2, 4] : [2, 1]);
      expect(capture.state.throttle).toEqual(superseded ? { cpu: 4, network: "off" } : null);
      expect(capture.state.cpuCleanup).toBeNull();
      expect(await capture.run("render-start")).toMatchObject({ ok: true });
    } finally { capture.close(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(["reject", "timeout"])("reports restore %s and never overwrites a newer CPU acknowledgement", async (failure) => {
    vi.useFakeTimers();
    const capture = await cpuCapture();
    let acknowledge!: (value: Record<string, unknown>) => void;
    try {
      await capture.override();
      capture.respond(async (rate) => {
        if (rate !== 1) return {};
        if (failure === "reject") throw new Error("test restore failure");
        return new Promise((resolve) => { acknowledge = resolve; });
      });
      const stopped = capture.run("render-stop");
      await vi.advanceTimersByTimeAsync(failure === "timeout" ? 4001 : 0);
      expect(await stopped).toMatchObject({ ok: true, value: { performanceReport: { restoration: { status: "failed", reason: "restore-failed", restoredCpu: null } } } });
      await capture.run("throttle", { cpu: 4 });
      if (failure === "timeout") { acknowledge({}); await vi.advanceTimersByTimeAsync(0); }
      expect(capture.state.throttle?.cpu).toBe(4);
      expect(capture.cpuRates).toEqual([2, 1, 4]);
    } finally { capture.close(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

describe("native performance approval denial", () => {
  it.each(["deny", "closed-frame", "changed-challenge", "rejected-decision"])("never creates a grant after %s", async (outcome) => {
    const challenge = { approvalId: "approval", projectId: "project", tabId: "tab", location: "https://fixture/", reportId: "report", cpu: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), bindingDigest: "binding" };
    let alive = true;
    let reads = 0;
    const posts: string[] = [];
    const onApproved = vi.fn(() => true);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(String(url)); return new Response("{}", { status: outcome === "rejected-decision" ? 409 : 200 }); }
      const current = outcome === "changed-challenge" && ++reads === 2 ? { ...challenge, cpu: 3, bindingDigest: "changed" } : challenge;
      return new Response(JSON.stringify({ challenge: current }), { status: 200 });
    });
    const confirm = createPerformanceApprovalConfirmer({ discoverDaemonUrl: async () => "http://127.0.0.1:1234", secret: Buffer.from("test-only"), alive: () => true,
      confirm: async () => { if (outcome === "closed-frame") alive = false; return outcome !== "deny"; },
      onApproved, fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await confirm({ approvalId: "approval" }, () => alive);
    expect(onApproved).not.toHaveBeenCalled();
    if (outcome === "deny") { expect(result).toEqual({ ok: true, decision: "denied" }); expect(posts).toEqual(["http://127.0.0.1:1234/api/mcp/approvals/approval/deny"]); }
    else { expect(result.ok).toBe(false); expect(posts).toHaveLength(outcome === "rejected-decision" ? 1 : 0); }
  });
});

describe("rendering report", () => {
  it("keeps shift targets valid through one CSS document lookup batch", async () => {
    const state = createDevtoolsState();
    let nextNode = 100;
    let documentReads = 0;
    const currentNodes = new Map<number, number>();
    const shifts = [
      { atMs: 700, value: 0.02, hadRecentInput: false, sources: [{ element: "#content" }] },
      { atMs: 2300, value: 0.02, hadRecentInput: false, sources: [{ element: "#paint" }] },
    ];
    const guest = { getURL: () => "https://fixture/", debugger: { sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") return { result: { value: { visible: true, timeOriginMs: 1000, observerAvailable: true, shiftSupported: true, shifts, loaf: [], animations: [] } } };
      if (method === "CSS.enable") onDevtoolsEvent(state, "CSS.styleSheetAdded", { header: { styleSheetId: "sheet", sourceURL: "https://fixture/layout.css", startLine: 0, startColumn: 0 } });
      if (method === "DOM.getDocument") {
        // Chromium's getDocument discards all previous frontend node bindings.
        documentReads++; currentNodes.clear();
        const nodeId = ++nextNode; currentNodes.set(nodeId, 1); return { root: { nodeId } };
      }
      if (method === "DOM.querySelector") {
        const nodeId = ++nextNode; currentNodes.set(nodeId, params?.selector === "#content" ? 8 : 9); return { nodeId };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: currentNodes.get(Number(params?.nodeId)) } };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: (params?.backendNodeIds as number[]).map((backend) => {
        const nodeId = ++nextNode; currentNodes.set(nodeId, backend); return nodeId;
      }) };
      if (method === "CSS.getMatchedStylesForNode") {
        if (!currentNodes.has(Number(params?.nodeId))) throw new Error("Could not find node with given id");
        return { matchedCSSRules: [{ rule: { origin: "regular", style: { styleSheetId: "sheet", range: { startLine: 0, startColumn: 0 } } } }] };
      }
      if (method === "Tracing.end") onDevtoolsEvent(state, "Tracing.tracingComplete", {});
      return {};
    } } } as unknown as WebContents;
    try {
      await executeDevtoolsAction(guest, state, { kind: "devtools", action: "render-start", params: {} });
      onDevtoolsEvent(state, "Tracing.dataCollected", { value: [task(0, 1), { name: "Paint", ph: "X", ...main, ts: 1000, dur: 500, args: { data: { nodeId: 10 } } }] });
      const stopped = await executeDevtoolsAction(guest, state, { kind: "devtools", action: "render-stop", params: {} });
      const report = (stopped as { value: { performanceReport: { evidence: Array<{ kind: string; target?: { backendNodeId: number }; relatedIds?: string[] }> } } }).value.performanceReport;
      const observedShifts = report.evidence.filter((entry) => entry.kind === "layout-shift");
      expect(observedShifts.map((entry) => entry.target?.backendNodeId)).toEqual([8, 9]);
      expect(observedShifts.every((entry) => entry.relatedIds?.some((id) => id.startsWith("style-")))).toBe(true);
      expect(documentReads).toBe(1);
    } finally { disposeDevtoolsState(state); }
  });

  it.each([true, false])("pre-navigation=%s keeps the correct Resource Timing boundary in the emitted collector", async (preNavigation) => {
    const state = createDevtoolsState();
    const pageWindow: Record<string, unknown> = {};
    pageWindow.top = pageWindow;
    const resources = [
      { name: "https://fixture/style.css", initiatorType: "link", startTime: 485, responseEnd: 669.8 },
      { name: "https://fixture/hero.png", initiatorType: "img", startTime: 485.4, responseEnd: 1209.9 },
    ];
    const context = {
      window: pageWindow, document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, getAnimations: () => [] },
      PerformanceObserver: { supportedEntryTypes: [] },
      performance: { timeOrigin: 1000, now: () => 502.3, getEntriesByType: (type: string) => type === "resource" ? resources : [] },
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    };
    let navigationScript = "";
    const guest = { getURL: () => "https://fixture/", debugger: { sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") { navigationScript = String(params?.source); return { identifier: "observer" }; }
      if (method === "Runtime.evaluate") return { result: { value: runInNewContext(String(params?.expression), context) } };
      if (method === "Tracing.end") onDevtoolsEvent(state, "Tracing.tracingComplete", {});
      return {};
    } } } as unknown as WebContents;
    try {
      await executeDevtoolsAction(guest, state, { kind: "devtools", action: "render-start", params: {} });
      if (preNavigation) {
        context.performance.timeOrigin = 1793396959552.3;
        runInNewContext(navigationScript, context);
      }
      onDevtoolsEvent(state, "Tracing.dataCollected", { value: [task(0, 1)] });
      const stopped = await executeDevtoolsAction(guest, state, { kind: "devtools", action: "render-stop", params: {} });
      expect(stopped.ok).toBe(true);
      const report = (stopped as { value: { performanceReport: { evidence: Array<{ kind: string; atMs: number }> } } }).value.performanceReport;
      expect(report.evidence.filter((entry) => entry.kind === "request").map((entry) => entry.atMs)).toEqual(preNavigation ? [485, 485.4] : []);
    } finally { disposeDevtoolsState(state); }
  });

  it("retains valid layout-shift IDs and reports omitted observer shifts", () => {
    const report = measuredReport();
    const load = createLoadCapture("capture", "document-initial", 1_000);
    reconcileLoadSnapshot(load, { observerAvailable: true, timeOriginMs: 1_000, shiftSupported: true,
      shifts: [{ atMs: 700, value: 0.2, hadRecentInput: false }], droppedShifts: 3 });
    addRenderingEvidence(report, { events: [], main, page: {}, load });
    expect(report.evidence[0]?.id).toBe("layout-shift-1");
    expect(report.findings[0]?.evidenceIds).toEqual(["layout-shift-1"]);
    expect(report.coverage.omittedEvidence).toBe(3);
    expect(report.coverage.reasons).toContain("rendering-budget-exceeded");
    expect(report.completeness).toBe("partial");
  });

  it("prunes links to CSS evidence removed by the report budget", () => {
    const report = measuredReport();
    report.evidence = Array.from({ length: 400 }, (_, index) => ({ id: `paint-${index + 1}`, kind: "paint", atMs: index, clock: "trace", documentId: null,
      values: {}, relatedIds: ["style-1"], sources: [{ label: "source-1", mapping: "unavailable" }, { label: "source-2", mapping: "unavailable" }] }));
    report.evidence.push({ id: "style-1", kind: "style", atMs: 0, clock: "document", documentId: null, values: {} });
    boundPerformanceReport(report);
    expect(report.coverage.omittedEvidence).toBeGreaterThan(0);
    expect(report.evidence.some((entry) => entry.id === "style-1")).toBe(false);
    expect(report.evidence.every((entry) => entry.relatedIds?.length === 0)).toBe(true);
  });

  it("recovers pre-navigation LCP and missing resource timing after lost debugger notifications", () => {
    const load = createLoadCapture("capture", "document-initial", 1_000);
    load.preNavigation = true;
    load.mainFrameId = "main";
    reconcileLoadSnapshot(load, { observerAvailable: true, timeOriginMs: 2_000, observerStartedAtMs: 4, beforeLoad: true, lcpSupported: true,
      lcp: { atMs: 1_200, size: 20_000, url: "https://fixture/hero.png?private=secret", navigation: { responseStart: 300 } },
      resources: [{ url: "https://fixture/hero.png?private=secret", initiatorType: "img", startTime: 400, responseStart: 500, responseEnd: 1_000, encodedBodySize: 2_000 }],
    });
    const report = buildPerformanceReport({ reportId: "capture", startedAt: 0, durationMs: 2_000,
      environment: { browserVersion: "1", viewport: null, visible: true, cpuThrottle: 1, network: "off", cacheDisabled: false,
        reducedMotion: false, animationRate: 1, documentId: "document-initial", timeOriginMs: 1_000 },
      events: [task(0, 1)], main, traceComplete: true, observerAvailable: true, retainedBytes: 1, droppedEvents: 0, reasons: new Set(),
    });
    addLoadEvidence(report, load);
    expect(report.documents).toContainEqual(expect.objectContaining({ timeOriginMs: 2_000, observerStartedAtMs: 4, observedBeforeLoad: true }));
    expect(report.evidence.find((entry) => entry.kind === "request")).toMatchObject({ clock: "document", request: { observation: "resource-timing" }, values: { fromCache: null, redirectHop: null } });
    expect(report.evidence.find((entry) => entry.kind === "lcp")).toMatchObject({ relatedIds: ["request-1"], values: { ttfbMs: 300, resourceLoadDelayMs: 100, resourceLoadDurationMs: 600, elementRenderDelayMs: 200 } });
    expect(report.completeness).toBe("partial");
    expect(report.coverage.reasons).toContain("request-details-unavailable");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("uses the maximum CLS session rather than adding separated shift clusters", () => {
    const report = analyzeRendering({ ...quiet, visible: true, page: { loaf: [], shifts: [
      { atMs: 700, value: 0.15, hadRecentInput: false },
      { atMs: 2_300, value: 0.2, hadRecentInput: false },
    ] } });
    expect(report.layoutShifts).toMatchObject({ cls: 0.2 });
  });

  it("a delayed old observer cleanup cannot delete a new capture's observers", async () => {
    vi.useFakeTimers();
    const state = createDevtoolsState();
    const pageWindow: Record<string, unknown> = {};
    pageWindow.top = pageWindow;
    const context = {
      window: pageWindow,
      document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, getAnimations: () => [] },
      PerformanceObserver: { supportedEntryTypes: [] }, performance: { timeOrigin: 100, now: () => 0, getEntriesByType: () => [] },
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    };
    let evaluations = 0;
    let lateCleanup!: () => void;
    const guest = {
      getURL: () => "about:blank",
      debugger: { sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          const evaluate = () => ({ result: { value: runInNewContext(String(params?.expression), context) } });
          if (++evaluations === 2) return new Promise((resolve) => { lateCleanup = () => resolve(evaluate()); });
          return evaluate();
        }
        if (method === "Tracing.end") onDevtoolsEvent(state, "Tracing.tracingComplete", {});
        return {};
      } },
    } as unknown as WebContents;
    const run = (action: string) => executeDevtoolsAction(guest, state, { kind: "devtools", action, params: {} });
    try {
      await run("render-start");
      const oldStop = run("render-stop");
      await vi.advanceTimersByTimeAsync(2_001);
      await oldStop;
      await run("render-start");
      const currentObservers = pageWindow.__odRender;
      lateCleanup();
      await Promise.resolve();
      expect(pageWindow.__odRender).toBe(currentObservers);
      const currentId = state.recording?.reportId;
      expect(await run("render-stop")).toMatchObject({ ok: true, value: { performanceReport: { reportId: currentId } } });
    } finally {
      disposeDevtoolsState(state);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["observer", "trace-command"])("bounds stop when %s never settles and fences late trace completion", async (hung) => {
    vi.useFakeTimers();
    const state = createDevtoolsState();
    let evaluations = 0;
    let ends = 0;
    const guest = {
      getURL: () => "about:blank",
      debugger: { sendCommand: async (method: string) => {
        if (method === "Runtime.evaluate") {
          if (++evaluations === 2 && hung === "observer") return new Promise(() => {});
          return { result: { value: { visible: true, timeOriginMs: 100, observerAvailable: true, shifts: [], loaf: [], animations: [] } } };
        }
        if (method === "Tracing.end") {
          ends++;
          if (hung === "trace-command") return new Promise(() => {});
          onDevtoolsEvent(state, "Tracing.tracingComplete", {});
        }
        return {};
      } },
    } as unknown as WebContents;
    const run = (action: string) => executeDevtoolsAction(guest, state, { kind: "devtools", action, params: {} });
    try {
      await run("render-start");
      let settled = false;
      const stopping = run("render-stop").then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(true);
      expect(ends).toBe(1);
      const stopped = await stopping;
      expect(await run("render-stop")).toEqual(stopped);
      if (hung === "trace-command") {
        expect((await run("render-start")).ok).toBe(false);
        onDevtoolsEvent(state, "Tracing.tracingComplete", {});
      }
      expect((await run("render-start")).ok).toBe(true);
      expect(state.recording?.traceComplete).toBe(false);
    } finally {
      disposeDevtoolsState(state);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects stop while trace start is pending, then permits stop and stable retries", async () => {
    vi.useFakeTimers();
    const state = createDevtoolsState();
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
    const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let ends = 0;
    const guest = {
      getURL: () => "about:blank",
      debugger: { sendCommand: async (method: string) => {
        if (method === "Tracing.start") { enteredStart(); await gate; }
        if (method === "Tracing.end") { ends++; onDevtoolsEvent(state, "Tracing.tracingComplete", {}); }
        if (method === "Runtime.evaluate") return { result: { value: { visible: true, timeOriginMs: 100, observerAvailable: true, shifts: [], loaf: [], animations: [] } } };
        return {};
      } },
    } as unknown as WebContents;
    const run = (action: string) => executeDevtoolsAction(guest, state, { kind: "devtools", action, params: {} });
    try {
      const starting = run("render-start");
      await entered;
      const earlyStop = await run("render-stop");
      releaseStart();
      await starting;
      expect(earlyStop).toEqual({ ok: false, reason: "rendering recording is starting; retry render-stop after render-start finishes" });
      expect(ends).toBe(0);
      const [first, second] = await Promise.all([run("render-stop"), run("render-stop")]);
      expect(first).toEqual(second);
      expect(await run("render-stop")).toEqual(first);
      expect(ends).toBe(1);
    } finally {
      releaseStart();
      disposeDevtoolsState(state);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("names layout shift, long tasks, thrash, and repainting animations in plain verdicts", () => {
    const events = [
      { name: "thread_name", ph: "M", ...main, args: { name: "CrRendererMain" } },
      task(1_000, 180),
      ...Array.from({ length: 300 }, (_, index) => layout(1_100 + index * 100)),
      task(400_000, 4),
      ...Array.from({ length: 60 }, (_, index) => frame(index * 16_700)),
    ];
    const report = analyzeRendering({
      animations: [{ name: "spin", element: "#spin", properties: ["left"], costlyProperties: ["left"] }],
      droppedEvents: 0,
      durationMs: 1_000,
      events,
      page: { loaf: [], shifts: [{ value: 0.2, hadRecentInput: false, sources: [{ element: "#banner" }] }] },
      visible: true,
    });
    const verdicts = (report.verdicts as string[]).join("\n");
    expect(verdicts).toContain("CLS 0.2");
    expect(verdicts).toContain("#banner");
    expect(verdicts).toContain("longest 180 ms");
    expect(verdicts).toContain("one task ran 300 layouts");
    expect(verdicts).toContain('"spin" on #spin animates left');
    expect(report.frames).toMatchObject({ drawn: 60, fps: 60, slowFrames: 0 });
  });

  it("marks empty captures as insufficient, including when the tab was hidden", () => {
    const hidden = analyzeRendering({ ...quiet, visible: false });
    expect(hidden.verdicts).toContainEqual(expect.stringContaining("not visible"));
    expect(hidden.frames).toMatchObject({ fps: null });
    expect(analyzeRendering({ ...quiet, visible: true }).verdicts).toContain("Insufficient evidence: no usable renderer tasks were captured.");
  });

  it("ignores shifts right after user input, as CLS does", () => {
    const report = analyzeRendering({
      ...quiet,
      page: { loaf: [], shifts: [{ value: 0.5, hadRecentInput: true, sources: [] }] },
      visible: true,
    });
    expect(report.layoutShifts).toMatchObject({ cls: 0 });
  });
});

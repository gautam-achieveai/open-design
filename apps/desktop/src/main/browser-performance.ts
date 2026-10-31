import type { BrowserPerformanceEnvironment, BrowserPerformanceEvidence, BrowserPerformanceFinding, BrowserPerformanceReport, BrowserPerformanceSourceLocator, BrowserPerformanceSourceReference } from "@open-design/contracts";

type Task = { name?: string; ph?: string; pid?: number; tid?: number; ts?: number; dur?: number };

/** Convert trace measurements to an allowlisted report before crossing the host boundary. */
export function buildPerformanceReport(input: {
  reportId: string; startedAt: number; durationMs: number;
  environment: BrowserPerformanceEnvironment;
  events: Task[]; main: { pid: number; tid: number } | null;
  traceComplete: boolean; observerAvailable: boolean; retainedBytes: number; droppedEvents: number; reasons: Set<string>;
}): BrowserPerformanceReport {
  const reasons = new Set(input.reasons);
  if (!input.traceComplete) reasons.add("trace-incomplete");
  if (!input.observerAvailable) reasons.add("observer-unavailable");
  if (!input.environment.visible) reasons.add("target-hidden");
  if (input.droppedEvents) reasons.add("trace-budget-exceeded");
  const tasks = input.events.filter((event) => event.name === "RunTask" && event.ph === "X" &&
    event.pid === input.main?.pid && event.tid === input.main?.tid &&
    Number.isFinite(event.ts) && Number.isFinite(event.dur) && (event.dur ?? 0) >= 0);
  if (!tasks.length) reasons.add("no-renderer-tasks");
  const traceOrigin = tasks.reduce((min, event) => Math.min(min, event.ts!), Infinity);
  const longTasks = tasks.filter((event) => event.dur! > 50_000);
  const retained = longTasks.slice(0, 2_000);
  const omittedEvidence = longTasks.length - retained.length;
  if (omittedEvidence) reasons.add("report-budget-exceeded");
  const evidence: BrowserPerformanceEvidence[] = retained.map((task, index) => ({
    id: `task-${index + 1}`, kind: "task", atMs: (task.ts! - traceOrigin) / 1_000,
    durationMs: task.dur! / 1_000, clock: "trace", documentId: input.environment.documentId,
    values: { thresholdMs: 50 },
  }));
  const findings: BrowserPerformanceFinding[] = evidence.map((entry, index) => ({
    id: `finding-${index + 1}`, kind: "task", severity: "warning", title: "Long main-thread task observed",
    interpretation: "observed", evidenceIds: [entry.id],
  }));
  // Main-thread mapping uses Chromium's thread labels and task counts, not target identity.
  reasons.add("renderer-thread-heuristic");
  const completeness = !tasks.length ? "failed" : [...reasons].some((reason) => reason !== "renderer-thread-heuristic") ? "partial" : "complete";
  return {
    schemaVersion: 1, reportId: input.reportId, startedAt: new Date(input.startedAt).toISOString(),
    durationMs: Math.round(input.durationMs), completeness,
    summary: completeness === "failed" ? "Insufficient evidence to assess rendering." : completeness === "partial" ? "Capture incomplete; only retained evidence assessed." :
      evidence.length ? "Long main-thread tasks were observed." : "No long main-thread tasks observed in the retained capture.",
    environment: { ...input.environment, ...(Number.isFinite(traceOrigin) ? { traceOriginUs: traceOrigin } : {}) },
    coverage: { traceComplete: input.traceComplete, observerAvailable: input.observerAvailable,
      retainedEvents: input.events.length, rendererTasks: tasks.length, retainedBytes: input.retainedBytes, droppedEvents: input.droppedEvents,
      omittedEvidence, reasons: [...reasons] }, findings, evidence,
  };
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Append bounded observations. Source locators remain transient until daemon authorization. */
export function addInteractionEvidence(report: BrowserPerformanceReport, profile: unknown, page: RecordValue, sampleCpu: boolean): BrowserPerformanceSourceLocator[] {
  const sources: BrowserPerformanceSourceLocator[] = [];
  const reasons = new Set(report.coverage.reasons);
  const supported = page.inputSupported === true;
  const inputs = Array.isArray(page.inputs) ? page.inputs.filter(record) : [];
  const droppedInputs = (number(page.droppedInputs) ? page.droppedInputs : 0) + Math.max(0, inputs.length - 200);
  report.coverage.inputTiming = { supported, retained: 0, dropped: droppedInputs };
  if (!supported) reasons.add("event-timing-unavailable");
  if (droppedInputs) reasons.add("input-budget-exceeded");
  for (const input of inputs.slice(0, 200)) {
    if (![input.atMs, input.durationMs, input.processingStartMs, input.processingEndMs, input.interactionId].every(number)) continue;
    const atMs = input.atMs as number;
    const durationMs = input.durationMs as number;
    const start = input.processingStartMs as number;
    const end = input.processingEndMs as number;
    if (atMs < 0 || durationMs < 0 || start < atMs || end < start) continue;
    const id = `input-${report.coverage.inputTiming.retained + 1}`;
    report.evidence.push({ id, kind: "input", atMs, durationMs, clock: "document", documentId: input.documentId === null ? null : typeof input.documentId === "string" ? input.documentId : report.environment.documentId,
      values: { interactionId: input.interactionId as number, inputDelayMs: start - atMs, processingMs: end - start,
        presentationDelayMs: Math.max(0, atMs + durationMs - end), timingResolutionMs: 8 } });
    report.coverage.inputTiming.retained++;
    if (durationMs >= 100) report.findings.push({ id: `finding-${report.findings.length + 1}`, kind: "input", severity: "warning",
      title: "Slow input event observed", interpretation: "observed", evidenceIds: [id] });
  }

  const validProfile = record(profile) && number(profile.startTime) && Array.isArray(profile.nodes) && Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas);
  report.coverage.cpuSampling = { status: sampleCpu ? validProfile ? "captured" : "unavailable" : "disabled", intervalUs: 5_000, retainedSamples: 0, droppedSamples: 0 };
  if (sampleCpu && !validProfile) reasons.add("profiler-unavailable");
  if (sampleCpu && validProfile) {
    report.environment.profileOriginUs = profile.startTime as number;
    reasons.add("profile-sampling-overhead");
    const nodes = (profile.nodes as unknown[]).filter(record);
    const byId = new Map(nodes.slice(0, 4_000).filter((node) => number(node.id)).map((node) => [node.id as number, node]));
    if (nodes.length > 4_000) reasons.add("profile-budget-exceeded");
    const parents = new Map<number, number>();
    for (const node of byId.values()) for (const child of Array.isArray(node.children) ? node.children : []) {
      if (number(child)) parents.set(child, node.id as number);
    }
    const labels = new Map<string, BrowserPerformanceSourceReference>();
    const referenceFor = (nodeId: unknown): BrowserPerformanceSourceReference | undefined => {
      let node = number(nodeId) ? byId.get(nodeId) : undefined;
      for (let depth = 0; node && depth < 16; depth++) {
        const frame = record(node.callFrame) ? node.callFrame : {};
        if (typeof frame.url === "string" && frame.url && number(frame.lineNumber) && frame.lineNumber >= 0 && number(frame.columnNumber) && frame.columnNumber >= 0) {
          let url: URL;
          try { url = new URL(frame.url); } catch { return undefined; }
          if (!["http:", "https:"].includes(url.protocol)) return undefined;
          url.username = ""; url.password = ""; url.search = ""; url.hash = "";
          if (url.href.length > 2_048) return undefined;
          const functionName = typeof frame.functionName === "string" && frame.functionName.length <= 128 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(frame.functionName) ? frame.functionName : undefined;
          const key = `${url.href}:${frame.lineNumber}:${frame.columnNumber}:${functionName ?? ""}`;
          const existing = labels.get(key);
          if (existing) return existing;
          if (sources.length >= 64) { reasons.add("source-budget-exceeded"); return undefined; }
          const label = `source-${sources.length + 1}`;
          const reference: BrowserPerformanceSourceReference = { label, line: frame.lineNumber + 1, column: frame.columnNumber + 1, mapping: "unavailable", unavailableReason: "source-unavailable" };
          labels.set(key, reference);
          sources.push({ label, url: url.href, line: reference.line!, column: reference.column!, ...(functionName ? { functionName } : {}) });
          return reference;
        }
        const parent = parents.get(node.id as number);
        node = parent === undefined ? undefined : byId.get(parent);
      }
      return undefined;
    };
    const samples = profile.samples as unknown[];
    const deltas = profile.timeDeltas as unknown[];
    const tasks = report.evidence.filter((entry) => entry.kind === "task");
    let timestamp = profile.startTime as number;
    for (let index = 0; index < Math.min(samples.length, deltas.length, 20_000); index++) {
      const delta = deltas[index];
      if (!number(delta) || delta < 0) { reasons.add("profile-budget-exceeded"); continue; }
      timestamp += delta;
      if (!Number.isFinite(timestamp)) { reasons.add("profile-budget-exceeded"); break; }
      const source = referenceFor(samples[index]);
      if (!source) continue;
      if (report.coverage.cpuSampling.retainedSamples >= 700) { report.coverage.cpuSampling.droppedSamples++; continue; }
      const id = `sample-${report.coverage.cpuSampling.retainedSamples + 1}`;
      const related = tasks.filter((task) => {
        const taskStart = (report.environment.traceOriginUs ?? Infinity) + task.atMs * 1_000;
        return timestamp >= taskStart && timestamp <= taskStart + (task.durationMs ?? 0) * 1_000;
      }).slice(0, 1);
      report.evidence.push({ id, kind: "sample", atMs: (timestamp - (profile.startTime as number)) / 1_000,
        clock: "profile", documentId: report.environment.documentId, values: { sampleIntervalUs: 5_000 }, sources: [source], relatedIds: related.map((task) => task.id) });
      report.coverage.cpuSampling.retainedSamples++;
      if (related.length) {
        reasons.add("profile-clock-correlation-heuristic");
        const task = related[0]!;
        if (!task.sources?.some((entry) => entry.label === source.label)) task.sources = [...(task.sources ?? []), source].slice(0, 5);
      }
    }
    if (samples.length > 20_000 || samples.length !== deltas.length || report.coverage.cpuSampling.droppedSamples) reasons.add("profile-budget-exceeded");
    for (const task of tasks.filter((entry) => entry.sources?.length)) report.findings.push({
      id: `finding-${report.findings.length + 1}`, kind: "sample", severity: "info", title: "Sampled function overlaps a long task",
      interpretation: "hypothesis", evidenceIds: [task.id],
    });
  }
  report.coverage.reasons = [...reasons];
  const informational = new Set(["renderer-thread-heuristic", "profile-sampling-overhead", "profile-clock-correlation-heuristic"]);
  if (report.completeness !== "failed" && [...reasons].some((reason) => !informational.has(reason))) report.completeness = "partial";
  if (report.completeness === "partial") report.summary = "Capture incomplete; only retained evidence assessed.";
  return sources;
}

/** Apply the shared budget after every evidence producer, including authorized source expansion headroom. */
export function boundPerformanceReport(report: BrowserPerformanceReport): void {
  // Leave space for daemon-authorized source paths and legacy host envelope fields.
  const sourceExpansionBytes = 1_024;
  let reportBytes = Buffer.byteLength(JSON.stringify(report), "utf8") + report.evidence.reduce((sum, entry) => sum + (entry.sources?.length ?? 0) * sourceExpansionBytes, 0);
  while (reportBytes > 700_000 && report.evidence.length) {
    const removed = report.evidence.pop()!;
    reportBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + (removed.sources?.length ?? 0) * sourceExpansionBytes;
    report.findings = report.findings.filter((finding) => {
      if (!finding.evidenceIds.includes(removed.id)) return true;
      reportBytes -= Buffer.byteLength(JSON.stringify(finding), "utf8");
      return false;
    });
    report.coverage.omittedEvidence++;
    if (removed.kind === "sample") { report.coverage.cpuSampling!.retainedSamples--; report.coverage.cpuSampling!.droppedSamples++; }
    if (removed.kind === "input") { report.coverage.inputTiming!.retained--; report.coverage.inputTiming!.dropped++; }
    if (removed.kind === "request" && report.coverage.load) { report.coverage.load.retainedRequests--; report.coverage.load.droppedRequests++; }
    if (!report.coverage.reasons.includes("report-budget-exceeded")) report.coverage.reasons.push("report-budget-exceeded");
    if (report.completeness !== "failed") report.completeness = "partial";
    report.summary = "Capture incomplete; only retained evidence assessed.";
  }
  const retainedIds = new Set(report.evidence.map((entry) => entry.id));
  for (const entry of report.evidence) if (entry.relatedIds) entry.relatedIds = entry.relatedIds.filter((id) => retainedIds.has(id));
  if (report.coverage.rendering) {
    report.coverage.rendering.retainedShifts = report.evidence.filter((entry) => entry.kind === "layout-shift").length;
    report.coverage.rendering.retainedPaints = report.evidence.filter((entry) => entry.kind === "paint").length;
    report.coverage.rendering.retainedFrames = report.evidence.filter((entry) => entry.kind === "frame").length;
    report.coverage.rendering.cssTargets = new Set(report.evidence.filter((entry) => entry.kind === "style").map((entry) => entry.target?.label)).size;
  }
}

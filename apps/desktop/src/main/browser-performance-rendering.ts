import type { BrowserPerformanceReport, BrowserPerformanceSourceLocator, BrowserPerformanceSourceReference } from "@open-design/contracts";
import type { LoadCapture } from "./browser-performance-load.js";

type Value = Record<string, unknown>;
type Trace = { name?: string; ph?: string; ts?: number; dur?: number; pid?: number; tid?: number; args?: Value };
const record = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** CLS is the largest session: gaps below one second, session span below five seconds. */
export function clsSessions(shifts: Array<{ atMs: number; value: number; hadRecentInput?: boolean }>): { cls: number; entries: Array<{ atMs: number; value: number; sessionScore: number }> } {
  const sorted = shifts.filter((shift) => !shift.hadRecentInput && Number.isFinite(shift.atMs) && Number.isFinite(shift.value) && shift.value >= 0)
    .sort((a, b) => a.atMs - b.atMs);
  let first = -Infinity;
  let last = -Infinity;
  let score = 0;
  let cls = 0;
  const entries = sorted.map((shift) => {
    if (shift.atMs - last >= 1_000 || shift.atMs - first >= 5_000) { first = shift.atMs; score = 0; }
    score += shift.value;
    last = shift.atMs;
    cls = Math.max(cls, score);
    return { atMs: shift.atMs, value: shift.value, sessionScore: score };
  });
  return { cls, entries };
}

export type StyleSheetLocation = { url: string; startLine: number; startColumn: number };
export type RenderTarget = { label: string; nodeId: number; backendNodeId: number; selector?: string };
type MatchedTarget = { target: RenderTarget; references: BrowserPerformanceSourceReference[]; locators: BrowserPerformanceSourceLocator[]; matchedRuleCount: number };

/** Matched rules describe the target's current styles; they do not identify a paint's cause. */
export async function collectMatchedCss(
  send: (method: string, params?: Value) => Promise<Value>, targets: RenderTarget[],
  styleSheets: Map<string, StyleSheetLocation>, firstSource: number,
): Promise<MatchedTarget[]> {
  const output: MatchedTarget[] = [];
  let nextSource = firstSource;
  for (const target of targets.slice(0, 8)) {
    let styles: Value;
    try { styles = await send("CSS.getMatchedStylesForNode", { nodeId: target.nodeId }); } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.warn(JSON.stringify({ event: "browser.performance.css", stage: "matched-styles-failed", target: target.backendNodeId,
        code: /(?:could not find|no) node|node.*(?:not found|does not belong)/i.test(message) ? "node-not-found" : "lookup-failed" }));
      continue;
    }
    const matches = Array.isArray(styles.matchedCSSRules) ? styles.matchedCSSRules.filter(record) : [];
    const references: BrowserPerformanceSourceReference[] = [];
    const locators: BrowserPerformanceSourceLocator[] = [];
    let authorRules = 0;
    let missingSheet = 0;
    let missingRange = 0;
    for (const match of matches) {
      const rule = record(match.rule) ? match.rule : {};
      if (rule.origin === "user-agent") continue;
      authorRules++;
      const style = record(rule.style) ? rule.style : {};
      const sheet = typeof style.styleSheetId === "string" ? styleSheets.get(style.styleSheetId) : undefined;
      const range = record(style.range) ? style.range : {};
      if (!sheet) missingSheet++;
      if (!finite(range.startLine) || !finite(range.startColumn)) missingRange++;
      if (!sheet || !finite(range.startLine) || !finite(range.startColumn) || references.length >= 3 || nextSource >= 64) continue;
      let url: URL;
      try { url = new URL(sheet.url); } catch { continue; }
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      if (url.href.length > 2_048) continue;
      const label = `source-${++nextSource}`;
      const line = sheet.startLine + range.startLine + 1;
      const column = range.startColumn + (range.startLine === 0 ? sheet.startColumn : 0) + 1;
      references.push({ label, line, column, mapping: "unavailable", unavailableReason: "source-unavailable" });
      locators.push({ label, url: url.href, line, column, kind: "stylesheet" });
    }
    console.warn(JSON.stringify({ event: "browser.performance.css", stage: "matched-styles", target: target.backendNodeId,
      matchingRules: matches.length, authorRules, missingSheet, missingRange, sourceRefs: references.length, sourceSlotsUsed: nextSource }));
    output.push({ target, references, locators, matchedRuleCount: matches.length });
  }
  return output;
}

export function appendMatchedCss(report: BrowserPerformanceReport, matches: MatchedTarget[], sources: BrowserPerformanceSourceLocator[], page: Value, documentId: string | null): void {
  for (const match of matches) {
    sources.push(...match.locators);
    const id = `style-${report.evidence.filter((entry) => entry.kind === "style").length + 1}`;
    const target = { label: match.target.label, backendNodeId: match.target.backendNodeId };
    report.evidence.push({ id, kind: "style", atMs: finite(page.observedAtMs) ? page.observedAtMs : 0, clock: "document", documentId,
      target, values: { matchedRuleCount: match.matchedRuleCount }, sources: match.references });
    for (const evidence of report.evidence) if (evidence.kind === "paint" && evidence.target?.backendNodeId === target.backendNodeId) {
      evidence.target = target; evidence.relatedIds = [...(evidence.relatedIds ?? []), id];
    }
    for (const shift of Array.isArray(page.shifts) ? page.shifts.filter(record) : []) {
      if (!match.target.selector || !Array.isArray(shift.sources) || !shift.sources.some((source) => record(source) && source.element === match.target.selector)) continue;
      const evidence = report.evidence.find((entry) => entry.kind === "layout-shift" && entry.documentId === documentId && entry.atMs === shift.atMs);
      if (evidence && !evidence.target) { evidence.target = target; evidence.relatedIds = [...(evidence.relatedIds ?? []), id]; }
    }
    report.findings.push({ id: `finding-${report.findings.length + 1}`, kind: "style", severity: "info",
      title: "Matched CSS rule observed", interpretation: "observed", evidenceIds: [id] });
  }
  if (matches.length && !report.coverage.reasons.includes("matched-css-not-causation")) report.coverage.reasons.push("matched-css-not-causation");
}

/** Numeric rendering evidence with no refresh-rate assumption or inferred compositor cost. */
export function addRenderingEvidence(report: BrowserPerformanceReport, input: { events: Trace[]; main: { pid: number; tid: number } | null; page: Value; load: LoadCapture }): number[] {
  const reasons = new Set(report.coverage.reasons);
  const documents = [...input.load.documents.values()];
  const droppedShifts = documents.reduce((sum, document) => sum + (document.droppedShifts ?? 0), 0);
  if (droppedShifts) { reasons.add("rendering-budget-exceeded"); report.coverage.omittedEvidence += droppedShifts; }
  const streamed = documents.flatMap((document) => document.shifts.map((shift) => ({ ...shift, documentId: document.documentId })));
  const fallbackDoc = finite(input.page.timeOriginMs) ? input.load.documents.get(input.page.timeOriginMs) : undefined;
  const shifts: Value[] = streamed.length ? streamed : (Array.isArray(input.page.shifts) ? input.page.shifts.filter(record).map((shift) => ({ ...shift, documentId: fallbackDoc?.documentId ?? null })) : []);
  const groups = new Map<string | null, Array<{ atMs: number; value: number; hadRecentInput: boolean }>>();
  for (const shift of shifts) {
    if (!finite(shift.atMs) || !finite(shift.value)) continue;
    const documentId = typeof shift.documentId === "string" ? shift.documentId : null;
    const group = groups.get(documentId) ?? [];
    group.push({ atMs: shift.atMs, value: shift.value, hadRecentInput: shift.hadRecentInput === true }); groups.set(documentId, group);
  }
  let retainedShifts = 0;
  for (const [documentId, entries] of groups) {
    const sessions = clsSessions(entries);
    for (const shift of sessions.entries) {
      if (retainedShifts >= 200) { reasons.add("rendering-budget-exceeded"); break; }
      const id = `layout-shift-${++retainedShifts}`;
      report.evidence.push({ id, kind: "layout-shift", atMs: shift.atMs, clock: "document", documentId,
        values: { score: shift.value, sessionScore: shift.sessionScore, cls: sessions.cls } });
      report.findings.push({ id: `finding-${report.findings.length + 1}`, kind: "layout-shift", severity: "warning",
        title: "Layout shift observed", interpretation: "observed", evidenceIds: [id] });
    }
  }
  const traceOrigin = report.environment.traceOriginUs ?? 0;
  const onRenderer = input.events.filter((event) => input.main !== null && event.pid === input.main.pid);
  const paints = onRenderer.filter((event) => event.name === "Paint" && event.ph === "X" && finite(event.ts) && finite(event.dur));
  const backendIds = new Set<number>();
  for (const paint of paints.slice(0, 500)) {
    const data = record(paint.args?.data) ? paint.args.data : {};
    const clip = Array.isArray(data.clip) && data.clip.length >= 8 && data.clip.every((value) => finite(value) && Math.abs(value) <= 1_000_000) ? data.clip as number[] : null;
    const xs = clip ? [clip[0]!, clip[2]!, clip[4]!, clip[6]!] : null;
    const ys = clip ? [clip[1]!, clip[3]!, clip[5]!, clip[7]!] : null;
    const backendNodeId = Number.isSafeInteger(data.nodeId) && (data.nodeId as number) > 0 ? data.nodeId as number : null;
    if (backendNodeId !== null && !input.load.navigationCount) backendIds.add(backendNodeId);
    const id = `paint-${report.evidence.filter((entry) => entry.kind === "paint").length + 1}`;
    report.evidence.push({ id, kind: "paint", atMs: Math.max(0, (paint.ts! - traceOrigin) / 1_000), durationMs: paint.dur! / 1_000,
      clock: "trace", documentId: input.load.navigationCount ? null : report.environment.documentId,
      ...(backendNodeId === null || input.load.navigationCount ? {} : { target: { label: `target-${backendNodeId}`, backendNodeId } }),
      values: { x: xs ? Math.min(...xs) : null, y: ys ? Math.min(...ys) : null,
        width: xs ? Math.max(...xs) - Math.min(...xs) : null, height: ys ? Math.max(...ys) - Math.min(...ys) : null },
    });
  }
  const frames = onRenderer.filter((event) => event.name === "DrawFrame" && finite(event.ts)).sort((a, b) => a.ts! - b.ts!);
  for (let index = 0; index < Math.min(frames.length, 1_000); index++) {
    const frame = frames[index]!;
    report.evidence.push({ id: `frame-${index + 1}`, kind: "frame", atMs: Math.max(0, (frame.ts! - traceOrigin) / 1_000),
      clock: "trace", documentId: input.load.navigationCount ? null : report.environment.documentId,
      values: { intervalMs: index ? (frame.ts! - frames[index - 1]!.ts!) / 1_000 : null } });
  }
  if (paints.length > 500 || frames.length > 1_000) reasons.add("rendering-budget-exceeded");
  if (paints.length) reasons.add("paint-not-compositor-cost");
  const paintIds = report.evidence.filter((entry) => entry.kind === "paint").slice(0, 20).map((entry) => entry.id);
  if (paintIds.length) report.findings.push({ id: `finding-${report.findings.length + 1}`, kind: "paint", severity: "info",
    title: "Paint activity observed", interpretation: "observed", evidenceIds: paintIds });
  if (frames.length) reasons.add("frame-cadence-not-display-refresh");
  report.coverage.rendering = { supported: input.page.shiftSupported === true || documents.some((document) => document.shiftSupported),
    retainedShifts, retainedPaints: Math.min(paints.length, 500), retainedFrames: Math.min(frames.length, 1_000), cssTargets: 0, displayRefreshHz: null };
  report.coverage.reasons = [...reasons];
  if (reasons.has("rendering-budget-exceeded") && report.completeness !== "failed") {
    report.completeness = "partial"; report.summary = "Capture incomplete; only retained evidence assessed.";
  }
  return [...backendIds].slice(0, 8);
}

import { randomUUID } from "node:crypto";
import type { BrowserPerformanceDocument, BrowserPerformanceEvidence, BrowserPerformanceReport } from "@open-design/contracts";

type Value = Record<string, unknown>;
const isRecord = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";
type DocumentCapture = BrowserPerformanceDocument & { lcpSupported: boolean; shiftSupported: boolean; inputs: Value[]; shifts: Value[]; droppedShifts?: number; lcp?: Value; resources?: Value[] };
type RequestHop = {
  id: string; requestId: string; loaderId: string; frameId: string; documentId: string | null;
  url: string; started: number; wallTime: number | null; finished: number | null;
  response: Value; resourceType: NonNullable<BrowserPerformanceEvidence["request"]>["resourceType"];
  initiatorType: NonNullable<BrowserPerformanceEvidence["request"]>["initiatorType"];
  relatedIds: string[]; failed: boolean; encodedBytes: number | null; redirectHop: number;
};

function responseTimings(value: Value): Value {
  const timing = isRecord(value.timing) ? value.timing : {};
  return { status: finite(value.status) ? value.status : null, fromDiskCache: value.fromDiskCache === true,
    fromServiceWorker: value.fromServiceWorker === true,
    timing: Object.fromEntries(["requestTime", "dnsStart", "dnsEnd", "connectStart", "connectEnd", "sslStart", "sslEnd", "sendStart", "sendEnd", "receiveHeadersEnd"]
      .map((key) => [key, finite(timing[key]) ? timing[key] : null])) };
}

export type LoadCapture = {
  bindingName: string; scriptId: string | null; preNavigation: boolean; mainFrameId: string;
  initialDocumentId: string; documents: Map<number, DocumentCapture>; requests: RequestHop[];
  currentRequests: Map<string, RequestHop>; loaderDocuments: Map<string, string>;
  droppedRequests: number; droppedObservations: number; navigationCount: number;
};

export function createLoadCapture(reportId: string, documentId: string, timeOriginMs: number | null): LoadCapture {
  return {
    bindingName: `__odPerformance_${reportId.replaceAll("-", "")}`, scriptId: null, preNavigation: false, mainFrameId: "",
    initialDocumentId: documentId, documents: new Map(timeOriginMs === null ? [] : [[timeOriginMs, {
      documentId, timeOriginMs, observerStartedAtMs: 0, observedBeforeLoad: false, lcpSupported: false, shiftSupported: false, inputs: [], shifts: [],
    }]]), requests: [], currentRequests: new Map(), loaderDocuments: new Map(), droppedRequests: 0, droppedObservations: 0, navigationCount: 0,
  };
}

/** Uses the existing debugger event router; no second connection or network-body collector. */
export function collectLoadEvent(load: LoadCapture, method: string, payload: Value): void {
  if (method === "Runtime.bindingCalled" && payload.name === load.bindingName && typeof payload.payload === "string") {
    if (payload.payload.length > 16_384) { load.droppedObservations++; return; }
    let message: unknown;
    try { message = JSON.parse(payload.payload); } catch { return; }
    if (!isRecord(message) || !finite(message.timeOriginMs) || !isRecord(message.entry)) return;
    const entry = message.entry;
    const origin = message.timeOriginMs;
    let document = load.documents.get(origin);
    if (!document) {
      if (load.documents.size >= 8) { load.droppedObservations++; return; }
      const navigation = load.requests.filter((request) => request.resourceType === "Document" &&
        load.mainFrameId !== "" && request.frameId === load.mainFrameId && request.wallTime !== null && Math.abs(request.wallTime * 1_000 - origin) < 1_000)
        .sort((a, b) => Math.abs(a.wallTime! * 1_000 - origin) - Math.abs(b.wallTime! * 1_000 - origin))[0];
      document = { documentId: navigation?.documentId ?? `document-${randomUUID()}`, timeOriginMs: origin,
        observerStartedAtMs: 0, observedBeforeLoad: false, lcpSupported: false, shiftSupported: false, inputs: [], shifts: [] };
      load.documents.set(origin, document);
    }
    if (message.kind === "document") {
      document.observerStartedAtMs = finite(message.entry.atMs) ? message.entry.atMs : 0;
      document.observedBeforeLoad = message.entry.beforeLoad === true;
      document.lcpSupported = message.entry.lcpSupported === true;
      document.shiftSupported = message.entry.shiftSupported === true;
    } else if (message.kind === "shift-dropped") {
      document.droppedShifts = Math.max(document.droppedShifts ?? 0, 1);
    } else if (message.kind === "input" || message.kind === "shift") {
      const entries = message.kind === "input" ? document.inputs : document.shifts;
      if (entries.length >= 200) load.droppedObservations++;
      else entries.push(Object.fromEntries((message.kind === "input"
        ? ["atMs", "durationMs", "interactionId", "processingStartMs", "processingEndMs"]
        : ["atMs", "value", "hadRecentInput"]).map((key) => [key, typeof entry[key] === "boolean" || finite(entry[key]) ? entry[key] : null])));
    } else if (message.kind === "lcp") {
      const navigation = isRecord(message.entry.navigation) ? message.entry.navigation : {};
      document.lcp = { atMs: message.entry.atMs, size: message.entry.size, url: text(message.entry.url).slice(0, 8_192),
        navigation: { responseStart: finite(navigation.responseStart) ? navigation.responseStart : null } };
    }
    return;
  }
  const requestId = text(payload.requestId);
  if (!requestId) return;
  if (method === "Network.requestWillBeSent" && isRecord(payload.request) && finite(payload.timestamp)) {
    const previous = load.currentRequests.get(requestId);
    if (previous && isRecord(payload.redirectResponse)) {
      previous.response = responseTimings(payload.redirectResponse);
      previous.finished = payload.timestamp;
      previous.encodedBytes = finite(payload.redirectResponse.encodedDataLength) ? payload.redirectResponse.encodedDataLength : null;
    }
    if (load.requests.length >= 200) { load.droppedRequests++; load.currentRequests.delete(requestId); return; }
    if (text(payload.request.url).length > 8_192) { load.droppedRequests++; return; }
    const loaderId = text(payload.loaderId);
    const frameId = text(payload.frameId);
    const isDocument = payload.type === "Document";
    if (isDocument && !load.loaderDocuments.has(loaderId)) {
      load.loaderDocuments.set(loaderId, `document-${randomUUID()}`);
      if (frameId === load.mainFrameId) load.navigationCount++;
    }
    const initiator = isRecord(payload.initiator) ? payload.initiator : {};
    const resourceTypes = ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "XHR", "Fetch"];
    const initiatorTypes = ["parser", "script", "preload", "preflight"];
    const stack = isRecord(initiator.stack) ? initiator.stack : {};
    const scriptFrame = Array.isArray(stack.callFrames) ? stack.callFrames.find((frame) => isRecord(frame) && text(frame.url)) : undefined;
    const initiatorUrl = text(initiator.url) || (isRecord(scriptFrame) ? text(scriptFrame.url) : "");
    const initiatorRequest = load.currentRequests.get(text(initiator.requestId)) ?? (initiatorUrl
      ? [...load.requests].reverse().find((candidate) => candidate.url === initiatorUrl && candidate.loaderId === loaderId)
      : undefined);
    const hop: RequestHop = {
      id: `request-${load.requests.length + 1}`, requestId, loaderId, frameId,
      documentId: load.loaderDocuments.get(loaderId) ?? (frameId === load.mainFrameId ? load.initialDocumentId : null),
      url: text(payload.request.url), started: payload.timestamp, wallTime: finite(payload.wallTime) ? payload.wallTime : null,
      finished: null, response: {}, resourceType: resourceTypes.includes(text(payload.type)) ? payload.type as RequestHop["resourceType"] : "Other",
      initiatorType: initiatorTypes.includes(text(initiator.type)) ? initiator.type as RequestHop["initiatorType"] : "other",
      relatedIds: [...new Set([...(previous ? [previous.id] : []), ...(initiatorRequest ? [initiatorRequest.id] : [])])],
      failed: false, encodedBytes: null, redirectHop: previous ? previous.redirectHop + 1 : 0,
    };
    load.requests.push(hop); load.currentRequests.set(requestId, hop);
    return;
  }
  const hop = load.currentRequests.get(requestId);
  if (!hop) return;
  if (method === "Network.responseReceived" && isRecord(payload.response)) hop.response = { ...responseTimings(payload.response), fromCache: hop.response.fromCache === true };
  if (method === "Network.requestServedFromCache") hop.response.fromCache = true;
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    hop.finished = finite(payload.timestamp) ? payload.timestamp : null;
    hop.failed = method === "Network.loadingFailed";
    hop.encodedBytes = finite(payload.encodedDataLength) ? payload.encodedDataLength : null;
  }
}

/** Recover bounded page-owned observations when a debugger navigation loses notifications. */
export function reconcileLoadSnapshot(load: LoadCapture, page: Value): void {
  if (!finite(page.timeOriginMs) || page.observerAvailable !== true) return;
  const emit = (kind: string, entry: Value) => collectLoadEvent(load, "Runtime.bindingCalled", {
    name: load.bindingName, payload: JSON.stringify({ kind, entry, timeOriginMs: page.timeOriginMs }),
  });
  emit("document", { atMs: page.observerStartedAtMs, beforeLoad: page.beforeLoad, lcpSupported: page.lcpSupported, shiftSupported: page.shiftSupported });
  if (isRecord(page.lcp)) emit("lcp", page.lcp);
  const document = load.documents.get(page.timeOriginMs);
  if (!document) return;
  // The final page arrays are authoritative for this document; streamed earlier documents remain.
  if (Array.isArray(page.inputs)) document.inputs = page.inputs.filter(isRecord).slice(0, 200);
  if (Array.isArray(page.shifts)) document.shifts = page.shifts.filter(isRecord).slice(0, 200);
  if (finite(page.droppedShifts)) document.droppedShifts = Math.max(document.droppedShifts ?? 0, page.droppedShifts);
  document.resources = Array.isArray(page.resources) ? page.resources.filter(isRecord).slice(0, 200) : [];
}

/** Keep only known timing fields; response headers, URLs and bodies never enter evidence. */
export function addLoadEvidence(report: BrowserPerformanceReport, load: LoadCapture): void {
  const origin = load.requests[0]?.started;
  if (origin !== undefined) report.environment.networkOriginUs = origin * 1_000_000;
  const reasons = new Set(report.coverage.reasons);
  if (!load.preNavigation) reasons.add("pre-navigation-observer-unavailable");
  if (!load.mainFrameId) reasons.add("main-frame-unavailable");
  if (load.droppedRequests) reasons.add("network-budget-exceeded");
  if (load.droppedObservations) reasons.add("document-observer-budget-exceeded");
  if (load.navigationCount) {
    // A trace/profiler task can cross document commits; do not guess its owning document.
    for (const entry of report.evidence) if (entry.kind === "task" || entry.kind === "sample") entry.documentId = null;
    reasons.add("cross-document-task-attribution-unavailable");
  }
  report.documents = [...load.documents.values()].map(({ documentId, timeOriginMs, observerStartedAtMs, observedBeforeLoad }) => ({ documentId, timeOriginMs, observerStartedAtMs, observedBeforeLoad }));
  for (const hop of load.requests) {
    const timing = isRecord(hop.response.timing) ? hop.response.timing : {};
    const phase = (start: string, end: string) => finite(timing[start]) && finite(timing[end]) && timing[start] >= 0 && timing[end] >= timing[start] ? timing[end] - timing[start] : null;
    const headersAt = finite(timing.requestTime) && finite(timing.receiveHeadersEnd) && timing.receiveHeadersEnd >= 0 ? timing.requestTime + timing.receiveHeadersEnd / 1_000 : null;
    if (hop.finished === null) reasons.add("request-incomplete");
    report.evidence.push({ id: hop.id, kind: "request", atMs: (hop.started - (origin ?? hop.started)) * 1_000,
      ...(hop.finished === null ? {} : { durationMs: Math.max(0, hop.finished - hop.started) * 1_000 }),
      clock: "network", documentId: hop.documentId, relatedIds: hop.relatedIds,
      request: { resourceType: hop.resourceType, initiatorType: hop.initiatorType, observation: "cdp" },
      values: { status: finite(hop.response.status) ? hop.response.status : null, dnsMs: phase("dnsStart", "dnsEnd"),
        connectMs: phase("connectStart", "connectEnd"), tlsMs: phase("sslStart", "sslEnd"), sendMs: phase("sendStart", "sendEnd"),
        waitMs: phase("sendEnd", "receiveHeadersEnd"), downloadMs: headersAt !== null && hop.finished !== null ? Math.max(0, hop.finished - headersAt) * 1_000 : null,
        encodedBytes: hop.encodedBytes, fromCache: hop.response.fromCache === true || hop.response.fromDiskCache === true,
        fromDiskCache: hop.response.fromDiskCache === true, fromServiceWorker: hop.response.fromServiceWorker === true,
        failed: hop.failed, redirectHop: hop.redirectHop },
    });
  }
  for (const document of load.documents.values()) {
    const fallbacks: Array<{ id: string; resource: Value }> = [];
    for (const resource of document.resources ?? []) {
      if (!finite(resource.startTime) || !finite(resource.responseEnd) || resource.responseEnd < resource.startTime || !text(resource.url)) continue;
      if (load.requests.some((request) => request.documentId === document.documentId && request.url === resource.url)) continue;
      if (report.evidence.filter((entry) => entry.kind === "request").length >= 200) { reasons.add("network-budget-exceeded"); break; }
      const id = `request-${report.evidence.filter((entry) => entry.kind === "request").length + 1}`;
      const phase = (start: string, end: string) => finite(resource[start]) && finite(resource[end]) && resource[start] > 0 && resource[end] >= resource[start] ? resource[end] - resource[start] : null;
      // A CSS initiator can fetch an image/font, and link can be preload; keep those unknown.
      const types: Record<string, NonNullable<BrowserPerformanceEvidence["request"]>["resourceType"]> = { img: "Image", script: "Script", fetch: "Fetch", xmlhttprequest: "XHR" };
      report.evidence.push({ id, kind: "request", atMs: resource.startTime, durationMs: resource.responseEnd - resource.startTime,
        clock: "document", documentId: document.documentId, relatedIds: [],
        request: { resourceType: types[text(resource.initiatorType)] ?? "Other", initiatorType: "other", observation: "resource-timing" },
        values: { status: finite(resource.responseStatus) && resource.responseStatus > 0 ? resource.responseStatus : null,
          dnsMs: phase("domainLookupStart", "domainLookupEnd"), connectMs: phase("connectStart", "connectEnd"), tlsMs: phase("secureConnectionStart", "connectEnd"),
          sendMs: null, waitMs: phase("requestStart", "responseStart"), downloadMs: phase("responseStart", "responseEnd"),
          encodedBytes: finite(resource.encodedBodySize) && resource.encodedBodySize > 0 ? resource.encodedBodySize : null,
          fromCache: resource.fromCache === true ? true : null, fromDiskCache: null, fromServiceWorker: null, failed: null, redirectHop: null } });
      fallbacks.push({ id, resource });
      reasons.add("resource-timing-fallback"); reasons.add("request-details-unavailable");
    }
    const lcp = document.lcp;
    if (!lcp || !finite(lcp.atMs)) continue;
    const navigation = isRecord(lcp.navigation) ? lcp.navigation : {};
    const resources = load.requests.filter((request) => request.documentId === document.documentId && request.url === lcp.url && request.finished !== null);
    const resource = resources.length === 1 ? resources[0] : undefined;
    const matchingFallbacks = fallbacks.filter((item) => item.resource.url === lcp.url);
    const fallback = !resource && matchingFallbacks.length === 1 ? matchingFallbacks[0] : undefined;
    const navRequest = load.requests.find((request) => request.documentId === document.documentId && request.resourceType === "Document" && request.wallTime !== null);
    const wallOffset = navRequest?.wallTime !== null && navRequest?.wallTime !== undefined ? navRequest.wallTime - navRequest.started : null;
    const resourceStart = resource && wallOffset !== null ? (resource.started + wallOffset) * 1_000 - document.timeOriginMs : fallback && finite(fallback.resource.startTime) ? fallback.resource.startTime : null;
    const resourceEnd = resource?.finished !== null && resource?.finished !== undefined && wallOffset !== null ? (resource.finished + wallOffset) * 1_000 - document.timeOriginMs : fallback && finite(fallback.resource.responseEnd) ? fallback.resource.responseEnd : null;
    const ttfb = finite(navigation.responseStart) ? navigation.responseStart : null;
    if (!resource && !fallback && text(lcp.url)) reasons.add("lcp-resource-unavailable");
    report.evidence.push({ id: `lcp-${report.evidence.filter((entry) => entry.kind === "lcp").length + 1}`, kind: "lcp", atMs: lcp.atMs,
      durationMs: lcp.atMs, clock: "document", documentId: document.documentId, relatedIds: resource ? [resource.id] : fallback ? [fallback.id] : [],
      values: { sizePx: finite(lcp.size) ? lcp.size : null, ttfbMs: ttfb,
        resourceLoadDelayMs: resourceStart !== null && ttfb !== null ? Math.max(0, resourceStart - ttfb) : null,
        resourceLoadDurationMs: resourceStart !== null && resourceEnd !== null ? Math.max(0, resourceEnd - resourceStart) : null,
        elementRenderDelayMs: resourceEnd !== null ? Math.max(0, lcp.atMs - resourceEnd) : null },
    });
  }
  report.coverage.load = { preNavigation: load.preNavigation, retainedRequests: report.evidence.filter((entry) => entry.kind === "request").length, droppedRequests: load.droppedRequests,
    documents: load.documents.size, lcpSupported: [...load.documents.values()].some((document) => document.lcpSupported) };
  report.coverage.reasons = [...reasons];
  if ([...reasons].some((reason) => ["pre-navigation-observer-unavailable", "main-frame-unavailable", "network-budget-exceeded", "document-observer-budget-exceeded", "cross-document-task-attribution-unavailable", "request-incomplete", "lcp-resource-unavailable", "request-details-unavailable"].includes(reason)) && report.completeness !== "failed") {
    report.completeness = "partial"; report.summary = "Capture incomplete; only retained evidence assessed.";
  }
}

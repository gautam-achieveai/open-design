import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BrowserPerformanceEvidence, BrowserPerformanceFinding, BrowserPerformancePage, BrowserPerformanceReport, BrowserPerformanceReportSummary } from '@open-design/contracts';
import { BrowserBrokerError } from './browser-command-broker.js';
import { isPerformanceSourcePath } from './browser-performance-sources.js';

const REPORT_BYTES = 1_048_576;
const PAGE_BYTES = 6_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_BYTES = 20 * 1_048_576;
const uuid = z.string().uuid();
const finite = z.number().finite();
const nonnegative = finite.min(0);
const count = nonnegative.int();
const kind = z.enum(['task', 'sample', 'input', 'request', 'lcp', 'layout-shift', 'paint', 'frame', 'style']);
const generatedId = z.string().regex(/^(?:task|sample|input|request|lcp|layout-shift|paint|frame|style|finding|coverage)-\d+$/).max(80);
const documentId = z.string().regex(/^document-[a-f0-9-]{36}$/);
const localLocation = z.object({ path: z.string().refine(isPerformanceSourcePath), line: count.min(1), column: count.min(1) });
const source = z.object({ label: z.string().regex(/^source-\d+$/), line: count.optional(), column: count.optional(),
  mapping: z.enum(['generated', 'project-local', 'unavailable']),
  resolutionBasis: z.literal('current-project-files-unverified-at-capture').optional(),
  generated: localLocation.extend({ functionName: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/).max(128).optional() }).optional(),
  original: localLocation.optional(), unavailableReason: z.enum(['source-unavailable', 'external-source', 'invalid-source-path',
    'source-too-large', 'map-missing', 'map-invalid', 'map-external', 'map-too-large', 'map-unmapped', 'source-outside-project']).optional() });
const findingSchema = z.object({ id: generatedId, kind: z.union([kind, z.literal('coverage')]),
  severity: z.enum(['info', 'warning']), title: z.string().max(200), interpretation: z.enum(['observed', 'hypothesis']),
  evidenceIds: z.array(generatedId).max(100) });
const evidenceSchema = z.object({ id: generatedId, kind, atMs: finite, durationMs: nonnegative.optional(),
  clock: z.enum(['trace', 'document', 'profile', 'network']), documentId: documentId.nullable(),
  values: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), z.union([finite, z.boolean(), z.null()])),
  relatedIds: z.array(generatedId).max(100).optional(), sources: z.array(source).max(20).optional(),
  target: z.object({ label: z.string().regex(/^target-\d+$/), backendNodeId: count.min(1).optional() }).optional(),
  request: z.object({ resourceType: z.enum(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'XHR', 'Fetch', 'Other']),
    initiatorType: z.enum(['parser', 'script', 'preload', 'preflight', 'other']),
    observation: z.enum(['cdp', 'resource-timing']).optional() }).optional() });
const reportSchema = z.object({ schemaVersion: z.literal(1), reportId: uuid, startedAt: z.iso.datetime(),
  scenarioId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
  durationMs: nonnegative.max(120_000), completeness: z.enum(['complete', 'partial', 'failed']), summary: z.string().max(500),
  environment: z.object({ browserVersion: z.string().regex(/^(?:[\d.]{1,40}|unknown)$/),
    viewport: z.object({ width: nonnegative, height: nonnegative, deviceScaleFactor: nonnegative }).nullable(),
    visible: z.boolean(), cpuThrottle: nonnegative, network: z.string().max(40), cacheDisabled: z.boolean(),
    reducedMotion: z.boolean().nullable(), animationRate: nonnegative, documentId, timeOriginMs: finite.nullable(),
    traceOriginUs: nonnegative.optional(), profileOriginUs: nonnegative.optional(), networkOriginUs: nonnegative.optional(),
    overridesFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), appliedCpuThrottle: finite.min(1).max(20).optional() }),
  coverage: z.object({ traceComplete: z.boolean(), observerAvailable: z.boolean(), retainedEvents: count,
    rendererTasks: count.optional(), droppedEvents: count, retainedBytes: count, omittedEvidence: count,
    reasons: z.array(z.string().max(80)).max(50),
    cpuSampling: z.object({ status: z.enum(['captured', 'unavailable', 'disabled']), intervalUs: nonnegative,
      retainedSamples: count, droppedSamples: count }).optional(),
    inputTiming: z.object({ supported: z.boolean(), retained: count, dropped: count }).optional(),
    load: z.object({ preNavigation: z.boolean(), retainedRequests: count, droppedRequests: count, documents: count, lcpSupported: z.boolean() }).optional(),
    rendering: z.object({ supported: z.boolean(), retainedShifts: count, retainedPaints: count, retainedFrames: count,
      cssTargets: count, displayRefreshHz: z.null() }).optional() }),
  documents: z.array(z.object({ documentId, timeOriginMs: nonnegative, observerStartedAtMs: nonnegative, observedBeforeLoad: z.boolean() })).max(64).optional(),
  restoration: z.union([
    z.object({ status: z.literal('not-modified-by-capture'), settingsChangedDuringCapture: z.boolean() }),
    z.object({ status: z.enum(['restored', 'failed', 'conflict']), priorCpu: finite.min(1).max(20), appliedCpu: finite.min(1).max(20),
      restoredCpu: finite.min(1).max(20).nullable(), settingsChangedDuringCapture: z.boolean(),
      reason: z.enum(['cpu-changed-externally', 'apply-timeout', 'restore-failed']).optional() }),
  ]).optional(),
  findings: z.array(findingSchema).max(5000), evidence: z.array(evidenceSchema).max(10000) });

function failure(message: string, status = 400): never {
  throw new BrowserBrokerError(status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message, status);
}

/** Only known structural fields survive; display text is derived, never renderer text. */
export function sanitizePerformanceReport(value: unknown, trustedSources = false): BrowserPerformanceReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) return failure('Invalid browser performance report');
  const report = parsed.data;
  // Older version-1 reports remain readable, but cannot prove a quiet recording.
  if (report.coverage.rendererTasks === undefined) report.coverage.reasons.push('renderer-task-count-unavailable');
  report.coverage.rendererTasks ??= 0;
  if (report.coverage.rendererTasks > report.coverage.retainedEvents) return failure('Invalid measured task count');
  report.summary = SAFE_SUMMARIES.has(report.summary) ? report.summary
    : `${report.completeness} capture: ${report.findings.length} findings, ${report.evidence.length} evidence entries`;
  report.findings = report.findings.map((finding) => ({ ...finding,
    title: ['Long main-thread task observed', 'Long main-thread task observed.', 'Sampled function overlaps a long task', 'Slow input event observed',
      'Layout shift observed', 'Paint activity observed', 'Matched CSS rule observed'].includes(finding.title) ? finding.title
      : `${finding.kind}: ${finding.interpretation === 'hypothesis' ? 'possible contributing factor' : 'measured evidence'}` }));
  // Arbitrary diagnostic strings must never carry page data into durable storage.
  report.environment.network = ['off', 'offline', 'slow-3g', 'fast-3g', 'custom', 'unknown']
    .includes(report.environment.network) ? report.environment.network : 'unknown';
  report.coverage.reasons = report.coverage.reasons.map((reason) => SAFE_REASONS.has(reason) ? reason : 'unsupported_coverage_reason');
  if (!trustedSources) {
    for (const entry of report.evidence) for (const reference of entry.sources ?? []) {
      delete reference.generated;
      delete reference.original;
      delete reference.resolutionBasis;
      if (reference.mapping === 'project-local') reference.mapping = 'unavailable';
    }
  }
  if (report.evidence.some((entry) => Object.keys(entry.values).some((key) => !SAFE_MEASUREMENTS.has(key)))) {
    return failure('Unsupported browser performance measurement key');
  }
  const ids = new Set(report.evidence.map((entry) => entry.id));
  if (ids.size !== report.evidence.length || new Set(report.findings.map((entry) => entry.id)).size !== report.findings.length
    || report.findings.some((entry) => entry.evidenceIds.some((id) => !ids.has(id)))
    || report.evidence.some((entry) => entry.relatedIds?.some((id) => !ids.has(id)))) {
    return failure('Invalid browser performance evidence references');
  }
  if (report.completeness === 'complete' && (!report.coverage.traceComplete || !report.coverage.retainedEvents
    || report.coverage.droppedEvents || report.coverage.omittedEvidence
    || (!report.evidence.length && !report.coverage.rendererTasks)
    || report.coverage.reasons.some((reason) => !INFORMATIONAL_REASONS.has(reason)))) {
    report.completeness = 'partial';
    report.summary = `partial capture: ${report.findings.length} findings, ${report.evidence.length} evidence entries`;
  }
  if (Buffer.byteLength(JSON.stringify(report)) > REPORT_BYTES) return failure('Browser performance report exceeds 1 MiB');
  if ([...report.findings, ...report.evidence].some((entry) => Buffer.byteLength(JSON.stringify([entry])) > PAGE_BYTES)) {
    return failure('Browser performance evidence entry exceeds the page budget');
  }
  return report as BrowserPerformanceReport;
}

const SAFE_SUMMARIES = new Set(['Insufficient evidence to assess rendering.', 'Long main-thread tasks were observed.',
  'No long main-thread tasks observed in the retained capture.', 'Capture incomplete; only retained evidence assessed.']);
const SAFE_REASONS = new Set(['unsupported_coverage_reason', 'target-detached', 'document-changed', 'trace-incomplete',
  'observer-unavailable', 'target-hidden', 'trace-budget-exceeded', 'no-renderer-tasks', 'report-budget-exceeded',
  'renderer-thread-heuristic', 'trace-completion-timeout', 'trace-stop-failed', 'observer-collection-timeout',
  'renderer-task-count-unavailable', 'profiler-unavailable', 'profiler-stop-timeout', 'profile-budget-exceeded',
  'source-budget-exceeded', 'input-budget-exceeded', 'event-timing-unavailable', 'profile-sampling-overhead', 'profile-clock-correlation-heuristic',
  'pre-navigation-observer-unavailable', 'network-budget-exceeded', 'document-observer-budget-exceeded',
  'document-observer-cleanup-failed', 'cross-document-task-attribution-unavailable', 'request-incomplete', 'lcp-resource-unavailable',
  'main-frame-unavailable', 'input-document-unavailable', 'frame-cadence-not-display-refresh', 'paint-not-compositor-cost',
  'matched-css-not-causation', 'rendering-budget-exceeded', 'css-attribution-unavailable',
  'cpu-override-during-capture', 'cpu-restoration-failed', 'cpu-restoration-conflict',
  'resource-timing-fallback', 'request-details-unavailable']);
const INFORMATIONAL_REASONS = new Set(['renderer-thread-heuristic', 'profile-sampling-overhead', 'profile-clock-correlation-heuristic',
  'frame-cadence-not-display-refresh', 'paint-not-compositor-cost', 'matched-css-not-causation']);
const SAFE_MEASUREMENTS = new Set(['thresholdMs', 'sampleIntervalUs', 'interactionId', 'inputDelayMs', 'processingMs',
  'presentationDelayMs', 'timingResolutionMs', 'status', 'dnsMs', 'connectMs', 'tlsMs', 'sendMs', 'waitMs', 'downloadMs',
  'encodedBytes', 'fromDiskCache', 'fromCache', 'fromServiceWorker', 'failed', 'redirectHop', 'ttfbMs',
  'resourceLoadDelayMs', 'resourceLoadDurationMs', 'elementRenderDelayMs', 'sizePx', 'score', 'sessionScore', 'cls',
  'x', 'y', 'width', 'height', 'intervalMs', 'matchedRuleCount']);

interface StoredReport { projectId: string; tabId: string; savedAt: number; expiresAt: number; report: BrowserPerformanceReport }

export function performanceReportSummary(report: BrowserPerformanceReport): BrowserPerformanceReportSummary {
  return { schemaVersion: report.schemaVersion, reportId: report.reportId, startedAt: report.startedAt,
    ...(report.scenarioId ? { scenarioId: report.scenarioId } : {}),
    durationMs: report.durationMs, completeness: report.completeness, summary: report.summary,
    findingsCount: report.findings.length, evidenceCount: report.evidence.length };
}

/** Immutable reports with bounded storage. The caller supplies the resolved daemon root. */
export class BrowserPerformanceReports {
  private readonly directory: string;
  constructor(dataRoot: string, private readonly now: () => number = Date.now) {
    this.directory = join(dataRoot, 'browser-performance');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.cleanTemporaryWrites();
    this.prune();
  }

  private cleanTemporaryWrites(): void {
    // Writes are synchronous and one daemon owns this root: neither startup nor
    // the next save can overlap an active write. Cleanup failure prevents growth.
    for (const name of readdirSync(this.directory)) {
      const parts = name.split('.');
      if (parts.length === 4 && parts[1] === 'json' && parts[3] === 'tmp'
        && uuid.safeParse(parts[0]).success && uuid.safeParse(parts[2]).success) unlinkSync(join(this.directory, name));
    }
  }

  private file(id: string): string {
    if (!uuid.safeParse(id).success) return failure('Invalid performance report ID');
    return join(this.directory, `${id}.json`);
  }

  private inventory(): { file: string; bytes: number; savedAt: number; expiresAt: number; projectId: string; id: string }[] {
    const rows = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = join(this.directory, name);
      try {
        const bytes = statSync(file).size;
        if (bytes > REPORT_BYTES + 16_384) continue;
        const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredReport;
        if (!Number.isFinite(stored.savedAt) || !Number.isFinite(stored.expiresAt) || typeof stored.projectId !== 'string') continue;
        rows.push({ file, bytes, savedAt: stored.savedAt, expiresAt: stored.expiresAt, projectId: stored.projectId, id: name.slice(0, -5) });
      } catch { /* Incomplete/unreadable files cannot be returned as successful reports. */ }
    }
    return rows.sort((a, b) => a.savedAt - b.savedAt || a.id.localeCompare(b.id));
  }

  private prune(incomingBytes = 0): void {
    const rows = this.inventory();
    let total = rows.reduce((sum, row) => sum + row.bytes, 0) + incomingBytes;
    for (const row of rows) {
      if (row.expiresAt > this.now() && total <= QUOTA_BYTES) continue;
      unlinkSync(row.file);
      total -= row.bytes;
    }
  }

  save(projectId: string, tabId: string, value: unknown, trustedSources = false): BrowserPerformanceReportSummary {
    const report = sanitizePerformanceReport(value, trustedSources);
    const file = this.file(report.reportId);
    let previous: StoredReport | undefined;
    try { previous = JSON.parse(readFileSync(file, 'utf8')) as StoredReport; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.projectId !== projectId || previous.tabId !== tabId || previous.expiresAt <= this.now()
        || JSON.stringify(previous.report) !== JSON.stringify(report)) return failure('Performance report identity conflict');
      return performanceReportSummary(previous.report);
    }
    const savedAt = this.now();
    const stored: StoredReport = { projectId, tabId, savedAt, expiresAt: savedAt + TTL_MS, report };
    const encoded = JSON.stringify(stored);
    this.cleanTemporaryWrites();
    this.prune(Buffer.byteLength(encoded));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return performanceReportSummary(report);
  }

  get(projectId: string, reportId: string): StoredReport {
    let stored: StoredReport;
    try { stored = JSON.parse(readFileSync(this.file(reportId), 'utf8')) as StoredReport; }
    catch (error) {
      if (error instanceof BrowserBrokerError) throw error;
      return failure('Performance report is missing or expired', 404);
    }
    if (stored.projectId !== projectId || stored.expiresAt <= this.now()) return failure('Performance report is missing or expired', 404);
    stored.report = sanitizePerformanceReport(stored.report, true);
    return stored;
  }

  describe(projectId: string, reportId: string) {
    const { report, tabId, expiresAt } = this.get(projectId, reportId);
    return { ...performanceReportSummary(report), tabId, expiresAt: new Date(expiresAt).toISOString(),
      environment: report.environment, coverage: report.coverage, ...(report.documents ? { documents: report.documents } : {}),
      ...(report.restoration ? { restoration: report.restoration } : {}), retention: { days: 7, maxReportBytes: REPORT_BYTES, totalBytes: QUOTA_BYTES } };
  }

  list(projectId: string, cursor?: string, limit = 20) {
    const reports = this.inventory().filter((row) => row.projectId === projectId && row.expiresAt > this.now()).reverse()
      .map((row) => performanceReportSummary(this.get(projectId, row.id).report));
    return this.pageItems(reports, ['list', projectId], cursor, limit);
  }

  page(projectId: string, reportId: string, section: 'findings' | 'evidence', cursor?: string, limit = 50,
    filterKind?: BrowserPerformanceFinding['kind']): BrowserPerformancePage {
    const { report } = this.get(projectId, reportId);
    if (section === 'evidence' && filterKind === 'coverage') return failure('Coverage is a finding kind, not evidence');
    const items = filterKind ? report[section].filter((entry) => entry.kind === filterKind) : report[section];
    const page = this.pageItems<BrowserPerformanceFinding | BrowserPerformanceEvidence>(items,
      ['report', projectId, reportId, report.schemaVersion, section, filterKind ?? null], cursor, limit);
    return { reportId, schemaVersion: report.schemaVersion, section, ...page,
      items: page.items as BrowserPerformancePage['items'], omitted: report.coverage.omittedEvidence, completeness: report.completeness };
  }

  private pageItems<T>(items: readonly T[], scope: unknown[], cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failure('Page limit must be an integer from 1 to 100');
    const digest = createHash('sha256').update(JSON.stringify([scope, items])).digest('hex').slice(0, 24);
    let offset = 0;
    if (cursor !== undefined) {
      const match = /^v1\.([a-f0-9]{24})\.(0|[1-9]\d{0,5})$/.exec(cursor);
      if (!match || match[1] !== digest || Number(match[2]) > items.length) return failure('Invalid or stale report cursor');
      offset = Number(match[2]);
    }
    const selected: T[] = [];
    for (; offset < items.length && selected.length < limit; offset++) {
      const candidate = [...selected, items[offset]!];
      if (Buffer.byteLength(JSON.stringify(candidate)) > PAGE_BYTES) {
        if (!selected.length) return failure('Report item exceeds the page budget');
        break;
      }
      selected.push(items[offset]!);
    }
    return { items: selected, total: items.length, nextCursor: offset < items.length ? `v1.${digest}.${offset}` : null };
  }
}

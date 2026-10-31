import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPerformanceReport, JsonValue } from '@open-design/contracts';
import type { Request } from 'express';
import { createBrowserCommandBroker } from '../src/services/browser-command-broker.js';
import { BrowserPerformanceService } from '../src/services/browser-performance.js';
import { BrowserPerformanceReports, sanitizePerformanceReport } from '../src/services/browser-performance-reports.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { createMcpCredentialStore } from '../src/mcp-http/credentials.js';
import { createBrowserReadAuthority } from '../src/mcp-http/browser-read-authority.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { registerBrowserPerformanceMcpTools } from '../src/mcp-http/browser-performance-tools.js';
import { McpToolRegistry, toolOk } from '../src/mcp-http/registry.js';
import { comparePerformanceReports } from '../src/services/browser-performance-comparison.js';

const directories: string[] = [];
const brokers: ReturnType<typeof createBrowserCommandBroker>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const broker of brokers.splice(0)) broker.shutdown();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('saved performance comparisons', () => {
  function repetitions(store: BrowserPerformanceReports, tasks: number[], inputs?: number[], tabId = 'tab') {
    return tasks.map((taskMs, index) => {
      const item = report();
      item.scenarioId = 'save-button';
      item.environment.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
      item.coverage.inputTiming = { supported: true, retained: inputs ? 1 : 0, dropped: 0 };
      if (taskMs) item.evidence.push({ id: 'task-1', kind: 'task', atMs: 10, durationMs: taskMs,
        clock: 'trace', documentId: item.environment.documentId, values: { thresholdMs: 50 } });
      if (inputs) item.evidence.push({ id: 'input-1', kind: 'input', atMs: 10, durationMs: inputs[index]!,
        clock: 'document', documentId: item.environment.documentId, values: { interactionId: 1 } });
      store.save('project', tabId, item);
      return item.reportId;
    });
  }

  it('compares three independent runs using observed distributions and distinguishes quiet tasks from missing input', async () => {
    const { reports } = setup();
    const baselineReportIds = repetitions(reports, [100, 200, 300], [300, 320, 340]);
    const candidateReportIds = repetitions(reports, [0, 0, 0], [40, 48, 56], 'reopened-tab');
    const result = await comparePerformanceReports(reports, 'project', { baselineReportIds, candidateReportIds }, () => true);
    expect(result.comparable).toBe(true);
    expect(result.warnings).toContain('target-changed');
    expect(result.metrics.find((metric) => metric.metric === 'longTaskMaxMs')).toMatchObject({
      baseline: { samples: [100, 200, 300], min: 100, median: 200, max: 300, mean: 200 },
      candidate: { samples: [0, 0, 0], min: 0, median: 0, max: 0, mean: 0, stddev: 0 },
      medianDelta: -200, medianDeltaPercent: -100,
    });
    expect(result.metrics.find((metric) => metric.metric === 'longTaskMaxMs')!.baseline.stddev).toBeCloseTo(81.649658, 5);
    expect(result.metrics.find((metric) => metric.metric === 'inputMaxMs')).toMatchObject({
      baseline: { median: 320 }, candidate: { median: 48 }, medianDelta: -272, medianDeltaPercent: -85,
    });
    const noInput = repetitions(reports, [0, 0, 0]);
    const missing = await comparePerformanceReports(reports, 'project', { baselineReportIds, candidateReportIds: noInput }, () => true);
    expect(missing.comparable).toBe(true);
    expect(missing.warnings).toContain('metric-unavailable');
    expect(missing.metrics.some((metric) => metric.metric === 'inputMaxMs')).toBe(false);
    expect(missing.metrics.find((metric) => metric.metric === 'longTaskTotalMs')!.candidate.samples).toEqual([0, 0, 0]);
  });

  it.each(['scenario-mismatch', 'environment-mismatch', 'capture-incomplete', 'override-not-restored'] as const)(
    'does not call the runs comparable when %s is present', async (warning) => {
      const { reports } = setup();
      const baselineReportIds = repetitions(reports, [100, 200, 300]);
      const candidateReportIds = repetitions(reports, [50, 60, 70]);
      const changed = { ...reports.get('project', candidateReportIds[0]!).report, reportId: randomUUID() };
      if (warning === 'scenario-mismatch') changed.scenarioId = 'different-button';
      if (warning === 'environment-mismatch') changed.environment = { ...changed.environment, cpuThrottle: 2 };
      if (warning === 'capture-incomplete') changed.completeness = 'partial';
      if (warning === 'override-not-restored') changed.restoration = {
        status: 'conflict', priorCpu: 1, appliedCpu: 2, restoredCpu: null, settingsChangedDuringCapture: true, reason: 'cpu-changed-externally',
      };
      reports.save('project', 'tab', changed);
      candidateReportIds[0] = changed.reportId;
      const result = await comparePerformanceReports(reports, 'project', { baselineReportIds, candidateReportIds }, () => true);
      expect(result.comparable).toBe(false);
      expect(result.warnings).toContain(warning);
    });

  it('rejects insufficient or repeated runs and rechecks authority and project scope for every report', async () => {
    const { reports } = setup();
    const baselineReportIds = repetitions(reports, [100, 200, 300]);
    const candidateReportIds = repetitions(reports, [50, 60, 70]);
    await expect(comparePerformanceReports(reports, 'project', {
      baselineReportIds: baselineReportIds.slice(1), candidateReportIds,
    }, () => true)).rejects.toThrow();
    await expect(comparePerformanceReports(reports, 'project', {
      baselineReportIds, candidateReportIds: [baselineReportIds[0], ...candidateReportIds.slice(1)],
    }, () => true)).rejects.toThrow('distinct report IDs');
    let checks = 0;
    await expect(comparePerformanceReports(reports, 'project', { baselineReportIds, candidateReportIds },
      () => ++checks < 4)).rejects.toThrow('access denied');
    expect(checks).toBe(4);
    const foreign = report();
    reports.save('another-project', 'tab', foreign);
    await expect(comparePerformanceReports(reports, 'project', {
      baselineReportIds, candidateReportIds: [foreign.reportId, ...candidateReportIds.slice(1)],
    }, () => true)).rejects.toThrow('missing or expired');
  });
});

function report(): BrowserPerformanceReport {
  return { schemaVersion: 1, reportId: randomUUID(), startedAt: new Date().toISOString(), durationMs: 500,
    completeness: 'complete', summary: 'Long main-thread tasks were observed.',
    environment: { browserVersion: '130.0', viewport: null, visible: true, cpuThrottle: 1, network: 'off', cacheDisabled: false,
      reducedMotion: null, animationRate: 1, documentId: `document-${randomUUID()}`, timeOriginMs: null },
    coverage: { traceComplete: true, observerAvailable: true, retainedEvents: 1, rendererTasks: 1,
      droppedEvents: 0, retainedBytes: 100, omittedEvidence: 0, reasons: [] }, findings: [], evidence: [] };
}

function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'od-browser-performance-test-'));
  directories.push(directory);
  let now = Date.now();
  const reports = new BrowserPerformanceReports(directory, () => now);
  const broker = createBrowserCommandBroker();
  brokers.push(broker);
  const service = new BrowserPerformanceService(reports, broker);
  const { leaseId } = broker.registerTab({ projectId: 'project', tabId: 'tab', url: 'http://localhost/', title: '' });
  async function respond<T>(pending: Promise<T>, action: 'render-start' | 'render-stop', result: unknown, error = false) {
    // Attach immediately: a deliberately rejected transport must not become an unhandled rejection.
    const settled = pending.then((value) => ({ value }), (failure: unknown) => ({ failure }));
    const command = await broker.nextCommand('project', 'tab', leaseId, 500);
    if (!command) throw new Error('No browser command queued');
    broker.submitResult('project', 'tab', command.commandId, error
      ? { leaseId, ok: false, error: { code: 'BROWSER_COMMAND_FAILED', message: 'injected stop failure' } }
      : { leaseId, ok: true, result: { operation: 'devtools', action, result: result as JsonValue } });
    const outcome = await settled;
    if ('failure' in outcome) throw outcome.failure;
    return outcome.value;
  }
  const start = (id: string) => respond(service.start('project', 'tab', 500, () => true), 'render-start',
    { recording: true, reportId: id, maxMs: 500, visible: true });
  return { directory, reports, service, respond, start, advance: () => { now += 8 * 24 * 60 * 60 * 1000; } };
}

describe('performance capture recovery and retention', () => {
  it('retries a saved stop without resurrecting its pruned report or renewing retention', async () => {
    const ctx = setup();
    const captured = report();
    await ctx.start(captured.reportId);
    const saved = await ctx.respond(ctx.service.stop('project', 'tab', () => true), 'render-stop', { performanceReport: captured });
    expect(await ctx.service.stop('project', 'tab', () => true)).toEqual(saved);
    ctx.advance();
    ctx.reports.save('project', 'another-tab', report());
    expect(() => ctx.reports.get('project', captured.reportId)).toThrow('missing or expired');
    await expect(ctx.service.stop('project', 'tab', () => true)).rejects.toThrow('missing or expired');
    expect(ctx.reports.list('project').total).toBe(1);
  });

  it.each(['renderer failure', 'malformed report'])('allows a fresh capture after definitive %s', async (failure) => {
    const ctx = setup();
    await ctx.start(randomUUID());
    await expect(ctx.respond(ctx.service.stop('project', 'tab', () => true), 'render-stop', {}, failure === 'renderer failure')).rejects.toThrow();
    const nextId = randomUUID();
    await expect(ctx.start(nextId)).resolves.toMatchObject({ recording: true, reportId: nextId });
  });

  it('removes failed and abandoned owned temporary writes without touching unrelated files', () => {
    const ctx = setup();
    const directory = join(ctx.directory, 'browser-performance');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected rename failure'); });
    syncBuiltinESMExports();
    try { expect(() => ctx.reports.save('project', 'tab', report())).toThrow('injected rename failure'); }
    finally { rename.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const abandoned = `${randomUUID()}.json.${randomUUID()}.tmp`;
    fs.writeFileSync(join(directory, abandoned), 'partial');
    fs.writeFileSync(join(directory, 'unrelated.tmp'), 'preserve');
    new BrowserPerformanceReports(ctx.directory);
    expect(fs.readdirSync(directory)).toEqual(['unrelated.tmp']);
  });

  it('distinguishes measured quiet recordings from missing evidence and readable legacy reports', () => {
    const quiet = report();
    expect(sanitizePerformanceReport(quiet).completeness).toBe('complete');
    expect(sanitizePerformanceReport({ ...quiet, coverage: { ...quiet.coverage, rendererTasks: 0 } }).completeness).toBe('partial');
    const { rendererTasks: _count, ...legacyCoverage } = quiet.coverage;
    const legacy = sanitizePerformanceReport({ ...quiet, coverage: legacyCoverage });
    expect(legacy.reportId).toBe(quiet.reportId);
    expect(legacy.coverage.reasons).toContain('renderer-task-count-unavailable');
    expect(legacy.completeness).toBe('partial');
  });

  it('persists sanitized evidence across restart and pages every retained item without crossing scope', () => {
    const ctx = setup();
    const large = report();
    large.summary = 'page-secret-in-summary';
    large.evidence = Array.from({ length: 250 }, (_, index) => ({ id: `task-${index}`, kind: 'task', atMs: index * 100,
      durationMs: 80, clock: 'trace', documentId: large.environment.documentId, values: { thresholdMs: 50 } }));
    large.findings = large.evidence.map((entry, index) => ({ id: `finding-${index}`, kind: 'task', severity: 'warning',
      title: 'page-secret-in-title', interpretation: 'observed', evidenceIds: [entry.id] }));
    large.evidence.push(...[1, 2].map((index) => ({ id: `request-${index}`, kind: 'request' as const, atMs: index * 10,
      durationMs: 20, clock: 'document' as const, documentId: large.environment.documentId,
      request: { resourceType: 'Image' as const, initiatorType: 'other' as const, observation: 'resource-timing' as const },
      values: { fromCache: null, fromDiskCache: null, fromServiceWorker: null, waitMs: 10, downloadMs: 10 } })));
    large.documents = [{ documentId: large.environment.documentId, timeOriginMs: 1000, observerStartedAtMs: 2, observedBeforeLoad: true }];
    large.coverage.reasons = ['resource-timing-fallback', 'request-details-unavailable'];
    large.restoration = { status: 'restored', priorCpu: 1, appliedCpu: 2, restoredCpu: 1, settingsChangedDuringCapture: false };
    large.environment.appliedCpuThrottle = 2;
    ctx.reports.save('project', 'tab', { ...large, rawTrace: 'page-secret-in-unknown-field' });
    const restarted = new BrowserPerformanceReports(ctx.directory);
    const stored = fs.readFileSync(join(ctx.directory, 'browser-performance', `${large.reportId}.json`), 'utf8');
    expect(stored).not.toContain('page-secret');
    expect(restarted.describe('project', large.reportId)).toMatchObject({ completeness: 'partial', documents: large.documents,
      restoration: large.restoration, environment: { appliedCpuThrottle: 2 },
      coverage: { reasons: ['resource-timing-fallback', 'request-details-unavailable'] } });
    expect(() => restarted.describe('another-project', large.reportId)).toThrow('missing or expired');
    for (const section of ['findings', 'evidence'] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = restarted.page('project', large.reportId, section, cursor);
        expect(Buffer.byteLength(JSON.stringify(toolOk(page, 0)))).toBeLessThan(32_000);
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        if (cursor) expect(() => restarted.page('project', large.reportId,
          section === 'findings' ? 'evidence' : 'findings', cursor)).toThrow('Invalid or stale');
      } while (cursor);
      expect(ids).toEqual(large[section].map((item) => item.id));
      expect(new Set(ids).size).toBe(large[section].length);
    }
    const requests = restarted.page('project', large.reportId, 'evidence', undefined, 1, 'request');
    expect(requests.total).toBe(2);
    expect(requests.items).toEqual([large.evidence[250]]);
    expect(requests.nextCursor).toBeTruthy();
    expect(() => restarted.page('project', large.reportId, 'evidence', requests.nextCursor!, 1, 'task')).toThrow('Invalid or stale');
    expect(() => restarted.page('project', large.reportId, 'evidence', requests.nextCursor!, 1)).toThrow('Invalid or stale');
    const finalRequest = restarted.page('project', large.reportId, 'evidence', requests.nextCursor!, 1, 'request');
    expect(finalRequest.items).toEqual([large.evidence[251]]);
    expect(finalRequest.nextCursor).toBeNull();

    for (const status of ['failed', 'conflict'] as const) {
      const receipt = { status, priorCpu: 1, appliedCpu: 2, restoredCpu: null, settingsChangedDuringCapture: true,
        reason: status === 'failed' ? 'restore-failed' as const : 'cpu-changed-externally' as const };
      const retained = { ...large, reportId: randomUUID(), restoration: receipt };
      ctx.reports.save('project', 'tab', retained);
      expect(new BrowserPerformanceReports(ctx.directory).describe('project', retained.reportId).restoration).toEqual(receipt);
    }
  });

  it('revalidates the real run bearer after asynchronous project authorization before returning a page', async () => {
    const ctx = setup();
    const saved = report();
    ctx.reports.save('project', 'tab', saved);
    const tokens = new ToolTokenRegistry();
    const credentials = createMcpCredentialStore({ filePath: join(ctx.directory, 'credentials.json') });
    const token = tokens.mint({ runId: 'run', projectId: 'project', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/performance/page'] }).token;
    const request = { query: {}, get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
    const auth = resolveMcpGrant(request, { toolTokenRegistry: tokens, credentialStore: credentials });
    if (!auth.ok) throw new Error('fixture authentication failed');
    const registry = new McpToolRegistry();
    const authorizeProject = vi.fn(async () => { tokens.revokeToken(token); return true; });
    registerBrowserPerformanceMcpTools(registry, { service: ctx.service,
      authorizeCurrentRead: createBrowserReadAuthority({ toolTokenRegistry: tokens, credentialStore: credentials,
        getRun: () => ({ id: 'run', projectId: 'project', status: 'running', cancelRequested: false, workspaceScope: null }),
        projectExists: () => true, getProjectWorkspaceId: () => null, decideProjectRequest: () => ({ ok: true }) }),
      authorizeProject,
    });
    try {
      const denied = await registry.call('browser_performance_page', { reportId: saved.reportId, section: 'evidence' }, auth.grant, undefined, request);
      expect(authorizeProject).toHaveBeenCalledOnce();
      expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(JSON.stringify(denied)).not.toContain(saved.reportId);
    } finally { tokens.clear(); }
  });
});

import { z } from 'zod';
import type { BrowserPerformanceComparison, BrowserPerformanceComparisonWarning, BrowserPerformanceMetricDistribution,
  BrowserPerformanceReport } from '@open-design/contracts';
import { BrowserBrokerError } from './browser-command-broker.js';
import type { BrowserPerformanceReports } from './browser-performance-reports.js';

export const performanceScenarioSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const performanceComparisonSchema = z.object({ baselineReportIds: z.array(z.string().uuid()).min(3).max(10),
  candidateReportIds: z.array(z.string().uuid()).min(3).max(10) }).strict().refine((input) => {
  const all = [...input.baselineReportIds, ...input.candidateReportIds];
  return new Set(all).size === all.length;
}, 'Use distinct report IDs for independent repetitions');

function distribution(samples: number[]): BrowserPerformanceMetricDistribution {
  const ordered = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { samples, min: ordered[0]!, max: ordered.at(-1)!, mean,
    median: ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2,
    stddev: Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length) };
}

function environment(report: BrowserPerformanceReport): string {
  const value = report.environment;
  // Capture/document clocks are intentionally different between repetitions.
  return JSON.stringify([value.browserVersion, value.viewport, value.visible, value.cpuThrottle, value.network,
    value.cacheDisabled, value.reducedMotion, value.animationRate, value.overridesFingerprint ?? null, value.appliedCpuThrottle ?? null]);
}

type Metric = BrowserPerformanceComparison['metrics'][number]['metric'];
function measurement(report: BrowserPerformanceReport, metric: Metric): number | undefined {
  const duration = (kind: string) => report.evidence.filter((entry) => entry.kind === kind)
    .map((entry) => entry.durationMs).filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (metric === 'longTaskMaxMs' || metric === 'longTaskTotalMs') {
    if (!report.coverage.rendererTasks || !report.coverage.traceComplete) return undefined;
    const tasks = duration('task');
    return metric === 'longTaskMaxMs' ? Math.max(0, ...tasks) : tasks.reduce((sum, value) => sum + value, 0);
  }
  if (metric === 'inputMaxMs') {
    if (!report.coverage.inputTiming?.supported) return undefined;
    const inputs = duration('input');
    return inputs.length ? Math.max(...inputs) : undefined;
  }
  if (metric === 'lcpMs') {
    if (!report.coverage.load?.lcpSupported) return undefined;
    const values = duration('lcp');
    return values.length ? Math.max(...values) : undefined;
  }
  const values = report.evidence.filter((entry) => entry.kind === 'layout-shift')
    .map((entry) => entry.values.cls ?? entry.values.sessionScore)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length ? Math.max(...values) : report.coverage.rendering?.supported ? 0 : undefined;
}

/** Compare retained measurements; no causal, field-performance, or significance claim. */
export async function comparePerformanceReports(store: BrowserPerformanceReports, projectId: string,
  raw: unknown, authorize: () => boolean | Promise<boolean>): Promise<BrowserPerformanceComparison> {
  const input = performanceComparisonSchema.parse(raw);
  const current = async () => {
    if (!await authorize()) throw new BrowserBrokerError('FORBIDDEN', 'Performance comparison access denied', 403);
  };
  const stored: ReturnType<BrowserPerformanceReports['get']>[] = [];
  for (const id of [...input.baselineReportIds, ...input.candidateReportIds]) {
    await current();
    stored.push(store.get(projectId, id));
  }
  await current();
  const reports = stored.map((entry) => entry.report);
  const baseline = reports.slice(0, input.baselineReportIds.length);
  const candidate = reports.slice(input.baselineReportIds.length);
  const warnings = new Set<BrowserPerformanceComparisonWarning>();
  if (reports.some((report) => !report.scenarioId)) warnings.add('scenario-missing');
  if (new Set(reports.map((report) => report.scenarioId)).size > 1) warnings.add('scenario-mismatch');
  if (new Set(reports.map(environment)).size > 1) warnings.add('environment-mismatch');
  if (reports.some((report) => report.environment.browserVersion === 'unknown' || !report.environment.viewport
    || (report.environment.network === 'custom' && !report.environment.overridesFingerprint))) warnings.add('environment-incomplete');
  if (new Set(stored.map((entry) => entry.tabId)).size > 1) warnings.add('target-changed');
  if (reports.some((report) => report.completeness !== 'complete')) warnings.add('capture-incomplete');
  const durations = reports.map((report) => report.durationMs);
  if (Math.max(...durations) > Math.max(1, Math.min(...durations)) * 1.1) warnings.add('duration-differs');
  if (reports.some((report) => report.restoration?.settingsChangedDuringCapture)) warnings.add('settings-changed-during-capture');
  if (reports.some((report) => report.restoration && report.restoration.status !== 'not-modified-by-capture'
    && (report.restoration.status !== 'restored' || report.restoration.restoredCpu !== report.restoration.priorCpu))) warnings.add('override-not-restored');
  const metrics: BrowserPerformanceComparison['metrics'] = [];
  for (const metric of ['longTaskMaxMs', 'longTaskTotalMs', 'inputMaxMs', 'lcpMs', 'cls'] as const) {
    const before = baseline.map((report) => measurement(report, metric));
    const after = candidate.map((report) => measurement(report, metric));
    if (before.some((value) => value === undefined) || after.some((value) => value === undefined)) {
      warnings.add('metric-unavailable');
      continue;
    }
    const baselineValues = distribution(before as number[]);
    const candidateValues = distribution(after as number[]);
    const medianDelta = candidateValues.median - baselineValues.median;
    metrics.push({ metric, unit: metric === 'cls' ? 'score' : 'ms', baseline: baselineValues, candidate: candidateValues,
      medianDelta, medianDeltaPercent: baselineValues.median === 0 ? null : medianDelta / baselineValues.median * 100 });
  }
  const incompatible: BrowserPerformanceComparisonWarning[] = ['scenario-missing', 'scenario-mismatch', 'environment-mismatch',
    'environment-incomplete', 'capture-incomplete', 'override-not-restored', 'settings-changed-during-capture'];
  return { schemaVersion: 1, comparable: metrics.length > 0 && !incompatible.some((warning) => warnings.has(warning)),
    scenarioId: warnings.has('scenario-missing') || warnings.has('scenario-mismatch') ? null : reports[0]!.scenarioId!,
    ...input, warnings: [...warnings], metrics };
}

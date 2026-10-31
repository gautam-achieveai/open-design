import { createHash } from 'node:crypto';
import type { BrowserPerformanceCaptureStart, BrowserPerformanceReportSummary, BrowserPerformanceStatus } from '@open-design/contracts';
import { BrowserBrokerError, type BrowserApprovalTarget, type BrowserCommandBroker } from './browser-command-broker.js';
import { BrowserPerformanceReports, performanceReportSummary } from './browser-performance-reports.js';
import { sanitizePerformanceReport } from './browser-performance-reports.js';
import { resolvePerformanceSources, type PerformanceSourceDependencies } from './browser-performance-sources.js';
import { performanceScenarioSchema } from './browser-performance-comparison.js';

type Authority = () => boolean | Promise<boolean>;
type Capture = { target: BrowserApprovalTarget; reportId: string | null; maxMs: number; scenarioId?: string; saved?: boolean; stop?: Promise<unknown> };
const fingerprint = (projectId: string, tabId: string, lease: string) => ({ projectId, tabId,
  leaseDigest: createHash('sha256').update(lease).digest('hex'), urlDigest: 'navigation-allowed' });

/** Capture transport and durable retrieval are shared by REST and MCP. */
export class BrowserPerformanceService {
  private readonly captures = new Map<string, Capture>();
  constructor(readonly reports: BrowserPerformanceReports, private readonly broker: BrowserCommandBroker,
    private readonly sources?: PerformanceSourceDependencies) {}

  private async requireAuthority(authorize: Authority): Promise<void> {
    if (!await authorize()) throw new BrowserBrokerError('FORBIDDEN', 'Browser performance access denied', 403);
  }

  status(projectId: string, tabId?: string): BrowserPerformanceStatus {
    const target = this.broker.captureApprovalTarget(projectId, tabId, fingerprint);
    const capture = this.captures.get(JSON.stringify([projectId, target.tabId]));
    if (!capture || capture.saved || capture.target.leaseDigest !== target.leaseDigest) return { state: 'idle', capture: null };
    return { state: 'pending', capture: { tabId: target.tabId, reportId: capture.reportId, maxMs: capture.maxMs } };
  }

  async start(projectId: string, tabId: string | undefined, maxMs: number, authorize: Authority,
    signal?: AbortSignal, scenarioId?: string): Promise<BrowserPerformanceCaptureStart> {
    if (scenarioId !== undefined) performanceScenarioSchema.parse(scenarioId);
    if (!Number.isInteger(maxMs) || maxMs < 500 || maxMs > 60_000) {
      throw new BrowserBrokerError('BAD_REQUEST', 'maxMs must be an integer from 500 to 60000', 400);
    }
    await this.requireAuthority(authorize);
    for (const [key, capture] of this.captures) {
      if (!this.broker.isApprovalTargetCurrent(capture.target, fingerprint)) this.captures.delete(key);
    }
    const target = this.broker.captureApprovalTarget(projectId, tabId, fingerprint);
    const key = JSON.stringify([projectId, target.tabId]);
    const prior = this.captures.get(key);
    if (prior && !prior.saved && this.broker.isApprovalTargetCurrent(prior.target, fingerprint)) {
      throw new BrowserBrokerError('BAD_REQUEST', 'A performance capture is already pending; stop it before starting another', 409);
    }
    const capture: Capture = { target, reportId: null, maxMs, ...(scenarioId ? { scenarioId } : {}) };
    this.captures.set(key, capture);
    // Preserve the pinned target after transport timeout: stop may recover the
    // recording, whereas an implicit replacement would lose its evidence.
    const response = await this.broker.execute(projectId, target.tabId,
      { operation: 'devtools', action: 'render-start', params: { maxMs, sampleCpu: true } }, undefined, signal).catch((error: unknown) => {
      if (error instanceof BrowserBrokerError && error.code === 'BROWSER_COMMAND_FAILED') this.captures.delete(key);
      throw error;
    });
    await this.requireAuthority(authorize);
    const value = response.result.operation === 'devtools' ? response.result.result as unknown as BrowserPerformanceCaptureStart : null;
    if (!value || value.recording !== true || !/^[a-f0-9-]{36}$/.test(value.reportId)
      || value.maxMs !== maxMs || typeof value.visible !== 'boolean') {
      throw new BrowserBrokerError('BROWSER_COMMAND_FAILED', 'Invalid performance capture start response', 502);
    }
    capture.reportId = value.reportId;
    return { recording: true, reportId: value.reportId, maxMs, visible: value.visible };
  }

  async stop(projectId: string, tabId: string | undefined, authorize: Authority,
    signal?: AbortSignal): Promise<BrowserPerformanceReportSummary> {
    await this.requireAuthority(authorize);
    const target = this.broker.captureApprovalTarget(projectId, tabId, fingerprint);
    const key = JSON.stringify([projectId, target.tabId]);
    const capture = this.captures.get(key);
    if (!capture || capture.target.leaseDigest !== target.leaseDigest) {
      throw new BrowserBrokerError('BROWSER_COMMAND_FAILED', 'No recoverable capture for this tab. Pending capture is lost if its host or daemon restarted before saving.', 409);
    }
    const savedSummary = () => performanceReportSummary(this.reports.get(projectId, capture.reportId!).report);
    if (capture.saved) return savedSummary();
    if (!capture.stop) {
      capture.stop = this.broker.execute(projectId, target.tabId,
        { operation: 'devtools', action: 'render-stop', params: {} }, undefined, signal)
        .then((response) => {
          const result = response.result.operation === 'devtools' ? response.result.result : null;
          return result && typeof result === 'object' && !Array.isArray(result)
            ? { report: result.performanceReport, sources: result.performanceSources } : undefined;
        });
    }
    const pending = capture.stop;
    try {
      const captured = await pending as { report?: unknown; sources?: unknown } | undefined;
      const value = captured?.report;
      await this.requireAuthority(authorize);
      if (!this.broker.isApprovalTargetCurrent(capture.target, fingerprint)) {
        throw new BrowserBrokerError('BROWSER_LEASE_CONFLICT', 'Capture host changed before the report was saved', 409);
      }
      // Another stop may already have saved while this caller revalidated. Never
      // recreate an expired/evicted report from a previously resolved payload.
      if (capture.saved) return savedSummary();
      if (capture.reportId && (!value || typeof value !== 'object' || !('reportId' in value) || value.reportId !== capture.reportId)) {
        throw new BrowserBrokerError('BROWSER_COMMAND_FAILED', 'Capture report identity changed', 502);
      }
      let report = sanitizePerformanceReport(value);
      if (capture.scenarioId) report.scenarioId = capture.scenarioId;
      else delete report.scenarioId;
      if (this.sources) report = await resolvePerformanceSources(report, captured?.sources, projectId, this.sources, authorize);
      await this.requireAuthority(authorize);
      if (!this.broker.isApprovalTargetCurrent(capture.target, fingerprint)) {
        throw new BrowserBrokerError('BROWSER_LEASE_CONFLICT', 'Capture host changed before the report was saved', 409);
      }
      if (capture.saved) return savedSummary();
      const summary = this.reports.save(projectId, target.tabId, report, true);
      capture.reportId = summary.reportId;
      capture.saved = true;
      return summary;
    } catch (error) {
      // A definitive host failure/invalid result is ended. An uncertain timeout
      // or storage failure remains recoverable through desktop's retained result.
      if (error instanceof BrowserBrokerError && (error.code === 'BROWSER_COMMAND_FAILED' || error.code === 'BAD_REQUEST')
        && this.captures.get(key) === capture) this.captures.delete(key);
      throw error;
    } finally {
      if (capture.stop === pending) delete capture.stop;
    }
  }
}

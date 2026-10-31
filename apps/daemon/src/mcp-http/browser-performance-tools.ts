import { z } from 'zod';
import type { Request } from 'express';
import type { BrowserPerformanceService } from '../services/browser-performance.js';
import { BrowserBrokerError } from '../services/browser-command-broker.js';
import { comparePerformanceReports, performanceComparisonSchema, performanceScenarioSchema } from '../services/browser-performance-comparison.js';
import { McpToolRegistry, toolError, toolOk, type McpAuthGrant, type McpToolContext } from './registry.js';

const project = { projectId: z.string().min(1).max(8192).optional() };
const tab = { ...project, tabId: z.string().min(1).max(8192).optional() };
const pagination = { cursor: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional() };

export function registerBrowserPerformanceMcpTools(registry: McpToolRegistry, deps: {
  service: BrowserPerformanceService;
  authorizeProject: (request: Request, projectId: string) => Promise<boolean>;
  authorizeCurrentRead: (request: Request, projectId: string, operation: string, grant: McpAuthGrant) => boolean;
}): void {
  async function execute(args: { projectId?: string | undefined }, context: McpToolContext, operation: string,
    run: (projectId: string, current: () => boolean) => unknown | Promise<unknown>) {
    const { grant, request } = context;
    const projectId = grant.kind === 'run' ? grant.projectId : args.projectId;
    const denied = () => toolError('PROJECT_SCOPE_DENIED', 'Browser performance access denied', 0);
    if (!request || !projectId || (grant.kind === 'run' && args.projectId && args.projectId !== projectId)) return denied();
    const current = () => deps.authorizeCurrentRead(request, projectId, operation, grant);
    if (!current() || !await deps.authorizeProject(request, projectId) || !current()) return denied();
    try {
      const result = await run(projectId, current);
      if (!current()) return denied();
      return toolOk(result, 0);
    } catch (error) {
      if (!current()) return denied();
      if (error instanceof BrowserBrokerError) return toolError(error.code, error.message, 0);
      return toolError('BROWSER_PERFORMANCE_FAILED', 'Browser performance operation failed', 0);
    }
  }

  registry.register({ name: 'browser_performance_start', operation: 'browser/performance/start', version: 1,
    description: 'Record a bounded performance scenario in an in-app browser tab (default 15 seconds, maximum 60). Requires browser/performance/start. Page-changing actions still need their separate real UI approval; recording grants none.',
    schema: z.object({ ...tab, maxMs: z.number().int().min(500).max(60_000).default(15_000), scenarioId: performanceScenarioSchema.optional() }).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/start',
      (projectId, current) => deps.service.start(projectId, args.tabId, args.maxMs, current, context.signal, args.scenarioId)),
  });
  registry.register({ name: 'browser_performance_stop', operation: 'browser/performance/stop', version: 1,
    description: 'Stop or retrieve the pending recording and save its sanitized report. Returns stable reportId and completeness; use browser_performance_report/page for every retained finding and evidence entry. Pending capture is lost if its host or daemon exits before saving.',
    schema: z.object(tab).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/stop',
      (projectId, current) => deps.service.stop(projectId, args.tabId, current, context.signal)),
  });
  registry.register({ name: 'browser_performance_status', operation: 'browser/performance/status', version: 1,
    description: 'Read authoritative pending capture state for this project/tab. Pending means recording or awaiting stop/save, including after the time limit; it does not claim Chromium is still recording.',
    annotations: { readOnlyHint: true }, schema: z.object(tab).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/status',
      (projectId) => deps.service.status(projectId, args.tabId)),
  });
  registry.register({ name: 'browser_performance_compare', operation: 'browser/performance/compare', version: 1,
    description: 'Compare 3–10 distinct baseline and candidate recordings of the same named scenario. Reports observed samples, median/range/variability and differences, with explicit environment/partial/missing-metric warnings. Missing input events are unavailable, never zero. No causal or field-performance claim.',
    annotations: { readOnlyHint: true }, schema: performanceComparisonSchema.safeExtend(project),
    handler: (args, context) => execute(args, context, 'browser/performance/compare',
      (projectId, current) => comparePerformanceReports(deps.service.reports, projectId,
        { baselineReportIds: args.baselineReportIds, candidateReportIds: args.candidateReportIds }, current)),
  });
  registry.register({ name: 'browser_performance_list', operation: 'browser/performance/list', version: 1,
    description: 'List retained performance report summaries for the authorized project. Follow nextCursor; retention is 7 days and 20 MiB total. Report IDs are not authorization credentials.',
    annotations: { readOnlyHint: true }, schema: z.object({ ...project, ...pagination }).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/list',
      (projectId) => deps.service.reports.list(projectId, args.cursor, args.limit)),
  });
  registry.register({ name: 'browser_performance_report', operation: 'browser/performance/report', version: 1,
    description: 'Read saved report summary, coverage, environment and expiry. Incomplete or empty evidence is not a healthy-page verdict. Retrieve all retained details with browser_performance_page; requires current project and browser/performance/report authority.',
    annotations: { readOnlyHint: true }, schema: z.object({ ...project, reportId: z.string().uuid() }).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/report',
      (projectId) => deps.service.reports.describe(projectId, args.reportId)),
  });
  registry.register({ name: 'browser_performance_page', operation: 'browser/performance/page', version: 1,
    description: 'Read a bounded findings or evidence page of an immutable saved report. Follow nextCursor until null for every retained entry, without clipping. Each call rechecks the exact browser/performance/page grant and current project/run authority. omitted counts capture omissions, not missing pagination.',
    annotations: { readOnlyHint: true }, schema: z.object({ ...project, ...pagination, reportId: z.string().uuid(), section: z.enum(['findings', 'evidence']),
      kind: z.enum(['task', 'sample', 'input', 'request', 'lcp', 'layout-shift', 'paint', 'frame', 'style', 'coverage']).optional() }).strict(),
    handler: (args, context) => execute(args, context, 'browser/performance/page',
      (projectId) => deps.service.reports.page(projectId, args.reportId, args.section, args.cursor, args.limit, args.kind)),
  });
}

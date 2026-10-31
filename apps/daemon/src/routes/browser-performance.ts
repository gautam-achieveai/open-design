import type { Express, Request } from 'express';
import { z } from 'zod';
import type { RegisterBrowserControlRoutesDeps } from './browser-control.js';
import { BrowserBrokerError } from '../services/browser-command-broker.js';
import type { BrowserPerformanceService } from '../services/browser-performance.js';
import { comparePerformanceReports, performanceComparisonSchema, performanceScenarioSchema } from '../services/browser-performance-comparison.js';
import type { BrowserPerformanceOverrides } from '../services/browser-performance-overrides.js';

const capture = z.object({ tabId: z.string().min(1).max(8192).optional(), maxMs: z.number().int().min(500).max(60_000).optional(),
  scenarioId: performanceScenarioSchema.optional() }).strict();
const query = z.object({ cursor: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  section: z.enum(['findings', 'evidence']).optional(),
  kind: z.enum(['task', 'sample', 'input', 'request', 'lcp', 'layout-shift', 'paint', 'frame', 'style', 'coverage']).optional() }).strict();

export function registerBrowserPerformanceRoutes(app: Express, ctx: RegisterBrowserControlRoutesDeps,
  service: BrowserPerformanceService, overrides?: BrowserPerformanceOverrides): void {
  const base = '/api/projects/:projectId/browser/performance';
  const local = ctx.http.requireLocalDaemonRequest;

  function route(method: 'get' | 'post', path: string,
    run: (req: Request, projectId: string, current: () => Promise<boolean>, signal: AbortSignal) => unknown | Promise<unknown>) {
    app[method](path, local, async (req, res) => {
      const abort = new AbortController();
      const cancel = () => { if (!res.writableEnded) abort.abort(); };
      req.once('aborted', cancel);
      res.once('close', cancel);
      try {
        const projectId = String(req.params.projectId);
        const current = async () => {
          if (!ctx.projectStore.getProject(ctx.db, projectId)) {
            if (!res.headersSent) ctx.http.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
            return false;
          }
          return ctx.authorizeProjectRequest(req, res, projectId, { mode: 'read' });
        };
        if (!await current()) return;
        const value = await run(req, projectId, current, abort.signal);
        if (!res.writableEnded && await current()) res.json(value);
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof z.ZodError) ctx.http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid browser performance arguments');
        else if (error instanceof BrowserBrokerError) ctx.http.sendApiError(res, error.status, error.code, error.message);
        else ctx.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Browser performance operation failed');
      } finally {
        req.off('aborted', cancel);
        res.off('close', cancel);
      }
    });
  }

  route('post', `${base}/start`, (req, projectId, current, signal) => {
    const args = capture.parse(req.body ?? {});
    return service.start(projectId, args.tabId, args.maxMs ?? 15_000, current, signal, args.scenarioId);
  });
  route('post', `${base}/stop`, (req, projectId, current, signal) => {
    const args = capture.omit({ maxMs: true, scenarioId: true }).parse(req.body ?? {});
    return service.stop(projectId, args.tabId, current, signal);
  });
  route('get', `${base}/status`, (req, projectId) => {
    const args = capture.omit({ maxMs: true, scenarioId: true }).parse(req.query);
    return service.status(projectId, args.tabId);
  });
  route('get', `${base}/reports`, (req, projectId) => {
    const args = query.omit({ section: true, kind: true }).parse(req.query);
    return service.reports.list(projectId, args.cursor, args.limit);
  });
  route('post', `${base}/compare`, (req, projectId, current) =>
    comparePerformanceReports(service.reports, projectId, performanceComparisonSchema.parse(req.body), current));
  if (overrides) route('post', `${base}/override`, (req, projectId, _current, signal) => overrides.request(req, projectId, req.body, signal));
  route('get', `${base}/reports/:reportId`, (req, projectId) => service.reports.describe(projectId, String(req.params.reportId)));
  route('get', `${base}/reports/:reportId/pages`, (req, projectId) => {
    const args = query.parse(req.query);
    return service.reports.page(projectId, String(req.params.reportId), args.section ?? 'findings', args.cursor, args.limit, args.kind);
  });
}

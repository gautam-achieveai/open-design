import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import type {
  AuthorizeProjectRequest,
  AuthorizeProjectToolRequest,
} from '../collab/project-request-authority.js';
import { listLiveArtifactsForTool } from '../services/live-artifact-tool-list.js';
import { createLiveArtifactForTool, updateLiveArtifactForTool, refreshLiveArtifactForTool } from '../services/live-artifact-tool-write.js';

export interface RegisterLiveArtifactRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'auth' | 'liveArtifacts' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  authorizeProjectToolRequest: AuthorizeProjectToolRequest;
}

export function registerLiveArtifactRoutes(app: Express, ctx: RegisterLiveArtifactRoutesDeps) {
  const { db } = ctx;
  const { sendApiError, sendLiveArtifactRouteError, requireLocalDaemonRequest } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { authorizeToolRequest, requestProjectOverride, requestRunOverride } = ctx.auth;
  const { createLiveArtifact, listLiveArtifacts, updateLiveArtifact, refreshLiveArtifact, emitLiveArtifactEvent, emitLiveArtifactRefreshEvent, readLiveArtifactCode, setLiveArtifactCodeHeaders, ensureLiveArtifactPreview, setLiveArtifactPreviewHeaders, getLiveArtifact, listLiveArtifactRefreshLogEntries, deleteLiveArtifact } = ctx.liveArtifacts;
  const { getProject, updateProject } = ctx.projectStore;
  const writeDeps = (res: any) => ({
    projectsRoot: PROJECTS_DIR, createLiveArtifact, updateLiveArtifact, refreshLiveArtifact,
    emitLiveArtifactEvent, emitLiveArtifactRefreshEvent,
    authorizeProjectToolWrite: async (projectId: string) => Boolean(await ctx.authorizeProjectToolRequest(
      res, projectId, { mode: 'write', capability: 'writeFiles' },
    )),
  });
  const authorizeProject = async (
    req: any,
    res: any,
    projectId: string,
    options: { mode: 'read'; allowNavigationQuery?: boolean } | {
      mode: 'write';
      capability: 'writeFiles';
    },
  ) => {
    return ctx.authorizeProjectRequest(req, res, projectId, options);
  };
  app.get('/api/live-artifacts', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(req, res, projectId, { mode: 'read' })) return;

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId,
      });
      res.json({ artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(
        req,
        res,
        projectId,
        { mode: 'read', allowNavigationQuery: true },
      )) return;

      const variant = typeof req.query.variant === 'string' ? req.query.variant : 'rendered';
      if (variant === 'template' || variant === 'rendered-source') {
        const html = await readLiveArtifactCode({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          variant: variant === 'template' ? 'template' : 'rendered',
        });
        setLiveArtifactCodeHeaders(res);
        return res.status(200).send(html);
      }
      if (variant !== 'rendered') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'variant must be rendered, template, or rendered-source');
      }

      const record = await ensureLiveArtifactPreview({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      setLiveArtifactPreviewHeaders(res);
      res.status(200).send(record.html);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(req, res, projectId, { mode: 'read' })) return;

      const record = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/refreshes', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(req, res, projectId, { mode: 'read' })) return;

      const refreshes = await listLiveArtifactRefreshLogEntries({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ refreshes });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/create', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:create');
      if (!toolGrant) return;
      const { projectId, input, templateHtml, provenanceJson, createdByRunId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (requestRunOverride(createdByRunId, toolGrant.runId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'createdByRunId is derived from the tool token', {
          details: { suppliedRunId: createdByRunId },
        });
      }
      const result = await createLiveArtifactForTool(toolGrant, {
        input: input ?? {},
        templateHtml,
        provenanceJson,
      }, writeDeps(res));
      if (!result.ok) return;
      res.json({ artifact: result.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/tools/live-artifacts/list', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:list');
      if (!toolGrant) return;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      const result = await listLiveArtifactsForTool(toolGrant, {
        projectsRoot: PROJECTS_DIR,
        authorizeProjectTool: async (projectId) => Boolean(await ctx.authorizeProjectToolRequest(
          res, projectId, { mode: 'read' },
        )),
        listLiveArtifacts,
      });
      if (!result.ok) return;
      res.json({ artifacts: result.artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/update', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:update');
      if (!toolGrant) return;
      const { projectId, artifactId, input, templateHtml, provenanceJson } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }
      const result = await updateLiveArtifactForTool(toolGrant, {
        artifactId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
      }, writeDeps(res));
      if (!result.ok) return;
      res.json({ artifact: result.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/refresh', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:refresh');
      if (!toolGrant) return;
      const { projectId, artifactId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }
      const result = await refreshLiveArtifactForTool(toolGrant, artifactId, writeDeps(res));
      if (!result.ok) return;
      res.json(result.result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.patch('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(
        req,
        res,
        projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
        input: req.body ?? {},
      });
      emitLiveArtifactEvent({ projectId }, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.delete('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(
        req,
        res,
        projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;

      const existing = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      await deleteLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      updateProject(db, projectId, {});
      emitLiveArtifactEvent({ projectId }, 'deleted', existing.artifact);
      res.json({ ok: true });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.post('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (!await authorizeProject(
        req,
        res,
        projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          onStarted: ({ refreshId }: any) => {
            emitLiveArtifactRefreshEvent({ projectId }, { phase: 'started', artifactId: req.params.artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent({ projectId }, {
          phase: 'failed',
          artifactId: req.params.artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent({ projectId }, {
        phase: 'succeeded',
        artifactId: req.params.artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

}

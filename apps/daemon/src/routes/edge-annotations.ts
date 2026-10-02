import type { Express, Request, Response } from 'express';
import { getConversation, getProject, getWorkspaceProjectByProjectId, isProjectCommentAnchorConversationId } from '../db.js';
import type { ReviewedEdgeChatMessage, EdgeChatMessageResult } from '../services/edge-chat-message.js';
import type { BrowserAnnotationEvidence, BrowserAnnotationPostRequest, ChatImageAttachment, EdgeInspectionRequest, PendingBrowserAnnotation } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { isLoopbackPeerAddress, normalizeLocalAuthority, isLoopbackHostname } from '../http/local-daemon-request.js';
import { EdgeAnnotationBrokerError, type EdgeAnnotationBroker } from '../services/edge-annotation-broker.js';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** Only advertise a directly reachable origin that Clipper's worker accepts. */
function clipperDaemonUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.port === '0' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.href !== url.origin + '/') return null;
    return url.origin;
  } catch { return null; }
}

export interface EdgeAnnotationRouteDeps {
  db: Parameters<typeof getProject>[0];
  broker: EdgeAnnotationBroker;
  getDaemonUrl: () => string;
  appendChatMessage: (input: ReviewedEdgeChatMessage) => EdgeChatMessageResult;
  storePendingAnnotation: (input: ReviewedEdgeChatMessage) => PendingBrowserAnnotation & { replayed: boolean };
  storePendingNativeAnnotation: (input: BrowserAnnotationPostRequest & { projectId: string }) => PendingBrowserAnnotation & { replayed: boolean };
  listPendingAnnotations: (projectId: string, conversationId: string) => PendingBrowserAnnotation[];
  discardPendingAnnotation: (projectId: string, conversationId: string, id: string) => boolean;
  readPendingImage: (projectId: string, conversationId: string, id: string) => Buffer | null;
  readPendingContext: (projectId: string, conversationId: string, id: string) => BrowserAnnotationEvidence | null;
  readClaimedContext: (projectId: string, conversationId: string, messageId: string,
    id: string) => BrowserAnnotationEvidence | null;
  emitPendingAnnotation: (projectId: string, conversationId: string) => unknown;
  postChatMessage: (input: BrowserAnnotationPostRequest & { projectId: string }) => EdgeChatMessageResult;
  readChatImage: (projectId: string, conversationId: string, messageId: string, imageId?: string) =>
    { metadata: ChatImageAttachment; data: Buffer } | null;
  emitChatMessage: (projectId: string, conversationId: string, messageId: string) => unknown;
  authorizeProjectRequest: AuthorizeProjectRequest;
  sendApiError: (res: Response, status: number, code: string, message: string) => unknown;
  verifyWorkspaceContext: (req: Request, projectId: string) => Promise<{
    ok: boolean;
    status?: number;
    code?: string;
    message?: string;
    context?: { workspaceId: string; workspaceMemberId: string };
  }>;
  /** Revalidate a paired member without trusting extension-supplied headers. */
  verifyPairedWorkspace?: (workspace: { workspaceId: string; workspaceMemberId: string }, projectId: string) => Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extensionRequest(req: Request, res: Response): string | null {
  const origin = req.get('origin');
  const host = normalizeLocalAuthority(req.get('host'));
  if (
    typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)
    || !isLoopbackPeerAddress(req.socket.remoteAddress)
    || !host || !isLoopbackHostname(host.hostname)
  ) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'paired local browser extension required' } });
    return null;
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return origin;
}

function failure(error: unknown, res: Response, sendApiError: EdgeAnnotationRouteDeps['sendApiError']): void {
  if (error instanceof EdgeAnnotationBrokerError) {
    const expired = error.code === 'PAIR_EXPIRED' || error.code === 'GRANT_EXPIRED';
    const status = expired ? 410
      : error.code === 'INSPECTION_TIMEOUT' ? 504
      : error.code === 'INSPECTION_UNAVAILABLE' ? 503
      : error.code === 'INSPECTION_BUSY' || error.code === 'IDEMPOTENCY_CONFLICT' ? 409
      : error.code === 'GRANT_NOT_FOUND' || error.code === 'PAIR_NOT_FOUND' ? 404 : 400;
    const code = error.code === 'INSPECTION_TIMEOUT' ? 'TIMEOUT'
      : error.code === 'INSPECTION_UNAVAILABLE' ? 'UNAVAILABLE'
      : error.code === 'INSPECTION_BUSY' ? 'CONFLICT'
      : error.code === 'INVALID_INSPECTION' ? 'BAD_REQUEST' : 'FORBIDDEN';
    sendApiError(res, status, code, error.message);
    return;
  }
  const message = error instanceof Error ? error.message : 'invalid Edge annotation';
  sendApiError(res, message === 'annotation event was already used with different content' ? 409 : 400,
    message === 'annotation event was already used with different content' ? 'CONFLICT' : 'BAD_REQUEST', message);
}

function bearer(req: Request): string {
  const authorization = req.get('authorization') ?? '';
  return /^Bearer [A-Za-z0-9_-]+$/i.test(authorization) ? authorization.slice(7) : '';
}

export function registerEdgeAnnotationRoutes(app: Express, deps: EdgeAnnotationRouteDeps): void {
  const { db, broker, authorizeProjectRequest, sendApiError } = deps;
  const projectPath = '/api/projects/:projectId/edge-annotations';
  app.use(['/api/edge-annotations', projectPath], (req, res, next) => {
    const correlation = req.get('x-od-annotation-correlation');
    if (correlation && /^[a-zA-Z0-9_-]{1,128}$/.test(correlation)) {
      res.setHeader('x-od-annotation-correlation', correlation);
    }
    res.setHeader('x-od-annotation-build', 'annotation-evidence-20260930');
    res.setHeader('Access-Control-Expose-Headers', 'x-od-annotation-correlation, x-od-annotation-build');
    next();
  });
  const destination = (projectId: string, conversationId: string) => {
    const port = Number(process.env.OD_WEB_PORT);
    const chatUrl = Number.isInteger(port) && port > 0 && port <= 65535
      ? `http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`
      : undefined;
    return { projectName: getProject(db, projectId)?.name ?? projectId,
      conversationName: getConversation(db, conversationId)?.title || conversationId,
      ...(chatUrl ? { chatUrl } : {}) };
  };
  const authorize = async (req: Request, res: Response, mode: 'read' | 'write' = 'read') => {
    const projectId = req.params.projectId;
    if (typeof projectId !== 'string' || !getProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return false;
    }
    const binding = getWorkspaceProjectByProjectId(db, projectId);
    if (binding?.workspaceId && mode === 'read'
      && (req.path.endsWith('/edge-image') || /\/pending\/[^/]+\/(image|context)$/.test(req.path)
        || /\/messages\/[^/]+\/annotation-context\/[^/]+$/.test(req.path))) {
      return authorizeProjectRequest(req, res, projectId, { mode: 'read', allowNavigationQuery: true });
    }
    if (binding?.workspaceId) {
      const verified = await deps.verifyWorkspaceContext(req, projectId).catch(() => null);
      if (!verified?.ok || !verified.context || verified.context.workspaceId !== binding.workspaceId) {
        sendApiError(res, verified?.status ?? 403, verified?.code ?? 'FORBIDDEN',
          verified?.message ?? 'workspace identity required for Edge annotations');
        return false;
      }
    }
    return authorizeProjectRequest(req, res, projectId, mode === 'write'
      ? { mode: 'write', capability: 'writeFiles' }
      : { mode: 'read' });
  };

  const pairedWorkspaceAuthorized = async (
    grant: { projectId: string; workspace?: { workspaceId: string; workspaceMemberId: string } },
    res: Response,
  ): Promise<boolean> => {
    const binding = getWorkspaceProjectByProjectId(db, grant.projectId);
    if (!binding?.workspaceId) {
      if (!grant.workspace) return true;
      sendApiError(res, 403, 'FORBIDDEN', 'paired workspace binding changed');
      return false;
    }
    const workspace = grant.workspace;
    if (!workspace || workspace.workspaceId !== binding.workspaceId || !deps.verifyPairedWorkspace
      || !await deps.verifyPairedWorkspace(workspace, grant.projectId).catch(() => false)) {
      sendApiError(res, 403, 'FORBIDDEN', 'paired workspace authority is no longer valid');
      return false;
    }
    const scoped = { get: (name: string) => ({
      'x-od-workspace-id': workspace.workspaceId,
      'x-od-workspace-member-id': workspace.workspaceMemberId,
    } as Record<string, string>)[name.toLowerCase()] } as Request;
    return authorizeProjectRequest(scoped, res, grant.projectId, { mode: 'write', capability: 'writeFiles' });
  };

  app.post(`${projectPath}/pair`, async (req, res) => {
    if (!await authorize(req, res, 'write')) return;
    const binding = getWorkspaceProjectByProjectId(db, req.params.projectId);
    const verified = binding?.workspaceId
      ? await deps.verifyWorkspaceContext(req, req.params.projectId).catch(() => null)
      : null;
    if (binding?.workspaceId && (!verified?.ok || !verified.context
      || verified.context.workspaceId !== binding.workspaceId)) {
      sendApiError(res, 403, 'FORBIDDEN', 'workspace authority is required for pairing');
      return;
    }
    const body = record(req.body);
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const pair = broker.createPendingPair({
        projectId: req.params.projectId,
        conversationId,
        ...(body.extensionId === undefined ? {} : { extensionId: body.extensionId as string }),
        ...(verified?.ok && verified.context ? { workspace: {
          workspaceId: verified.context.workspaceId,
          workspaceMemberId: verified.context.workspaceMemberId,
        } } : {}),
      });
      const daemonUrl = clipperDaemonUrl(deps.getDaemonUrl());
      res.json({ ...pair, ...(daemonUrl ? { connectionUrl: `${daemonUrl}/#od-annotation=${encodeURIComponent(pair.code)}` } : {}) });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.get(projectPath, async (req, res) => {
    if (!await authorize(req, res)) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string'
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 400, 'BAD_REQUEST', 'a project conversation is required');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      grants: broker.listGrants(req.params.projectId).filter((grant) => grant.conversationId === conversationId),
      daemonUrl: clipperDaemonUrl(deps.getDaemonUrl()),
    });
  });

  app.get(`${projectPath}/pending`, async (req, res) => {
    if (!await authorize(req, res)) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ annotations: deps.listPendingAnnotations(req.params.projectId, conversationId) });
  });

  app.delete(`${projectPath}/pending/:annotationId`, async (req, res) => {
    if (!await authorize(req, res, 'write')) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    const discarded = deps.discardPendingAnnotation(req.params.projectId, conversationId, req.params.annotationId);
    if (discarded) deps.emitPendingAnnotation(req.params.projectId, conversationId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ discarded });
  });

  app.get(`${projectPath}/pending/:annotationId/image`, async (req, res) => {
    if (!await authorize(req, res)) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    const image = deps.readPendingImage(req.params.projectId, conversationId, req.params.annotationId);
    if (!image) {
      sendApiError(res, 404, 'BAD_REQUEST', 'annotation image not found');
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/png').send(image);
  });

  app.get(`${projectPath}/pending/:annotationId/context`, async (req, res) => {
    if (!await authorize(req, res)) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    const context = deps.readPendingContext(req.params.projectId, conversationId, req.params.annotationId);
    if (!context) {
      sendApiError(res, 404, 'BAD_REQUEST', 'annotation context not found');
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="annotation-context.json"');
    res.json(context);
  });

  app.get('/api/projects/:projectId/conversations/:conversationId/messages/:messageId/annotation-context/:annotationId',
    async (req, res) => {
      if (!await authorize(req, res)) return;
      const { projectId, conversationId, messageId, annotationId } = req.params;
      if (isProjectCommentAnchorConversationId(conversationId)
        || getConversation(db, conversationId)?.projectId !== projectId) {
        sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
        return;
      }
      const context = deps.readClaimedContext(projectId, conversationId, messageId, annotationId);
      if (!context) {
        sendApiError(res, 404, 'BAD_REQUEST', 'annotation context not found');
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline; filename="annotation-context.json"');
      res.json(context);
    });

  app.post(`${projectPath}/draft`, async (req, res) => {
    if (!await authorize(req, res, 'write')) return;
    const body = record(req.body);
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    try {
      const url = typeof body.url === 'string' && body.url.length <= 8192 ? new URL(body.url) : null;
      if (!url || !['http:', 'https:', 'file:'].includes(url.protocol)) {
        sendApiError(res, 400, 'BAD_REQUEST', 'a browser page URL is required');
        return;
      }
      const result = deps.storePendingNativeAnnotation({
        projectId: req.params.projectId,
        conversationId,
        url: url.href,
        note: body.note as string,
        eventId: body.eventId as string,
        ...(body.screenshotDataUrl === undefined ? {} : { screenshotDataUrl: body.screenshotDataUrl as string }),
        ...(body.target === undefined ? {} : { target: body.target as NonNullable<BrowserAnnotationPostRequest['target']> }),
        ...(typeof body.title === 'string' ? { title: body.title.slice(0, 512) } : {}),
      });
      if (!result.replayed) deps.emitPendingAnnotation(result.projectId, result.conversationId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post(`${projectPath}/post`, async (req, res) => {
    if (!await authorize(req, res, 'write')) return;
    const body = record(req.body);
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    try {
      const url = typeof body.url === 'string' && body.url.length <= 8192 ? new URL(body.url) : null;
      if (!url || !['http:', 'https:', 'file:'].includes(url.protocol)) {
        sendApiError(res, 400, 'BAD_REQUEST', 'a browser page URL is required');
        return;
      }
      const result = deps.postChatMessage({
        projectId: req.params.projectId,
        conversationId,
        url: url.href,
        note: body.note as string,
        eventId: body.eventId as string,
        ...(body.screenshotDataUrl === undefined ? {} : { screenshotDataUrl: body.screenshotDataUrl as string }),
        ...(body.target === undefined ? {} : { target: body.target as NonNullable<BrowserAnnotationPostRequest['target']> }),
        ...(typeof body.title === 'string' ? { title: body.title.slice(0, 512) } : {}),
      });
      if (!result.replayed) deps.emitChatMessage(result.projectId, result.conversationId, result.messageId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.get('/api/projects/:projectId/conversations/:conversationId/messages/:messageId/edge-image', async (req, res) => {
    if (!await authorize(req, res)) return;
    const { projectId, conversationId, messageId } = req.params;
    if (isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation not found');
      return;
    }
    const imageId = req.query.imageId;
    if (imageId !== undefined && (typeof imageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(imageId))) {
      sendApiError(res, 400, 'BAD_REQUEST', 'image ID is invalid');
      return;
    }
    const image = deps.readChatImage(projectId, conversationId, messageId, imageId);
    if (!image) {
      sendApiError(res, 404, 'BAD_REQUEST', 'chat image not found');
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/png').send(image.data);
  });

  app.post(`${projectPath}/inspect`, async (req, res) => {
    if (req.get('origin')?.startsWith('chrome-extension://')) {
      sendApiError(res, 403, 'FORBIDDEN', 'inspection requests require project authority');
      return;
    }
    if (!await authorize(req, res, 'write')) return;
    const body = record(req.body);
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || isProjectCommentAnchorConversationId(conversationId)
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 404, 'BAD_REQUEST', 'conversation does not belong to project');
      return;
    }
    const grant = broker.listGrants(req.params.projectId).find((item) => item.grantId === body.grantId
      && item.conversationId === conversationId);
    if (!grant) {
      sendApiError(res, 404, 'FORBIDDEN', 'paired grant not found in this conversation');
      return;
    }
    if (!await pairedWorkspaceAuthorized(grant, res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const { requestId, url, promise } = broker.requestInspection({
        ...body, projectId: req.params.projectId,
      } as EdgeInspectionRequest & { projectId: string });
      const onDisconnect = () => broker.cancelInspection(grant.grantId, requestId);
      res.once('close', onDisconnect);
      try {
        const result = await promise;
        if (res.destroyed || res.writableEnded) return;
        if (!await pairedWorkspaceAuthorized(grant, res)) return;
        if (res.destroyed || res.writableEnded) return;
        if (!await authorize(req, res, 'write')) return;
        if (res.destroyed || res.writableEnded) return;
        if (getConversation(db, conversationId)?.projectId !== grant.projectId
          || !broker.inspectionStillPaired(grant.projectId, grant.grantId, conversationId,
            grant.documentId, url)) {
          sendApiError(res, 403, 'FORBIDDEN', 'paired document or conversation changed');
          return;
        }
        res.json(result);
      } finally { res.off('close', onDisconnect); }
    } catch (error) { if (!res.destroyed && !res.writableEnded) failure(error, res, sendApiError); }
  });

  app.delete(`${projectPath}/:grantId`, async (req, res) => {
    if (!await authorize(req, res, 'write')) return;
    const conversationId = req.query.conversationId;
    if (typeof conversationId !== 'string'
      || getConversation(db, conversationId)?.projectId !== req.params.projectId) {
      sendApiError(res, 400, 'BAD_REQUEST', 'a project conversation is required');
      return;
    }
    const grant = broker.listGrants(req.params.projectId).find((item) => item.grantId === req.params.grantId);
    res.json({ revoked: grant?.conversationId === conversationId
      ? broker.revoke(req.params.projectId, req.params.grantId) : false });
  });

  // The global /api origin middleware admits ONLY these paired extension
  // operations. Browser code never receives a project mutation capability merely
  // because it runs on the same machine as the daemon.
  app.options('/api/edge-annotations/:operation', (req, res) => {
    if (!['redeem', 'status', 'submit', 'revoke'].includes(req.params.operation) || !extensionRequest(req, res)) return;
    res.sendStatus(204);
  });
  app.options('/api/edge-annotations/inspect/:operation', (req, res) => {
    if (!['poll', 'result'].includes(req.params.operation) || !extensionRequest(req, res)) return;
    res.sendStatus(204);
  });

  app.post('/api/edge-annotations/redeem', (req, res) => {
    const origin = extensionRequest(req, res);
    if (!origin) return;
    const body = record(req.body);
    try {
      const { grant, token } = broker.redeemPair({
        code: body.code as string,
        tabId: body.tabId as number,
        documentId: body.documentId as string,
        origin: body.origin as string,
        extensionOrigin: origin,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ grant, token, ...destination(grant.projectId, grant.conversationId) });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post('/api/edge-annotations/status', (req, res) => {
    const origin = extensionRequest(req, res);
    if (!origin) return;
    const body = record(req.body);
    try {
      res.setHeader('Cache-Control', 'no-store');
      const grant = broker.requireGrant({
        grantId: body.grantId as string,
        token: bearer(req),
        tabId: body.tabId as number,
        documentId: body.documentId as string,
        url: body.url as string,
        extensionOrigin: origin,
      }, { rebindDocument: true });
      res.json({ grant, ...destination(grant.projectId, grant.conversationId) });
    } catch (error) { failure(error, res, sendApiError); }
  });

  const inspectionWorkerGrant = async (req: Request, res: Response) => {
    const origin = extensionRequest(req, res);
    if (!origin) return null;
    const body = record(req.body);
    const grant = broker.requireGrant({
      grantId: body.grantId as string,
      token: bearer(req),
      tabId: body.tabId as number,
      documentId: body.documentId as string,
      url: body.url as string,
      extensionOrigin: origin,
    });
    if (grant.projectId !== body.projectId || !getProject(db, grant.projectId)
      || isProjectCommentAnchorConversationId(grant.conversationId)
      || getConversation(db, grant.conversationId)?.projectId !== grant.projectId) {
      sendApiError(res, 404, 'FORBIDDEN', 'paired conversation is no longer available');
      return null;
    }
    if (!await pairedWorkspaceAuthorized(grant, res)) return null;
    return { grant, origin, body };
  };

  app.post('/api/edge-annotations/inspect/poll', async (req, res) => {
    try {
      const authenticated = await inspectionWorkerGrant(req, res);
      if (!authenticated) return;
      const { grant, origin, body } = authenticated;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, request: broker.pollInspection({
        projectId: grant.projectId, grantId: grant.grantId,
        token: bearer(req), extensionOrigin: origin,
        tabId: body.tabId as number, documentId: body.documentId as string,
        url: body.url as string,
      }) });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post('/api/edge-annotations/inspect/result', async (req, res) => {
    try {
      const authenticated = await inspectionWorkerGrant(req, res);
      if (!authenticated) return;
      const { grant, origin, body } = authenticated;
      if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId)) {
        sendApiError(res, 400, 'BAD_REQUEST', 'inspection request ID is invalid');
        return;
      }
      broker.submitInspectionResult({
        projectId: grant.projectId, grantId: grant.grantId,
        token: bearer(req), extensionOrigin: origin,
        tabId: body.tabId as number, documentId: body.documentId as string,
        url: body.url as string, requestId: body.requestId,
        ok: body.ok as boolean, result: body.result, error: body.error,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post('/api/edge-annotations/revoke', (req, res) => {
    const origin = extensionRequest(req, res);
    if (!origin) return;
    const body = record(req.body);
    try {
      const grant = broker.requireGrant({
        grantId: body.grantId as string,
        token: bearer(req),
        tabId: body.tabId as number,
        documentId: body.documentId as string,
        url: body.url as string,
        extensionOrigin: origin,
      });
      res.json({ revoked: broker.revoke(grant.projectId, grant.grantId) });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post('/api/edge-annotations/submit', async (req, res) => {
    const origin = extensionRequest(req, res);
    if (!origin) return;
    const body = record(req.body);
    try {
      const submission = broker.submit({
        ...body,
        token: bearer(req),
        extensionOrigin: origin,
      } as Parameters<typeof broker.submit>[0]);
      const { grant } = submission;
      const project = getProject(db, grant.projectId);
      const conversation = getConversation(db, grant.conversationId);
      if (!project || !conversation || conversation.projectId !== grant.projectId
        || isProjectCommentAnchorConversationId(grant.conversationId)) {
        sendApiError(res, 404, 'BAD_REQUEST', 'paired conversation no longer exists');
        return;
      }
      const binding = getWorkspaceProjectByProjectId(db, grant.projectId);
      if (binding?.workspaceId) {
        const workspace = grant.workspace;
        if (!workspace || workspace.workspaceId !== binding.workspaceId || !deps.verifyPairedWorkspace
          || !await deps.verifyPairedWorkspace(workspace, grant.projectId).catch(() => false)) {
          sendApiError(res, 403, 'FORBIDDEN', 'paired workspace authority is no longer valid');
          return;
        }
        // Apply the same creator/single-writer gate as ordinary chat messages.
        const scoped = { get: (name: string) => ({
          'x-od-workspace-id': workspace.workspaceId,
          'x-od-workspace-member-id': workspace.workspaceMemberId,
        } as Record<string, string>)[name.toLowerCase()] } as Request;
        if (!await authorizeProjectRequest(scoped, res, grant.projectId,
          { mode: 'write', capability: 'writeFiles' })) return;
      } else if (grant.workspace) {
        sendApiError(res, 403, 'FORBIDDEN', 'paired workspace binding changed');
        return;
      }
      const result = deps.storePendingAnnotation(submission);
      if (!result.replayed) deps.emitPendingAnnotation(result.projectId, result.conversationId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...result, ...destination(result.projectId, result.conversationId) });
    } catch (error) { failure(error, res, sendApiError); }
  });
}

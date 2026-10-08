import type { Express, Request, Response } from 'express';
import { getConversation, getProject, getWorkspaceProjectByProjectId, isProjectCommentAnchorConversationId } from '../db.js';
import type { ReviewedEdgeChatMessage, EdgeChatMessageResult } from '../services/edge-chat-message.js';
import {
  BROWSER_ANNOTATION_SCREENSHOT_DIR,
  browserCommentFileKey,
  type BrowserAnnotationEvidence,
  type BrowserAnnotationPostRequest,
  type ChatImageAttachment,
  type EdgeAnnotationTarget,
  type EdgeInspectionRequest,
  type PendingBrowserAnnotation,
  type PreviewComment,
} from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { isLoopbackPeerAddress, normalizeLocalAuthority, isLoopbackHostname } from '../http/local-daemon-request.js';
import {
  EdgeAnnotationBrokerError,
  validateEdgeAnnotationScreenshot,
  validateEdgeAnnotationTarget,
  type EdgeAnnotationBroker,
} from '../services/edge-annotation-broker.js';
import { EDGE_ANNOTATION_EXTENSION_OPERATIONS } from '../origin-validation.js';

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
  /**
   * Grant-scoped pin storage (`comment-list` / `comment-upsert` /
   * `comment-delete`). Pins are ordinary `PreviewComment` rows keyed by the
   * reviewed page URL, so the paired extension and the in-app browser share one
   * numbering space. Routes answer 503 when the host did not wire this.
   *
   * `workspace` is the member the grant was paired as. The host decides
   * whether that member relays the write to the Team, by the same rule as the
   * project comment routes; the routes themselves never relay.
   */
  comments?: {
    list: (projectId: string, conversationId: string) => PreviewComment[];
    get: (projectId: string, conversationId: string, id: string) => PreviewComment | null;
    upsert: (
      projectId: string,
      conversationId: string,
      input: Record<string, unknown>,
      workspace?: PairedWorkspace,
    ) => PreviewComment | null | Promise<PreviewComment | null>;
    remove: (
      projectId: string,
      conversationId: string,
      id: string,
      workspace?: PairedWorkspace,
    ) => boolean | Promise<boolean>;
    /** Persist a validated PNG and return its project-relative path. */
    storeScreenshot: (projectId: string, data: Buffer) => Promise<string>;
    /** Best-effort removal of a PNG no row references any more (replaced crop, refused write). */
    discardScreenshot?: (projectId: string, path: string) => Promise<void>;
    emitChanged: (projectId: string) => unknown;
  };
}

type PairedWorkspace = { workspaceId: string; workspaceMemberId: string };

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
      if (!url || (!['http:', 'https:', 'file:'].includes(url.protocol) && url.href !== 'about:blank')) {
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
      if (!url || (!['http:', 'https:', 'file:'].includes(url.protocol) && url.href !== 'about:blank')) {
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
  // Same operation list as the server's origin-guard pass-through
  // (`isEdgeAnnotationExtensionRequest`): a preflight here for an operation
  // the guard blocks would promise a POST that can never arrive.
  app.options('/api/edge-annotations/:operation', (req, res, next) => {
    // An unlisted operation is not ours to answer: fall through to the 404
    // instead of holding the request open.
    if (!EDGE_ANNOTATION_EXTENSION_OPERATIONS.includes(req.params.operation)) { next(); return; }
    if (!extensionRequest(req, res)) return;
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

  // ---- Grant-scoped pins (numbered PreviewComment rows on the paired page) ----
  //
  // One scope check for all three routes: the grant proof re-verifies the
  // paired tab/document and the reviewed URL, the conversation is the one
  // fixed at pairing, and the page key is derived here — the extension never
  // names a `filePath`. Writes carry the paired member to the host store,
  // which relays them to the Team by the same rule as every other pin
  // (`teamCommentRelayAllowed` in routes/project/comments.ts).
  const pinScope = async (req: Request, res: Response): Promise<{
    grant: ReturnType<EdgeAnnotationBroker['requireGrant']>;
    filePath: string;
    body: Record<string, unknown>;
  } | null> => {
    const origin = extensionRequest(req, res);
    if (!origin) return null;
    if (!deps.comments) {
      sendApiError(res, 503, 'UNAVAILABLE', 'browser pins are not available on this daemon');
      return null;
    }
    const body = record(req.body);
    const grant = broker.requireGrant({
      grantId: body.grantId as string,
      token: bearer(req),
      tabId: body.tabId as number,
      documentId: body.documentId as string,
      url: body.url as string,
      extensionOrigin: origin,
    });
    const project = getProject(db, grant.projectId);
    const conversation = getConversation(db, grant.conversationId);
    if (!project || !conversation || conversation.projectId !== grant.projectId
      || isProjectCommentAnchorConversationId(grant.conversationId)) {
      sendApiError(res, 404, 'BAD_REQUEST', 'paired conversation no longer exists');
      return null;
    }
    if (!await pairedWorkspaceAuthorized(grant, res)) return null;
    const filePath = browserCommentFileKey(body.url as string);
    if (!filePath) {
      sendApiError(res, 400, 'BAD_REQUEST', 'paired page must be an http(s) URL');
      return null;
    }
    res.setHeader('Cache-Control', 'no-store');
    return { grant, filePath, body };
  };
  // The page's pins, as the in-app browser and the Preview canvas see them:
  // `open` rows on this key. A sent or resolved row keeps its number but is
  // neither listed nor reachable for edit/delete from the page.
  const onPage = (comment: PreviewComment | null | undefined, filePath: string): comment is PreviewComment =>
    !!comment && comment.filePath === filePath && comment.status === 'open';
  // `(grant, eventId)` → comment id, so a Save retried after a lost response
  // returns the row already written instead of inserting a second number.
  // A grant lives for one pairing, so a small bounded window is enough.
  const pinReplay = new Map<string, string>();
  const PIN_REPLAY_LIMIT = 1000;
  const replayKey = (grantId: string, eventId: unknown): string | null =>
    typeof eventId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(eventId) ? `${grantId}\u0000${eventId}` : null;
  const rememberReplay = (key: string, id: string): void => {
    if (pinReplay.size >= PIN_REPLAY_LIMIT) pinReplay.delete(pinReplay.keys().next().value as string);
    pinReplay.set(key, id);
  };
  const isPinScreenshot = (path: string): boolean => path.startsWith(`${BROWSER_ANNOTATION_SCREENSHOT_DIR}/`);
  const discardScreenshot = async (projectId: string, path: string): Promise<void> => {
    try { await deps.comments?.discardScreenshot?.(projectId, path); } catch { /* orphan file only; the row is right */ }
  };

  app.post('/api/edge-annotations/comment-list', async (req, res) => {
    try {
      const scope = await pinScope(req, res);
      if (!scope) return;
      const comments = deps.comments!.list(scope.grant.projectId, scope.grant.conversationId)
        .filter((comment) => onPage(comment, scope.filePath));
      res.json({ filePath: scope.filePath, comments });
    } catch (error) { failure(error, res, sendApiError); }
  });

  app.post('/api/edge-annotations/comment-upsert', async (req, res) => {
    // A PNG written for this request that no row references yet. Cleared once
    // the row owns it, discarded on any exit before that (refused or thrown).
    let orphan: { projectId: string; path: string } | null = null;
    try {
      const scope = await pinScope(req, res);
      if (!scope) return;
      const { grant, filePath, body } = scope;
      const store = deps.comments!;
      const requestedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      const existing = requestedId ? store.get(grant.projectId, grant.conversationId, requestedId) : null;
      if (requestedId && !onPage(existing, filePath)) {
        sendApiError(res, 404, 'NOT_FOUND', 'pin not found on the paired page');
        return;
      }
      const replay = replayKey(grant.grantId, body.eventId);
      const replayedId = replay ? pinReplay.get(replay) : undefined;
      const replayed = replayedId ? store.get(grant.projectId, grant.conversationId, replayedId) : null;
      if (onPage(replayed, filePath)) {
        res.json({ comment: replayed, replayed: true });
        return;
      }
      const target = validateEdgeAnnotationTarget(body.target as EdgeAnnotationTarget);
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      // A fresh crop replaces the crop stored for this pin (one screenshot per
      // pin, the current one); anything else attached is kept.
      let attachments = [...(existing?.attachments ?? [])];
      let storedPath: string | null = null;
      let replacedPaths: string[] = [];
      if (typeof body.screenshotDataUrl === 'string' && body.screenshotDataUrl) {
        const { data } = validateEdgeAnnotationScreenshot(body.screenshotDataUrl);
        storedPath = await store.storeScreenshot(grant.projectId, data);
        orphan = { projectId: grant.projectId, path: storedPath };
        replacedPaths = attachments.map((entry) => entry.path).filter(isPinScreenshot);
        attachments = [...attachments.filter((entry) => !isPinScreenshot(entry.path)),
          { path: storedPath, name: storedPath.split('/').pop() ?? storedPath }];
      }
      const comment = await store.upsert(grant.projectId, grant.conversationId, {
        ...(requestedId ? { id: requestedId } : {}),
        target: {
          filePath,
          elementId: target.elementId || target.selector,
          selector: target.selector,
          label: target.label,
          text: target.text,
          position: target.position,
          htmlHint: target.htmlHint,
          ...(target.style ? { style: target.style } : {}),
          ...(target.ancestors ? { ancestors: target.ancestors } : {}),
          metadata: { source: 'clipper', ...(target.scope ? { scope: target.scope } : {}) },
        },
        note,
        attachments,
        ...(grant.workspace ? { authorMemberId: grant.workspace.workspaceMemberId } : {}),
      }, grant.workspace);
      if (!comment) {
        if (orphan) await discardScreenshot(orphan.projectId, orphan.path);
        orphan = null;
        sendApiError(res, 400, 'BAD_REQUEST', 'pin could not be saved');
        return;
      }
      orphan = null; // the row owns the PNG now
      for (const path of replacedPaths) await discardScreenshot(grant.projectId, path);
      if (replay) rememberReplay(replay, comment.id);
      store.emitChanged(grant.projectId);
      res.json({ comment });
    } catch (error) {
      if (orphan) await discardScreenshot(orphan.projectId, orphan.path);
      failure(error, res, sendApiError);
    }
  });

  app.post('/api/edge-annotations/comment-delete', async (req, res) => {
    try {
      const scope = await pinScope(req, res);
      if (!scope) return;
      const { grant, filePath, body } = scope;
      const store = deps.comments!;
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const existing = id ? store.get(grant.projectId, grant.conversationId, id) : null;
      if (!onPage(existing, filePath)) {
        sendApiError(res, 404, 'NOT_FOUND', 'pin not found on the paired page');
        return;
      }
      const deleted = await store.remove(grant.projectId, grant.conversationId, id, grant.workspace);
      if (deleted) {
        // The row owned its crop; nothing references the PNG once the row is gone.
        for (const entry of existing.attachments ?? []) {
          if (isPinScreenshot(entry.path)) await discardScreenshot(grant.projectId, entry.path);
        }
        store.emitChanged(grant.projectId);
      }
      res.json({ deleted });
    } catch (error) { failure(error, res, sendApiError); }
  });
}

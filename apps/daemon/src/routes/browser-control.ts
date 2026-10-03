import type { Express, NextFunction, Request, Response } from 'express';
import type {
  ApiErrorCode,
  BrowserElementTarget,
  BrowserOperationRequest,
  BrowserOperationResult,
  RegisterBrowserTabRequest,
  SubmitBrowserCommandResultRequest,
} from '@open-design/contracts';
import { API_ERROR_CODES, isBrowserOperationName, isBrowserViewportId, isBrowserStylePatch, isBrowserStyleInspection } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import type { BrowserCommandBroker } from '../services/browser-command-broker.js';
import { BrowserBrokerError } from '../services/browser-command-broker.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterBrowserControlRoutesDeps
  extends RouteDeps<'db' | 'http' | 'projectStore' | 'browserControl'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredParam(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || !value) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} route parameter is required`, 400);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string, maxLength = 8_192): string {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value) throw new BrowserBrokerError('BAD_REQUEST', `${key} is required`, 400);
  if (value.length > maxLength) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} is too long`, 400);
  }
  return value;
}

function requiredText(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = typeof body[key] === 'string' ? body[key] : '';
  if (!value) throw new BrowserBrokerError('BAD_REQUEST', `${key} is required`, 400);
  if (value.length > maxLength) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} is too long`, 400);
  }
  return value;
}

function optionalFiniteNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} must be a finite number`, 400);
  }
  if (options.min !== undefined && value < options.min) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} must be at least ${options.min}`, 400);
  }
  if (options.max !== undefined && value > options.max) {
    throw new BrowserBrokerError('BAD_REQUEST', `${key} must be at most ${options.max}`, 400);
  }
  return value;
}

function parseTarget(raw: unknown): BrowserElementTarget {
  const target = objectValue(raw);
  if (!target) throw new BrowserBrokerError('BAD_REQUEST', 'target is required', 400);
  if (typeof target.selector === 'string' && target.selector.trim()) {
    return { selector: target.selector.trim() };
  }
  throw new BrowserBrokerError('BAD_REQUEST', 'target.selector is required', 400);
}

function requireApproval(body: Record<string, unknown>): true {
  if (body.approved !== true) {
    throw new BrowserBrokerError(
      'FORBIDDEN',
      'command.approved must be true for consequential browser operations',
      403,
    );
  }
  return true;
}

function parseOperation(raw: unknown): BrowserOperationRequest {
  const body = objectValue(raw);
  if (!body || !isBrowserOperationName(body.operation)) {
    throw new BrowserBrokerError('BAD_REQUEST', 'command.operation is invalid', 400);
  }
  switch (body.operation) {
    case 'style': {
      const approved = requireApproval(body);
      const target = parseTarget(body.target);
      if (target.selector.length > 8_192 || !isBrowserStylePatch(body.styles)) {
        throw new BrowserBrokerError('BAD_REQUEST', 'styles must be a nonempty bounded object of allowed style strings', 400);
      }
      return { operation: 'style', approved, target, styles: body.styles };
    }
    case 'viewport':
      if (!isBrowserViewportId(body.preset)) throw new BrowserBrokerError('BAD_REQUEST', 'preset must be desktop, tablet, or mobile', 400);
      return { operation: 'viewport', preset: body.preset };
    case 'snapshot':
      return { operation: 'snapshot' };
    case 'inspect':
      return {
        operation: 'inspect',
        target: parseTarget(body.target),
      };
    case 'screenshot': {
      const quality = optionalFiniteNumber(body, 'quality', { min: 0, max: 100 });
      const format = body.format;
      if (format !== undefined && format !== 'png' && format !== 'jpeg') {
        throw new BrowserBrokerError('BAD_REQUEST', 'format must be png or jpeg', 400);
      }
      return {
        operation: 'screenshot',
        ...(typeof body.fullPage === 'boolean' ? { fullPage: body.fullPage } : {}),
        ...(format ? { format } : {}),
        ...(quality !== undefined ? { quality } : {}),
      };
    }
    case 'click': {
      const approved = requireApproval(body);
      const button = body.button;
      if (button !== undefined && button !== 'left' && button !== 'middle' && button !== 'right') {
        throw new BrowserBrokerError('BAD_REQUEST', 'button must be left, middle, or right', 400);
      }
      const clickCount = optionalFiniteNumber(body, 'clickCount', { min: 1, max: 3 });
      return {
        operation: 'click',
        approved,
        target: parseTarget(body.target),
        ...(button ? { button } : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
      };
    }
    case 'type': {
      const approved = requireApproval(body);
      return {
        operation: 'type',
        approved,
        target: parseTarget(body.target),
        text: requiredText(body, 'text', 1_000_000),
        ...(typeof body.clear === 'boolean' ? { clear: body.clear } : {}),
      };
    }
    case 'scroll': {
      const approved = requireApproval(body);
      return {
        operation: 'scroll',
        approved,
        deltaX: optionalFiniteNumber(body, 'deltaX') ?? 0,
        deltaY: optionalFiniteNumber(body, 'deltaY') ?? 0,
        ...(body.target === undefined ? {} : { target: parseTarget(body.target) }),
      };
    }
    case 'navigate': {
      const approved = requireApproval(body);
      const url = requiredString(body, 'url');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BrowserBrokerError('BAD_REQUEST', 'url must be absolute', 400);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BrowserBrokerError('BAD_REQUEST', 'url must use http or https', 400);
      }
      const waitUntil = body.waitUntil;
      if (
        waitUntil !== undefined
        && waitUntil !== 'load'
        && waitUntil !== 'domcontentloaded'
        && waitUntil !== 'networkidle'
      ) {
        throw new BrowserBrokerError('BAD_REQUEST', 'waitUntil is invalid', 400);
      }
      return {
        operation: 'navigate',
        approved,
        url: parsed.toString(),
        ...(waitUntil ? { waitUntil } : {}),
      };
    }
    case 'console': {
      const level = body.level;
      if (
        level !== undefined
        && level !== 'all'
        && level !== 'debug'
        && level !== 'info'
        && level !== 'warning'
        && level !== 'error'
      ) {
        throw new BrowserBrokerError('BAD_REQUEST', 'console level is invalid', 400);
      }
      const limit = optionalFiniteNumber(body, 'limit', { min: 1, max: 1_000 });
      return { operation: 'console', ...(level ? { level } : {}), ...(limit ? { limit } : {}) };
    }
    case 'network-list': {
      const limit = optionalFiniteNumber(body, 'limit', { min: 1, max: 1_000 });
      return {
        operation: 'network-list',
        ...(typeof body.resourceType === 'string' && body.resourceType.trim()
          ? { resourceType: body.resourceType.trim() }
          : {}),
        ...(limit ? { limit } : {}),
      };
    }
    case 'network-get':
      return { operation: 'network-get', requestId: requiredString(body, 'requestId') };
    case 'network-failures': {
      const limit = optionalFiniteNumber(body, 'limit', { min: 1, max: 1_000 });
      return { operation: 'network-failures', ...(limit ? { limit } : {}) };
    }
  }
}

function parseResult(raw: unknown): BrowserOperationResult {
  const value = objectValue(raw);
  if (!value || !isBrowserOperationName(value.operation)) {
    throw new BrowserBrokerError('BAD_REQUEST', 'result.operation is invalid', 400);
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new BrowserBrokerError('BAD_REQUEST', 'result must be JSON-safe', 400);
  }
  switch (value.operation) {
    case 'style':
      if (value.applied === true && isBrowserStyleInspection(value.inspection)) return value as unknown as BrowserOperationResult;
      break;
    case 'viewport':
      if (isBrowserViewportId(value.preset) && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
        && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0) return value as unknown as BrowserOperationResult;
      break;
    case 'snapshot':
      if (value.snapshot === undefined) break;
      return value as unknown as BrowserOperationResult;
    case 'inspect':
      if (value.inspection === undefined) break;
      return value as unknown as BrowserOperationResult;
    case 'screenshot':
      if (
        typeof value.data === 'string'
        && (value.mimeType === 'image/png' || value.mimeType === 'image/jpeg')
      ) {
        return value as unknown as BrowserOperationResult;
      }
      break;
    case 'click':
      if (value.clicked === true) return value as unknown as BrowserOperationResult;
      break;
    case 'type':
      if (value.typed === true) return value as unknown as BrowserOperationResult;
      break;
    case 'scroll':
      if (value.scrolled === true) return value as unknown as BrowserOperationResult;
      break;
    case 'navigate':
      if (typeof value.url === 'string') return value as unknown as BrowserOperationResult;
      break;
    case 'console':
    case 'network-list':
    case 'network-failures':
      if (Array.isArray(value.entries)) return value as unknown as BrowserOperationResult;
      break;
    case 'network-get':
      if (value.entry !== undefined) return value as unknown as BrowserOperationResult;
      break;
  }
  throw new BrowserBrokerError(
    'BAD_REQUEST',
    `result payload is invalid for ${value.operation}`,
    400,
  );
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string'
    && (API_ERROR_CODES as readonly string[]).includes(value);
}

function parseTimeout(body: Record<string, unknown>, fallback: number): number {
  return optionalFiniteNumber(body, 'timeoutMs', { min: 0, max: 60_000 }) ?? fallback;
}

function handleError(
  error: unknown,
  res: Response,
  sendApiError: RegisterBrowserControlRoutesDeps['http']['sendApiError'],
): void {
  if (res.writableEnded) return;
  if (error instanceof BrowserBrokerError) {
    sendApiError(res, error.status, error.code, error.message, {
      ...(error.details === undefined ? {} : { details: error.details }),
      retryable: error.code === 'BROWSER_COMMAND_TIMEOUT',
    });
    return;
  }
  sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

export function registerBrowserControlRoutes(
  app: Express,
  ctx: RegisterBrowserControlRoutesDeps,
): void {
  const { browserControl: broker, db } = ctx;
  const { getProject } = ctx.projectStore;
  const { requireLocalDaemonRequest, sendApiError } = ctx.http;

  const authorize = async (
    req: Request,
    res: Response,
    mode: 'read' | 'write' = 'read',
  ): Promise<boolean> => {
    const projectId = requiredParam(req, 'projectId');
    if (!getProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return false;
    }
    return await ctx.authorizeProjectRequest(
      req,
      res,
      projectId,
      mode === 'read'
        ? { mode: 'read' }
        : { mode: 'write', capability: 'writeFiles' },
    );
  };

  const local = (req: Request, res: Response, next: NextFunction) =>
    requireLocalDaemonRequest(req, res, next);

  app.get('/api/projects/:projectId/browser/tabs', local, async (req, res) => {
    if (!await authorize(req, res)) return;
    try {
      res.json(broker.listTabs(requiredParam(req, 'projectId')));
    } catch (error) {
      handleError(error, res, sendApiError);
    }
  });

  app.put('/api/projects/:projectId/browser/active-tab', local, async (req, res) => {
    if (!await authorize(req, res)) return;
    try {
      const body = objectValue(req.body) ?? {};
      const tabId = body.tabId === null ? null : requiredString(body, 'tabId');
      res.json({ activeTabId: broker.selectActiveTab(requiredParam(req, 'projectId'), tabId) });
    } catch (error) {
      handleError(error, res, sendApiError);
    }
  });

  app.post('/api/projects/:projectId/browser/tabs/register', local, async (req, res) => {
    if (!await authorize(req, res)) return;
    try {
      const body = objectValue(req.body) ?? {};
      const projectId = requiredString(body, 'projectId');
      if (projectId !== requiredParam(req, 'projectId')) {
        throw new BrowserBrokerError('BAD_REQUEST', 'projectId must match the route', 400);
      }
      const input: RegisterBrowserTabRequest = {
        projectId,
        tabId: requiredString(body, 'tabId'),
        url: requiredString(body, 'url'),
        title: typeof body.title === 'string' ? body.title.slice(0, 4_096) : '',
        ...(typeof body.leaseId === 'string' && body.leaseId ? { leaseId: body.leaseId } : {}),
      };
      res.json(broker.registerTab(input));
    } catch (error) {
      handleError(error, res, sendApiError);
    }
  });

  app.post('/api/projects/:projectId/browser/tabs/:tabId/lease', local, async (req, res) => {
    if (!await authorize(req, res)) return;
    try {
      const body = objectValue(req.body) ?? {};
      res.json(broker.renewLease(requiredParam(req, 'projectId'), requiredParam(req, 'tabId'), {
        leaseId: requiredString(body, 'leaseId'),
        url: requiredString(body, 'url'),
        title: typeof body.title === 'string' ? body.title.slice(0, 4_096) : '',
      }));
    } catch (error) {
      handleError(error, res, sendApiError);
    }
  });

  app.delete('/api/projects/:projectId/browser/tabs/:tabId/lease', local, async (req, res) => {
    if (!await authorize(req, res)) return;
    try {
      const body = objectValue(req.body) ?? {};
      res.json({
        released: broker.releaseLease(
          requiredParam(req, 'projectId'),
          requiredParam(req, 'tabId'),
          requiredString(body, 'leaseId'),
        ),
      });
    } catch (error) {
      handleError(error, res, sendApiError);
    }
  });

  app.post(
    '/api/projects/:projectId/browser/tabs/:tabId/commands/next',
    local,
    async (req, res) => {
      if (!await authorize(req, res)) return;
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) abort.abort();
      };
      req.once('aborted', cancel);
      res.once('close', cancel);
      try {
        const body = objectValue(req.body) ?? {};
        const command = await broker.nextCommand(
          requiredParam(req, 'projectId'),
          requiredParam(req, 'tabId'),
          requiredString(body, 'leaseId'),
          parseTimeout(body, 25_000),
          abort.signal,
        );
        if (!res.writableEnded) res.json({ command });
      } catch (error) {
        handleError(error, res, sendApiError);
      } finally {
        req.off('aborted', cancel);
        res.off('close', cancel);
      }
    },
  );

  app.post(
    '/api/projects/:projectId/browser/tabs/:tabId/commands/:commandId/result',
    local,
    async (req, res) => {
      if (!await authorize(req, res)) return;
      try {
        const body = objectValue(req.body) ?? {};
        if (body.ok !== true && body.ok !== false) {
          throw new BrowserBrokerError('BAD_REQUEST', 'ok must be true or false', 400);
        }
        const rendererError = objectValue(body.error);
        const input: SubmitBrowserCommandResultRequest = body.ok === true
          ? {
              leaseId: requiredString(body, 'leaseId'),
              ok: true,
              result: parseResult(body.result),
            }
          : {
              leaseId: requiredString(body, 'leaseId'),
              ok: false,
              error: {
                code: isApiErrorCode(rendererError?.code)
                  ? rendererError.code
                  : 'BROWSER_COMMAND_FAILED',
                message: typeof rendererError?.message === 'string'
                  ? rendererError.message
                  : 'renderer browser command failed',
              },
            };
        broker.submitResult(
          requiredParam(req, 'projectId'),
          requiredParam(req, 'tabId'),
          requiredParam(req, 'commandId'),
          input,
        );
        res.json({ accepted: true });
      } catch (error) {
        handleError(error, res, sendApiError);
      }
    },
  );

  app.post('/api/projects/:projectId/browser/commands', local, async (req, res) => {
    const abort = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) abort.abort();
    };
    req.once('aborted', cancel);
    res.once('close', cancel);
    try {
      const body = objectValue(req.body) ?? {};
      const command = parseOperation(body.command);
      const consequential = command.operation === 'click'
        || command.operation === 'type'
        || command.operation === 'scroll'
        || command.operation === 'navigate'
        || command.operation === 'style';
      if (!await authorize(req, res, consequential ? 'write' : 'read')) return;
      const result = await broker.execute(
        requiredParam(req, 'projectId'),
        typeof body.tabId === 'string' && body.tabId.trim() ? body.tabId.trim() : undefined,
        command,
        parseTimeout(body, 30_000),
        abort.signal,
      );
      if (!res.writableEnded) res.json(result);
    } catch (error) {
      handleError(error, res, sendApiError);
    } finally {
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  });
}

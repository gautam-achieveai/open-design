import type { Express, Request, Response } from 'express';
import type { McpApprovalView } from '@open-design/contracts';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import type { ApprovalTarget, McpApprovalStore } from './approval-store.js';
import { verifyNativePerformanceDecision } from './native-performance-decision.js';

export interface RegisterMcpApprovalRoutesDeps {
  store: McpApprovalStore;
  /** Checks project write authority and the captured workspace scope. */
  authorize: (req: Request, approval: McpApprovalView) => Promise<boolean>;
  /** Must synchronously recheck current project and captured scope authority. */
  authorizeCurrent: (req: Request, approval: McpApprovalView) => boolean;
  /** Broker-owned synchronous lease and recorded-URL check. */
  targetCurrent: (target: ApprovalTarget) => boolean;
  desktopSecret?: () => Buffer | null;
}

function local(req: Request, res: Response): boolean {
  const result = validateLocalDaemonRequest(req);
  if (!result.ok) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: result.message } });
    return false;
  }
  res.setHeader('Vary', 'Origin');
  if (result.origin) res.setHeader('Access-Control-Allow-Origin', result.origin);
  return true;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'approval not found' } });
}

export function registerMcpApprovalRoutes(app: Express, deps: RegisterMcpApprovalRoutesDeps): void {
  app.get('/api/mcp/approvals', async (req, res) => {
    if (!local(req, res)) return;
    const approvals: McpApprovalView[] = [];
    try {
      const authorized: string[] = [];
      for (const candidate of deps.store.list()) {
        if (await deps.authorize(req, candidate)) authorized.push(candidate.id);
      }
      // Recheck every item after the last await, immediately before publication.
      for (const id of authorized) {
        const current = deps.store.get(id);
        if (current?.status === 'pending' && deps.authorizeCurrent(req, current) === true) approvals.push(current);
      }
      res.json({ approvals });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'approval list unavailable' } });
    }
  });

  app.get('/api/mcp/approvals/:id', async (req, res) => {
    if (!local(req, res)) return;
    try {
      const candidate = deps.store.get(req.params.id);
      if (!candidate || !await deps.authorize(req, candidate)) return notFound(res);
      const current = deps.store.get(candidate.id);
      if (!current || deps.authorizeCurrent(req, current) !== true) return notFound(res);
      res.json({ approval: current });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'approval unavailable' } });
    }
  });

  app.get('/api/mcp/approvals/:id/native-challenge', async (req, res) => {
    if (!local(req, res)) return;
    try {
      const candidate = deps.store.get(req.params.id);
      if (!candidate?.nativeConfirmationRequired || !await deps.authorize(req, candidate)) return notFound(res);
      const current = deps.store.get(candidate.id);
      const target = deps.store.getTarget(candidate.id);
      const challenge = deps.store.nativeChallenge(candidate.id);
      if (!current || !target || !challenge || !deps.authorizeCurrent(req, current) || !deps.targetCurrent(target)) return notFound(res);
      res.json({ challenge });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Native confirmation unavailable' } });
    }
  });

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`/api/mcp/approvals/:id/${decision}`, async (req, res) => {
      if (!local(req, res)) return;
      if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some((key) => key !== 'nativeConfirmation'))) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'approval decision takes no arguments' } });
        return;
      }
      try {
        const candidate = deps.store.get(req.params.id);
        if (!candidate || !await deps.authorize(req, candidate)) return notFound(res);
        const current = deps.store.get(candidate.id);
        if (!current || deps.authorizeCurrent(req, current) !== true) return notFound(res);
        const challenge = current.nativeConfirmationRequired ? deps.store.nativeChallenge(current.id) : null;
        const nativeConfirmed = !!challenge && verifyNativePerformanceDecision(deps.desktopSecret?.() ?? null,
          challenge, decision, req.body?.nativeConfirmation);
        if (current.nativeConfirmationRequired && !nativeConfirmed) {
          res.status(403).json({ error: { code: 'NATIVE_CONFIRMATION_REQUIRED', message: 'Use the desktop native confirmation for this temporary CPU override' } });
          return;
        }
        if (!current.nativeConfirmationRequired && req.body && Object.keys(req.body).length) {
          res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'approval decision takes no arguments' } });
          return;
        }
        let authorityLost = false;
        const outcome = deps.store.decide(candidate.id, decision, (target) => {
          const targetIsCurrent = deps.targetCurrent(target);
          authorityLost = deps.authorizeCurrent(req, current) !== true;
          const bindingCurrent = !challenge || deps.store.nativeChallenge(current.id)?.bindingDigest === challenge.bindingDigest;
          return targetIsCurrent && !authorityLost && bindingCurrent;
        }, nativeConfirmed);
        if (authorityLost) return notFound(res);
        if (!outcome.ok) {
          if (outcome.code === 'NOT_FOUND') return notFound(res);
          res.status(409).json({ error: { code: outcome.code, message: 'approval cannot be decided' } });
          return;
        }
        res.json({ approval: outcome.approval });
      } catch {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'approval decision unavailable' } });
      }
    });
  }
}

import type { Request } from 'express';
import type { McpApprovalView } from '@open-design/contracts';
import type { DecideProjectRequestSync } from '../collab/project-request-authority.js';
import type { RunWorkspaceScope } from '../runtimes/project-amr-trace-env.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { resolveMcpGrant } from './auth.js';
import type { ApprovalPrincipal } from './approval-store.js';
import type { McpCredentialStore } from './credentials.js';
import { operationAllowed } from './registry.js';

export interface ApprovalRun {
  id: string;
  projectId: string | null;
  status: string;
  cancelRequested?: boolean;
  workspaceScope?: RunWorkspaceScope | null;
}

export type ApprovalPrincipalResolution =
  | { ok: true; principal: ApprovalPrincipal }
  | { ok: false; code: string; message: string };

export interface ApprovalPrincipalDependencies {
  toolTokenRegistry: ToolTokenRegistry;
  credentialStore: McpCredentialStore;
  getRun: (runId: string) => ApprovalRun | null | undefined;
  projectExists: (projectId: string) => boolean;
  /** The current persisted workspace binding, if any. */
  getProjectWorkspaceId: (projectId: string) => string | null;
  decideProjectRequest: DecideProjectRequestSync;
}

type Scope = ApprovalPrincipal['scope'];
type HeaderScope = { ok: true; scope: Scope } | { ok: false };

function headerScope(req: Request): HeaderScope {
  const workspace = req.get('x-od-workspace-id');
  const member = req.get('x-od-workspace-member-id');
  if (workspace === undefined && member === undefined) return { ok: true, scope: null };
  if (typeof workspace !== 'string' || typeof member !== 'string') return { ok: false };
  const workspaceId = workspace.trim();
  const workspaceMemberId = member.trim();
  if (!workspaceId || !workspaceMemberId) return { ok: false };
  return { ok: true, scope: { workspaceId, workspaceMemberId } };
}

function sameScope(a: Scope, b: Scope): boolean {
  return a === null ? b === null : b !== null
    && a.workspaceId === b.workspaceId && a.workspaceMemberId === b.workspaceMemberId;
}

function runScope(run: ApprovalRun, projectId: string): HeaderScope {
  const pinned = run.workspaceScope;
  if (pinned && pinned.projectId !== projectId) return { ok: false };
  if (pinned?.source === 'persisted_project_binding') {
    const workspaceId = pinned.workspaceId?.trim();
    const workspaceMemberId = pinned.workspaceMemberId?.trim();
    if (!workspaceId || !workspaceMemberId) return { ok: false };
    return { ok: true, scope: { workspaceId, workspaceMemberId } };
  }
  if (!pinned || (pinned.source === 'unbound_account' && pinned.workspaceId === null)) {
    return { ok: true, scope: null };
  }
  return { ok: false };
}

function isActiveRun(run: ApprovalRun | null | undefined, id: string, projectId: string): run is ApprovalRun {
  return !!run && run.id === id && run.projectId === projectId && !run.cancelRequested
    && (run.status === 'queued' || run.status === 'running');
}

/**
 * Check the lifecycle of an approval's recorded principal before showing or
 * deciding it. The view contains no run bearer identity, so this cannot prove
 * which of a run's tokens remains valid; dispatch must revalidate the bearer.
 */
export function createApprovalViewPrincipalCheck(deps: Pick<ApprovalPrincipalDependencies, 'credentialStore' | 'getRun'> & {
  now?: () => number;
}): (view: McpApprovalView) => boolean {
  const now = deps.now ?? Date.now;
  return (view) => {
    try {
      const { id, kind } = view.principal;
      if (!id || !view.projectId || !/^browser_[a-z0-9_]+$/.test(view.operation)) return false;
      if (kind === 'external') {
        const credential = deps.credentialStore.list().find((candidate) => candidate.id === id);
        if (!credential) return false;
        if (credential.expiresAt !== null) {
          const expiry = Date.parse(credential.expiresAt);
          if (!Number.isFinite(expiry) || now() >= expiry) return false;
        }
        const operation = `browser/${view.operation.slice('browser_'.length).replace(/_/g, '-')}`;
        return operationAllowed(credential.allowedOperations, operation);
      }
      if (kind !== 'run') return false;
      const run = deps.getRun(id);
      if (!isActiveRun(run, id, view.projectId)) return false;
      const pinned = runScope(run, view.projectId);
      return pinned.ok && sameScope(pinned.scope, view.scope);
    } catch {
      return false;
    }
  };
}

function requestForScope(scope: Scope): { get: (name: string) => string | undefined } {
  return {
    get(name) {
      switch (name.toLowerCase()) {
        case 'x-od-workspace-id': return scope?.workspaceId;
        case 'x-od-workspace-member-id': return scope?.workspaceMemberId;
        default: return undefined;
      }
    },
  };
}

const DENIED: ApprovalPrincipalResolution = {
  ok: false, code: 'PROJECT_SCOPE_DENIED', message: 'current project authority denied',
};

/** Revalidate all local authority synchronously immediately before enqueue. */
export function createApprovalPrincipalResolver(deps: ApprovalPrincipalDependencies): (
  req: Request, projectId: string, operation: string,
) => ApprovalPrincipalResolution {
  return (req, projectId, operation) => {
    try {
      if (!projectId || !operation) return DENIED;
      // resolveMcpGrant checks the current bearer, expiry/revocation and MCP audience.
      const auth = resolveMcpGrant(req, deps);
      if (!auth.ok) return { ok: false, code: auth.code, message: auth.message };
      const grant = auth.grant;
      if (!operationAllowed(grant.allowedOperations, operation)) {
        return { ok: false, code: 'TOOL_OPERATION_DENIED', message: 'operation is not allowed for this token' };
      }
      const supplied = headerScope(req);
      if (!supplied.ok || !deps.projectExists(projectId)) return DENIED;

      let scope: Scope;
      let id: string;
      if (grant.kind === 'run') {
        if (!grant.runId || grant.projectId !== projectId) return DENIED;
        const run = deps.getRun(grant.runId);
        if (!isActiveRun(run, grant.runId, projectId)) return DENIED;
        const pinned = runScope(run, projectId);
        if (!pinned.ok) return DENIED;
        scope = pinned.scope;
        if (supplied.scope !== null && !sameScope(scope, supplied.scope)) return DENIED;
        id = grant.runId;
      } else {
        if (!grant.credentialId) return DENIED;
        scope = supplied.scope;
        id = grant.credentialId;
      }

      // A previously unbound run must not inherit a later binding; nor can a
      // scoped run continue after its project is moved to another workspace.
      const currentWorkspace = deps.getProjectWorkspaceId(projectId);
      if (scope === null ? currentWorkspace !== null : currentWorkspace !== scope.workspaceId) return DENIED;
      const decision = deps.decideProjectRequest(requestForScope(scope), projectId, {
        mode: 'write', capability: 'writeFiles',
      });
      if (!decision || decision.ok !== true) return DENIED;
      return { ok: true, principal: { kind: grant.kind, id, projectId, scope } };
    } catch {
      // Do not copy exception text or request data into the response.
      return DENIED;
    }
  };
}

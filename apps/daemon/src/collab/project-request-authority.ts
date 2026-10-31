import type { Response } from 'express';
import {
  requestWithWorkspaceNavigationScope,
  workspaceResourceContextFromRequest,
  type ResolveWorkspaceResourceReadAuthority,
  type VerifyWorkspaceRequestAuthority,
  type WorkspaceResourceAccessInput,
  type WorkspaceResourceMutationCapability,
} from './workspace-resource-mutation.js';

export type AuthorizeProjectRequestOptions =
  | {
      mode: 'read';
      /** EventSource, iframe, and direct asset navigation cannot set headers. */
      allowNavigationQuery?: boolean;
    }
  | {
      mode: 'write';
      capability: WorkspaceResourceMutationCapability;
    };

export type AuthorizeProjectRequest = (
  req: any,
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<boolean>;

export type AuthorizedProjectToolRequest = {
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspaceMemberId: string;
  } | null;
};

export type AuthorizeProjectToolRequest = (
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<AuthorizedProjectToolRequest | null>;

type LocalProjectDataPlaneRequestInput = {
  req: any;
  projectId: string;
  options: AuthorizeProjectRequestOptions;
  db: unknown;
  getWorkspaceProject: (
    db: unknown,
    workspaceId: string,
    projectId: string,
  ) => WorkspaceResourceAccessInput | null | undefined;
  getWorkspaceProjectByProjectId: (
    db: unknown,
    projectId: string,
  ) => WorkspaceResourceAccessInput | null | undefined;
  onDenied?: (
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => unknown;
};

function enforceLocalProjectDataPlaneRequestSync(input: LocalProjectDataPlaneRequestInput): boolean {
  const {
    req,
    projectId,
    options,
    db,
    getWorkspaceProject,
    getWorkspaceProjectByProjectId,
    onDenied,
  } = input;
  const deny = (
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): false => {
    onDenied?.(status, code, message, details);
    return false;
  };
  const persisted = getWorkspaceProjectByProjectId(db, projectId);
  if (!persisted?.workspaceId) return true;

  const scopedRequest = options.mode === 'read' && options.allowNavigationQuery
    ? requestWithWorkspaceNavigationScope(req)
    : req;
  if (scopedRequest === 'conflict') {
    return deny(
      400,
      'WORKSPACE_CONTEXT_CONFLICT',
      'workspace header and navigation scope must match',
    );
  }
  const claimed = workspaceResourceContextFromRequest(scopedRequest);
  if (claimed === 'missing') {
    return deny(
      400,
      'WORKSPACE_CONTEXT_INCOMPLETE',
      'both workspace and member identity are required',
    );
  }
  if (claimed && claimed.workspaceId !== persisted.workspaceId) {
    return deny(
      403,
      'WORKSPACE_PROJECT_PERMISSION_DENIED',
      `workspace project ${options.mode} is not allowed`,
    );
  }

  const row = getWorkspaceProject(db, persisted.workspaceId, projectId);
  if (!row || row.resourceState === 'deleted') {
    return deny(
      403,
      'WORKSPACE_PROJECT_PERMISSION_DENIED',
      `workspace project ${options.mode} is not allowed`,
    );
  }
  if (options.mode === 'read') {
    if (
      claimed
      && row.visibility === 'personal'
      && row.createdByWorkspaceMemberId
      && row.createdByWorkspaceMemberId !== claimed.workspaceMemberId
    ) {
      return deny(
        403,
        'WORKSPACE_PROJECT_PERMISSION_DENIED',
        'workspace project read is not allowed',
      );
    }
    return true;
  }
  if (row.resourceState === 'frozen') {
    return deny(
      403,
      'WORKSPACE_LOCKED',
      'workspace project mutation is not allowed',
    );
  }
  if (options.capability === 'comment' && row.visibility === 'team') return true;
  if (!claimed && row.visibility === 'team') {
    return deny(
      400,
      'WORKSPACE_CONTEXT_REQUIRED',
      'workspace context is required',
    );
  }

  // A Team project is single-writer. Pulled member mirrors deliberately persist
  // a null creator, so null means "no local writer", not "unattributed local
  // project". Keep those mirrors read-only from the durable row even when Vela
  // is unavailable; only an exact persisted creator/member match may write.
  if (
    row.visibility === 'team'
    && row.createdByWorkspaceMemberId !== claimed?.workspaceMemberId
  ) {
    return deny(
      403,
      'WORKSPACE_PROJECT_PERMISSION_DENIED',
      'workspace project mutation is not allowed',
    );
  }

  // An explicit browser/tool identity must still match the persisted creator
  // for attributed Personal projects. Headerless Personal projects retain CLI
  // compatibility.
  if (
    claimed
    && row.createdByWorkspaceMemberId
    && row.createdByWorkspaceMemberId !== claimed.workspaceMemberId
  ) {
    return deny(
      403,
      'WORKSPACE_PROJECT_PERMISSION_DENIED',
      'workspace project mutation is not allowed',
    );
  }
  return true;
}

export async function enforceLocalProjectDataPlaneRequest(input: LocalProjectDataPlaneRequestInput): Promise<boolean> {
  return enforceLocalProjectDataPlaneRequestSync(input);
}

/**
 * Build the one project data-plane authority gate used by route modules.
 *
 * Persisted project binding is the local namespace and creator witness. Local
 * project data-plane requests never synchronously depend on Vela membership
 * availability; cloud share/sync/billing boundaries perform their own fresh
 * authorization. Unbound pre-Workspace local projects retain legacy behavior.
 */
export interface ProjectRequestAuthorityDependencies {
  db: unknown;
  getWorkspaceProject: (
    db: unknown,
    workspaceId: string,
    projectId: string,
  ) => WorkspaceResourceAccessInput | null | undefined;
  getWorkspaceProjectByProjectId: (
    db: unknown,
    projectId: string,
  ) => WorkspaceResourceAccessInput | null | undefined;
  /** @deprecated Retained as an ignored compatibility seam for route fixtures. */
  verifyWorkspaceReadAuthority?: VerifyWorkspaceRequestAuthority;
  /** @deprecated Retained as an ignored compatibility seam for route fixtures. */
  resolveWorkspaceReadAuthority?: ResolveWorkspaceResourceReadAuthority;
  /** @deprecated Local project data-plane requests never call this verifier. */
  verifyWorkspaceRequestAuthority?: VerifyWorkspaceRequestAuthority;
  /**
   * Durable local quarantine witness for a pulled mirror whose authoritative
   * Team catalog row disappeared. Kept outside the generic workspace binding
   * shape because it lives on project metadata for restart-safe recovery.
   */
  isProjectRevoked?: (db: unknown, projectId: string) => boolean;
  /** Product retirement policy; does not rewrite the durable binding or data. */
  isProjectUnavailable?: (db: unknown, projectId: string) => boolean;
  /** A bound first-open placeholder may be read but is never content authority. */
  isProjectUnmaterializedPlaceholder?: (db: unknown, projectId: string) => boolean;
}

export type ProjectRequestDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

export type DecideProjectRequest = (
  req: any,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<ProjectRequestDecision>;

export type DecideProjectRequestSync = (
  req: any,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => ProjectRequestDecision;

/**
 * Read current local project authority without an asynchronous gap. The caller
 * must use synchronous dependency implementations, as required by their types.
 * This allows an approval to re-check authority immediately before enqueue.
 */
export function createSynchronousProjectRequestDecision(deps: ProjectRequestAuthorityDependencies): DecideProjectRequestSync {
  const {
    db,
    getWorkspaceProject,
    getWorkspaceProjectByProjectId,
    isProjectRevoked,
    isProjectUnavailable,
    isProjectUnmaterializedPlaceholder,
  } = deps;
  return (req, projectId, options) => {
    if (isProjectRevoked?.(db, projectId)) {
      return {
        ok: false,
        status: options.mode === 'read' ? 404 : 403,
        code: options.mode === 'read' ? 'PROJECT_NOT_FOUND' : 'WORKSPACE_PROJECT_PERMISSION_DENIED',
        message: options.mode === 'read' ? 'project not found' : 'workspace project mutation is not allowed',
      };
    }
    if (isProjectUnavailable?.(db, projectId)) {
      return {
        ok: false,
        status: 403,
        code: 'WORKSPACE_UNAVAILABLE',
        message: 'Team projects are unavailable because Cloud support has been removed. Stored data has been preserved.',
      };
    }
    const denial: { value?: ProjectRequestDecision } = {};
    const allowed = enforceLocalProjectDataPlaneRequestSync({
      req,
      projectId,
      options,
      db,
      getWorkspaceProject,
      getWorkspaceProjectByProjectId,
      onDenied: (status, code, message, details) => {
        denial.value = { ok: false, status, code, message, ...(details === undefined ? {} : { details }) };
      },
    });
    if (!allowed) {
      if (!denial.value) throw new Error('Project authority denied without a reason');
      return denial.value;
    }
    if (
      options.mode !== 'read'
      && options.capability !== 'comment'
      && isProjectUnmaterializedPlaceholder?.(db, projectId)
    ) {
      return {
        ok: false,
        status: 409,
        code: 'PROJECT_MATERIALIZATION_PENDING',
        message: 'project content is still materializing',
      };
    }
    return { ok: true };
  };
}

export function createProjectRequestDecision(deps: ProjectRequestAuthorityDependencies): DecideProjectRequest {
  const decide = createSynchronousProjectRequestDecision(deps);
  return async (req, projectId, options) => decide(req, projectId, options);
}

export function createAuthorizeProjectRequest(deps: ProjectRequestAuthorityDependencies & {
  sendApiError: (
    res: Response,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => unknown;
}): AuthorizeProjectRequest {
  const decide = createProjectRequestDecision(deps);
  return async (req, res, projectId, options) => {
    const decision = await decide(req, projectId, options);
    if (decision.ok) return true;
    if (decision.details === undefined) {
      deps.sendApiError(res, decision.status, decision.code, decision.message);
    } else {
      deps.sendApiError(res, decision.status, decision.code, decision.message, decision.details);
    }
    return false;
  };
}

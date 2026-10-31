import type { Request } from 'express';
import type { AuthorizeProjectRequestOptions, DecideProjectRequestSync } from '../collab/project-request-authority.js';
import type { ApprovalRun } from './approval-principal.js';

/** Caller must first validate the live bearer and its exact endpoint and operation. */
export function authorizeCurrentRunProject(input: {
  request: Request;
  runId: string;
  projectId: string;
  options: AuthorizeProjectRequestOptions;
}, deps: {
  getRun: (runId: string) => ApprovalRun | null | undefined;
  getProjectWorkspaceId: (projectId: string) => string | null;
  decideProjectRequest: DecideProjectRequestSync;
}): boolean {
  try {
    const { runId, projectId, request, options } = input;
    const run = deps.getRun(runId);
    if (!run || run.id !== runId || run.projectId !== projectId || run.cancelRequested || !['queued', 'running'].includes(run.status)) return false;
    const pinned = run.workspaceScope;
    if (pinned && pinned.projectId !== projectId) return false;
    let workspaceId: string | null = null;
    let memberId: string | null = null;
    if (pinned?.source === 'persisted_project_binding') {
      workspaceId = pinned.workspaceId?.trim() || null;
      memberId = pinned.workspaceMemberId?.trim() || null;
      if (!workspaceId || !memberId) return false;
    } else if (pinned && (pinned.source !== 'unbound_account' || pinned.workspaceId !== null)) return false;
    if (deps.getProjectWorkspaceId(projectId) !== workspaceId) return false;
    const suppliedWorkspace = request.get('x-od-workspace-id');
    const suppliedMember = request.get('x-od-workspace-member-id');
    if ((suppliedWorkspace !== undefined || suppliedMember !== undefined)
      && (suppliedWorkspace?.trim() !== workspaceId || suppliedMember?.trim() !== memberId)) return false;
    const scoped = { get: (name: string) => name.toLowerCase() === 'x-od-workspace-id' ? workspaceId ?? undefined
      : name.toLowerCase() === 'x-od-workspace-member-id' ? memberId ?? undefined : undefined };
    return deps.decideProjectRequest(scoped, projectId, options).ok === true;
  } catch {
    return false;
  }
}

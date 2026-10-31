import type { Request } from 'express';
import type { ProjectMetadata } from '@open-design/contracts';
import type { AuthorizeProjectRequestOptions, DecideProjectRequestSync } from '../collab/project-request-authority.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { isSafeId } from '../projects.js';
import { isRevokedProjectFileAccess } from '../services/project-file-read.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import type { ApprovalRun } from './approval-principal.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { operationAllowed, toolError, type McpToolContext, type McpToolResult } from './registry.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';

export type ReadAccessProject = { id: string; metadata?: ProjectMetadata | null };
export interface UnboundReadProjectSnapshot {
  payload: { project: ReadAccessProject };
  revalidate: () => boolean;
}
export interface ProjectReadAccessDeps {
  tokenRegistry: ToolTokenRegistry;
  getRun: (runId: string) => ApprovalRun | null | undefined;
  getProject: (projectId: string) => ReadAccessProject | null | undefined;
  getProjectWorkspaceId: (projectId: string) => string | null;
  decideProjectRequest: DecideProjectRequestSync;
  credentialStore?: McpCredentialStore;
  readUnboundProjectDetail?: (id: string) => Promise<UnboundReadProjectSnapshot | null>;
}
export type ProjectReadAccess = {
  ok: true;
  project: ReadAccessProject;
  projectId: string;
  /** Principal scope for pagination. A run never shares a cursor with an external credential. */
  principal: { kind: 'run' | 'external'; id: string };
  request: Request;
  current: () => boolean;
} | { ok: false; result: McpToolResult };

/** Reusable read access for file and artifact adapters; no filesystem work occurs here. */
async function resolveProjectAccess(projectArg: string | undefined, context: McpToolContext,
  operation: string, deps: ProjectReadAccessDeps, options: AuthorizeProjectRequestOptions): Promise<ProjectReadAccess> {
  const denied = (): ProjectReadAccess => ({ ok: false, result: toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0) });
  const request = context.request;
  if (!request) return { ok: false, result: toolError('TOOL_TOKEN_MISSING', 'run token or local MCP credential is required', 0) };
  if (context.grant.kind === 'run') {
    const checked = deps.tokenRegistry.validate(bearerTokenFromRequest(request), { endpoint: '/mcp', operation });
    if (!checked.ok) return { ok: false, result: toolError(checked.code, checked.message, 0) };
    const { projectId, runId } = checked.grant;
    if (projectId !== context.grant.projectId || runId !== context.grant.runId
      || (projectArg !== undefined && projectArg !== projectId)) return denied();
    const project = deps.getProject(projectId);
    if (!project || project.id !== projectId) return denied();
    const metadata = JSON.stringify(project.metadata ?? null);
    const current = () => {
      const liveToken = deps.tokenRegistry.validate(bearerTokenFromRequest(request), { endpoint: '/mcp', operation });
      const liveProject = deps.getProject(projectId);
      return !context.signal?.aborted && liveToken.ok && liveToken.grant.runId === runId && liveToken.grant.projectId === projectId
        && liveProject?.id === projectId && !isRevokedProjectFileAccess(liveProject)
        && JSON.stringify(liveProject.metadata ?? null) === metadata
        && authorizeCurrentRunProject({ request, runId, projectId, options }, deps);
    };
    return current() ? { ok: true, project, projectId, principal: { kind: 'run', id: runId }, request, current } : denied();
  }

  const hasWorkspaceHeaders = () => Object.keys(request.headers ?? {}).some(key => key.toLowerCase().startsWith('x-od-workspace-'))
    || request.get('x-od-workspace-id') !== undefined || request.get('x-od-workspace-member-id') !== undefined;
  if (hasWorkspaceHeaders()) return { ok: false, result: toolError('WORKSPACE_SCOPE_UNSUPPORTED', 'workspace-scoped external file access is not supported', 0) };
  if (!projectArg || !isSafeId(projectArg) || !deps.credentialStore || !deps.readUnboundProjectDetail) return denied();
  const credentialCurrent = () => {
    if (context.signal?.aborted || hasWorkspaceHeaders()) return false;
    const auth = resolveMcpGrant(request, { toolTokenRegistry: deps.tokenRegistry, credentialStore: deps.credentialStore! });
    return auth.ok && auth.grant.kind === 'external' && Boolean(auth.grant.credentialId)
      && auth.grant.credentialId === context.grant.credentialId && operationAllowed(auth.grant.allowedOperations, operation);
  };
  if (!credentialCurrent()) return denied();
  const snapshot = await deps.readUnboundProjectDetail(projectArg);
  if (!snapshot || snapshot.payload.project.id !== projectArg || !credentialCurrent() || !snapshot.revalidate()) return denied();
  const project = snapshot.payload.project;
  const metadata = JSON.stringify(project.metadata ?? null);
  const current = () => {
    if (!credentialCurrent() || !snapshot.revalidate()) return false;
    const liveProject = deps.getProject(projectArg);
    return liveProject?.id === projectArg && !isRevokedProjectFileAccess(liveProject)
      && JSON.stringify(liveProject.metadata ?? null) === metadata && deps.getProjectWorkspaceId(projectArg) === null
      && deps.decideProjectRequest(request, projectArg, options).ok && credentialCurrent();
  };
  return current() ? { ok: true, project, projectId: projectArg,
    principal: { kind: 'external', id: context.grant.credentialId! }, request, current } : denied();
}

export function resolveProjectReadAccess(projectArg: string | undefined, context: McpToolContext,
  operation: string, deps: ProjectReadAccessDeps): Promise<ProjectReadAccess> {
  return resolveProjectAccess(projectArg, context, operation, deps, { mode: 'read' });
}

export function resolveProjectWriteAccess(projectArg: string | undefined, context: McpToolContext,
  operation: string, deps: ProjectReadAccessDeps): Promise<ProjectReadAccess> {
  return resolveProjectAccess(projectArg, context, operation, deps, { mode: 'write', capability: 'writeFiles' });
}

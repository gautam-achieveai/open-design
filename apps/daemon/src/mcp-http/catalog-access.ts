import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { operationAllowed, type McpToolContext } from './registry.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';

export type CatalogScope = { workspaceId: string | null; workspaceMemberId: string | null };
export type CatalogAccessDeps = Parameters<typeof authorizeCurrentRunProject>[1] & {
  tokenRegistry: ToolTokenRegistry;
  credentialStore?: McpCredentialStore;
  projectExists: (projectId: string) => boolean;
};

/** External credentials see the unbound catalog; run credentials keep their pinned workspace. */
export function resolveCatalogAccess(context: McpToolContext, operation: string, deps: CatalogAccessDeps): {
  scope: CatalogScope;
  current: () => boolean;
} | null {
  const request = context.request;
  if (!request) return null;
  if (context.grant.kind === 'external') {
    if (!deps.credentialStore) return null;
    const current = () => {
      if (context.signal?.aborted || Object.keys(request.headers ?? {}).some(key => key.toLowerCase().startsWith('x-od-workspace-'))
        || request.get('x-od-workspace-id') !== undefined || request.get('x-od-workspace-member-id') !== undefined) return false;
      const auth = resolveMcpGrant(request, { toolTokenRegistry: deps.tokenRegistry, credentialStore: deps.credentialStore! });
      return auth.ok && auth.grant.kind === 'external' && Boolean(auth.grant.credentialId)
        && auth.grant.credentialId === context.grant.credentialId && operationAllowed(auth.grant.allowedOperations, operation);
    };
    return current() ? { scope: { workspaceId: null, workspaceMemberId: null }, current } : null;
  }
  const readScope = (): CatalogScope => {
    const pinned = deps.getRun(context.grant.runId!)?.workspaceScope;
    return pinned?.source === 'persisted_project_binding'
      ? { workspaceId: pinned.workspaceId ?? null, workspaceMemberId: pinned.workspaceMemberId ?? null }
      : { workspaceId: null, workspaceMemberId: null };
  };
  // getRun may hydrate and repair durable state. Check live authority first.
  const tokenCurrent = () => {
    if (context.signal?.aborted) return false;
    const auth = deps.tokenRegistry.validate(bearerTokenFromRequest(request), { endpoint: '/mcp', operation });
    return auth.ok && auth.grant.runId === context.grant.runId && auth.grant.projectId === context.grant.projectId;
  };
  if (!tokenCurrent()) return null;
  const scope = readScope();
  const current = () => {
    if (!tokenCurrent()) return false;
    const after = readScope();
    return deps.projectExists(context.grant.projectId!) && after.workspaceId === scope.workspaceId && after.workspaceMemberId === scope.workspaceMemberId
      && authorizeCurrentRunProject({ request, runId: context.grant.runId!, projectId: context.grant.projectId!, options: { mode: 'read' } }, deps);
  };
  return current() ? { scope, current } : null;
}

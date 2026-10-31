import type { Request } from 'express';
import type { DecideProjectRequestSync } from '../collab/project-request-authority.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import type { ApprovalRun } from './approval-principal.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { operationAllowed, type McpAuthGrant } from './registry.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';

/** Recheck the exact incoming bearer and project scope at each read boundary. */
export function createBrowserReadAuthority(deps: {
  toolTokenRegistry: ToolTokenRegistry;
  credentialStore: McpCredentialStore;
  getRun: (runId: string) => ApprovalRun | null | undefined;
  projectExists: (projectId: string) => boolean;
  getProjectWorkspaceId: (projectId: string) => string | null;
  decideProjectRequest: DecideProjectRequestSync;
}): (request: Request, projectId: string, operation: string, ingress: McpAuthGrant) => boolean {
  return (request, projectId, operation, ingress) => {
    try {
      const current = resolveMcpGrant(request, deps);
      if (!current.ok || !operationAllowed(current.grant.allowedOperations, operation)
        || current.grant.kind !== ingress.kind || !deps.projectExists(projectId)) return false;
      if (current.grant.kind === 'run') {
        const { runId } = current.grant;
        return !!runId && runId === ingress.runId && current.grant.projectId === projectId
          && ingress.projectId === projectId && authorizeCurrentRunProject({
            request, runId, projectId, options: { mode: 'read' },
          }, deps);
      }
      return !!current.grant.credentialId && current.grant.credentialId === ingress.credentialId
        && deps.decideProjectRequest(request, projectId, { mode: 'read' }).ok === true;
    } catch {
      return false;
    }
  };
}

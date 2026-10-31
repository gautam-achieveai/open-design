import { z } from 'zod';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { readActiveContext, type ActiveContextStore } from '../services/active-context.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';
import type { McpCredentialStore } from './credentials.js';
import { resolveMcpGrant } from './auth.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk, type McpToolContext } from './registry.js';

const OPERATION = 'context/active:read';
const INACTIVE_HINT = 'OpenDesign has no active project right now. The active context expires about 5 minutes after the last user interaction with OpenDesign, so the user may need to click into a project (or switch tabs inside one) to wake it up. Alternatively, pass project="<id-or-name>" to other tools to bypass active context entirely.';
const BEARER_PATTERN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;

/** Expose active UI context only when it belongs to the authenticated run. */
export function registerActiveContextMcpTool(registry: McpToolRegistry, deps: Parameters<typeof authorizeCurrentRunProject>[1] & {
  tokenRegistry: ToolTokenRegistry;
  store: ActiveContextStore;
  getProject: (projectId: string) => { name?: string | null } | null | undefined;
  now: () => number;
  credentialStore?: McpCredentialStore;
  readUnboundProjectDetail?: (id: string) => Promise<{ revalidate: () => boolean } | null>;
}): void {
  registry.register({
    name: 'get_active_context', operation: OPERATION, version: 1,
    description: 'Read the active project and file when they belong to this run or are unbound and visible to a headerless external credential.',
    annotations: { readOnlyHint: true },
    schema: z.object({ pluginWorkflowId: z.unknown().optional().describe('Unsupported by the HTTP transport.') }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'run token is required', 0);
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      if (context.grant.kind === 'external') {
        if (Object.keys(context.request.headers ?? {}).some((key) => key.toLowerCase().startsWith('x-od-workspace-'))) {
          return toolError('WORKSPACE_SCOPE_UNSUPPORTED', 'workspace-scoped active context is not supported', 0);
        }
        const externalCurrent = () => {
          if (!context.request || context.signal?.aborted || !deps.credentialStore) return false;
          const auth = resolveMcpGrant(context.request, { toolTokenRegistry: deps.tokenRegistry, credentialStore: deps.credentialStore });
          return auth.ok && auth.grant.kind === 'external' && !!auth.grant.credentialId
            && auth.grant.credentialId === context.grant.credentialId && operationAllowed(auth.grant.allowedOperations, OPERATION);
        };
        try {
          if (!externalCurrent() || !deps.readUnboundProjectDetail) return denied();
          const observed = readActiveContext(deps.store, deps.getProject, deps.now);
          if (!observed.active) return externalCurrent() ? toolOk({ active: false, hint: INACTIVE_HINT }, 0) : denied();
          const snapshot = await deps.readUnboundProjectDetail(observed.projectId);
          if (!snapshot || !externalCurrent()) return denied();
          const active = readActiveContext(deps.store, deps.getProject, deps.now);
          if (!active.active || active.projectId !== observed.projectId || active.fileName !== observed.fileName || active.ts !== observed.ts
            || !snapshot.revalidate() || !externalCurrent()) return denied();
          const strings = [active.projectId, active.projectName, active.fileName];
          const bearer = bearerTokenFromRequest(context.request);
          if (strings.some((value) => typeof value === 'string' && (BEARER_PATTERN.test(value) || (bearer && value.includes(bearer))))) {
            return toolError('ACTIVE_CONTEXT_SENSITIVE', 'Active context cannot be returned safely', 0);
          }
          if (strings.some((value) => typeof value === 'string' && value.length > 4000) || JSON.stringify(active).length > 9000) {
            return toolError('ACTIVE_CONTEXT_TOO_LARGE', 'Active context exceeds the output limit', 0);
          }
          return toolOk(active, 0);
        } catch { return toolError('ACTIVE_CONTEXT_FAILED', 'Unable to read active context', 0); }
      }
      const current = (ctx: McpToolContext) => {
        if (!ctx.request || ctx.signal?.aborted) return false;
        const checked = deps.tokenRegistry.validate(bearerTokenFromRequest(ctx.request), { endpoint: '/mcp', operation: OPERATION });
        return checked.ok && checked.grant.runId === ctx.grant.runId && checked.grant.projectId === ctx.grant.projectId
          && Boolean(deps.getProject(checked.grant.projectId))
          && authorizeCurrentRunProject({ request: ctx.request, runId: checked.grant.runId,
            projectId: checked.grant.projectId, options: { mode: 'read' } }, deps);
      };
      try {
        if (!current(context)) return denied();
        const active = readActiveContext(deps.store, deps.getProject, deps.now);
        if (!current(context) || (active.active && active.projectId !== context.grant.projectId)) return denied();
        const data = active.active ? active : { active: false, hint: INACTIVE_HINT };
        const strings = active.active ? [active.projectId, active.projectName, active.fileName] : [];
        const bearer = bearerTokenFromRequest(context.request);
        if (strings.some((value) => typeof value === 'string' && (BEARER_PATTERN.test(value) || (bearer && value.includes(bearer))))) {
          return toolError('ACTIVE_CONTEXT_SENSITIVE', 'Active context cannot be returned safely', 0);
        }
        if (strings.some((value) => typeof value === 'string' && value.length > 4000)
          || JSON.stringify(data).length > 9000) return toolError('ACTIVE_CONTEXT_TOO_LARGE', 'Active context exceeds the output limit', 0);
        return toolOk(data, 0);
      } catch {
        return toolError('ACTIVE_CONTEXT_FAILED', 'Unable to read active context', 0);
      }
    },
  });
}

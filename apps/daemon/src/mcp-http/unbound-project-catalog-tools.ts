import { z } from 'zod';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import type { McpCredentialStore } from './credentials.js';
import { resolveMcpGrant } from './auth.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk, type McpToolContext } from './registry.js';

const OPERATION = 'project/projects:list';
const BUDGET = 8_000;
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;
type Snapshot = { entries: readonly Record<string, unknown>[]; revalidate: (indices: readonly number[]) => boolean };
function safeEntry(value: unknown, bearer: string | null): boolean {
  let units = 0, nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 2_000 || depth > 24 || ++units > BUDGET) return false;
    if (typeof item === 'string') {
      units += item.length;
      return units <= BUDGET && !TOKEN.test(item) && !(bearer && item.includes(bearer));
    }
    if (!item || typeof item !== 'object') return true;
    if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      units += key.length;
      if (units > BUDGET || TOKEN.test(key) || (bearer && key.includes(bearer)) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

/** Headerless external credentials can see only the current unbound catalog. */
export function registerUnboundProjectCatalogMcpTool(registry: McpToolRegistry, deps: {
  toolTokenRegistry: ToolTokenRegistry;
  credentialStore: McpCredentialStore;
  readUnboundProjectCatalog: () => Promise<Snapshot>;
}): void {
  registry.register({
    name: 'list_projects', operation: OPERATION, version: 1,
    description: 'List unbound projects visible without a workspace. Inventory and offsets can change between calls.',
    annotations: { readOnlyHint: true },
    schema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional(),
      pluginWorkflowId: z.unknown().optional().describe('Unsupported by HTTP MCP.') }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (context.grant.kind !== 'external' || !context.request) return toolError('PROJECT_SCOPE_DENIED', 'headerless external access required', 0);
      if (Object.keys(context.request.headers ?? {}).some((key) => key.toLowerCase().startsWith('x-od-workspace-'))) return toolError('WORKSPACE_SCOPE_UNSUPPORTED', 'workspace-scoped project listing is not supported', 0);
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      const current = (ctx: McpToolContext) => {
        if (!ctx.request || ctx.signal?.aborted) return false;
        const auth = resolveMcpGrant(ctx.request, deps);
        return auth.ok && auth.grant.kind === 'external' && !!auth.grant.credentialId
          && auth.grant.credentialId === ctx.grant.credentialId && operationAllowed(auth.grant.allowedOperations, OPERATION);
      };
      try {
        if (!current(context)) return denied();
        const snapshot = await deps.readUnboundProjectCatalog();
        if (!current(context)) return denied();
        const projects: Record<string, unknown>[] = [], indices: number[] = [];
        let cursor = args.offset ?? 0;
        const end = Math.min(snapshot.entries.length, cursor + (args.limit ?? 100));
        const bearer = bearerTokenFromRequest(context.request) ?? null;
        while (cursor < end) {
          const entry = snapshot.entries[cursor]!;
          if (!safeEntry(entry, bearer)) return toolError('PROJECT_CATALOG_ENTRY_UNSAFE', 'A project catalog entry is too large or cannot be returned safely', 0);
          if (JSON.stringify({projects:[...projects,entry],nextOffset:cursor+1}).length > BUDGET) {
            if (!projects.length) return toolError('PROJECT_CATALOG_ENTRY_UNSAFE', 'A project catalog entry is too large or cannot be returned safely', 0);
            break;
          }
          projects.push(entry); indices.push(cursor++);
        }
        if (!current(context) || !snapshot.revalidate(indices) || !current(context)) return denied();
        const hasMore = cursor < snapshot.entries.length;
        return toolOk({ projects, ...(hasMore ? {nextOffset:cursor} : {}) }, 0, {truncated:hasMore});
      } catch { return toolError('PROJECT_CATALOG_FAILED', 'Unable to list projects', 0); }
    },
  });
}

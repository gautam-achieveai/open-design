import { z } from 'zod';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { projectPluginCatalog } from '../services/plugin-catalog.js';
import { resolveCatalogAccess, type CatalogAccessDeps, type CatalogScope as Scope } from './catalog-access.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';

const OPERATION = 'catalog/plugins:list';
const PAGE_BUDGET = 8_000;
const MAX_PAGE = 100;
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;
type Snapshot = { entries: InstalledPluginRecord[]; incomplete?: boolean; revalidate: (indices: readonly number[]) => boolean };

function safeEntry(entry: unknown, bearer: string | null): boolean {
  let units = 0, nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 2_000 || depth > 24 || ++units > PAGE_BUDGET) return false;
    if (typeof value === 'string') {
      units += value.length;
      return units <= PAGE_BUDGET && !TOKEN.test(value) && !(bearer && value.includes(bearer));
    }
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1));
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      units += key.length;
      if (units > PAGE_BUDGET || TOKEN.test(key) || (bearer && key.includes(bearer)) || !visit((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(entry, 0);
}

/** Inventory is an observed, non-atomic view; offsets can change between calls. */
export function registerPluginCatalogMcpTool(registry: McpToolRegistry, deps: CatalogAccessDeps & {
  listPluginSnapshot: (scope: Scope) => Promise<Snapshot>;
}): void {
  registry.register({
    name: 'list_plugins', operation: OPERATION, version: 1,
    description: 'List plugins observed for the pinned workspace, or the unbound catalog for an external credential. Inventory and offsets can change between calls.',
    annotations: { readOnlyHint: true },
    schema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(),
      limit: z.number().int().min(1).max(MAX_PAGE).optional(),
      pluginWorkflowId: z.unknown().optional().describe('Unsupported by HTTP MCP.') }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'MCP credential is required', 0);
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      try {
        const access = resolveCatalogAccess(context, OPERATION, deps);
        if (!access) return denied();
        const snapshot = await deps.listPluginSnapshot(access.scope);
        if (!access.current()) return denied();
        if (snapshot.incomplete) return toolError('PLUGIN_CATALOG_INCOMPLETE', 'Plugin catalog could not be read safely', 0);
        const all = projectPluginCatalog(snapshot.entries);
        const selected: typeof all = [];
        const indices: number[] = [];
        let cursor = args.offset ?? 0;
        const end = Math.min(all.length, cursor + (args.limit ?? MAX_PAGE));
        const bearer = bearerTokenFromRequest(context.request) ?? null;
        while (cursor < end) {
          const entry = all[cursor]!;
          if (!safeEntry(entry, bearer)) return toolError('PLUGIN_CATALOG_ENTRY_UNSAFE', 'A plugin catalog entry is too large or cannot be returned safely', 0);
          if (JSON.stringify({ plugins: [...selected, entry], nextOffset: cursor + 1 }).length > PAGE_BUDGET) {
            if (!selected.length) return toolError('PLUGIN_CATALOG_ENTRY_UNSAFE', 'A plugin catalog entry is too large or cannot be returned safely', 0);
            break;
          }
          selected.push(entry);
          indices.push(cursor++);
        }
        if (!snapshot.revalidate(indices) || !access.current()) return denied();
        const hasMore = cursor < all.length;
        return toolOk({ plugins: selected, ...(hasMore ? { nextOffset: cursor } : {}) }, 0, { truncated: hasMore });
      } catch {
        return toolError('PLUGIN_CATALOG_FAILED', 'Unable to list plugins', 0);
      }
    },
  });
}

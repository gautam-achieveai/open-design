import { z } from 'zod';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { projectSkillCatalog, type SkillCatalogEntry } from '../services/skill-catalog.js';
import type { SkillInfo } from '../skills.js';
import { resolveCatalogAccess, type CatalogAccessDeps, type CatalogScope as Scope } from './catalog-access.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';

const OPERATION = 'catalog/skills:list';
// Each item appears twice in the MCP envelope, with additional JSON escaping.
const PAGE_BUDGET = 8_000;
const MAX_PAGE = 100;
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;

/** Refuse a single oversized or bearer-bearing entry instead of corrupting its identity. */
function safeEntry(value: unknown, bearer: string | null): boolean {
  let units = 0, nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 2_000 || depth > 24 || ++units > PAGE_BUDGET) return false;
    if (typeof item === 'string') {
      units += item.length;
      return units <= PAGE_BUDGET && !TOKEN.test(item) && !(bearer && item.includes(bearer));
    }
    if (!item || typeof item !== 'object') return true;
    if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      units += key.length;
      if (units > PAGE_BUDGET || TOKEN.test(key) || (bearer && key.includes(bearer))
        || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function pageSkills(skills: SkillCatalogEntry[], offset: number, limit: number, bearer: string | null) {
  const selected: SkillCatalogEntry[] = [];
  let cursor = offset;
  for (const skill of skills.slice(offset, offset + limit)) {
    if (!safeEntry(skill, bearer)) return null;
    const next = { skills: [...selected, skill], nextOffset: cursor + 1 };
    if (JSON.stringify(next).length > PAGE_BUDGET) {
      if (!selected.length) return null;
      break;
    }
    selected.push(skill);
    cursor++;
  }
  const hasMore = cursor < skills.length;
  return { data: { skills: selected, ...(hasMore ? { nextOffset: cursor } : {}) }, truncated: hasMore };
}

/** Skill visibility is resolved using the run's pinned workspace and member. */
export function registerSkillCatalogMcpTool(registry: McpToolRegistry, deps: CatalogAccessDeps & {
  listSkillsSnapshot: (scope: Scope) => Promise<{ entries: SkillInfo[]; revalidate: (selectedIds: readonly string[]) => boolean }>;
}): void {
  registry.register({
    name: 'list_skills', operation: OPERATION, version: 1,
    description: 'List skills visible to this run’s pinned workspace, or the unbound catalog for an external credential. Pages can change between calls.',
    annotations: { readOnlyHint: true },
    schema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(),
      limit: z.number().int().min(1).max(MAX_PAGE).optional(),
      pluginWorkflowId: z.unknown().optional().describe('Unsupported by the HTTP transport.') }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'MCP credential is required', 0);
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      try {
        const access = resolveCatalogAccess(context, OPERATION, deps);
        if (!access) return denied();
        const snapshot = await deps.listSkillsSnapshot(access.scope);
        if (!access.current()) return denied();
        const page = pageSkills(projectSkillCatalog(snapshot.entries), args.offset ?? 0, args.limit ?? MAX_PAGE, bearerTokenFromRequest(context.request) ?? null);
        if (!page) return toolError('SKILL_CATALOG_ENTRY_UNSAFE', 'A skill catalog entry is too large or cannot be returned safely', 0);
        if (!snapshot.revalidate(page.data.skills.map((entry) => entry.id)) || !access.current()) return denied();
        return toolOk(page.data, 0, { truncated: page.truncated });
      } catch {
        return toolError('SKILL_CATALOG_FAILED', 'Unable to list skills', 0);
      }
    },
  });
}

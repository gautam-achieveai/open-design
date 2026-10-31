import { z } from 'zod';
import { projectAgentCatalog } from '../services/agent-catalog-projection.js';
import { resolveCatalogAccess, type CatalogAccessDeps } from './catalog-access.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const OPERATION = 'catalog/agents:list';
// Result-object budget, not the JSON-RPC/HTTP wire envelope. Keep a small
// reserve for timing representation and registry metadata.
const CATALOG_RESULT_BUDGET = 32_000 - 128;
const DEFAULT_PAGE_SIZE = 100;

function withinPreflight(value: unknown): boolean {
  let units = 0, nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 5_000 || depth > 32 || ++units > CATALOG_RESULT_BUDGET) return false;
    if (typeof item === 'string') { units += item.length; return units <= CATALOG_RESULT_BUDGET; }
    if (!item || typeof item !== 'object') return true;
    if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      units += key.length;
      if (units > CATALOG_RESULT_BUDGET || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function boundedAgentPage(agents: Array<Record<string, unknown>>, offset: number, limit: number) {
  const page = agents.slice(offset, offset + limit);
  const selected: Array<Record<string, unknown>> = [];
  let cursor = offset;
  let compacted = false;
  const result = () => {
    const hasMore = cursor < agents.length;
    return { data: { agents: selected, ...(hasMore ? { nextOffset: cursor } : {}) }, truncated: hasMore || compacted };
  };
  const fits = () => {
    const candidate = result();
    return withinPreflight(candidate.data) && toolOkFitsUtf8Bytes(candidate.data, candidate.truncated, 1, CATALOG_RESULT_BUDGET);
  };
  for (const agent of page) {
    selected.push(agent); cursor++;
    if (fits()) continue;
    selected.pop(); cursor--;
    if (selected.length) break;
    // Keep complete identity and counts. A single item whose mandatory fields
    // cannot fit is an explicit error, rather than a shortened identifier.
    const minimal: Record<string, unknown> = { ...agent, models: [], entryTruncated: true };
    selected.push(minimal); cursor++; compacted = true;
    if (!fits()) return null;
    const models = Array.isArray(agent.models) ? agent.models : [];
    const accepted = minimal.models as unknown[];
    for (const model of models) {
      accepted.push(model);
      if (!fits()) { accepted.pop(); break; }
    }
    break;
  }
  return result();
}

/** The inventory is machine-global; each call still needs its catalog operation. */
export function registerAgentCatalogMcpTool(registry: McpToolRegistry, deps: CatalogAccessDeps & {
  listOfferedAgents: () => Promise<readonly unknown[]>;
}): void {
  registry.register({
    name: 'list_agents', operation: OPERATION, version: 1,
    description: 'List the agent runtimes available to OpenDesign.',
    annotations: { readOnlyHint: true },
    schema: z.object({
      includeUnavailable: z.boolean().optional(),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Zero-based index for the next page; inventory may change between calls.'),
      limit: z.number().int().min(1).max(DEFAULT_PAGE_SIZE).optional(),
      pluginWorkflowId: z.unknown().optional().describe('Unsupported by the HTTP transport.'),
    }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'MCP credential is required', 0);
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      try {
        const access = resolveCatalogAccess(context, OPERATION, deps);
        if (!access) return denied();
        const agents = await deps.listOfferedAgents();
        if (!access.current()) return denied();
        const projected = projectAgentCatalog(agents, args.includeUnavailable === true);
        const page = boundedAgentPage(projected.agents, args.offset ?? 0, args.limit ?? DEFAULT_PAGE_SIZE);
        if (!page) return toolError('AGENT_CATALOG_ENTRY_TOO_LARGE', 'An agent catalog entry exceeds the output limit', 0);
        return toolOk(page.data, 0, { truncated: page.truncated });
      } catch {
        return toolError('AGENT_CATALOG_FAILED', 'Unable to list agent runtimes', 0);
      }
    },
  });
}

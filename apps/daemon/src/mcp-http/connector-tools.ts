import { z } from 'zod';
import { ConnectorDispatchDeniedError, ConnectorServiceError, type ConnectorService } from '../connectors/service.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { executeAuthorizedConnectorTool, listConnectorTools } from '../tools/connectors.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';
import { collectionPage, collectionPageSchema } from './collection-pages.js';

const LIST_ENDPOINT = '/api/tools/connectors/list';
const LIST_OPERATION = 'connectors:list';

export function registerConnectorMcpTools(
  registry: McpToolRegistry,
  deps: Parameters<typeof authorizeCurrentRunProject>[1] & {
    tokenRegistry: ToolTokenRegistry;
    projectsRoot: string;
    service: ConnectorService;
    projectExists: (projectId: string) => boolean;
  },
): void {
  const current = (context: import('./registry.js').McpToolContext, runId: string, projectId: string, endpoint: string, operation: string) => {
    try {
      if (!context.request || context.signal?.aborted || !deps.projectExists(projectId)) return false;
      const checked = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), { endpoint, operation });
      return checked.ok && checked.grant.runId === runId && checked.grant.projectId === projectId
        && authorizeCurrentRunProject({ request: context.request, runId, projectId, options: { mode: 'read' } }, deps);
    } catch { return false; }
  };
  registry.register({
    name: 'connectors_list',
    description: 'List connected read-only connector tools. Follow page.nextCursor; connectors can span pages. If inventory changes, restart the listing.',
    operation: LIST_OPERATION,
    version: 1,
    annotations: { readOnlyHint: true },
    schema: z.object({ useCase: z.enum(['personal_daily_digest']).optional(), cursor: z.string().min(1).max(collectionPageSchema.cursor.maxLength).optional(),
      limit: z.number().int().min(1).max(collectionPageSchema.maxItems).optional() }).strict(),
    handler: async (args, context) => {
      if (context.grant.kind !== 'run') {
        return toolError('EXTERNAL_APPROVAL_REQUIRED', 'external connector access requires trusted credential issuance', 0);
      }
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'run token is required', 0);
      const validated = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), {
        endpoint: LIST_ENDPOINT,
        operation: LIST_OPERATION,
      });
      if (!validated.ok) return toolError(validated.code, validated.message, 0);
      if (validated.grant.runId !== context.grant.runId || validated.grant.projectId !== context.grant.projectId) {
        return toolError('PROJECT_SCOPE_DENIED', 'run or project is outside the caller scope', 0);
      }
      const { runId, projectId } = validated.grant;
      if (!current(context, runId, projectId, LIST_ENDPOINT, LIST_OPERATION)) {
        return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      }
      try {
        const connectors = await listConnectorTools({
          grant: validated.grant,
          projectsRoot: deps.projectsRoot,
          service: deps.service,
          ...(args.useCase === undefined ? {} : { useCase: args.useCase }),
        });
        if (!current(context, runId, projectId, LIST_ENDPOINT, LIST_OPERATION)) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
        const entries = connectors.flatMap((connector, connectorIndex) => connector.tools.map((_, toolIndex) => ({ connectorIndex, toolIndex, compact: false })));
        const page = collectionPage({ entries, domain: 'connectors_list', scope: { projectId, runId, useCase: args.useCase ?? null, connectors },
          cursor: args.cursor, limit: args.limit, token: bearerTokenFromRequest(context.request),
          render: (items) => {
            const grouped = new Map<number, Record<string, unknown>>();
            for (const item of items) {
              const source = connectors[item.connectorIndex]!;
              const tool = source.tools[item.toolIndex]!;
              let group = grouped.get(item.connectorIndex);
              if (!group) {
                const { tools: _tools, ...header } = source;
                group = item.compact
                  ? { id: source.id, name: source.name, provider: source.provider, category: source.category, status: source.status, tools: [], entryTruncated: true }
                  : { ...header, tools: [] };
                grouped.set(item.connectorIndex, group);
              }
              (group.tools as unknown[]).push(item.compact
                ? { name: tool.name, title: tool.title, safety: { sideEffect: tool.safety.sideEffect, approval: tool.safety.approval }, refreshEligible: tool.refreshEligible, entryTruncated: true }
                : tool);
            }
            return { connectors: [...grouped.values()] };
          },
          compact: (entry) => ({ ...entry, compact: true }),
        });
        if (!page.ok) return toolError(page.code, page.code === 'INVENTORY_CHANGED' ? 'Connector inventory changed; restart listing' : 'Unable to return this connector page', 0);
        return toolOk(page.data, 0, page.truncated ? { truncated: true } : undefined);
      } catch {
        // Provider failures may contain authorization headers or request data.
        return toolError('CONNECTOR_EXECUTION_FAILED', 'Unable to list connector tools', 0);
      }
    },
  });
  registry.register({
    name: 'connectors_execute',
    description: 'Execute an approved read-only connector tool for the current run.',
    operation: 'connectors:execute',
    version: 1,
    annotations: { readOnlyHint: true },
    schema: z.strictObject(
      { connectorId: z.string().min(1), toolName: z.string().min(1), input: z.record(z.string(), z.unknown()) },
      { error: (issue) => issue.code === 'unrecognized_keys' ? 'Unexpected argument' : undefined },
    ),
    handler: async (args, context) => {
      if (context.grant.kind !== 'run') return toolError('EXTERNAL_APPROVAL_REQUIRED', 'external connector access requires trusted credential issuance', 0);
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'run token is required', 0);
      const validated = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), {
        endpoint: '/api/tools/connectors/execute', operation: 'connectors:execute',
      });
      if (!validated.ok) return toolError(validated.code, validated.message, 0);
      if (validated.grant.runId !== context.grant.runId || validated.grant.projectId !== context.grant.projectId) {
        return toolError('PROJECT_SCOPE_DENIED', 'run or project is outside the caller scope', 0);
      }
      const { runId, projectId } = validated.grant;
      const authorize = () => current(context, runId, projectId, '/api/tools/connectors/execute', 'connectors:execute');
      if (!authorize()) {
        return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      }
      try {
        const outcome = await executeAuthorizedConnectorTool(args, {
          grant: validated.grant, projectsRoot: deps.projectsRoot, service: deps.service, authorizeBeforeDispatch: authorize,
        });
        if (!authorize()) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
        if (!outcome.ok) return toolError(outcome.code, 'Connector tool request denied', 0);
        return toolOk(outcome.result, 0);
      } catch (error) {
        if (error instanceof ConnectorDispatchDeniedError) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
        return toolError(error instanceof ConnectorServiceError ? error.code : 'CONNECTOR_EXECUTION_FAILED', 'Connector tool execution failed', 0);
      }
    },
  });
}

import { z } from 'zod';
import type { DecideProjectRequestSync } from '../collab/project-request-authority.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { enrichRunToolResult, fitRunAgentText, runAgentText } from '../services/run-tool-result.js';
import type { ProjectRunCommandService } from '../services/project-run-commands.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const OPERATION = 'run/run:read';
type Run = { id: string; projectId: string | null; status: string };
type Event = { event: string; data?: unknown };
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Native REST validation/durable hydration, shared stdio delivery, current external authority. */
export function registerExternalRunStatusMcpTool<TRun extends Run>(registry: McpToolRegistry, deps: {
  toolTokenRegistry: ToolTokenRegistry;
  credentialStore: McpCredentialStore;
  peekRunProjectId: (id: string) => string | null;
  peekInMemoryRun: (id: string) => TRun | null | undefined;
  queryRun: ProjectRunCommandService['getRun'];
  readRunEvents: (run: TRun, assertCurrent: () => void) => Promise<readonly Event[]>;
  readUnboundProjectDetail: (id: string) => Promise<{ revalidate: () => boolean } | null>;
  isUnboundProjectCurrentlyVisible: (id: string) => boolean;
  decideProjectRequest: DecideProjectRequestSync;
  getOrigins: () => Promise<{ daemonBaseUrl: string; webBaseUrl: string | null }>;
}): void {
  registry.register({
    name: 'get_run', operation: OPERATION, version: 1, annotations: { readOnlyHint: false },
    description: 'Poll an exact run for a visible unbound project, including durable history and validated delivery links. Current runtime links are refreshed on each call.',
    schema: z.object({ runId: z.string().min(1).max(128), pluginWorkflowId: z.unknown().optional().describe('Unsupported by HTTP MCP.') }).strict(),
    handler: async (args, context) => {
      const unavailable = () => toolError('RUN_UNAVAILABLE', 'Run unavailable in this scope', 0);
      const partial = () => toolError('RUN_QUERY_STARTED_RESULT_UNAVAILABLE', 'Status preparation may have updated local state; its response is unavailable.', 0);
      let effectsStarted = false;
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      const request = context.request;
      if (context.grant.kind !== 'external' || !request) return unavailable();
      const hasWorkspace = () => Object.keys(request.headers ?? {}).some(key => key.toLowerCase().startsWith('x-od-workspace-'))
        || request.get('x-od-workspace-id') !== undefined || request.get('x-od-workspace-member-id') !== undefined;
      if (hasWorkspace()) return toolError('WORKSPACE_SCOPE_UNSUPPORTED', 'Workspace-scoped external run access is not supported', 0);
      try {
        const credentialCurrent = () => {
          if (context.signal?.aborted || hasWorkspace()) return false;
          const auth = resolveMcpGrant(request, deps);
          return auth.ok && auth.grant.kind === 'external' && Boolean(auth.grant.credentialId)
            && auth.grant.credentialId === context.grant.credentialId && operationAllowed(auth.grant.allowedOperations, OPERATION);
        };
        if (!credentialCurrent() || !/^[A-Za-z0-9._-]+$/u.test(args.runId) || /^\.+$/u.test(args.runId)) return unavailable();
        const projectId = deps.peekRunProjectId(args.runId);
        if (!projectId) return unavailable();
        const snapshot = await deps.readUnboundProjectDetail(projectId);
        if (!snapshot || !snapshot.revalidate() || !credentialCurrent()) return unavailable();
        let selectedRun: TRun | null = null;
        const current = () => credentialCurrent() && deps.peekRunProjectId(args.runId) === projectId
          && (!selectedRun || deps.peekInMemoryRun(args.runId) === selectedRun)
          && (effectsStarted || snapshot.revalidate()) && deps.isUnboundProjectCurrentlyVisible(projectId)
          && deps.decideProjectRequest(request, projectId, { mode: 'read' }).ok && credentialCurrent();
        const assertCurrent = () => { if (!current()) throw new Error('Run access changed'); };
        if (!current()) return unavailable();
        const result = await deps.queryRun({ runId: args.runId, projectId, signal: context.signal,
          assertCurrent: current, onMutationStarting: () => { effectsStarted = true; } });
        effectsStarted ||= result.mutationStarted;
        if (!current()) return effectsStarted ? partial() : unavailable();
        const status = object(result.body);
        if (result.status >= 400 || !status || status.id !== args.runId || status.projectId !== projectId) return unavailable();
        selectedRun = deps.peekInMemoryRun(args.runId) ?? null;
        if (!selectedRun || selectedRun.projectId !== projectId || !current()) return unavailable();
        const text = status.status === 'succeeded'
          ? runAgentText(await deps.readRunEvents(selectedRun, assertCurrent))
          : { message: null, truncated: false };
        assertCurrent();
        const origins = await deps.getOrigins();
        assertCurrent();
        const data = enrichRunToolResult(status, { ...origins, agentMessage: text.message, agentMessageTruncated: text.truncated });
        const serialized = JSON.stringify(data), bearer = bearerTokenFromRequest(request);
        // Text was bounded before formatting. Reject sensitive/oversized base
        // status, then trim only agent text to fit the full duplicated envelope.
        if (serialized.length > 64_000 || /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/u.test(serialized) || (bearer && serialized.includes(bearer))) {
          return toolError('RUN_STATUS_UNSAFE', 'Run status cannot be returned safely', 0);
        }
        const fitted = fitRunAgentText(data, value => JSON.stringify(value).length <= 16_000 && toolOkFitsUtf8Bytes(value, false, 1, 32_000));
        if (!fitted) return toolError('RUN_STATUS_UNSAFE', 'Run status exceeds the output limit', 0);
        assertCurrent();
        return toolOk(fitted, 0);
      } catch {
        return effectsStarted ? partial() : unavailable();
      }
    },
  });
}
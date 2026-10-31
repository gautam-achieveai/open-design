import { z } from 'zod';
import type { DecideProjectRequestSync } from '../collab/project-request-authority.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { RunCancellationOptions } from '../routes/runs.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const OPERATION = 'run/run:cancel';
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/u;
// The canonical default status is about 10k characters. Bound both its walk
// and the complete duplicated MCP representations without dropping fields.
const MAX_STATUS_UNITS = 16_000;
type Run = { id: string; projectId: string | null };
type Status = { id: string; projectId: string | null };
const safeId = (value: string) => /^[A-Za-z0-9._-]{1,128}$/u.test(value) && !/^\.+$/u.test(value);

/** Reject unsafe status before serialization; the action itself is never retried. */
function safeStatus(value: unknown, bearer: string | null): boolean {
  let nodes = 0, units = 0;
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 2000 || depth > 24 || ++units > MAX_STATUS_UNITS) return false;
    if (typeof item === 'string') {
      units += item.length;
      return units <= MAX_STATUS_UNITS && !TOKEN.test(item) && !(bearer && item.includes(bearer));
    }
    if (!item || typeof item !== 'object') return true;
    if (ancestors.has(item)) return false;
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        units += key.length;
        if (units > MAX_STATUS_UNITS || TOKEN.test(key) || (bearer && key.includes(bearer)) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
      }
      return true;
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

/** Exact external cancellation; every target lookup remains in the current map. */
export function registerExternalRunCancelMcpTool<TRun extends Run, TStatus extends Status>(registry: McpToolRegistry, deps: {
  toolTokenRegistry: ToolTokenRegistry;
  credentialStore: McpCredentialStore;
  peekInMemoryRun: (id: string) => TRun | null | undefined;
  readUnboundProjectDetail: (id: string) => Promise<{ revalidate: () => boolean } | null>;
  decideProjectRequest: DecideProjectRequestSync;
  beginCancelRun: (run: TRun, options: RunCancellationOptions<TRun>) => { completion: Promise<TRun> };
  readRunStatus: (run: TRun) => TStatus;
}): void {
  registry.register({
    name: 'cancel_run', operation: OPERATION, version: 1,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: 'Cancel an exact in-memory run for a visible unbound project. Requires an external credential authorized for run/run:cancel. Durable-only and workspace-scoped runs are unavailable. A partial outcome can mean task state changed before physical cancellation was confirmed.',
    schema: z.object({ runId: z.string().min(1).max(128) }).strict(),
    handler: async (args, context) => {
      const unavailable = () => toolError('RUN_UNAVAILABLE', 'Run unavailable in this scope or in-memory cache', 0);
      let actionMayHaveStarted = false;
      let physicalDispatchStarted = false;
      const partial = () => toolError('CANCEL_STARTED_RESULT_UNAVAILABLE', physicalDispatchStarted
        ? 'Cancellation dispatch was attempted; its result is unavailable.'
        : 'Task cancellation may have changed state; physical cancellation was not confirmed.', 0);
      try {
        const request = context.request;
        if (context.grant.kind !== 'external' || !request || !safeId(args.runId)) return unavailable();
        const current = () => {
          if (context.signal?.aborted || Object.keys(request.headers ?? {}).some(key => key.toLowerCase().startsWith('x-od-workspace-'))) return false;
          const auth = resolveMcpGrant(request, deps);
          return auth.ok && auth.grant.kind === 'external' && Boolean(auth.grant.credentialId)
            && auth.grant.credentialId === context.grant.credentialId
            && operationAllowed(auth.grant.allowedOperations, OPERATION);
        };
        if (!current()) return unavailable();
        const requestedRun = deps.peekInMemoryRun(args.runId);
        if (!requestedRun || requestedRun.id !== args.runId || !requestedRun.projectId) return unavailable();
        const projectId = requestedRun.projectId;
        const snapshot = await deps.readUnboundProjectDetail(projectId);
        if (!snapshot) return unavailable();
        const validate: NonNullable<RunCancellationOptions<TRun>['validate']> = (target, task) => current()
          && deps.peekInMemoryRun(args.runId) === requestedRun && requestedRun.projectId === projectId
          && deps.peekInMemoryRun(target.id) === target && target.projectId === projectId
          && (!task || (task.projectId === projectId && (!task.activeRunId || task.activeRunId === target.id)))
          && snapshot.revalidate()
          && deps.decideProjectRequest(request, projectId, { mode: 'write', capability: 'writeFiles' }).ok
          && current() && deps.peekInMemoryRun(args.runId) === requestedRun
          && requestedRun.projectId === projectId && deps.peekInMemoryRun(target.id) === target && target.projectId === projectId;
        if (!validate(requestedRun, null)) return unavailable();
        const started = deps.beginCancelRun(requestedRun, {
          resolveTarget: (id) => {
            const target = safeId(id) ? deps.peekInMemoryRun(id) : null;
            if (!target || target.id !== id) throw new Error('Run unavailable');
            return target;
          },
          validate,
          onTaskCancellationStarting: () => { actionMayHaveStarted = true; },
          onPhysicalCancellationStarting: () => { actionMayHaveStarted = true; physicalDispatchStarted = true; },
        });
        const selectedRun = await started.completion;
        if (!validate(selectedRun, null)) return partial();
        // The shared projection can fail an invalid active strategy run.
        const status = deps.readRunStatus(selectedRun);
        if (!validate(selectedRun, null) || status.id !== selectedRun.id || status.projectId !== projectId) return partial();
        const data = { ok: true, run: status };
        if (!safeStatus(data, bearerTokenFromRequest(request) ?? null) || !toolOkFitsUtf8Bytes(data, false, 1, 32_000)) return partial();
        return toolOk(data, 0);
      } catch {
        return actionMayHaveStarted ? partial() : unavailable();
      }
    },
  });
}

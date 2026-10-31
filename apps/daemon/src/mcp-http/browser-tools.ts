import { z } from 'zod';
import { BROWSER_SNAPSHOT_TOOL_DESCRIPTION } from '../prompts/browser-tooling.js';
import type { Request } from 'express';
import type { BrowserOperationRequest, BrowserOperationResult } from '@open-design/contracts';
import { BROWSER_DEVTOOLS_ACTIONS, BROWSER_DEVTOOLS_MAX_PARAMS_LENGTH, BROWSER_EVALUATE_MAX_EXPRESSION_LENGTH, browserDevtoolsActionMutates, isBrowserDevtoolsAction, isBrowserStylePatch } from '@open-design/contracts';
import type { BrowserCommandBroker } from '../services/browser-command-broker.js';
import { BrowserBrokerError } from '../services/browser-command-broker.js';
import type { ApprovalPrincipal, McpApprovalStore } from './approval-store.js';
import { type McpAuthGrant, type McpToolContext, McpToolRegistry, redactSecrets, toolError, toolOk } from './registry.js';

// The desktop host rejects selectors longer than this across all operations.
const target = z.object({ selector: z.string().trim().min(1).max(4096) }).strict();
const common = {
  projectId: z.string().trim().min(1).max(8192).optional(),
  tabId: z.string().trim().min(1).max(8192).optional(),
};
const limit = z.number().finite().min(1).max(1000).optional();
const MAX_PNG_DATA_URL_CHARS = 3 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Data is sent twice (as structured content and JSON text); the latter is
// escaped again in the wire envelope. Reserve for both representations.
const BROWSER_TEXT_BUDGET = 9_000;
// Registry timing and tool-version metadata are added after shaping. Reserve
// room for them so a near-limit response stays below the envelope budget.
const BROWSER_RESPONSE_BUDGET = 31_800;
const TRUNCATION_MARKER = '[truncated]';

/** Avoid serializing a potentially large renderer value merely to check its size. */
function browserReadFitsPreflight(value: unknown): boolean {
  let units = 0, nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 5000 || depth > 32 || ++units > 12_000) return false;
    if (typeof item === 'string') { units += item.length; return units <= 12_000; }
    if (!item || typeof item !== 'object') return true;
    if (Array.isArray(item)) {
      for (const child of item) if (!visit(child, depth + 1)) return false;
      return true;
    }
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      units += key.length + 2;
      if (units > 12_000 || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

/** Produce a valid partial JSON value with an exact serialized-character budget. */
function clipBrowserJson(value: unknown, maxChars: number): { value: unknown; truncated: boolean } {
  let remaining = maxChars;
  let truncated = false;
  let nodes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 5000 || depth > 32) { truncated = true; return undefined; }
    if (typeof input === 'string') {
      if (input.length <= remaining) {
        const full = JSON.stringify(input);
        if (full.length <= remaining) { remaining -= full.length; return input; }
      }
      truncated = true;
      let low = 0, high = Math.min(input.length, remaining), best: string | undefined;
      while (low <= high) {
        let end = Math.floor((low + high) / 2);
        if (end > 0 && end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]!)) end--;
        const candidate = input.slice(0, end) + TRUNCATION_MARKER;
        if (JSON.stringify(candidate).length <= remaining) { best = candidate; low = Math.floor((low + high) / 2) + 1; }
        else high = Math.floor((low + high) / 2) - 1;
      }
      if (best === undefined) return undefined;
      remaining -= JSON.stringify(best).length;
      return best;
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      const encoded = JSON.stringify(input);
      if (encoded === undefined || encoded.length > remaining) { truncated = true; return undefined; }
      remaining -= encoded.length;
      return input;
    }
    if (!input || typeof input !== 'object' || remaining < 2) { truncated = true; return undefined; }
    remaining -= 2;
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      for (const item of input) {
        const separator = output.length ? 1 : 0;
        if (remaining < separator) { truncated = true; break; }
        remaining -= separator;
        const next = visit(item, depth + 1);
        if (next === undefined) { remaining += separator; truncated = true; break; }
        output.push(next);
      }
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    let count = 0, inspected = 0;
    // Keep descriptive fields before large nested child arrays. No object-key
    // array or sorting is needed, even for a very large renderer object.
    for (const objects of [false, true]) {
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (++inspected > 5000) { truncated = true; return output; }
        const item = (input as Record<string, unknown>)[key];
        if (Boolean(item && typeof item === 'object') !== objects) continue;
        if (key.length + 2 > remaining) { truncated = true; return output; }
        const overhead = JSON.stringify(key).length + 1 + (count ? 1 : 0);
        if (remaining < overhead) { truncated = true; return output; }
        remaining -= overhead;
        const next = visit(item, depth + 1);
        if (next === undefined) { remaining += overhead; truncated = true; return output; }
        output[key] = next;
        count++;
      }
    }
    return output;
  };
  return { value: visit(value, 0) ?? null, truncated };
}

function boundedBrowserRead(result: BrowserOperationResult) {
  if (browserReadFitsPreflight(result) && JSON.stringify(toolOk(result, 0)).length <= BROWSER_RESPONSE_BUDGET) return toolOk(result, 0);
  if (result.operation === 'console' || result.operation === 'network-list' || result.operation === 'network-failures') {
    const entries: unknown[] = [];
    let used = 0;
    let clipped = false;
    for (let index = result.entries.length - 1; index >= 0; index--) {
      const item = clipBrowserJson(result.entries[index], 4000);
      const size = JSON.stringify(item.value).length + 1;
      if (used + size > BROWSER_TEXT_BUDGET - 512) break;
      entries.unshift(item.value);
      used += size;
      clipped ||= item.truncated;
    }
    const omittedEntries = result.entries.length - entries.length;
    return toolOk({ operation: result.operation, entries, omittedEntries }, 0, { truncated: clipped || omittedEntries > 0 });
  }
  if (result.operation === 'snapshot' || result.operation === 'inspect' || result.operation === 'network-get' || result.operation === 'devtools') {
    const field = result.operation === 'snapshot' ? 'snapshot' : result.operation === 'inspect' ? 'inspection'
      : result.operation === 'network-get' ? 'entry' : 'result';
    const clipped = clipBrowserJson((result as unknown as Record<string, unknown>)[field], BROWSER_TEXT_BUDGET - 512);
    const data: Record<string, unknown> = { operation: result.operation, [field]: clipped.value };
    if (result.operation === 'devtools') data.action = result.action;
    // The desktop's own snapshot flag must not say the returned tree is whole.
    if (result.operation === 'snapshot' && data.snapshot && typeof data.snapshot === 'object' && !Array.isArray(data.snapshot)) {
      (data.snapshot as Record<string, unknown>).truncated = true;
    }
    return toolOk(data, 0, { truncated: true });
  }
  return toolError('BROWSER_RESULT_TOO_LARGE', 'Browser result exceeds the output limit', 0);
}

/** Preserve the completed mutation's discriminator when its result is large. */
function boundedBrowserMutation(result: BrowserOperationResult) {
  if (browserReadFitsPreflight(result) && JSON.stringify(toolOk(result, 0)).length <= BROWSER_RESPONSE_BUDGET) {
    return toolOk(result, 0, result.operation === 'evaluate' && result.truncated ? { truncated: true } : undefined);
  }
  const budget = BROWSER_TEXT_BUDGET - 512;
  if (result.operation === 'evaluate') {
    // A corrupt renderer must not replace a required discriminator with an
    // unbounded string that causes the registry to discard the whole result.
    if (typeof result.type !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(result.type)) {
      return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result metadata could not be returned. Do not automatically retry.', 0);
    }
    const value = clipBrowserJson(result.value, budget);
    return toolOk({ operation: 'evaluate', type: result.type, value: value.value, truncated: true }, 0, { truncated: true });
  }
  if (result.operation === 'style') {
    if (result.applied !== true) return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result metadata could not be returned. Do not automatically retry.', 0);
    const inspection = clipBrowserJson(result.inspection, budget);
    return toolOk({ operation: 'style', applied: true, inspection: inspection.value }, 0, { truncated: true });
  }
  if (result.operation === 'devtools') {
    if (!isBrowserDevtoolsAction(result.action)) return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result metadata could not be returned. Do not automatically retry.', 0);
    const partial = clipBrowserJson(result.result, budget);
    return toolOk({ operation: 'devtools', action: result.action, result: partial.value }, 0, { truncated: true });
  }
  if (result.operation === 'click' || result.operation === 'type' || result.operation === 'scroll') {
    const field = result.operation === 'click' ? 'clicked' : result.operation === 'type' ? 'typed' : 'scrolled';
    if ((result as unknown as Record<string, unknown>)[field] !== true) return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result metadata could not be returned. Do not automatically retry.', 0);
    const details = result.details === undefined ? undefined : clipBrowserJson(result.details, budget).value;
    return toolOk({ operation: result.operation, [field]: true, ...(details === undefined ? {} : { details }) }, 0, { truncated: true });
  }
  if (result.operation === 'viewport') {
    if (!['desktop', 'tablet', 'mobile'].includes(result.preset) || !Number.isFinite(result.width) || !Number.isFinite(result.height)) {
      return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result metadata could not be returned. Do not automatically retry.', 0);
    }
    return toolOk({ operation: result.operation, preset: result.preset, width: result.width, height: result.height }, 0, { truncated: true });
  }
  if (result.operation === 'navigate') {
    const url = clipBrowserJson(result.url, Math.floor(budget / 2));
    const title = result.title === undefined ? undefined : clipBrowserJson(result.title, Math.floor(budget / 4));
    const details = result.details === undefined ? undefined : clipBrowserJson(result.details, Math.floor(budget / 4));
    return toolOk({ operation: result.operation, url: url.value, ...(title === undefined ? {} : { title: title.value }),
      ...(details === undefined ? {} : { details: details.value }) }, 0, { truncated: true });
  }
  return toolError('BROWSER_RESULT_TOO_LARGE', 'The action may have executed, but its result could not be returned. Do not automatically retry.', 0);
}

export type CurrentApprovalPrincipal =
  | { ok: true; principal: ApprovalPrincipal }
  | { ok: false; code: string; message: string };

class ApprovalDispatchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function registerBrowserMcpTools(
  registry: McpToolRegistry,
  deps: {
    broker: BrowserCommandBroker;
    authorizeProject: (request: Request, projectId: string) => Promise<boolean>;
    authorizeCurrentRead: (request: Request, projectId: string, operation: string, grant: McpAuthGrant) => boolean;
    approval?: {
      store: McpApprovalStore;
      /** Must revalidate bearer, active run, operation and current write scope synchronously. */
      resolveCurrentPrincipal: (request: Request, projectId: string, operation: string) => CurrentApprovalPrincipal;
    };
  },
): void {
  async function execute(
    args: { projectId?: string | undefined; tabId?: string | undefined },
    grant: McpAuthGrant,
    request: Request | undefined,
    signal: AbortSignal | undefined,
    command: BrowserOperationRequest,
  ) {
    const projectId = grant.kind === 'run' ? grant.projectId : args.projectId;
    if (!projectId || (grant.kind === 'run' && args.projectId && args.projectId !== projectId)) {
      return toolError('PROJECT_SCOPE_DENIED', 'project is outside the caller scope', 0);
    }
    if (!request || !await deps.authorizeProject(request, projectId)) {
      return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
    }
    const current = () => deps.authorizeCurrentRead(request, projectId, `browser/${command.operation}`, grant);
    try {
      if (!current()) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      const result = await deps.broker.execute(projectId, args.tabId, command, undefined, signal);
      if (!current()) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      return result.result;
    } catch (error) {
      if (!current()) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      if (error instanceof BrowserBrokerError) return toolError(error.code, redactSecrets(error.message), 0);
      throw error;
    }
  }

  if (deps.approval) {
    const { store, resolveCurrentPrincipal } = deps.approval;
    const fingerprint = store.captureTarget.bind(store);
    const approvalRequestId = z.string().trim().min(1).max(128).optional();
    async function executeApproved(
      args: { projectId?: string | undefined; tabId?: string | undefined; approvalRequestId?: string | undefined },
      context: McpToolContext,
      operation: 'browser_click' | 'browser_type' | 'browser_navigate' | 'browser_scroll' | 'browser_viewport' | 'browser_style' | 'browser_evaluate' | 'browser_devtools',
      actionArgs: Record<string, unknown>,
      command: Extract<BrowserOperationRequest, { operation: 'click' | 'type' | 'navigate' | 'scroll' | 'viewport' | 'style' | 'evaluate' | 'devtools' }>,
    ) {
        const { grant, request } = context;
        const projectId = grant.kind === 'run' ? grant.projectId : args.projectId;
        if (!request || !projectId || (grant.kind === 'run' && args.projectId && args.projectId !== projectId)) {
          return toolError('PROJECT_SCOPE_DENIED', 'project is outside the caller scope', 0);
        }
        const current = (): ApprovalPrincipal => {
          const resolution = resolveCurrentPrincipal(request, projectId, `browser/${command.operation}`);
          if (!resolution || resolution.ok !== true) {
            throw new ApprovalDispatchError(resolution && resolution.ok === false ? resolution.code : 'PROJECT_SCOPE_DENIED',
              resolution && resolution.ok === false ? resolution.message : 'current authority denied');
          }
          const principal = resolution.principal;
          const ingressId = grant.kind === 'run' ? grant.runId : grant.credentialId;
          if (!principal || principal.kind !== grant.kind || principal.id !== ingressId || principal.projectId !== projectId) {
            throw new ApprovalDispatchError('PROJECT_SCOPE_DENIED', 'current authority differs from the calling grant');
          }
          return principal;
        };
        // A claimed mutation cannot be undone. Withhold its result if the
        // exact authority that consumed the approval is no longer current.
        let dispatchedPrincipal: ApprovalPrincipal | undefined;
        const resultAuthorityCurrent = (): boolean => {
          if (!dispatchedPrincipal) return false;
          try {
            const next = current();
            const previousScope = dispatchedPrincipal.scope;
            const nextScope = next.scope;
            return next.kind === dispatchedPrincipal.kind && next.id === dispatchedPrincipal.id
              && next.projectId === dispatchedPrincipal.projectId
              && (previousScope === null ? nextScope === null : nextScope !== null
                && previousScope.workspaceId === nextScope.workspaceId
                && previousScope.workspaceMemberId === nextScope.workspaceMemberId);
          } catch {
            return false;
          }
        };
        const resultAuthorityDenied = () => toolError('PROJECT_SCOPE_DENIED',
          'Browser authority changed; the action may have executed. Do not automatically retry.', 0);
        try {
          const principal = current();
          if (!args.approvalRequestId) {
            const target = deps.broker.captureApprovalTarget(projectId, args.tabId, fingerprint);
            const outcome = store.create({ principal, target, operation, args: actionArgs });
            if (!outcome.ok) return toolError(`APPROVAL_${outcome.code}`, 'could not create the browser approval', 0);
            return toolOk({ status: 'approval_required', approvalRequestId: outcome.approval.id, approval: outcome.approval }, 0);
          }
          const view = store.get(args.approvalRequestId);
          const target = store.getTarget(args.approvalRequestId);
          if (!view || !target || view.status === 'expired') {
            return toolError('APPROVAL_NOT_FOUND', 'approval is missing or expired', 0);
          }
          if (target.projectId !== projectId || (args.tabId !== undefined && args.tabId !== target.tabId)) {
            return toolError('APPROVAL_MISMATCH', 'approval does not match this target', 0);
          }
          const enqueued = deps.broker.enqueueIfCurrent({
            target, fingerprint, expiresAtMs: Date.parse(view.expiresAt),
            ...(context.signal ? { signal: context.signal } : {}),
            request: command.operation === 'devtools' && command.action === 'capture-throttle'
              ? { ...command, params: { ...command.params, nativeApprovalId: args.approvalRequestId } } : command,
            authorizeAndConsume: () => {
              const livePrincipal = current();
              const outcome = store.consume(args.approvalRequestId!, { principal: livePrincipal, target, operation, args: actionArgs });
              if (!outcome.ok) throw new ApprovalDispatchError(outcome.code === 'APPROVAL_REQUIRED' ? outcome.code : `APPROVAL_${outcome.code}`, 'approval is not valid for this action');
              dispatchedPrincipal = { ...livePrincipal, scope: livePrincipal.scope ? { ...livePrincipal.scope } : null };
              return undefined;
            },
          });
          const result = await enqueued.result;
          if (!resultAuthorityCurrent()) return resultAuthorityDenied();
          if (command.operation === 'devtools' && result.result.operation === 'devtools' && result.result.action !== command.action) {
            return toolError('BROWSER_RESULT_MISMATCH', 'The action may have executed, but its result did not match the request. Do not automatically retry.', 0);
          }
          return boundedBrowserMutation(result.result);
        } catch (error) {
          if (dispatchedPrincipal && !resultAuthorityCurrent()) return resultAuthorityDenied();
          if (error instanceof ApprovalDispatchError && error.code === 'APPROVAL_REQUIRED' && args.approvalRequestId) {
            const approval = store.get(args.approvalRequestId);
            if (approval) return toolOk({ status: 'approval_required', approvalRequestId: approval.id, approval }, 0);
          }
          if (error instanceof ApprovalDispatchError || error instanceof BrowserBrokerError) {
            return toolError(error.code, redactSecrets(error.message), 0);
          }
          throw error;
        }
    }
    registry.register({
      name: 'browser_click', operation: 'browser/click', version: 1,
      description: 'Request approval, then click the same target once using the returned approvalRequestId.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, target, button: z.enum(['left', 'middle', 'right']).default('left'),
        clickCount: z.number().int().min(1).max(3).default(1), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { target: args.target, button: args.button, clickCount: args.clickCount };
        return executeApproved(args, context, 'browser_click', action, { operation: 'click', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_type', operation: 'browser/type', version: 1,
      description: 'Request approval, then type into the same target once. The current desktop host supports at most 100,000 characters.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, target, text: z.string().min(1).max(100_000), clear: z.boolean().default(false), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { target: args.target, text: args.text, clear: args.clear };
        return executeApproved(args, context, 'browser_type', action, { operation: 'type', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_navigate', operation: 'browser/navigate', version: 1,
      description: 'Request approval, then navigate the same browser tab once.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common,
        url: z.string().trim().min(1).max(8192).refine((value) => {
          try {
            const normalized = new URL(value);
            return ['http:', 'https:'].includes(normalized.protocol) && normalized.toString().length <= 8192;
          } catch { return false; }
        }, 'url must be an absolute HTTP or HTTPS URL no longer than 8192 characters after normalization'),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { url: new URL(args.url).toString(), ...(args.waitUntil === undefined ? {} : { waitUntil: args.waitUntil }) };
        return executeApproved(args, context, 'browser_navigate', action, { operation: 'navigate', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_scroll', operation: 'browser/scroll', version: 1,
      description: 'Request approval, then scroll the same browser tab once.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, target: target.optional(), deltaX: z.number().finite().default(0), deltaY: z.number().finite().default(0), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { deltaX: args.deltaX, deltaY: args.deltaY, ...(args.target === undefined ? {} : { target: args.target }) };
        return executeApproved(args, context, 'browser_scroll', action, { operation: 'scroll', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_viewport', operation: 'browser/viewport', version: 1,
      description: 'Request approval, then set the browser viewport once.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, preset: z.enum(['desktop', 'tablet', 'mobile']), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { preset: args.preset };
        return executeApproved(args, context, 'browser_viewport', action, { operation: 'viewport', ...action });
      },
    });
    registry.register({
      name: 'browser_style', operation: 'browser/style', version: 1,
      description: 'Request approval, then apply a bounded style patch to the same target once.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, target, styles: z.record(z.string(), z.string()).refine(isBrowserStylePatch, 'styles must be a nonempty bounded object of allowed style strings'), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { target: args.target, styles: args.styles };
        return executeApproved(args, context, 'browser_style', action, { operation: 'style', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_evaluate', operation: 'browser/evaluate', version: 1,
      description: 'Request approval, then evaluate a JavaScript expression in the browser once.',
      annotations: { destructiveHint: true },
      schema: z.object({ ...common, expression: z.string().min(1).max(BROWSER_EVALUATE_MAX_EXPRESSION_LENGTH).refine((value) => !!value.trim(), 'expression is required'), approvalRequestId }).strict(),
      handler: async (args, context) => {
        const action = { expression: args.expression };
        return executeApproved(args, context, 'browser_evaluate', action, { operation: 'evaluate', approved: true, ...action });
      },
    });
    registry.register({
      name: 'browser_devtools', operation: 'browser/devtools', version: 1,
      description: `Use a named DevTools action. Mutating actions require approval. Actions: ${Object.keys(BROWSER_DEVTOOLS_ACTIONS).join(', ')}.`,
      schema: z.object({ ...common, action: z.string().refine(isBrowserDevtoolsAction, 'unknown DevTools action'),
        params: z.record(z.string(), z.json()).default({}).refine((value) => JSON.stringify(value).length <= BROWSER_DEVTOOLS_MAX_PARAMS_LENGTH, 'params is too long'), approvalRequestId }).strict(),
      handler: async (args, context) => {
        if (!isBrowserDevtoolsAction(args.action)) return toolError('INVALID_ARGS', 'unknown DevTools action', 0);
        const action = { action: args.action, params: args.params };
        if (browserDevtoolsActionMutates(args.action)) {
          return executeApproved(args, context, 'browser_devtools', action, { operation: 'devtools', approved: true, ...action });
        }
        if (args.approvalRequestId) return toolError('INVALID_ARGS', 'read-only DevTools actions do not take approvalRequestId', 0);
        const result = await execute(args, context.grant, context.request, context.signal, { operation: 'devtools', ...action });
        return 'structuredContent' in result ? result : boundedBrowserRead(result);
      },
    });
  }

  registry.register({
    name: 'browser_snapshot', operation: 'browser/snapshot', version: 1,
    description: BROWSER_SNAPSHOT_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, depth: z.number().int().min(1).max(64).optional(), target: target.optional() }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'snapshot', ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.target === undefined ? {} : { target: args.target }),
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_inspect', operation: 'browser/inspect', version: 1,
    description: 'Inspect an element in a browser tab.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, target }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'inspect', target: args.target,
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_console', operation: 'browser/console', version: 1,
    description: 'Read captured console messages for a browser tab.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, level: z.enum(['all', 'debug', 'info', 'warning', 'error']).optional(), limit }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'console', ...(args.level === undefined ? {} : { level: args.level }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_network_list', operation: 'browser/network-list', version: 1,
    description: 'Read captured network requests for a browser tab.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, resourceType: z.string().trim().min(1).max(8192).optional(), limit }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'network-list', ...(args.resourceType === undefined ? {} : { resourceType: args.resourceType }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_network_get', operation: 'browser/network-get', version: 1,
    description: 'Read a captured network request by ID.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, requestId: z.string().trim().min(1).max(8192) }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'network-get', requestId: args.requestId,
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_network_failures', operation: 'browser/network-failures', version: 1,
    description: 'Read captured failed network requests for a browser tab.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, limit }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'network-failures', ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return 'structuredContent' in result ? result : boundedBrowserRead(result);
    },
  });
  registry.register({
    name: 'browser_screenshot', operation: 'browser/screenshot', version: 1,
    description: 'Capture a PNG image of a browser tab.',
    annotations: { readOnlyHint: true },
    schema: z.object({ ...common, fullPage: z.boolean().optional() }).strict(),
    handler: async (args, context) => {
      const result = await execute(args, context.grant, context.request, context.signal, {
        operation: 'screenshot', format: 'png',
        ...(args.fullPage === undefined ? {} : { fullPage: args.fullPage }),
      });
      if ('structuredContent' in result) return result;
      if (result.operation !== 'screenshot' || result.mimeType !== 'image/png'
        || result.data.length > MAX_PNG_DATA_URL_CHARS
        || !result.data.startsWith(PNG_DATA_URL_PREFIX)) {
        return toolError('INVALID_SCREENSHOT', 'browser returned an invalid or oversized PNG', 0);
      }
      const encoded = result.data.slice(PNG_DATA_URL_PREFIX.length);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        return toolError('INVALID_SCREENSHOT', 'browser returned invalid PNG base64', 0);
      }
      const bytes = Buffer.from(encoded, 'base64');
      // This checks transport and format only. The trusted renderer creates
      // PNGs; this is not a full image decoder or integrity check.
      if (bytes.toString('base64') !== encoded || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return toolError('INVALID_SCREENSHOT', 'browser returned an invalid PNG', 0);
      }
      return {
        content: [{ type: 'image', data: encoded, mimeType: 'image/png' }],
        structuredContent: { ok: true, data: {
          mimeType: 'image/png', ...(result.width === undefined ? {} : { width: result.width }),
          ...(result.height === undefined ? {} : { height: result.height }),
        }, meta: { ms: 0 } },
      };
    },
  });
}

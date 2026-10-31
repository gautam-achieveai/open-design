import type { Request } from 'express';
import { z } from 'zod';
import type { BrowserPerformanceOverrideResponse } from '@open-design/contracts';
import { BrowserBrokerError, type BrowserCommandBroker } from './browser-command-broker.js';
import type { BrowserPerformanceService } from './browser-performance.js';
import { LOCAL_PERFORMANCE_PRINCIPAL_ID, type ApprovalPrincipal, type McpApprovalStore } from '../mcp-http/approval-store.js';

export const performanceOverrideSchema = z.object({ reportId: z.string().uuid(), cpu: z.number().finite().min(1).max(20),
  tabId: z.string().min(1).max(8192).optional(), approvalRequestId: z.string().uuid().optional() }).strict();

/** Local UI/CLI requests still require a separate signed native decision. */
export class BrowserPerformanceOverrides {
  constructor(private readonly deps: {
    broker: BrowserCommandBroker;
    captures: BrowserPerformanceService;
    store: McpApprovalStore;
    principal: (request: Request, projectId: string) => ApprovalPrincipal | null;
  }) {}

  async request(request: Request, projectId: string, raw: unknown, signal?: AbortSignal): Promise<BrowserPerformanceOverrideResponse> {
    const args = performanceOverrideSchema.parse(raw);
    const { broker, captures, store } = this.deps;
    const current = () => {
      const principal = this.deps.principal(request, projectId);
      if (!principal || principal.kind !== 'local' || principal.id !== LOCAL_PERFORMANCE_PRINCIPAL_ID || principal.projectId !== projectId) {
        throw new BrowserBrokerError('FORBIDDEN', 'Current project write authority is required', 403);
      }
      return principal;
    };
    const principal = current();
    const capture = captures.status(projectId, args.tabId);
    if (capture.state !== 'pending' || capture.capture?.reportId !== args.reportId) {
      throw new BrowserBrokerError('BAD_REQUEST', 'CPU override requires the same pending capture', 409);
    }
    const fingerprint = store.captureTarget.bind(store);
    const action = { action: 'capture-throttle', params: { reportId: args.reportId, cpu: args.cpu } };
    if (!args.approvalRequestId) {
      const target = broker.captureApprovalTarget(projectId, capture.capture.tabId, fingerprint);
      const created = store.create({ principal, target, operation: 'browser_devtools', args: action });
      if (!created.ok) throw new BrowserBrokerError('FORBIDDEN', 'Could not request native CPU confirmation', 403);
      return { status: 'approval_required', approvalRequestId: created.approval.id, approval: created.approval };
    }
    const view = store.get(args.approvalRequestId);
    const target = store.getTarget(args.approvalRequestId);
    if (!view?.nativeConfirmationRequired || !target || target.projectId !== projectId || target.tabId !== capture.capture.tabId) {
      throw new BrowserBrokerError('FORBIDDEN', 'Native CPU confirmation does not match this capture', 403);
    }
    const result = await broker.enqueueIfCurrent({ target, fingerprint, expiresAtMs: Date.parse(view.expiresAt),
      ...(signal ? { signal } : {}), request: { operation: 'devtools', action: 'capture-throttle',
        params: { ...action.params, nativeApprovalId: args.approvalRequestId }, approved: true },
      authorizeAndConsume: () => {
        const consumed = store.consume(args.approvalRequestId!, { principal: current(), target, operation: 'browser_devtools', args: action });
        if (!consumed.ok) throw new BrowserBrokerError('FORBIDDEN', 'Native CPU confirmation is not approved for this exact request', 403);
        return undefined;
      },
    }).result;
    try {
      const latest = current();
      if (JSON.stringify(latest.scope) !== JSON.stringify(principal.scope)) throw new Error('scope changed');
    } catch {
      throw new BrowserBrokerError('FORBIDDEN', 'Authority changed; the CPU override may have executed. Do not automatically retry.', 403);
    }
    if (result.result.operation !== 'devtools' || result.result.action !== 'capture-throttle') {
      throw new BrowserBrokerError('BROWSER_COMMAND_FAILED', 'The CPU override may have executed but its response was invalid', 502);
    }
    return { status: 'applied', reportId: args.reportId, cpu: args.cpu };
  }
}

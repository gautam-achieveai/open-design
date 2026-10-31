import type {
  BrowserPerformanceCaptureStart,
  BrowserPerformancePage,
  BrowserPerformanceReportDetail,
  BrowserPerformanceReportList,
  BrowserPerformanceReportSummary,
  BrowserPerformanceStatus,
  BrowserPerformanceEvidenceKind,
  BrowserPerformanceComparison,
  BrowserPerformanceComparisonRequest,
  BrowserPerformanceOverrideRequest,
  BrowserPerformanceOverrideResponse,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { getOpenDesignHost } from '@open-design/host';

export type BrowserPerformanceErrorKind = 'error' | 'accessError' | 'missingError' | 'connectionError' | 'pendingError' | 'lostError' | 'nativeUnavailable';
export class BrowserPerformanceRequestError extends Error {
  constructor(readonly kind: BrowserPerformanceErrorKind) { super(kind); }
}
export function browserPerformanceErrorKind(error: unknown): BrowserPerformanceErrorKind {
  return error instanceof BrowserPerformanceRequestError ? error.kind : 'error';
}

/** Main owns the native decision and signed submission; web cannot supply a decision or receipt. */
export async function confirmBrowserPerformanceApproval(approvalId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<'approved' | 'denied'> {
  const browser = getOpenDesignHost()?.browser;
  if (!browser?.confirmPerformanceApproval) throw new BrowserPerformanceRequestError('nativeUnavailable');
  const result = await browser.confirmPerformanceApproval({ approvalId, workspaceContext });
  if (!result.ok) throw new BrowserPerformanceRequestError('nativeUnavailable');
  return result.decision;
}

/** All surfaces share the daemon's project-scoped capture and report store. */
export function browserPerformanceApi(projectId: string, context?: WorkspaceCollabContext | null) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/browser/performance`;
  async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      signal,
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(context ? workspaceProjectHeaders(context) : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string }; code?: string } | null;
      const code = body?.error?.code ?? body?.code;
      const kind = response.status === 401 || response.status === 403 ? 'accessError'
        : code === 'BROWSER_COMMAND_FAILED' && response.status === 409 ? 'lostError'
        : code === 'BROWSER_TAB_NOT_FOUND' || code === 'BROWSER_LEASE_EXPIRED' || code === 'BROWSER_LEASE_CONFLICT' ? 'connectionError'
        : response.status === 404 ? 'missingError'
        : response.status === 409 ? 'pendingError' : 'error';
      throw new BrowserPerformanceRequestError(kind);
    }
    return response.json() as Promise<T>;
  }
  return {
    status: (tabId: string, signal: AbortSignal) => request<BrowserPerformanceStatus>(`/status?${new URLSearchParams({ tabId })}`, signal),
    start: (tabId: string, signal: AbortSignal, scenarioId?: string, maxMs = 15000) => request<BrowserPerformanceCaptureStart>('/start', signal, { tabId, maxMs, ...(scenarioId ? { scenarioId } : {}) }),
    stop: (tabId: string, signal: AbortSignal) => request<BrowserPerformanceReportSummary>('/stop', signal, { tabId }),
    list: (signal: AbortSignal, cursor?: string) => request<BrowserPerformanceReportList>(`/reports?${new URLSearchParams({ limit: '10', ...(cursor ? { cursor } : {}) })}`, signal),
    report: (id: string, signal: AbortSignal) => request<BrowserPerformanceReportDetail>(`/reports/${encodeURIComponent(id)}`, signal),
    page: (id: string, section: 'findings' | 'evidence', signal: AbortSignal, cursor?: string, kind?: BrowserPerformanceEvidenceKind | 'coverage') => request<BrowserPerformancePage>(`/reports/${encodeURIComponent(id)}/pages?${new URLSearchParams({ section, limit: '20', ...(cursor ? { cursor } : {}), ...(kind ? { kind } : {}) })}`, signal),
    compare: (groups: BrowserPerformanceComparisonRequest, signal: AbortSignal) => request<BrowserPerformanceComparison>('/compare', signal, groups),
    override: (action: BrowserPerformanceOverrideRequest, signal: AbortSignal) => request<BrowserPerformanceOverrideResponse>('/override', signal, action),
  };
}

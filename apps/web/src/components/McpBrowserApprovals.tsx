import { useEffect, useRef, useState } from 'react';
import type { McpApprovalView, WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { useT } from '../i18n';
import { browserPerformanceErrorKind, confirmBrowserPerformanceApproval } from '../providers/browser-performance';

/** Pending requests are scoped to the browser tab and current workspace. */
export function McpBrowserApprovals({ projectId, tabId, workspaceContext }: {
  projectId: string;
  tabId: string | undefined;
  workspaceContext: WorkspaceCollabContext | null | undefined;
}) {
  const t = useT();
  const [approvals, setApprovals] = useState<McpApprovalView[]>([]);
  const [error, setError] = useState(false);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const scopeGeneration = useRef(0);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    scopeGeneration.current += 1;
    setApprovals([]);
    setError(false);
    setNativeUnavailable(false);
    setBusyId(null);
    if (!tabId) return () => { disposed = true; controller.abort(); };

    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/mcp/approvals', {
          signal: controller.signal,
          ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
        });
        if (!response.ok) throw new Error('approval list unavailable');
        const body = await response.json() as { approvals?: McpApprovalView[] };
        if (!disposed) {
          setApprovals((body.approvals ?? []).filter((item) => item.projectId === projectId && item.tabId === tabId && item.status === 'pending'));
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); };
  }, [projectId, tabId, workspaceContext, refresh]);

  async function decide(approval: McpApprovalView, decision: 'approve' | 'deny') {
    const id = approval.id;
    const generation = scopeGeneration.current;
    setBusyId(id);
    setError(false);
    setNativeUnavailable(false);
    try {
      if (approval.nativeConfirmationRequired) {
        await confirmBrowserPerformanceApproval(id, workspaceContext);
      } else {
        const response = await fetch(`/api/mcp/approvals/${encodeURIComponent(id)}/${decision}`, {
          method: 'POST',
          ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
        });
        if (!response.ok) throw new Error('approval decision failed');
      }
      if (generation !== scopeGeneration.current) return;
      setApprovals((items) => items.filter((item) => item.id !== id));
      setRefresh((value) => value + 1);
    } catch (error) {
      if (generation === scopeGeneration.current) {
        if (browserPerformanceErrorKind(error) === 'nativeUnavailable') setNativeUnavailable(true);
        else setError(true);
      }
    } finally {
      if (generation === scopeGeneration.current) setBusyId(null);
    }
  }

  if (!tabId || (approvals.length === 0 && !error && !nativeUnavailable)) return null;
  return (
    <section className="db-approvals" aria-label={t('designBrowser.approvals.title')} aria-live="polite">
      <strong>{t('designBrowser.approvals.title')}</strong>
      {approvals.some((approval) => !approval.nativeConfirmationRequired) && <p>{t('designBrowser.approvals.trust')}</p>}
      {approvals.some((approval) => approval.nativeConfirmationRequired) && <p>{t('designBrowser.performance.nativeApprovalHint')}</p>}
      {error && <p role="alert">{t('designBrowser.approvals.error')}</p>}
      {nativeUnavailable && <p role="alert">{t('designBrowser.performance.nativeUnavailable')}</p>}
      {approvals.map((approval) => {
        const expires = Date.parse(approval.expiresAt);
        const expired = Number.isFinite(expires) && expires <= Date.now();
        return (
          <div className="db-approval" key={approval.id}>
            <div className="db-approval-details">
              <strong>{approval.operation}</strong>
              <span>{approval.principal.kind}: {approval.principal.id}</span>
              <span>{approval.projectId} / {approval.tabId}</span>
              <span>{approval.location}</span>
              <pre>{approval.preview}</pre>
              {approval.partial && <span>{t('designBrowser.approvals.partial')}</span>}
              <span>{t('designBrowser.approvals.expires')}: {Number.isFinite(expires) ? new Date(expires).toLocaleTimeString() : approval.expiresAt}</span>
            </div>
            <div className="db-approval-actions">
              {approval.nativeConfirmationRequired ? <button type="button" onClick={() => { void decide(approval, 'approve'); }} disabled={busyId !== null || expired}>{t('designBrowser.performance.nativeReview')}</button> : <>
                <button type="button" onClick={() => { void decide(approval, 'deny'); }} disabled={busyId !== null || expired}>{t('designBrowser.approvals.deny')}</button>
                <button type="button" onClick={() => { void decide(approval, 'approve'); }} disabled={busyId !== null || expired}>{t('designBrowser.approvals.approve')}</button>
              </>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

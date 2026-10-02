import { useEffect, useState } from 'react';
import type { EdgeAnnotationPairCode, EdgeAnnotationStatusResponse, EdgeInspectionOperation, EdgeInspectionResponse, WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { Button } from '@open-design/components';
import { useT } from '../i18n';
import styles from './EdgeAnnotationsPanel.module.css';

interface EdgeAnnotationsPanelProps {
  projectId: string;
  conversationId: string | null;
  pageUrl: string;
  workspaceContext?: WorkspaceCollabContext | null;
  onOpenExternal: () => void;
}

function endpoint(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/edge-annotations`;
}

function clipperDaemonUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.port === '0' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.href !== url.origin + '/') return null;
    return url.origin;
  } catch { return null; }
}

export function EdgeAnnotationsPanel({
  projectId, conversationId, workspaceContext,
}: EdgeAnnotationsPanelProps) {
  const t = useT();
  const [pair, setPair] = useState<EdgeAnnotationPairCode | null>(null);
  const [status, setStatus] = useState<EdgeAnnotationStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selector, setSelector] = useState('');
  const [inspection, setInspection] = useState<EdgeInspectionResponse | null>(null);
  const [inspectionScope, setInspectionScope] = useState('');
  const currentScope = JSON.stringify([projectId, conversationId]);

  async function refresh() {
    if (!conversationId) return;
    const response = await fetch(`${endpoint(projectId)}?conversationId=${encodeURIComponent(conversationId)}`, { cache: 'no-store', ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}) });
    if (!response.ok) throw new Error(t('designBrowser.edge.error'));
    setStatus(await response.json() as EdgeAnnotationStatusResponse);
  }

  useEffect(() => {
    setPair(null);
    setStatus(null);
    setInspection(null);
    setInspectionScope('');
    let mounted = true;
    if (!conversationId) return;
    const poll = async () => {
      try {
        const response = await fetch(`${endpoint(projectId)}?conversationId=${encodeURIComponent(conversationId)}`, { cache: 'no-store', ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}) });
        if (!response.ok) {
          if (mounted) setStatus(null);
          return;
        }
        const next = await response.json() as EdgeAnnotationStatusResponse;
        if (mounted) setStatus(next);
      } catch { if (mounted) setStatus(null); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 15_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [projectId, conversationId, workspaceContext]);

  const daemonUrl = clipperDaemonUrl(status?.daemonUrl);

  async function connect() {
    if (!conversationId || busy || !daemonUrl) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${endpoint(projectId)}/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}) },
        body: JSON.stringify({ conversationId }),
      });
      if (!response.ok) throw new Error(t('designBrowser.edge.error'));
      const next = await response.json() as EdgeAnnotationPairCode;
      next.connectionUrl = `${daemonUrl}/#od-annotation=${encodeURIComponent(next.code)}`;
      setPair(next);
      await navigator.clipboard?.writeText(next.connectionUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('designBrowser.edge.error'));
    } finally { setBusy(false); }
  }

  async function inspect(grantId: string, operation: EdgeInspectionOperation) {
    if (!conversationId || busy || (operation === 'inspect' && (!selector.trim() || selector.length > 512))) return;
    const requestScope = currentScope;
    setBusy(true);
    setError('');
    setInspection(null);
    setInspectionScope('');
    try {
      const response = await fetch(`${endpoint(projectId)}/inspect`, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}) },
        body: JSON.stringify({ conversationId, grantId, operation,
          ...(operation === 'inspect' ? { selector } : {}) }),
      });
      if (!response.ok) throw new Error(t('designBrowser.edge.error'));
      setInspection(await response.json() as EdgeInspectionResponse);
      setInspectionScope(requestScope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('designBrowser.edge.error'));
    } finally { setBusy(false); }
  }

  async function disconnect(grantId: string) {
    if (!conversationId || busy) return;
    setBusy(true);
    setError('');
    setInspection(null);
    setInspectionScope('');
    try {
      const response = await fetch(`${endpoint(projectId)}/${encodeURIComponent(grantId)}?conversationId=${encodeURIComponent(conversationId)}`, {
        method: 'DELETE', ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      });
      if (!response.ok) throw new Error(t('designBrowser.edge.error'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('designBrowser.edge.error'));
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.panel} aria-label={t('designBrowser.edge.annotations')}>
      <div className={styles.header}>
        <strong>{t('designBrowser.edge.annotations')}</strong>
        <Button type="button" onClick={() => void connect()} disabled={!conversationId || busy || !daemonUrl}>
          {t('designBrowser.edge.copyConnectionUrl')}
        </Button>
      </div>
      <p>{t('designBrowser.edge.instructions')}</p>
      {!daemonUrl ? <p role="status">{t('designBrowser.edge.daemonUrlUnavailable')}</p> : null}
      <p>{t('designBrowser.edge.connectionSteps')}</p>
      {pair && pair.expiresAt > Date.now() ? (
        <p className={styles.code}>{t('designBrowser.edge.connectionUrl')}: <code className={styles.url}>{pair.connectionUrl}</code></p>
      ) : null}
      <p>{t('designBrowser.edge.paired')}: {status?.grants.length ?? 0}</p>
      {status?.grants.map((grant) => (
        <div key={grant.grantId}>
          <div className={styles.actions}>
            <span>{grant.origin}</span>
            <Button type="button" onClick={() => void disconnect(grant.grantId)} disabled={busy}>
              {t('designBrowser.edge.disconnect')}
            </Button>
          </div>
          <div className={styles.actions}>
            <Button type="button" onClick={() => void inspect(grant.grantId, 'snapshot')} disabled={busy}>
              Snapshot
            </Button>
            <Button type="button" onClick={() => void inspect(grant.grantId, 'screenshot')} disabled={busy}>
              Screenshot of entire paired tab
            </Button>
          </div>
          <label>
            CSS selector
            <input value={selector} onChange={(event) => setSelector(event.target.value)}
              maxLength={512} placeholder="main" aria-label="CSS selector for paired tab" />
          </label>
          <Button type="button" onClick={() => void inspect(grant.grantId, 'inspect')}
            disabled={busy || !selector.trim()}>Inspect element</Button>
        </div>
      ))}
      {inspectionScope === currentScope && inspection?.result && ('html' in inspection.result
        ? <pre className={styles.url} aria-label="Paired tab inspection text">{inspection.result.html}</pre>
        : <img src={inspection.result.dataUrl} alt="Screenshot of paired tab" style={{ maxWidth: '100%' }} />)}
      <p>{t('designBrowser.edge.feedbackOnly')}</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

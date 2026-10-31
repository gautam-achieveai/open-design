import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserPerformanceStatus, BrowserPerformanceEvidence, BrowserPerformanceEvidenceKind, BrowserPerformanceFinding, BrowserPerformancePage, BrowserPerformanceReportDetail, BrowserPerformanceReportList, BrowserPerformanceComparisonRequest, WorkspaceCollabContext } from '@open-design/contracts';
import { browserPerformanceApi, browserPerformanceErrorKind, confirmBrowserPerformanceApproval, type BrowserPerformanceErrorKind } from '../providers/browser-performance';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { BrowserPerformanceComparisonPanel } from './BrowserPerformanceComparisonPanel';

type Api = ReturnType<typeof browserPerformanceApi>;
const coverageReasonKeys: Record<string, keyof Dict> = {
  'renderer-thread-heuristic': 'designBrowser.performance.coverageEstimated',
  'trace-incomplete': 'designBrowser.performance.coverageTraceIncomplete',
  'trace-completion-timeout': 'designBrowser.performance.coverageTraceIncomplete',
  'trace-stop-failed': 'designBrowser.performance.coverageTraceIncomplete',
  'observer-unavailable': 'designBrowser.performance.coverageObserverUnavailable',
  'observer-collection-timeout': 'designBrowser.performance.coverageObserverUnavailable',
  'target-hidden': 'designBrowser.performance.coverageHidden',
  'trace-budget-exceeded': 'designBrowser.performance.coverageBudget',
  'report-budget-exceeded': 'designBrowser.performance.coverageBudget',
  'no-renderer-tasks': 'designBrowser.performance.coverageNoTasks',
  'target-detached': 'designBrowser.performance.coverageDetached',
  'document-changed': 'designBrowser.performance.coverageNavigation',
  'resource-timing-fallback': 'designBrowser.performance.resourceFallback',
  'request-details-unavailable': 'designBrowser.performance.requestDetailsUnavailable',
};

/** Kept in the browser layout so recording controls never cover the page being measured. */
export function BrowserPerformancePanel({ projectId, tabId, workspaceContext, connected, onClose }: {
  projectId: string;
  tabId: string | undefined;
  workspaceContext?: WorkspaceCollabContext | null;
  connected: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const api = useMemo(() => browserPerformanceApi(projectId, workspaceContext), [projectId, workspaceContext]);
  const controller = useRef(new AbortController());
  const [capture, setCapture] = useState<BrowserPerformanceStatus['capture']>(null);
  const [reports, setReports] = useState<BrowserPerformanceReportList | null>(null);
  const [report, setReport] = useState<BrowserPerformanceReportDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BrowserPerformanceErrorKind | null>(null);
  const [statusError, setStatusError] = useState<BrowserPerformanceErrorKind | null>(null);
  const [section, setSection] = useState<'findings' | 'evidence'>('findings');
  const [scenarioId, setScenarioId] = useState('');
  const [maxMs, setMaxMs] = useState(15000);
  const [overrideCpu, setOverrideCpu] = useState(2);
  const [overrideStatus, setOverrideStatus] = useState<'applied' | 'denied' | null>(null);
  const [groups, setGroups] = useState<Record<string, 'baseline' | 'candidate'>>({});
  const [comparison, setComparison] = useState<BrowserPerformanceComparisonRequest | null>(null);
  const validScenario = scenarioId === '' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scenarioId);
  const baselineReportIds = Object.keys(groups).filter((id) => groups[id] === 'baseline');
  const candidateReportIds = Object.keys(groups).filter((id) => groups[id] === 'candidate');
  const canCompare = [baselineReportIds.length, candidateReportIds.length].every((count) => count >= 3 && count <= 10);
  const actionVersion = useRef(0);
  const actionPending = useRef(false);

  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setReports(null);
    setReport(null);
    setCapture(null);
    setError(null);
    setStatusError(null);
    setBusy(false);
    setGroups({});
    setComparison(null);
    setOverrideStatus(null);
    actionPending.current = false;
    void api.list(current.signal).then((value) => { if (!current.signal.aborted) setReports(value); })
      .catch((error: unknown) => { if (!current.signal.aborted) setError(browserPerformanceErrorKind(error)); });
    return () => current.abort();
  }, [api]);

  useEffect(() => {
    if (!tabId || !connected) return;
    const current = new AbortController();
    let polling = false;
    async function poll() {
      if (polling || actionPending.current) return;
      polling = true;
      const version = actionVersion.current;
      try {
        const next = await api.status(tabId!, current.signal);
        if (!current.signal.aborted && version === actionVersion.current) {
          setCapture(next.capture);
          setStatusError(null);
        }
      } catch (error) {
        if (!current.signal.aborted && version === actionVersion.current) setStatusError(browserPerformanceErrorKind(error));
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { current.abort(); window.clearInterval(timer); };
  }, [api, tabId, connected]);

  async function act(action: (signal: AbortSignal) => Promise<void>) {
    const signal = controller.current.signal;
    actionVersion.current += 1;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try { await action(signal); }
    catch (error) {
      if (!signal.aborted) {
        const kind = browserPerformanceErrorKind(error);
        setError(kind);
        if (kind === 'lostError') setCapture(null);
      }
    }
    finally { if (!signal.aborted) { setBusy(false); actionPending.current = false; } }
  }
  async function openReport(id: string, signal: AbortSignal) {
    setComparison(null);
    setReport(null);
    const next = await api.report(id, signal);
    if (!signal.aborted) { setReport(next); setSection('findings'); }
  }
  async function requestCpu(signal: AbortSignal) {
    if (!capture?.reportId) return;
    setOverrideStatus(null);
    const action = { tabId: capture.tabId, reportId: capture.reportId, cpu: overrideCpu };
    let result = await api.override(action, signal);
    if (signal.aborted) return;
    if (result.status === 'approval_required') {
      const decision = await confirmBrowserPerformanceApproval(result.approvalRequestId, workspaceContext);
      if (signal.aborted) return;
      if (decision === 'denied') { setOverrideStatus('denied'); return; }
      result = await api.override({ ...action, approvalRequestId: result.approvalRequestId }, signal);
    }
    if (!signal.aborted) {
      if (result.status !== 'applied') throw new Error('native approval was not consumed');
      setOverrideStatus('applied');
    }
  }
  return (
    <section className="db-performance" aria-label={t('designBrowser.performance.title')} data-testid="browser-performance">
      <div className="db-performance-toolbar">
        <strong>{t('designBrowser.performance.title')}</strong>
        <label className="db-performance-scenario">{t('designBrowser.performance.scenario')} <input data-testid="performance-scenario" value={scenarioId} maxLength={64} disabled={!!capture || busy} aria-invalid={!validScenario} onChange={(event) => setScenarioId(event.target.value)} /></label>
        <label>{t('designBrowser.performance.duration')} <select data-testid="performance-duration" value={maxMs} disabled={!!capture || busy} onChange={(event) => setMaxMs(Number(event.target.value))}>
          {[15000, 30000, 60000].map((value) => <option value={value} key={value}>{value / 1000}s</option>)}
        </select></label>
        <button type="button" data-testid="performance-start" title={t('designBrowser.performance.samplingNotice')} disabled={busy || !!capture || !connected || !tabId || !validScenario} onClick={() => void act(async (signal) => {
          setOverrideStatus(null);
          const next = await api.start(tabId!, signal, scenarioId || undefined, maxMs);
          if (!signal.aborted) setCapture({ reportId: next.reportId, maxMs: next.maxMs, tabId: tabId! });
        })}>{t('designBrowser.performance.start')}</button>
        <button type="button" data-testid="performance-stop" disabled={busy || !connected || !tabId} onClick={() => void act(async (signal) => {
          const saved = await api.stop(capture?.tabId ?? tabId!, signal);
          if (signal.aborted) return;
          setCapture(null);
          setOverrideStatus(null);
          await openReport(saved.reportId, signal);
          const next = await api.list(signal);
          if (!signal.aborted) setReports(next);
        })}>{t('designBrowser.performance.stop')}</button>
        <button type="button" disabled={busy} onClick={() => void act(async (signal) => {
          const next = await api.list(signal);
          if (!signal.aborted) setReports(next);
        })}>{t('designBrowser.reload')}</button>
        <button type="button" className="db-performance-close" onClick={onClose} aria-label={t('common.close')}>×</button>
      </div>
      <div className="db-performance-toolbar">
        <label>{t('designBrowser.performance.temporaryCpu')} <select data-testid="performance-cpu" value={overrideCpu} disabled={busy} onChange={(event) => setOverrideCpu(Number(event.target.value))}>
          {[2, 4, 6].map((value) => <option value={value} key={value}>{value}×</option>)}
        </select></label>
        <button type="button" data-testid="performance-request-cpu" title={t('designBrowser.performance.cpuHint')} disabled={busy || !capture?.reportId || !connected} onClick={() => void act(requestCpu)}>{t('designBrowser.performance.requestCpu')}</button>
      </div>
      <div className="db-performance-status">
        {overrideStatus && <p role="status">{t(`designBrowser.performance.override.${overrideStatus}`)}</p>}
        {!validScenario && <p role="alert">{t('designBrowser.performance.scenarioInvalid')}</p>}
        {!capture && !error && !statusError && <p>{t('designBrowser.performance.samplingNotice')}</p>}
        {(error ?? statusError) && <p role="alert">{t(`designBrowser.performance.${(error ?? statusError)!}`)}</p>}
        {capture && <p role="status" data-testid="performance-recording">{t('designBrowser.performance.recording')} {capture.reportId} · {capture.tabId} · {capture.maxMs / 1000}s. {t('designBrowser.performance.retrieve')}</p>}
      </div>
      <div className="db-performance-body" aria-busy={busy}>
        <nav className="db-performance-reports" aria-label={t('designBrowser.performance.reports')}>
          <strong>{t('designBrowser.performance.reports')}</strong>
          <button type="button" data-testid="performance-compare" disabled={!canCompare || busy} onClick={() => setComparison({ baselineReportIds, candidateReportIds })}>{t('designBrowser.performance.compare')} ({baselineReportIds.length} / {candidateReportIds.length})</button>
          <p>{t('designBrowser.performance.compareHint')}</p>
          {reports?.items.length === 0 && <p>{t('designBrowser.performance.empty')}</p>}
          {reports?.items.map((item) => <div className="db-performance-report-choice" key={item.reportId}><button type="button" disabled={busy} aria-pressed={report?.reportId === item.reportId && !comparison} onClick={() => void act((signal) => openReport(item.reportId, signal))}>
            <span>{new Date(item.startedAt).toLocaleString()}</span>
            <span>{t(`designBrowser.performance.${item.completeness}`)} · {Math.round(item.durationMs)} ms</span>
            <code>{item.reportId}</code>
            {item.scenarioId && <span>{item.scenarioId}</span>}
          </button>
            <select aria-label={`${t('designBrowser.performance.comparisonGroup')} ${item.reportId}`} value={groups[item.reportId] ?? ''} onChange={(event) => {
              const group = event.target.value;
              setGroups((previous) => {
                const next = { ...previous };
                if (group === 'baseline' || group === 'candidate') next[item.reportId] = group;
                else delete next[item.reportId];
                return next;
              });
            }}>
              <option value="">{t('designBrowser.performance.notSelected')}</option>
              <option value="baseline">{t('designBrowser.performance.baseline')}</option>
              <option value="candidate">{t('designBrowser.performance.candidate')}</option>
            </select>
          </div>)}
          {reports?.nextCursor && <button type="button" disabled={busy} onClick={() => void act(async (signal) => {
            const next = await api.list(signal, reports.nextCursor!);
            if (!signal.aborted) setReports((old) => ({ ...next, items: [...(old?.items ?? []), ...next.items] }));
          })}>{t('designBrowser.performance.more')}</button>}
        </nav>
        <div className="db-performance-report">
          {comparison ? <BrowserPerformanceComparisonPanel api={api} request={comparison} /> : report ? <>
            <strong data-testid="performance-completeness">{t(`designBrowser.performance.${report.completeness}`)}</strong>
            <code data-testid="performance-report-id">{report.reportId}</code>
            {report.scenarioId && <p>{t('designBrowser.performance.scenario')}: {report.scenarioId}</p>}
            <p>{report.summary}</p>
            {report.restoration && <div data-testid="performance-restoration" className={report.restoration.status === 'failed' || report.restoration.status === 'conflict' ? 'db-performance-warning' : undefined}>
              <p>{t(`designBrowser.performance.restoration.${report.restoration.status}`)}</p>
              {report.restoration.status !== 'not-modified-by-capture' && <p>{report.restoration.priorCpu}× → {report.restoration.appliedCpu}× → {report.restoration.restoredCpu === null ? '—' : `${report.restoration.restoredCpu}×`}</p>}
              {report.restoration.settingsChangedDuringCapture && <p>{t('designBrowser.performance.warning.settings-changed-during-capture')}</p>}
            </div>}
            {report.completeness !== 'complete' && <p className="db-performance-warning">{t('designBrowser.performance.incomplete')}</p>}
            <details open={report.coverage.reasons.length > 0}>
              <summary>{t('designBrowser.performance.coverage')}</summary>
              <p>{t('designBrowser.performance.retained')}: {report.coverage.retainedEvents} · {t('designBrowser.performance.omitted')}: {report.coverage.droppedEvents + report.coverage.omittedEvidence}</p>
              {report.coverage.cpuSampling && <p>{t('designBrowser.performance.cpuSamples')}: {report.coverage.cpuSampling.status} · {report.coverage.cpuSampling.retainedSamples} · {t('designBrowser.performance.omitted')}: {report.coverage.cpuSampling.droppedSamples} · {report.coverage.cpuSampling.intervalUs / 1000} ms</p>}
              {report.coverage.inputTiming && <p>{report.coverage.inputTiming.supported ? `${t('designBrowser.performance.inputTiming')}: ${report.coverage.inputTiming.retained}` : t('designBrowser.performance.inputUnavailable')} · {t('designBrowser.performance.omitted')}: {report.coverage.inputTiming.dropped}</p>}
              {report.coverage.load && <p>{t('designBrowser.performance.kind.request')}: {report.coverage.load.retainedRequests} · {t('designBrowser.performance.omitted')}: {report.coverage.load.droppedRequests} · {report.coverage.load.preNavigation ? t('designBrowser.performance.preNavigation') : t('designBrowser.performance.lateObservers')}</p>}
              {report.coverage.rendering && <p>{t('designBrowser.performance.kind.layout-shift')}: {report.coverage.rendering.retainedShifts} · {t('designBrowser.performance.kind.paint')}: {report.coverage.rendering.retainedPaints} · {t('designBrowser.performance.kind.frame')}: {report.coverage.rendering.retainedFrames} · {t('designBrowser.performance.kind.style')}: {report.coverage.rendering.cssTargets}</p>}
              {report.documents?.map((document) => <p key={document.documentId}>{document.documentId} · {document.timeOriginMs} ms · {document.observedBeforeLoad ? t('designBrowser.performance.preNavigation') : t('designBrowser.performance.lateObservers')}</p>)}
              <ul>{report.coverage.reasons.map((reason) => <li key={reason}>{coverageReasonKeys[reason] ? t(coverageReasonKeys[reason]) : reason.replaceAll(/[-_]/g, ' ')}</li>)}</ul>
              <p>{report.environment.browserVersion} · {report.environment.viewport ? `${report.environment.viewport.width} × ${report.environment.viewport.height}` : '—'} · {Math.round(report.durationMs)} ms</p>
              <p>CPU: {report.environment.appliedCpuThrottle ?? report.environment.cpuThrottle}× · {report.environment.network} · {t('designBrowser.performance.cacheDisabled')}: {String(report.environment.cacheDisabled)} · {t('designBrowser.performance.animationRate')}: {report.environment.animationRate}×</p>
              <p>{t('designBrowser.performance.expires')}: {new Date(report.expiresAt).toLocaleString()}</p>
            </details>
            <div className="db-performance-toolbar">
              {(['findings', 'evidence'] as const).map((name) => <button type="button" key={name} aria-pressed={section === name} onClick={() => setSection(name)}>{t(`designBrowser.performance.${name}`)} ({name === 'findings' ? report.findingsCount : report.evidenceCount})</button>)}
            </div>
            <ReportPage key={`${report.reportId}:${section}`} api={api} reportId={report.reportId} section={section} />
          </> : <p>{t('designBrowser.performance.hint')}</p>}
        </div>
      </div>
    </section>
  );
}

function ReportPage({ api, reportId, section }: { api: Api; reportId: string; section: 'findings' | 'evidence' }) {
  const t = useT();
  const [page, setPage] = useState<BrowserPerformancePage | null>(null);
  const [error, setError] = useState<BrowserPerformanceErrorKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<BrowserPerformanceEvidenceKind | 'coverage' | ''>('');
  const controller = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setPage(null);
    setError(null);
    void api.page(reportId, section, current.signal, undefined, kind || undefined).then((next) => { if (!current.signal.aborted) setPage(next); })
      .catch((error: unknown) => { if (!current.signal.aborted) setError(browserPerformanceErrorKind(error)); })
      .finally(() => { if (!current.signal.aborted) setBusy(false); });
    return () => current.abort();
  }, [api, reportId, section, kind]);
  async function more() {
    if (!page?.nextCursor) return;
    const signal = controller.current.signal;
    setBusy(true); setError(null);
    try {
      const next = await api.page(reportId, section, signal, page.nextCursor, kind || undefined);
      if (!signal.aborted) setPage((old) => ({ ...next, items: [...(old?.items ?? []), ...next.items] as BrowserPerformancePage['items'] }));
    } catch (error) { if (!signal.aborted) setError(browserPerformanceErrorKind(error)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <div aria-busy={busy}>
    <label>{t('designBrowser.performance.filter')} <select data-testid="performance-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
      <option value="">{t('designBrowser.performance.allKinds')}</option>
      {(['task', 'sample', 'input', 'request', 'lcp', 'layout-shift', 'paint', 'frame', 'style'] as const).map((value) => <option key={value} value={value}>{t(`designBrowser.performance.kind.${value}`)}</option>)}
      {section === 'findings' && <option value="coverage">{t('designBrowser.performance.coverage')}</option>}
    </select></label>
    {error && <p role="alert">{t(`designBrowser.performance.${error}`)}</p>}
    {page && <p>{page.items.length} / {page.total} · {t('designBrowser.performance.omitted')}: {page.omitted}</p>}
    {page?.items.map((item) => <div className="db-performance-evidence" key={item.id}>
      {'title' in item ? <Finding item={item} /> : <Evidence item={item} />}
    </div>)}
    {page?.nextCursor && <button type="button" data-testid="performance-more" disabled={busy} onClick={() => void more()}>{t('designBrowser.performance.more')}</button>}
  </div>;
}

function Finding({ item }: { item: BrowserPerformanceFinding }) {
  const t = useT();
  return <><strong>{item.title}</strong><p>{t(`designBrowser.performance.${item.interpretation}`)} · {item.id}</p><p>{item.evidenceIds.join(', ')}</p></>;
}

function Evidence({ item }: { item: BrowserPerformanceEvidence }) {
  const t = useT();
  return <>
    <strong>{t(`designBrowser.performance.kind.${item.kind}`)} · {item.id}</strong>
    {item.kind === 'sample' && <p>{t('designBrowser.performance.sampleHint')}</p>}
    {item.kind === 'input' && <p>{t('designBrowser.performance.inputHint')}</p>}
    {item.kind === 'style' && <p>{t('designBrowser.performance.styleHint')}</p>}
    {item.kind === 'frame' && <p>{t('designBrowser.performance.frameHint')}</p>}
    {item.kind === 'paint' && <p>{t('designBrowser.performance.paintHint')}</p>}
    {item.target && <p>{t('designBrowser.performance.target')}: {item.target.label}</p>}
    <p>{Math.round(item.atMs)} ms{item.durationMs !== undefined ? ` · ${Math.round(item.durationMs)} ms duration` : ''} · {item.clock} · {item.documentId ?? t('designBrowser.performance.unknownDocument')}</p>
    {item.request && <p>{item.request.resourceType} · {t('designBrowser.performance.initiator')}: {item.request.initiatorType}</p>}
    {item.request?.observation === 'resource-timing' && <p className="db-performance-warning">{t('designBrowser.performance.resourceFallback')}</p>}
    <dl>{Object.entries(item.values).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{value === null ? '—' : typeof value === 'number' && key.endsWith('Ms') ? value.toFixed(1) : String(value)}</dd></div>)}</dl>
    {item.sources?.map((source, index) => <div key={index}>
      <p>{source.label}{source.line === undefined ? '' : `:${source.line}:${source.column ?? 0}`} · {source.mapping}</p>
      {source.generated && <p>{t('designBrowser.performance.generatedSource')}: <code>{source.generated.path}:{source.generated.line}:{source.generated.column}</code> {source.generated.functionName}</p>}
      {source.original && <p>{t('designBrowser.performance.originalSource')}: <code>{source.original.path}:{source.original.line}:{source.original.column}</code></p>}
      {source.unavailableReason && <p>{t('designBrowser.performance.mappingUnavailable')}: {source.unavailableReason.replaceAll('-', ' ')}</p>}
      {source.resolutionBasis && <p>{t('designBrowser.performance.currentSourceWarning')}</p>}
    </div>)}
    {item.relatedIds?.length ? <p>{item.relatedIds.join(', ')}</p> : null}
  </>;
}

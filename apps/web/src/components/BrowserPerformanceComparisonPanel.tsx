import { useEffect, useState } from 'react';
import type { BrowserPerformanceComparison, BrowserPerformanceComparisonRequest } from '@open-design/contracts';
import { browserPerformanceErrorKind, type BrowserPerformanceErrorKind, type browserPerformanceApi } from '../providers/browser-performance';
import { useT } from '../i18n';

/** Compare persisted reports through the same daemon calculation used by CLI and MCP. */
export function BrowserPerformanceComparisonPanel({ api, request }: {
  api: ReturnType<typeof browserPerformanceApi>;
  request: BrowserPerformanceComparisonRequest;
}) {
  const t = useT();
  const [result, setResult] = useState<BrowserPerformanceComparison | null>(null);
  const [error, setError] = useState<BrowserPerformanceErrorKind | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(null);
    void api.compare(request, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(browserPerformanceErrorKind(error)); });
    return () => controller.abort();
  }, [api, request]);
  if (error) return <p role="alert">{t(`designBrowser.performance.${error}`)}</p>;
  if (!result) return <p role="status">{t('designBrowser.performance.comparing')}</p>;
  return <section data-testid="performance-comparison">
    <strong>{result.comparable ? t('designBrowser.performance.comparable') : t('designBrowser.performance.incompatible')}</strong>
    <p>{result.scenarioId ?? t('designBrowser.performance.noScenario')}</p>
    <p>{t('designBrowser.performance.baseline')}: {result.baselineReportIds.length} · {t('designBrowser.performance.candidate')}: {result.candidateReportIds.length}</p>
    {result.warnings.length > 0 && <ul className="db-performance-warning">{result.warnings.map((warning) => <li key={warning}>{t(`designBrowser.performance.warning.${warning}`)}</li>)}</ul>}
    <p>{t('designBrowser.performance.variabilityHint')}</p>
    <table className="db-performance-comparison-table">
      <thead><tr><th>{t('designBrowser.performance.metric')}</th><th>{t('designBrowser.performance.baseline')}</th><th>{t('designBrowser.performance.candidate')}</th><th>{t('designBrowser.performance.change')}</th></tr></thead>
      <tbody>{result.metrics.map((metric) => <tr key={metric.metric}>
        <th scope="row">{t(`designBrowser.performance.metric.${metric.metric}`)} ({metric.unit})</th>
        <td>{format(metric.baseline.median, metric.unit)}<small>{format(metric.baseline.min, metric.unit)}–{format(metric.baseline.max, metric.unit)}</small></td>
        <td>{format(metric.candidate.median, metric.unit)}<small>{format(metric.candidate.min, metric.unit)}–{format(metric.candidate.max, metric.unit)}</small></td>
        <td>{format(metric.medianDelta, metric.unit)}<small>{metric.medianDeltaPercent === null ? '—' : `${metric.medianDeltaPercent.toFixed(1)}%`}</small></td>
      </tr>)}</tbody>
    </table>
    <details><summary>{t('designBrowser.performance.allRuns')}</summary>
      <p>{t('designBrowser.performance.baseline')}: <code>{result.baselineReportIds.join(', ')}</code></p>
      <p>{t('designBrowser.performance.candidate')}: <code>{result.candidateReportIds.join(', ')}</code></p>
      {result.metrics.map((metric) => <div key={metric.metric}><strong>{t(`designBrowser.performance.metric.${metric.metric}`)}</strong>
        <p>{t('designBrowser.performance.baseline')}: {metric.baseline.samples.map((value) => format(value, metric.unit)).join(', ')}</p>
        <p>{t('designBrowser.performance.candidate')}: {metric.candidate.samples.map((value) => format(value, metric.unit)).join(', ')}</p>
      </div>)}
    </details>
  </section>;
}

function format(value: number, unit: 'ms' | 'score'): string {
  return value.toFixed(unit === 'score' ? 3 : 1);
}

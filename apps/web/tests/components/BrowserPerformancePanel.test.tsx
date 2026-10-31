// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserPerformanceComparison, BrowserPerformanceReportDetail, WorkspaceCollabContext } from '@open-design/contracts';
import { BrowserPerformancePanel } from '../../src/components/BrowserPerformancePanel';

const host = vi.hoisted(() => ({ getOpenDesignHost: vi.fn() }));
vi.mock('@open-design/host', () => host);

const report: BrowserPerformanceReportDetail = {
  schemaVersion: 1, reportId: 'report-a', startedAt: '2026-10-30T12:00:00Z', durationMs: 1000,
  completeness: 'partial', summary: 'One long task observed.', findingsCount: 2, evidenceCount: 1,
  tabId: 'tab-a', expiresAt: '2026-11-06T12:00:00Z',
  environment: { browserVersion: 'fixture', viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visible: true,
    cpuThrottle: 1, network: 'none', cacheDisabled: false, reducedMotion: false, animationRate: 1, documentId: 'document-a', timeOriginMs: 0 },
  coverage: { traceComplete: true, observerAvailable: true, retainedEvents: 5, rendererTasks: 1, droppedEvents: 0, retainedBytes: 100,
    omittedEvidence: 0, reasons: ['renderer-thread-heuristic'] },
  retention: { days: 7, maxReportBytes: 1048576, totalBytes: 20971520 },
};
const context = { workspaceId: 'workspace-a', workspaceMemberId: 'member-a', workspaceType: 'team', role: 'owner',
  lifecycleState: 'active', memberStatus: 'active', permissions: { canShareProjects: true, canWriteSyncedFiles: true } } as unknown as WorkspaceCollabContext;
const props = { projectId: 'project-a', tabId: 'tab-a', connected: true, workspaceContext: context, onClose: vi.fn() };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); host.getOpenDesignHost.mockReset(); });

it('saves the capture, explains coverage, and retrieves all finding pages with workspace authority', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let saved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (url.includes('/status?')) return Response.json({ state: 'idle', capture: null });
    if (url.endsWith('/start')) return Response.json({ recording: true, reportId: 'report-a', maxMs: 15000, visible: true });
    if (url.endsWith('/stop')) { saved = true; return Response.json(report); }
    if (url.endsWith('/reports/report-a')) return Response.json(report);
    if (url.includes('/pages?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const second = query.has('cursor');
      return Response.json({ reportId: 'report-a', schemaVersion: 1, section: 'findings',
        items: [{ id: second ? 'finding-b' : 'finding-a', kind: 'task', severity: 'warning',
          title: second ? 'Second finding' : 'First finding', interpretation: 'observed', evidenceIds: ['task-a'] }],
        total: 2, nextCursor: second ? null : 'opaque-next', omitted: 0, completeness: 'partial' });
    }
    return Response.json({ items: saved ? [report] : [], total: saved ? 1 : 0, nextCursor: null });
  }));
  render(<BrowserPerformancePanel {...props} />);
  await screen.findByText('No saved reports yet.');
  fireEvent.click(screen.getByTestId('performance-start'));
  expect(await screen.findByTestId('performance-recording')).toHaveTextContent('report-a');
  expect(screen.getByTestId('performance-start')).toBeDisabled();
  fireEvent.click(screen.getByTestId('performance-stop'));
  expect(await screen.findByTestId('performance-report-id')).toHaveTextContent('report-a');
  expect(screen.getByTestId('performance-completeness')).toHaveTextContent('Partial');
  expect(screen.getByText(/This recording has gaps/)).toBeTruthy();
  expect(screen.getByText('The page thread was estimated from its recorded tasks. Attribution may be incomplete.')).toBeTruthy();
  await screen.findByText('First finding');
  fireEvent.click(screen.getByTestId('performance-more'));
  await screen.findByText('Second finding');
  expect(screen.getAllByText('First finding')).toHaveLength(1);
  expect(screen.queryByTestId('performance-more')).toBeNull();
  expect(calls.find((call) => call.url.endsWith('/stop'))?.options?.body).toBe(JSON.stringify({ tabId: 'tab-a' }));
  expect(calls.some((call) => call.url.includes('cursor=opaque-next'))).toBe(true);
  for (const call of calls) {
    expect(new Headers(call.options?.headers).get('x-od-workspace-id')).toBe('workspace-a');
  }
});

it('ignores a late report list after the project changes', async () => {
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/status?')
    ? Promise.resolve(Response.json({ state: 'idle', capture: null }))
    : url.includes('/project-a/')
    ? new Promise<Response>((resolve) => { resolveOld = resolve; })
    : Promise.resolve(Response.json({ items: [], total: 0, nextCursor: null }))));
  const view = render(<BrowserPerformancePanel {...props} />);
  view.rerender(<BrowserPerformancePanel {...props} projectId="project-b" />);
  await screen.findByText('No saved reports yet.');
  await act(async () => { resolveOld(Response.json({ items: [report], total: 1, nextCursor: null })); });
  expect(screen.queryByText('report-a')).toBeNull();
});

it('allows a new recording after host loss without exposing a raw server error', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/status?')) return Response.json({ state: 'idle', capture: null });
    if (url.endsWith('/start')) return Response.json({ recording: true, reportId: 'report-a', maxMs: 15000, visible: true });
    if (url.endsWith('/stop')) return Response.json({ error: { code: 'BROWSER_COMMAND_FAILED', message: 'private-sentinel' } }, { status: 409 });
    return Response.json({ items: [], total: 0, nextCursor: null });
  }));
  render(<BrowserPerformancePanel {...props} />);
  await screen.findByText('No saved reports yet.');
  fireEvent.click(screen.getByTestId('performance-start'));
  await screen.findByTestId('performance-recording');
  fireEvent.click(screen.getByTestId('performance-stop'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The unsaved recording is no longer recoverable.');
  await waitFor(() => expect(screen.getByTestId('performance-start')).not.toBeDisabled());
  expect(screen.queryByText(/private-sentinel/)).toBeNull();
});

it('shows an externally started pending capture without claiming it is still recording', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/status?')
    ? Response.json({ state: 'pending', capture: { reportId: 'external-report', tabId: 'tab-a', maxMs: 15000 } })
    : Response.json({ items: [], total: 0, nextCursor: null })));
  render(<BrowserPerformancePanel {...props} />);
  expect(await screen.findByTestId('performance-recording')).toHaveTextContent('external-report');
  expect(screen.getByTestId('performance-recording')).toHaveTextContent('Unsaved capture:');
  expect(screen.getByTestId('performance-start')).toBeDisabled();
  expect(screen.getByTestId('performance-stop')).not.toBeDisabled();
});

it('keeps filtered evidence paging scoped and ignores an old page after the filter changes', async () => {
  const pages: Array<{ url: URL; options?: RequestInit }> = [];
  let resolveOld!: (value: Response) => void;
  const page = (id: string, kind: 'request' | 'style', nextCursor: string | null) => ({
    reportId: report.reportId, schemaVersion: 1, section: 'evidence', total: 2, nextCursor,
    omitted: 0, completeness: 'partial',
    items: [{ id, kind, atMs: 1, clock: 'document', documentId: 'document-a', values: {} }],
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/status?')) return Response.json({ state: 'idle', capture: null });
    if (url.endsWith('/reports/report-a')) return Response.json(report);
    if (url.includes('/pages?')) {
      const parsed = new URL(url, 'http://localhost');
      pages.push({ url: parsed, options });
      if (parsed.searchParams.get('kind') === 'request') {
        if (parsed.searchParams.has('cursor')) return new Promise<Response>((resolve) => { resolveOld = resolve; });
        return Response.json(page('request-first', 'request', 'request-next'));
      }
      if (parsed.searchParams.get('kind') === 'style') return Response.json(page('style-current', 'style', null));
      return Response.json({ ...page('unused', 'request', null), items: [], total: 0 });
    }
    return Response.json({ items: [report], total: 1, nextCursor: null });
  }));
  render(<BrowserPerformancePanel {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /report-a/ }));
  fireEvent.click(await screen.findByRole('button', { name: /^Evidence/ }));
  fireEvent.change(screen.getByTestId('performance-kind'), { target: { value: 'request' } });
  await screen.findByText('Requests · request-first');
  fireEvent.click(screen.getByTestId('performance-more'));
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  fireEvent.change(screen.getByTestId('performance-kind'), { target: { value: 'style' } });
  await screen.findByText('CSS rules · style-current');
  await act(async () => { resolveOld(Response.json(page('request-stale', 'request', null))); });
  expect(screen.queryByText(/request-first|request-stale/)).toBeNull();
  expect(screen.getByText('CSS rules · style-current')).toBeTruthy();
  expect(screen.queryByTestId('performance-more')).toBeNull();
  const filtered = pages.filter(({ url }) => url.searchParams.has('kind'));
  expect(filtered.map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
    { section: 'evidence', limit: '20', kind: 'request' },
    { section: 'evidence', limit: '20', kind: 'request', cursor: 'request-next' },
    { section: 'evidence', limit: '20', kind: 'style' },
  ]);
  for (const { url, options } of filtered) {
    expect(url.pathname).toBe('/api/projects/project-a/browser/performance/reports/report-a/pages');
    expect(new Headers(options?.headers).get('x-od-workspace-id')).toBe('workspace-a');
  }
});

it.each([true, false])('compares exact saved groups and presents returned variability (compatible=%s)', async (comparable) => {
  const baselineReportIds = ['before-1', 'before-2', 'before-3'];
  const candidateReportIds = ['after-1', 'after-2', 'after-3'];
  const result: BrowserPerformanceComparison = {
    schemaVersion: 1, comparable, scenarioId: 'slow-click', baselineReportIds, candidateReportIds,
    warnings: comparable ? ['metric-unavailable'] : ['metric-unavailable', 'environment-mismatch'],
    metrics: [{ metric: 'longTaskMaxMs', unit: 'ms',
      baseline: { samples: [101, 123, 987], min: 101, median: 123, max: 987, mean: 403.67, stddev: 412.57 },
      candidate: { samples: [75, 88, 900], min: 75, median: 88, max: 900, mean: 354.33, stddev: 385.88 },
      medianDelta: -35, medianDeltaPercent: -28.455 }],
  };
  const comparisons: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/status?')) return Response.json({ state: 'idle', capture: null });
    if (url.endsWith('/compare')) { comparisons.push(options!); return Response.json(result); }
    return Response.json({ items: [...baselineReportIds, ...candidateReportIds].map((reportId) => ({ ...report, reportId })), total: 6, nextCursor: null });
  }));
  render(<BrowserPerformancePanel {...props} />);
  await screen.findByLabelText('Comparison group before-1');
  expect(screen.getByTestId('performance-compare')).toBeDisabled();
  for (const id of baselineReportIds) fireEvent.change(screen.getByLabelText(`Comparison group ${id}`), { target: { value: 'baseline' } });
  for (const id of candidateReportIds) fireEvent.change(screen.getByLabelText(`Comparison group ${id}`), { target: { value: 'candidate' } });
  fireEvent.click(screen.getByTestId('performance-compare'));
  const view = within(await screen.findByTestId('performance-comparison'));
  expect(comparisons).toHaveLength(1);
  expect(comparisons[0]?.method).toBe('POST');
  expect(JSON.parse(String(comparisons[0]?.body))).toEqual({ baselineReportIds, candidateReportIds });
  expect(new Headers(comparisons[0]?.headers).get('x-od-workspace-id')).toBe('workspace-a');
  expect(view.getByText(comparable ? 'Conditions are compatible' : 'Conditions differ — do not treat this as a verified improvement')).toBeTruthy();
  expect(view.getByText('Some measurements are unavailable.')).toBeTruthy();
  if (!comparable) expect(view.getByText('Browser or measurement settings differ.')).toBeTruthy();
  expect(view.getByText(/Variation is not a statistical guarantee/)).toBeTruthy();
  const cells = view.getAllByRole('cell');
  expect(cells[0]).toHaveTextContent('123.0');
  expect(cells[0]).toHaveTextContent('101.0–987.0');
  expect(cells[1]).toHaveTextContent('88.0');
  expect(cells[1]).toHaveTextContent('75.0–900.0');
  expect(cells[2]).toHaveTextContent('-35.0');
  fireEvent.click(view.getByText('All recorded values'));
  expect(view.getByText(baselineReportIds.join(', '))).toBeTruthy();
  expect(view.getByText(candidateReportIds.join(', '))).toBeTruthy();
  expect(view.getByText('Baseline: 101.0, 123.0, 987.0')).toBeTruthy();
  expect(view.getByText('After: 75.0, 88.0, 900.0')).toBeTruthy();
});

it.each(['approved', 'denied', 'unavailable'] as const)('requires native confirmation before CPU dispatch: %s', async (decision) => {
  let resolveDecision!: (value: { ok: true; decision: 'approved' | 'denied' }) => void;
  const confirm = vi.fn(() => new Promise<{ ok: true; decision: 'approved' | 'denied' }>((resolve) => { resolveDecision = resolve; }));
  host.getOpenDesignHost.mockReturnValue(decision === 'unavailable' ? undefined : { browser: { confirmPerformanceApproval: confirm } });
  const posts: Array<{ url: string; options: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') posts.push({ url, options });
    if (url.endsWith('/override')) return Response.json(posts.length === 1
      ? { status: 'approval_required', approvalRequestId: 'approval-a', approval: { nativeConfirmationRequired: true } }
      : { status: 'applied', reportId: 'external-report', cpu: 4 });
    if (url.includes('/status?')) return Response.json({ state: 'pending', capture: { reportId: 'external-report', tabId: 'tab-a', maxMs: 60000 } });
    return Response.json({ items: [], total: 0, nextCursor: null });
  }));
  render(<BrowserPerformancePanel {...props} />);
  await screen.findByTestId('performance-recording');
  fireEvent.change(screen.getByTestId('performance-cpu'), { target: { value: '4' } });
  fireEvent.click(screen.getByTestId('performance-request-cpu'));
  if (decision === 'unavailable') {
    expect(await screen.findByRole('alert')).toHaveTextContent('Desktop confirmation is unavailable');
    expect(confirm).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith({ approvalId: 'approval-a', workspaceContext: context }));
    expect(posts).toHaveLength(1);
    expect(screen.getByTestId('performance-request-cpu')).toBeDisabled();
    await act(async () => { resolveDecision({ ok: true, decision }); });
    await screen.findByText(decision === 'approved' ? /Temporary CPU change applied/ : 'CPU change denied. No change was dispatched.');
  }
  expect(posts.map(({ options }) => JSON.parse(String(options.body)))).toEqual([
    { tabId: 'tab-a', reportId: 'external-report', cpu: 4 },
    ...(decision === 'approved' ? [{ tabId: 'tab-a', reportId: 'external-report', cpu: 4, approvalRequestId: 'approval-a' }] : []),
  ]);
  for (const { url, options } of posts) {
    expect(url).toBe('/api/projects/project-a/browser/performance/override');
    expect(new Headers(options.headers).get('x-od-workspace-id')).toBe('workspace-a');
  }
});

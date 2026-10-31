// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { McpBrowserApprovals } from '../../src/components/McpBrowserApprovals';

const host = vi.hoisted(() => ({ getOpenDesignHost: vi.fn() }));
vi.mock('@open-design/host', () => host);

const pending = {
  id: 'a1', principal: { kind: 'run', id: 'r1' }, projectId: 'p1', scope: null,
  tabId: 't1', operation: 'browser_click', location: 'https://example.invalid/',
  preview: 'Click #go', partial: true, createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z', status: 'pending',
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); host.getOpenDesignHost.mockReset(); });

it('shows a scoped request and warning, then sends the approval', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let approved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, method: options?.method ?? 'GET' });
    if (options?.method === 'POST') { approved = true; return Response.json({ approval: { ...pending, status: 'approved' } }); }
    return Response.json({ approvals: approved ? [] : [pending, { ...pending, id: 'other', tabId: 't2' }] });
  }));
  render(<McpBrowserApprovals projectId="p1" tabId="t1" workspaceContext={null} />);
  expect(await screen.findByText('Click #go')).toBeTruthy();
  expect(screen.getByText('Local apps and agents can make this decision too.')).toBeTruthy();
  expect(screen.getByText('Some action details are hidden or shortened.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.queryByText('Click #go')).toBeNull());
  expect(calls).toContainEqual({ url: '/api/mcp/approvals/a1/approve', method: 'POST' });
});

it('does not let an expired request be decided and reports a failed decision', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST'
    ? new Response('', { status: 409 })
    : Response.json({ approvals: [pending, { ...pending, id: 'expired', preview: 'Expired action', expiresAt: '2000-01-01T00:00:00Z' }] })));
  render(<McpBrowserApprovals projectId="p1" tabId="t1" workspaceContext={null} />);
  expect(await screen.findByText('Expired action')).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Approve' }) as HTMLButtonElement[];
  expect(buttons[1]?.disabled).toBe(true);
  fireEvent.click(buttons[0]!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update browser action requests');
});

it('uses the current workspace headers for listing and decisions', async () => {
  const sent: Headers[] = [];
  const context = { workspaceId: 'workspace-a', workspaceMemberId: 'member-a', workspaceType: 'team', role: 'owner',
    lifecycleState: 'active', memberStatus: 'active', permissions: { canShareProjects: true, canWriteSyncedFiles: true } } as unknown as WorkspaceCollabContext;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    sent.push(new Headers(options?.headers));
    return Response.json(options?.method === 'POST' ? { approval: { ...pending, status: 'denied' } } : { approvals: [pending] });
  }));
  render(<McpBrowserApprovals projectId="p1" tabId="t1" workspaceContext={context} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
  for (const headers of sent.slice(0, 2)) {
    expect(headers.get('x-od-workspace-id')).toBe('workspace-a');
    expect(headers.get('x-od-workspace-member-id')).toBe('member-a');
  }
});

it.each(['approved', 'denied', 'unavailable'] as const)('routes native-required requests only through desktop confirmation: %s', async (decision) => {
  let resolveDecision!: (value: { ok: true; decision: 'approved' | 'denied' }) => void;
  let decided = false;
  const confirm = vi.fn(() => new Promise<{ ok: true; decision: 'approved' | 'denied' }>((resolve) => { resolveDecision = resolve; }));
  host.getOpenDesignHost.mockReturnValue(decision === 'unavailable' ? undefined : { browser: { confirmPerformanceApproval: confirm } });
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, method: options?.method ?? 'GET' });
    return Response.json({ approvals: decided ? [] : [{ ...pending, nativeConfirmationRequired: true }] });
  }));
  render(<McpBrowserApprovals projectId="p1" tabId="t1" workspaceContext={null} />);
  const review = await screen.findByRole('button', { name: 'Review in desktop' });
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  fireEvent.click(review);
  if (decision === 'unavailable') {
    expect(await screen.findByRole('alert')).toHaveTextContent('Desktop confirmation is unavailable');
    expect(screen.getByText('Click #go')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith({ approvalId: 'a1', workspaceContext: null }));
    expect(review).toBeDisabled();
    expect(screen.getByText('Click #go')).toBeTruthy();
    await act(async () => { decided = true; resolveDecision({ ok: true, decision }); });
    await waitFor(() => expect(screen.queryByText('Click #go')).toBeNull());
  }
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(({ url, method }) => url === '/api/mcp/approvals' && method === 'GET')).toBe(true);
});

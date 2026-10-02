// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeAnnotationsPanel } from '../../src/components/EdgeAnnotationsPanel';

vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key }));

let requests: Array<{ url: string; method: string; body?: string; headers?: HeadersInit }>;
let grants: Array<{ grantId: string; origin: string }>;
let daemonUrl: string | null;

beforeEach(() => {
  requests = [];
  grants = [];
  daemonUrl = 'http://127.0.0.1:61546';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body as string | undefined, headers: init?.headers });
    if (url.endsWith('/pair')) {
      return { ok: true, json: async () => ({ pairId: 'pair', code: 'pair.secret', expiresAt: Date.now() + 120_000 }) };
    }
    if (url.endsWith('/inspect')) {
      const operation = JSON.parse(init?.body as string).operation as string;
      return operation === 'screenshot'
        ? { ok: true, json: async () => ({ ok: true, requestId: 'r2',
          result: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } }) }
        : { ok: true, json: async () => ({ ok: true, requestId: 'r1',
          result: { html: '<script>alert(1)</script>', truncated: false,
            url: 'https://app.example.test', title: 'Example' } }) };
    }
    if (method === 'DELETE') {
      grants = [];
      return { ok: true, json: async () => ({ revoked: true }) };
    }
    return { ok: true, json: async () => ({ grants, daemonUrl }) };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('managed Edge one-step chat pairing', () => {
  it('shows the exact daemon URL and the setup order, not the web origin', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('designBrowser.edge.connectionSteps')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:61546/#od-annotation=pair.secret'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it.each([null, 'http://remote.example.test:61546', 'http://127.0.0.1:61546/?token=private'])
  ('does not suggest an unavailable or unsafe daemon URL: %s', async (value) => {
    daemonUrl = value;
    render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={vi.fn()} />);
    expect(await screen.findByText('designBrowser.edge.daemonUrlUnavailable')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears the previous daemon URL when the active conversation changes', async () => {
    const pending: Array<(response: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { pending.push(resolve); })));
    const { rerender } = render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={vi.fn()} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!({ ok: true, json: async () => ({ grants: [], daemonUrl: 'http://127.0.0.1:61546' }) });
    await waitFor(() => expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(false));
    rerender(<EdgeAnnotationsPanel projectId="p1" conversationId="c2"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={vi.fn()} />);
    expect(await screen.findByText('designBrowser.edge.daemonUrlUnavailable')).toBeTruthy();
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ ok: false });
    expect(screen.queryByText('http://127.0.0.1:61546')).toBeNull();
  });

  it('requires a conversation but not an extension ID', async () => {
    const onOpenExternal = vi.fn();
    const { rerender } = render(<EdgeAnnotationsPanel projectId="p1" conversationId={null}
      pageUrl="https://app.example.test/dashboard" onOpenExternal={onOpenExternal} />);
    const connect = screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    rerender(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={onOpenExternal} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(connect);
    await waitFor(() => expect(screen.getByText('http://127.0.0.1:61546/#od-annotation=pair.secret')).toBeTruthy());
    expect(requests.find((request) => request.url.endsWith('/pair'))).toMatchObject({
      method: 'POST', body: JSON.stringify({ conversationId: 'c1' }),
    });
    expect(onOpenExternal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'designBrowser.edge.send' })).toBeNull();
    expect(requests.some((request) => request.url.includes('/annotations/'))).toBe(false);
  });

  it('uses the active workspace identity for pairing, status, and revocation', async () => {
    grants = [{ grantId: 'grant-1', origin: 'https://app.example.test' }];
    const workspaceContext = {
      workspaceId: 'w1', workspaceMemberId: 'm1', workspaceType: 'personal',
      role: 'owner', lifecycleState: 'active', memberStatus: 'active',
      permissions: { canShareProjects: true, canWriteSyncedFiles: true },
    } as Parameters<typeof EdgeAnnotationsPanel>[0]['workspaceContext'];
    render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" workspaceContext={workspaceContext} onOpenExternal={vi.fn()} />);
    await screen.findByText('https://app.example.test');
    await waitFor(() => expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }));
    await screen.findByText('http://127.0.0.1:61546/#od-annotation=pair.secret');
    fireEvent.click(screen.getByRole('button', { name: 'designBrowser.edge.disconnect' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
    for (const request of requests) {
      expect(new Headers(request.headers).get('x-od-workspace-id')).toBe('w1');
      expect(new Headers(request.headers).get('x-od-workspace-member-id')).toBe('m1');
    }
  });

  it('reads only from the paired grant and displays returned markup as text, never HTML', async () => {
    grants = [{ grantId: 'grant-1', origin: 'https://app.example.test' }];
    render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test" onOpenExternal={vi.fn()} />);
    await screen.findByText('https://app.example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }));
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('script')?.textContent).not.toBe('alert(1)');
    expect(requests.find((request) => request.url.endsWith('/inspect'))).toMatchObject({
      method: 'POST', body: JSON.stringify({ conversationId: 'c1', grantId: 'grant-1',
        operation: 'snapshot' }),
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'CSS selector for paired tab' }),
      { target: { value: 'main' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Inspect element' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect element' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Screenshot of entire paired tab' }) as HTMLButtonElement).disabled).toBe(false));
    expect(requests.filter((request) => request.url.endsWith('/inspect'))).toHaveLength(2);
    expect(JSON.parse(requests.filter((request) => request.url.endsWith('/inspect'))[1]!.body!))
      .toMatchObject({ operation: 'inspect', selector: 'main' });
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot of entire paired tab' }));
    expect(await screen.findByAltText('Screenshot of paired tab')).toBeTruthy();
  });

  it('never displays a late inspection result in another conversation', async () => {
    grants = [{ grantId: 'grant-1', origin: 'https://app.example.test' }];
    let finish!: (response: unknown) => void;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('/inspect') ? new Promise((resolve) => { finish = resolve; }) : originalFetch(url, init)));
    const { rerender } = render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test" onOpenExternal={vi.fn()} />);
    await screen.findByText('https://app.example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }));
    expect(finish).toBeTypeOf('function');
    rerender(<EdgeAnnotationsPanel projectId="p1" conversationId="c2"
      pageUrl="https://app.example.test" onOpenExternal={vi.fn()} />);
    finish({ ok: true, json: async () => ({ ok: true, requestId: 'r1',
      result: { html: 'previous conversation', truncated: false,
        url: 'https://app.example.test', title: 'Example' } }) });
    await waitFor(() => expect((screen.getByRole('button', { name: 'designBrowser.edge.copyConnectionUrl' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('previous conversation')).toBeNull();
    expect(document.querySelector('[aria-label="Paired tab inspection text"]')).toBeNull();
  });

  it('shows and revokes only grants from the current conversation, never a staging inbox', async () => {
    grants = [{ grantId: 'grant-1', origin: 'https://app.example.test' }];
    render(<EdgeAnnotationsPanel projectId="p1" conversationId="c1"
      pageUrl="https://app.example.test/dashboard" onOpenExternal={vi.fn()} />);
    await screen.findByText('https://app.example.test');
    fireEvent.click(screen.getByRole('button', { name: 'designBrowser.edge.disconnect' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE'
      && request.url === '/api/projects/p1/edge-annotations/grant-1?conversationId=c1')).toBe(true));
    expect(screen.queryByText('https://app.example.test')).toBeNull();
  });
});

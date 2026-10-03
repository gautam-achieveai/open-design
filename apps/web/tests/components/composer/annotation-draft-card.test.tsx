// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer, type ChatComposerHandle } from '../../../src/components/ChatComposer';
import { saveComposerDraftExtras } from '../../../src/runtime/chat/composer-draft';
import { ANNOTATION_EVENT, type AnnotationEventDetail } from '../../../src/components/PreviewDrawOverlay';
import { composerText, flushMounts, pressEnter } from '../../helpers/lexical-composer';

const KEY = 'od:chat-composer:draft:project-1:conv-1';
const ID = '11111111-1111-4111-8111-111111111111';
const note = 'Make the heading clearer';
const annotation = {
  id: ID, projectId: 'project-1', conversationId: 'conv-1', eventId: ID,
  note, text: `${note}\n\nBrowser page: https://example.test`, hasScreenshot: true, createdAt: 1,
  evidence: { url: 'https://example.test', target: { selector: '#hero', text: 'Hero', label: 'h1', htmlHint: 'h1', position: { x: 10, y: 20, width: 100, height: 40 } } },
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });
function mount(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  return render(<ChatComposer projectId="project-1" conversationId="conv-1" projectFiles={[]}
    streaming={false} draftStorageKey={KEY} onEnsureProject={async () => 'project-1'}
    onSend={vi.fn()} onStop={vi.fn()} annotationDrafts={[annotation]} {...overrides} />);
}

describe('browser annotation draft image', () => {
  it('shows one card, opens note/context and submits both evidence IDs with its hidden note', async () => {
    const onSend = vi.fn((..._args: Parameters<NonNullable<ComponentProps<typeof ChatComposer>['onSend']>>) => 'restore-draft' as const);
    mount({ onSend });
    await flushMounts();
    await waitFor(() => expect(screen.getAllByTestId('staged-browser-annotation-image')).toHaveLength(1));
    expect(screen.queryByRole('link', { name: 'annotation-context.json' })).toBeNull();
    expect(composerText().trim()).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Preview Attached images' }));
    const dialog = screen.getByRole('dialog', { name: 'Attached images' });
    expect(dialog.textContent).toContain(note);
    expect(dialog.textContent).toContain('#hero');
    expect(within(dialog).getByRole('link', { name: 'annotation-context.json' }).getAttribute('href')).toContain(`/pending/${ID}/context`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe(note);
    expect(onSend.mock.calls[0]?.[3]).toMatchObject({ annotationIds: [ID], annotationImageIds: [ID] });
  });

  it('discards the whole annotation without deleting matching human text', async () => {
    window.localStorage.setItem(KEY, note);
    mount();
    await flushMounts();
    await waitFor(() => expect(screen.getByTestId('staged-browser-annotation-image')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment attachment' }));
    await waitFor(() => expect(screen.queryByTestId('staged-browser-annotation-image')).toBeNull());
    expect(composerText()).toBe(note);
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes(`/pending/${ID}?`) && options?.method === 'DELETE')).toBe(true);
  });

  it('retains evidence on discard failure and provides details when the image fails', async () => {
    fetchMock.mockImplementation(async (_url: string, options?: RequestInit) =>
      new Response('{}', { status: options?.method === 'DELETE' ? 409 : 200, headers: { 'content-type': 'application/json' } }));
    mount();
    await flushMounts();
    const card = screen.getByTestId('staged-browser-annotation-image');
    fireEvent.error(card.querySelector('img')!);
    expect(card.textContent).toContain('Unavailable');
    fireEvent.click(within(card).getByRole('button', { name: 'Preview Attached images' }));
    expect(screen.getByRole('dialog').textContent).toContain(note);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment attachment' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByTestId('staged-browser-annotation-image')).toBeTruthy();
  });

  it('restores hidden-note IDs, waits for metadata and preserves older draft notes without duplication', async () => {
    saveComposerDraftExtras(KEY, { attachments: [], commentAttachments: [], quotes: [],
      annotationIds: [ID], annotationImageIds: [ID], hiddenAnnotationIds: [ID],
      context: { skillIds: [], mcpServerIds: [], connectorIds: [], workspaceItems: [] } });
    const onSend = vi.fn((..._args: Parameters<NonNullable<ComponentProps<typeof ChatComposer>['onSend']>>) => 'restore-draft' as const);
    const view = mount({ annotationDrafts: [], onSend });
    await flushMounts();
    expect(screen.getByRole('status').textContent).toBe('Loading annotation details…');
    pressEnter({ meta: true });
    expect(onSend).not.toHaveBeenCalled();
    view.rerender(<ChatComposer projectId="project-1" conversationId="conv-1" projectFiles={[]}
      streaming={false} draftStorageKey={KEY} onEnsureProject={async () => 'project-1'}
      onSend={onSend} onStop={vi.fn()} annotationDrafts={[annotation]} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe(note);
    cleanup();
    window.localStorage.setItem(KEY, note);
    saveComposerDraftExtras(KEY, { attachments: [], commentAttachments: [], quotes: [],
      annotationIds: [ID], annotationImageIds: [ID], context: { skillIds: [], mcpServerIds: [], connectorIds: [], workspaceItems: [] } });
    mount({ onSend });
    await flushMounts();
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0]).toBe(note);
  });

  it('keeps a queued annotation note once when restoring its composed text for editing', async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn((..._args: Parameters<NonNullable<ComponentProps<typeof ChatComposer>['onSend']>>) => 'restore-draft' as const);
    mount({ ref, onSend, streaming: true });
    await flushMounts();
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const queued = onSend.mock.calls[0]!;
    act(() => ref.current?.restoreDraft({ text: queued[0], meta: queued[3] }));
    await flushMounts();
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0]).toBe(note);
    expect(onSend.mock.calls[1]?.[3]).toMatchObject({ annotationIds: [ID], annotationImageIds: [ID] });
  });

  it.each([['send', false], ['queue', false], ['send', true]] as const)('rejects %s annotations before staging/upload when hidden metadata is absent (streaming=%s)', async (action, streaming) => {
    saveComposerDraftExtras(KEY, { attachments: [], commentAttachments: [], quotes: [],
      annotationIds: [ID], annotationImageIds: [ID], hiddenAnnotationIds: [ID],
      context: { skillIds: [], mcpServerIds: [], connectorIds: [], workspaceItems: [] } });
    const onSend = vi.fn();
    const ack = vi.fn();
    mount({ annotationDrafts: [], onSend, streaming });
    await flushMounts();
    const detail: AnnotationEventDetail = { file: null, note: 'Keep this new caller note', action, ack };
    act(() => window.dispatchEvent(new CustomEvent(ANNOTATION_EVENT, { detail })));
    await waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalledWith({ ok: false, message: 'Loading annotation details…' });
    expect(onSend).not.toHaveBeenCalled();
    expect(composerText().trim()).toBe('');
    expect(detail.note).toBe('Keep this new caller note');
    expect(screen.getByTestId('staged-browser-annotation-image')).toBeTruthy();
  });

  it('marks queued restored IDs applied before their pending metadata arrives', async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn((..._args: Parameters<NonNullable<ComponentProps<typeof ChatComposer>['onSend']>>) => 'restore-draft' as const);
    const view = mount({ ref, annotationDrafts: [], onSend });
    await flushMounts();
    act(() => ref.current?.restoreDraft({ text: note, meta: { annotationIds: [ID], annotationImageIds: [ID] } }));
    view.rerender(<ChatComposer ref={ref} projectId="project-1" conversationId="conv-1" projectFiles={[]}
      streaming={false} draftStorageKey={KEY} onEnsureProject={async () => 'project-1'}
      onSend={onSend} onStop={vi.fn()} annotationDrafts={[annotation]} />);
    await flushMounts();
    pressEnter({ meta: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe(note);
    expect(onSend.mock.calls[0]?.[3]).toMatchObject({ annotationIds: [ID], annotationImageIds: [ID] });
  });
});

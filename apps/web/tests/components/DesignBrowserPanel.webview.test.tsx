// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenDesignHostBrowserPopup, OpenDesignHostBrowserPopupCommand } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import { DesignBrowserPanel, browserClampedOverlayBounds, browserPinTargetSignature, browserPinTargetsFromSignature } from '../../src/components/DesignBrowserPanel';
import { browserCommentFilePath, type BrowserElementSnapshot } from '../../src/components/design-browser-tools';
import { I18nProvider } from '../../src/i18n';
import type { PreviewComment } from '../../src/types';
import { writeProjectTextFile } from '../../src/providers/registry';
import * as browserControl from '../../src/runtime/embedded-browser-control';

// The panel imports these writers from the registry at module load; stub them so
// rendering never reaches the network.
vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    openExternalUrl: vi.fn(async () => true),
    writeProjectTextFile: vi.fn(async () => null),
    writeProjectBase64File: vi.fn(async () => null),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SavePreviewComment = NonNullable<ComponentProps<typeof DesignBrowserPanel>['onSavePreviewComment']>;
/** Popover Save hands the pick to the workspace; the panel owns nothing after. */
function savePreviewCommentMock() {
  return vi.fn<SavePreviewComment>(async () => null);
}

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(writeProjectTextFile).mockResolvedValue(null);
  // Makes isOpenDesignHostAvailable() true so the panel renders the desktop
  // <webview> branch (rather than the iframe fallback).
  restoreHost = installMockOpenDesignHost();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function dispatchWebviewNavigate(webview: HTMLElement, url: string) {
  act(() => {
    const event = new Event('did-navigate') as Event & { url?: string; isMainFrame?: boolean };
    event.url = url;
    event.isMainFrame = true;
    webview.dispatchEvent(event);
  });
}

function dispatchWebviewTitle(webview: HTMLElement, title: string) {
  act(() => {
    const event = new Event('page-title-updated') as Event & { title?: string };
    event.title = title;
    webview.dispatchEvent(event);
  });
}

function getAddressDisplay(container: HTMLElement) {
  return {
    title: container.querySelector('.db-address-title')?.textContent ?? '',
    url: container.querySelector('.db-address-url')?.textContent ?? '',
  };
}

describe('DesignBrowserPanel <webview> navigation', () => {
  it('enables pop-ups before the webview is inserted and Electron attaches its guest', () => {
    const allowPopupsAtInsertion: (string | null)[] = [];
    const appendChild = Node.prototype.appendChild;
    vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function <T extends Node>(this: Node, child: T): T {
      if (child instanceof HTMLElement && child.tagName === 'WEBVIEW') {
        allowPopupsAtInsertion.push(child.getAttribute('allowpopups'));
      }
      return appendChild.call(this, child) as T;
    });

    render(<DesignBrowserPanel projectId="popup-initial-attribute" initialUrl="http://localhost:1234/"
      onOpenFile={() => {}} onRefreshFiles={() => {}} />);

    expect(allowPopupsAtInsertion).toEqual(['true']);
  });

  it('captures a value-masked native screenshot when annotating a form field', async () => {
    const capturePage = vi.fn(async (options?: { clip?: { x: number; y: number; width: number; height: number } }) => ({
      ok: true as const, dataUrl: 'data:image/png;base64,AAAA', w: 200, h: 100, capturedCssRect: options?.clip }));
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1"
      initialUrl="http://localhost:1234/signin" onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('function snapshotFor(el, ev)') ? {
      elementId: 'dom:body > form > input', selector: 'body > form > input', label: 'input', text: '',
      htmlHint: 'input', domOutline: 'input', isFormField: true,
      position: { x: 0, y: 0, width: 100, height: 30 },
      maskRects: [{ x: 0, y: 0, width: 100, height: 30 }], viewport: { width: 300, height: 200 },
    } : script.includes('const targets =') ? [{
      elementId: 'dom:body > form > input', selector: 'body > form > input', label: 'input', text: '',
      htmlHint: 'input', domOutline: 'input', isFormField: true,
      position: { x: 0, y: 0, width: 100, height: 30 }, key: 'capture',
      maskRects: [{ x: 0, y: 0, width: 100, height: 30 }], viewport: { width: 300, height: 200 },
    }] : null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await waitFor(() => expect(capturePage).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText('Comment on this element…')).toBeTruthy();
  });

  it.each(['valid', 'legacy', 'malformed', 'unavailable'] as const)(
    'uses exact ordinary host capture geometry before attaching masked evidence: %s', async (kind) => {
      const dataUrl = 'data:image/png;base64,cGl4ZWxz';
      const captured = { x: 278 / 1.2, y: 290 / 1.2, width: 287 / 1.2, height: 191 / 1.2 };
      let captures = 0;
      const capturePage = vi.fn(async () => {
        if (++captures === 1 && kind === 'unavailable') return { ok: false as const, reason: 'host capture unavailable' };
        return { ok: true as const, dataUrl, w: 287, h: 191,
          ...(kind === 'legacy' ? {} : { capturedCssRect: kind === 'malformed' ? { ...captured, width: NaN } : captured }) };
      });
      restoreHost?.(); restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
      vi.stubGlobal('Image', class {
        naturalWidth = 287; naturalHeight = 191; onload?: () => void;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
      });
      const drawImage = vi.fn(), fillRect = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
      const fetchMock = vi.fn(async (url: string) => url.startsWith('data:')
        ? { blob: async () => new Blob(['crop'], { type: 'image/png' }) } : { ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const save = savePreviewCommentMock();
      const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
        onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
      const node = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
      node.getBoundingClientRect = () => ({ left: 30, top: 40, right: 1030, bottom: 840,
        width: 1000, height: 800, x: 30, y: 40, toJSON() {} } as DOMRect);
      const target = { elementId: 'dom:#field', selector: '#field', label: 'input', text: '', htmlHint: 'input',
        position: { x: 201, y: 201, width: 240, height: 160 }, viewport: { width: 1000, height: 800 },
        maskRects: [{ x: 1, y: 1, width: 10, height: 10 }, { x: 25, y: 25, width: 10, height: 10, textHidden: true }] };
      let restored = false;
      node.executeJavaScript = vi.fn(async (script: string) => {
        if (script.includes('function snapshotFor(el, ev)')) return target;
        if (script.includes('const targets =')) return [{ ...target, key: 'capture' }];
        if (script.includes('data-od-annotation-text')) {
          if (script.includes('if (false) {')) restored = true;
          return true;
        }
        return null;
      });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
      await waitFor(() => expect(restored).toBe(true));
      expect(capturePage).toHaveBeenCalledTimes(1);
      if (kind === 'valid') {
        fireEvent.click(await screen.findByRole('button', { name: /^Attach image \(1\)/ }));
        await screen.findByRole('button', { name: /^browser-annotation-/ });
        expect(fillRect).toHaveBeenCalledWith(0, 0, 13, 13);
      } else expect(fillRect).not.toHaveBeenCalled();
      fireEvent.change(screen.getByPlaceholderText('Comment on this element…'), { target: { value: 'Review the field' } });
      await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const images = save.mock.calls[0]![3] ?? [];
      if (kind === 'valid') expect(images.map((file) => file.name)).toEqual([expect.stringMatching(/^browser-annotation-/)]);
      else expect(images).toEqual([]);
    });

  it.each(['stable', 'navigation', 'viewport', 'mask', 'capture-failure', 'decode-failure'] as const)(
    'captures the original popup annotation with actual pixel scaling and masking: %s', async (change) => {
      const nativeDataUrl = 'data:image/png;base64,cG9wdXA=';
      const hostCapture = vi.fn(async () => ({ ok: true as const,
        dataUrl: 'data:image/png;base64,aG9zdA==', w: 900, h: 600 }));
      const imageSizes = new Map([[nativeDataUrl, { w: 600, h: 600 }]]);
      vi.stubGlobal('Image', class {
        onload?: () => void; onerror?: () => void; naturalWidth = 0; naturalHeight = 0; srcValue = '';
        set src(value: string) {
          this.srcValue = value;
          const size = imageSizes.get(value);
          if (size && change !== 'decode-failure') {
            this.naturalWidth = size.w; this.naturalHeight = size.h;
            queueMicrotask(() => this.onload?.());
          } else queueMicrotask(() => this.onerror?.());
        }
      });
      const drawImage = vi.fn(), fillRect = vi.fn(), strokeRect = vi.fn(); let images = 0;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect, strokeRect } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
        const url = `data:image/png;base64,${btoa(`crop-${++images}`)}`;
        imageSizes.set(url, { w: this.width, h: this.height }); return url;
      });
      const target = { elementId: 'dom:#field', selector: '#field', label: 'input', text: '', htmlHint: 'input',
        position: { x: -10, y: 20, width: 110, height: 50 }, viewport: { width: 300, height: 200, contentWidth: 150, contentHeight: 200 },
        maskRects: [{ x: 10, y: 0, width: 20, height: 10, textHidden: true }, { x: 35, y: 15, width: 10, height: 10 }] };
      const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:annotation', projectId: 'p1', openerTabId: '__browser__:1',
        ancestorTabIds: ['__browser__:1'], tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Written child',
        loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
      let measured = 0, restored = false, currentPageUrl = popup.url;
      const hiddenAtCapture: Array<{ popover: boolean; status: boolean }> = [];
      const hiddenByAncestor = (node: Element | null) => {
        for (let el = node as HTMLElement | null; el; el = el.parentElement) if (el.style?.visibility === 'hidden') return true;
        return false;
      };
      const popupCommand = vi.fn(async (request: OpenDesignHostBrowserPopupCommand) => {
        if (request.kind === 'capture') {
          // The compositor must never see host chrome: popover and status toast
          // are committed hidden before the pixels are taken.
          hiddenAtCapture.push({
            popover: hiddenByAncestor(document.querySelector('[data-testid="comment-popover-save"]')),
            status: hiddenByAncestor(document.querySelector('.db-status')),
          });
          if (change === 'capture-failure') return { ok: false as const, reason: 'capture unavailable' };
          return { ok: true as const, value: nativeDataUrl };
        }
        if (request.kind !== 'evaluate') return { ok: true as const };
        if (request.code.includes('function snapshotFor(el, ev)')) return { ok: true as const, value: target };
        if (request.code.includes('const targets =') && request.code.includes('"key":"capture"')) {
          measured++;
          if (measured === 2 && change === 'navigation') currentPageUrl = 'https://example.com/changed';
          return { ok: true as const, value: [{ ...target, key: 'capture',
            ...(measured === 2 && change === 'viewport' ? { viewport: { width: 301, height: 200 } } : {}),
            ...(measured === 2 && change === 'mask' ? { maskRects: [] } : {}) }] };
        }
        if (request.code.includes('data-od-annotation-text')) {
          if (request.code.includes('if (false) {')) restored = true;
          return { ok: true as const, value: true };
        }
        return { ok: true as const, value: null };
      });
      restoreHost?.();
      restoreHost = installMockOpenDesignHost({ host: { capture: { page: hostCapture }, browser: {
        listPopups: async () => ({ ok: true, popups: [popup] }), subscribePopups: () => () => {},
        bindPopup: async () => ({ ok: true }), popupCommand,
        presentPopup: async (request) => ({ ok: true, value: { revision: request.revision, bounds: request.bounds } }),
      } } });
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      const fetchMock = vi.fn(async (url: string) => url.startsWith('data:')
        ? { blob: async () => new Blob(['crop'], { type: 'image/png' }) } : { ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const save = vi.fn<SavePreviewComment>(async (pinTarget, note) => ({
        id: 'cmt-1', projectId: 'p1', conversationId: 'c1', filePath: pinTarget.filePath,
        elementId: pinTarget.elementId, selector: pinTarget.selector, label: pinTarget.label, text: pinTarget.text,
        htmlHint: pinTarget.htmlHint, position: pinTarget.position, note, status: 'open', pinSeq: 1,
        createdAt: 1, updatedAt: 1,
      }));
      const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" browserTabId="__browser__:2"
        popup={popup} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
      const surface = container.querySelector('[data-popup-surface]')! as HTMLElement & { getURL(): string };
      surface.getBoundingClientRect = () => ({ left: 30, top: 40, right: 330, bottom: 240,
        width: 300, height: 200, x: 30, y: 40, toJSON() {} } as DOMRect);
      surface.getURL = () => currentPageUrl;
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
      await waitFor(() => expect(restored).toBe(true));
      expect(hostCapture).not.toHaveBeenCalled();
      if (change === 'stable') {
        fireEvent.click(await screen.findByRole('button', { name: /^Attach image \(1\)/ }));
        await screen.findByRole('button', { name: /^browser-annotation-/ });
      }
      const note = screen.getByPlaceholderText('Comment on this element…');
      fireEvent.change(note, { target: { value: 'Review the field' } });
      await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const savedImages = save.mock.calls[0]![3] ?? [];
      if (change === 'stable') {
        // The 100x50 visible field is smaller than the 160x100 minimum, so the
        // crop grows from the viewport's corner, capped at the 150px content
        // box (the guest scrollbar is left out); 2x/3x native pixels. The mask
        // maps into it and a ring marks the field inside.
        expect(drawImage.mock.calls[0]!.slice(1)).toEqual([0, 0, 300, 300, 0, 0, 300, 300]);
        expect(fillRect).toHaveBeenCalledWith(50, 105, 20, 30);
        expect(strokeRect).toHaveBeenCalledWith(-6, 34, 212, 112);
        expect(hiddenAtCapture.length).toBeGreaterThan(0);
        expect(hiddenAtCapture.every((state) => state.popover && state.status)).toBe(true);
        expect(savedImages.map((file) => file.name)).toEqual([expect.stringMatching(/^browser-annotation-/)]);
      } else expect(savedImages).toEqual([]);
      // Only a pin without a picture is called out after Save.
      await waitFor(() => expect(container.querySelector('.db-status')?.textContent).toBe(change === 'stable'
        ? 'Browser comment saved'
        : 'Pin saved without a picture. Pick the element again to retry the capture.'));
    });

  it('omits a native screenshot if a field moves between the two geometry checks', async () => {
    const capturePage = vi.fn(async (options?: { clip?: { x: number; y: number; width: number; height: number } }) => ({
      ok: true as const, dataUrl: 'data:image/png;base64,AAAA', w: 200, h: 100, capturedCssRect: options?.clip }));
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
    const fetchMock = vi.fn(async (_url: string, _options: { body: string }) => ({ ok: true,
      json: async () => ({ projectId: 'p1', conversationId: 'c1', id: '11111111-1111-4111-8111-111111111111', replayed: false }) }));
    vi.stubGlobal('fetch', fetchMock);
    const save = savePreviewCommentMock();
    try {
      const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1"
        initialUrl="http://localhost:1234/signin" onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
      const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
      webview.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200,
        width: 300, height: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
      let measured = 0;
      const target = { elementId: 'dom:body > input', selector: 'body > input', label: 'input', text: '',
        htmlHint: 'input', position: { x: 0, y: 0, width: 100, height: 30 },
        maskRects: [{ x: 0, y: 0, width: 100, height: 30 }], viewport: { width: 300, height: 200 } };
      webview.executeJavaScript = vi.fn(async (script: string) => script.includes('function snapshotFor(el, ev)')
        ? target : script.includes('const targets =') ? [{ ...target, key: 'capture',
          maskRects: script.includes('"key":"capture"') && ++measured > 1
            ? [{ x: 10, y: 0, width: 90, height: 30 }] : target.maskRects }] : null);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
      await waitFor(() => expect(capturePage).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(measured).toBeGreaterThanOrEqual(2));
      const note = screen.getByPlaceholderText('Comment on this element…');
      fireEvent.change(note, { target: { value: 'Adjust the field layout' } });
      await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0]![3] ?? []).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('saves a picked element as a dock pin without staging it, draws its pinSeq marker and edits it in place', async () => {
    const agentSend = vi.fn();
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const hero = { elementId: 'hero', selector: '#hero', label: 'div', text: 'Save', htmlHint: '<div id="hero">',
      domOutline: 'div\n  h1 Save', position: { x: 0, y: 0, width: 100, height: 100 } };
    const save = vi.fn<SavePreviewComment>(async (target, note, _attach, _images, commentId) => ({
      id: commentId ?? 'cmt-1', projectId: 'p1', conversationId: 'c1', filePath: target.filePath,
      elementId: target.elementId, selector: target.selector, label: target.label, text: target.text,
      htmlHint: target.htmlHint, position: target.position, note, status: 'open', pinSeq: 7,
      createdAt: 1, updatedAt: 1,
    }));
    function Harness() {
      const [previewComments, setPreviewComments] = useState<PreviewComment[]>([]);
      return (
        <DesignBrowserPanel projectId="p1" conversationId="c1"
          initialUrl="http://localhost:1234/demo?view=wide#hero" onOpenFile={() => {}} onRefreshFiles={() => {}}
          previewComments={previewComments}
          onSendBoardCommentAttachments={agentSend}
          onSavePreviewComment={async (...args) => {
            const saved = await save(...args);
            if (saved) setPreviewComments((current) => [...current.filter((item) => item.id !== saved.id), saved]);
            return saved;
          }} />
      );
    }
    try {
      const { container } = render(<Harness />);
      const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
      webview.executeJavaScript = vi.fn(async (script: string) => {
        if (script.includes('function snapshotFor(el, ev)')) return hero;
        if (script.includes('const targets =')) {
          // Every requested key resolves to the hero rect, so saved pins get a live rect.
          return Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ ...hero, key: match[1] }));
        }
        return null;
      });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
      const input = screen.getByPlaceholderText('Comment on this element…');
      fireEvent.change(input, { target: { value: 'Make Save clearer' } });
      expect(screen.queryByRole('button', { name: 'Add to chat draft' })).toBeNull();
      await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const [target, note, attachAfterSave, images, commentId] = save.mock.calls[0]!;
      expect(target).toMatchObject({ filePath: 'browser:http://localhost:1234/demo?view=wide#hero', selector: '#hero' });
      expect(note).toBe('Make Save clearer');
      expect(attachAfterSave).toBe(false);
      expect(images).toEqual([]);
      expect(commentId).toBeUndefined();
      // No capture was available, so the save says the pin has no picture.
      await waitFor(() => expect(container.querySelector('.db-status')?.textContent)
        .toBe('Pin saved without a picture. Pick the element again to retry the capture.'));
      expect(agentSend).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/edge-annotations/'))).toBe(false);
      expect(writeProjectTextFile).not.toHaveBeenCalled();

      // The saved pin is drawn from its live rect, numbered by pinSeq, and the
      // popover stays open on it so the note can be edited in place.
      // The accessible name carries the pin number and the open pin is
      // announced through aria-current, not colour alone.
      const badge = await screen.findByRole('button', { name: 'Open pin #7: div' });
      expect(badge.textContent).toBe('7');
      expect(badge.getAttribute('aria-current')).toBe('true');
      expect(screen.getByTestId('db-comment-marker-cmt-1')).toBeTruthy();
      expect(screen.getByTestId('comment-side-dock')).toBeTruthy();
      fireEvent.change(screen.getByPlaceholderText('Comment on this element…'), { target: { value: 'Make Save bolder' } });
      await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save.mock.calls[1]![1]).toBe('Make Save bolder');
      expect(save.mock.calls[1]![4]).toBe('cmt-1');
      expect(screen.getAllByTestId(/^db-comment-marker-/)).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('clamps a saved pin marker to the guest viewport so its number stays visible (D2)', async () => {
    const pin: PreviewComment = {
      id: 'cmt-wide', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#card2', selector: '#card2', label: 'p', text: 'Another block', htmlHint: '<p>',
      position: { x: 45, y: 300, width: 300, height: 40 }, note: 'Card copy is vague', status: 'open',
      pinSeq: 2, createdAt: 1, updatedAt: 1,
    };
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    // The picker never resolves (no click); the measure script sees the pin
    // 45px in from the left of a 303px-wide guest viewport, 42px past its edge.
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('const targets =')
      ? Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ key: match[1],
        elementId: pin.elementId, selector: pin.selector, label: pin.label, text: pin.text, htmlHint: pin.htmlHint,
        position: pin.position, viewport: { width: 303, height: 600 } }))
      : new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    const marker = await screen.findByTestId('db-comment-marker-cmt-wide');
    expect(marker.style.left).toBe('45px');
    expect(marker.style.width).toBe('258px');
    expect(marker.getAttribute('data-clamped-right')).toBe('true');
    expect(marker.getAttribute('data-clamped-top')).toBeNull();
    const badge = screen.getByRole('button', { name: 'Open pin #2: p' });
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('aria-current')).toBeNull();
  });

  it('does not measure saved pins while the browser tab is hidden, even with the comment tool on (F6)', async () => {
    const pin: PreviewComment = {
      id: 'cmt-hidden', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Hero note', status: 'open',
      pinSeq: 1, createdAt: 1, updatedAt: 1,
    };
    const measure = vi.fn(async (script: string) => script.includes('const targets =')
      ? Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ key: match[1],
        elementId: pin.elementId, selector: pin.selector, label: pin.label, text: pin.text, htmlHint: pin.htmlHint,
        position: pin.position, viewport: { width: 300, height: 200 } }))
      : new Promise(() => {}));
    function Harness({ active }: { active: boolean }) {
      return (
        <DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com" browserTabActive={active}
          previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()} />
      );
    }
    const { container, rerender } = render(<Harness active />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = measure;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await screen.findByTestId('db-comment-marker-cmt-hidden');
    const measuredWhileActive = measure.mock.calls.filter(([script]) => script.includes('"key":"comment:cmt-hidden"')).length;
    expect(measuredWhileActive).toBeGreaterThan(0);

    rerender(<Harness active={false} />);
    const measuredAtHide = measure.mock.calls.filter(([script]) => script.includes('"key":"comment:cmt-hidden"')).length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    const measuredWhileHidden = measure.mock.calls.filter(([script]) => script.includes('"key":"comment:cmt-hidden"')).length;
    expect(measuredWhileHidden).toBe(measuredAtHide);
  });

  it('stops measuring the picked element too once the browser tab is hidden (F6 residual)', async () => {
    const hero = { elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, viewport: { width: 300, height: 200 } };
    const measure = vi.fn(async (script: string) => {
      if (script.includes('function snapshotFor(el, ev)')) return hero;
      if (script.includes('const targets =')) {
        return Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ ...hero, key: match[1] }));
      }
      return null;
    });
    const activeMeasurements = () => measure.mock.calls.filter(([script]) => script.includes('"key":"active"')).length;
    function Harness({ active }: { active: boolean }) {
      return (
        <DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com" browserTabActive={active}
          onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()} />
      );
    }
    const { container, rerender } = render(<Harness active />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = measure;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await screen.findByPlaceholderText('Comment on this element…');
    await waitFor(() => expect(activeMeasurements()).toBeGreaterThan(0));

    rerender(<Harness active={false} />);
    await act(async () => { await Promise.resolve(); });
    const atHide = activeMeasurements();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(activeMeasurements()).toBe(atHide);
  });

  it('stages the selected dock pins into the composer without sending or deleting them', async () => {
    const pins: PreviewComment[] = [1, 2].map((n) => ({
      id: `cmt-${n}`, projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: `dom:#el${n}`, selector: `#el${n}`, label: 'p', text: `Text ${n}`, htmlHint: '<p>',
      position: { x: 10, y: 10 + n * 50, width: 100, height: 40 }, note: `Pin ${n}`, status: 'open',
      pinSeq: n, createdAt: n, updatedAt: n,
    }));
    const onStagePreviewComments = vi.fn();
    const onSendBoardCommentAttachments = vi.fn();
    const onRemovePreviewComment = vi.fn(async () => true);
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={pins} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()}
      onStagePreviewComments={onStagePreviewComments} onSendBoardCommentAttachments={onSendBoardCommentAttachments}
      onRemovePreviewComment={onRemovePreviewComment} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = vi.fn(async () => new Promise(() => {}));
    expect(screen.queryByTestId('comment-side-dock')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    expect(screen.getByTestId('comment-side-dock')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByTestId('comment-side-send-claude'));
    expect(onStagePreviewComments).toHaveBeenCalledTimes(1);
    expect(onStagePreviewComments.mock.calls[0]![0].map((comment: PreviewComment) => comment.id).sort()).toEqual(['cmt-1', 'cmt-2']);
    expect(onSendBoardCommentAttachments).not.toHaveBeenCalled();
    expect(onRemovePreviewComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('comment-side-selectbar')).toBeNull();
    expect(screen.getByText('Pin 1')).toBeTruthy();
    expect(screen.getByText('Pin 2')).toBeTruthy();
  });

  it('waits for a still-pending element capture and saves its screenshot (F8)', async () => {
    const dataUrl = 'data:image/png;base64,cGl4ZWxz';
    const captured = { x: 278 / 1.2, y: 290 / 1.2, width: 287 / 1.2, height: 191 / 1.2 };
    let resolveCapture: ((value: unknown) => void) | null = null;
    // Typed `never` so the deferred promise fits the host capture signature;
    // the test resolves it with a real capture payload below.
    const capturePage = vi.fn(() => new Promise<never>((resolve) => { resolveCapture = resolve as (value: unknown) => void; }));
    restoreHost?.(); restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
    vi.stubGlobal('Image', class {
      naturalWidth = 287; naturalHeight = 191; onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('data:')
      ? { blob: async () => new Blob(['crop'], { type: 'image/png' }) } : { ok: true }));
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
    const node = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    node.getBoundingClientRect = () => ({ left: 30, top: 40, right: 1030, bottom: 840,
      width: 1000, height: 800, x: 30, y: 40, toJSON() {} } as DOMRect);
    const target = { elementId: 'dom:#field', selector: '#field', label: 'input', text: '', htmlHint: 'input',
      position: { x: 201, y: 201, width: 240, height: 160 }, viewport: { width: 1000, height: 800 }, maskRects: [] };
    node.executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('function snapshotFor(el, ev)')) return target;
      if (script.includes('const targets =')) return [{ ...target, key: 'capture' }];
      if (script.includes('data-od-annotation-text')) return true;
      return null;
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await waitFor(() => expect(capturePage).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('Comment on this element…'), { target: { value: 'Review the field' } });
    // Save lands while the host capture is still pending: nothing is staged yet.
    expect(screen.queryByRole('button', { name: /^Attach image \(1\)/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { resolveCapture!({ ok: true, dataUrl, w: 287, h: 191, capturedCssRect: captured }); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![3] ?? []).map((file) => file.name)).toEqual([expect.stringMatching(/^browser-annotation-/)]);
  });

  it('neither measures nor draws a scoped Clipper pin, but keeps it listed in the dock', async () => {
    const scope = { frame: 'child' as const, url: 'https://example.com/frame', selectorRoot: 'document' as const,
      shadowHosts: [], screenshot: 'not-supported' as const };
    const scoped: PreviewComment = {
      id: 'cmt-scoped', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Framed hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Inside the frame', status: 'open',
      pinSeq: 1, createdAt: 1, updatedAt: 1, metadata: { source: 'clipper', scope },
    };
    const plain: PreviewComment = { ...scoped, id: 'cmt-plain', selector: '#cta', elementId: 'dom:#cta', pinSeq: 2,
      note: 'Top document', metadata: { source: 'browser' } };
    const measure = vi.fn(async (script: string) => script.includes('const targets =')
      ? Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ key: match[1],
        elementId: 'dom:#hero', selector: '#hero', label: 'div', text: '', htmlHint: '<div>',
        position: { x: 10, y: 10, width: 100, height: 40 }, viewport: { width: 300, height: 200 } }))
      : new Promise(() => {}));
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[scoped, plain]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = measure;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await screen.findByTestId('db-comment-marker-cmt-plain');
    // The top-document querySelector cannot resolve a child-frame / shadow
    // selector, so a scoped pin is never requested and never badged on a
    // top-document element that happens to share its selector.
    expect(measure.mock.calls.some(([script]) => script.includes('"key":"comment:cmt-scoped"'))).toBe(false);
    expect(measure.mock.calls.some(([script]) => script.includes('"key":"comment:cmt-plain"'))).toBe(true);
    expect(screen.queryByTestId('db-comment-marker-cmt-scoped')).toBeNull();
    expect(container.querySelector('.comment-side-item[data-comment-id="cmt-scoped"]')).toBeTruthy();
  });

  it("keeps a pin's scope and source metadata when its note is edited in the in-app browser", async () => {
    const scope = { frame: 'child' as const, url: 'https://example.com/frame', selectorRoot: 'open-shadow' as const,
      shadowHosts: ['#host'], screenshot: 'not-supported' as const };
    const pin: PreviewComment = {
      id: 'cmt-scoped', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Framed hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Inside the frame', status: 'open',
      pinSeq: 1, createdAt: 1, updatedAt: 1, metadata: { source: 'clipper', scope },
    };
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('const targets =') ? [] : new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    fireEvent.click(container.querySelector('.comment-side-item[data-comment-id="cmt-scoped"]')!);
    const input = await screen.findByPlaceholderText('Comment on this element…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Inside the frame, revised' } });
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [target, , , , commentId] = save.mock.calls[0]!;
    expect(commentId).toBe('cmt-scoped');
    // The upsert replaces metadata wholesale: dropping these here would strip
    // the Clipper pin of the scope that makes its selector resolvable.
    expect(target.metadata).toMatchObject({ source: 'clipper', scope });
  });

  it('saves without the screenshot when the element capture never settles, after the capture deadline', async () => {
    const capturePage = vi.fn(() => new Promise<never>(() => {}));
    restoreHost?.(); restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
    const node = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    node.getBoundingClientRect = () => ({ left: 30, top: 40, right: 1030, bottom: 840,
      width: 1000, height: 800, x: 30, y: 40, toJSON() {} } as DOMRect);
    const target = { elementId: 'dom:#field', selector: '#field', label: 'input', text: '', htmlHint: 'input',
      position: { x: 201, y: 201, width: 240, height: 160 }, viewport: { width: 1000, height: 800 }, maskRects: [] };
    node.executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('function snapshotFor(el, ev)')) return target;
      if (script.includes('const targets =')) return [{ ...target, key: 'capture' }];
      if (script.includes('data-od-annotation-text')) return true;
      return null;
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await waitFor(() => expect(capturePage).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('Comment on this element…'), { target: { value: 'Review the field' } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toBe('Review the field');
    expect(save.mock.calls[0]![3]).toEqual([]);
    expect(warn.mock.calls.some(([line]) => String(line).includes('"reason":"save-deadline"'))).toBe(true);
  });

  it('returns focus to the badge and keeps the comment tool on when the pin popover closes on Escape (F-028)', async () => {
    const pin: PreviewComment = {
      id: 'cmt-focus', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Hero note', status: 'open',
      pinSeq: 5, createdAt: 1, updatedAt: 1,
    };
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={savePreviewCommentMock()} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('const targets =')
      ? Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ key: match[1],
        elementId: pin.elementId, selector: pin.selector, label: pin.label, text: '', htmlHint: pin.htmlHint,
        position: pin.position, viewport: { width: 300, height: 200 } }))
      : new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'Open pin #5: div' }));
    const dialog = await screen.findByRole('dialog', { name: 'Annotation' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Annotation' })).toBeNull());
    // Closing the popover must not strand keyboard focus on <body>: it goes
    // back to the badge the pin was opened from, which stays mounted because
    // the comment tool stays on (PC2) and the panel returns to pick mode.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open pin #5: div' }));
    expect(screen.getByRole('button', { name: 'Annotate' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('comment-side-dock')).toBeTruthy();
    expect(container.querySelector('.db-tool-hint')?.textContent).toBe('Click an element to comment');
  });

  it('requests saved pins position-only so the poll skips the per-pin mask walk', () => {
    const pins = [
      { id: 'c1', elementId: 'hero', selector: '#hero' },
      { id: 'c2', elementId: 'cta', selector: 'main > a.cta' },
    ] as PreviewComment[];
    expect(browserPinTargetsFromSignature(browserPinTargetSignature(pins))).toEqual([
      { key: 'comment:c1', elementId: 'hero', selector: '#hero', positionOnly: true },
      { key: 'comment:c2', elementId: 'cta', selector: 'main > a.cta', positionOnly: true },
    ]);
    expect(browserPinTargetsFromSignature('')).toEqual([]);
  });

  it('clamps overlay bounds to the guest viewport on every edge', () => {
    const snapshot = (position: BrowserElementSnapshot['position'], viewport?: BrowserElementSnapshot['viewport']): BrowserElementSnapshot => ({
      filePath: browserCommentFilePath('https://example.com'), elementId: 'dom:#x', selector: '#x', label: 'div', text: '', htmlHint: '<div>',
      position, ...(viewport ? { viewport } : {}),
    });
    const viewport = { width: 300, height: 200 };
    expect(browserClampedOverlayBounds(snapshot({ x: 20, y: -10, width: 50, height: 40 }, viewport)))
      .toEqual({ left: 20, top: 0, width: 50, height: 30, clampedRight: false, clampedTop: true });
    expect(browserClampedOverlayBounds(snapshot({ x: 400, y: 20, width: 50, height: 40 }, viewport))).toBeNull();
    expect(browserClampedOverlayBounds(snapshot({ x: 20, y: 250, width: 50, height: 40 }, viewport))).toBeNull();
    expect(browserClampedOverlayBounds(snapshot({ x: 20, y: 20, width: 50, height: 40 }, viewport)))
      .toEqual({ left: 20, top: 20, width: 50, height: 40, clampedRight: false, clampedTop: false });
    expect(browserClampedOverlayBounds(snapshot({ x: 20, y: 20, width: 500, height: 40 })))
      .toEqual({ left: 20, top: 20, width: 500, height: 40, clampedRight: false, clampedTop: false });
  });

  it('lists an unmeasured pin in the dock without a marker and opens it for edit from its row', async () => {
    const pin: PreviewComment = {
      id: 'cmt-gone', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#gone', selector: '#gone', label: 'p', text: 'Gone', htmlHint: '<p>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Element navigated away', status: 'open',
      pinSeq: 3, createdAt: 1, updatedAt: 1,
    };
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save}
      onRemovePreviewComment={async () => true} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    // The selector no longer matches anything on the page: the measure returns nothing.
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('const targets =') ? [] : new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await waitFor(() => expect(webview.executeJavaScript).toHaveBeenCalled());
    expect(screen.queryByTestId('db-comment-marker-cmt-gone')).toBeNull();
    const row = container.querySelector('.comment-side-item[data-comment-id="cmt-gone"]')!;
    expect(row).toBeTruthy();
    fireEvent.click(row);
    const input = await screen.findByPlaceholderText('Comment on this element…') as HTMLTextAreaElement;
    expect(input.value).toBe('Element navigated away');
    // Reopened from the row: Save updates that pin instead of creating a second one.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Element navigated away (checked)' } });
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBe('Element navigated away (checked)');
    expect(save.mock.calls[0]![4]).toBe('cmt-gone');
  });

  it('reopens a persisted pin from its badge and saves to the same id', async () => {
    const pin: PreviewComment = {
      id: 'cmt-badge', projectId: 'p1', conversationId: 'c1', filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#hero', selector: '#hero', label: 'div', text: 'Hero', htmlHint: '<div>',
      position: { x: 10, y: 10, width: 100, height: 40 }, note: 'Hero note', status: 'open',
      pinSeq: 4, createdAt: 1, updatedAt: 1,
    };
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="p1" conversationId="c1" initialUrl="https://example.com"
      previewComments={[pin]} onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save}
      onRemovePreviewComment={async () => true} />);
    const webview = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    // Saved pins are measured position-only (no text/style); the live rect is
    // moved on purpose so the reopened target proves it took the fresh geometry.
    // The full `active` measurement that follows a reopen is left hanging, as
    // on a slow guest, so Save lands inside that window.
    const moved = { x: 50, y: 60, width: 100, height: 40 };
    webview.executeJavaScript = vi.fn(async (script: string) => script.includes('const targets =') && !script.includes('"key":"active"')
      ? Array.from(script.matchAll(/"key":"([^"]+)"/g), (match) => ({ key: match[1],
        elementId: pin.elementId, selector: pin.selector, label: pin.label, text: '', htmlHint: pin.htmlHint,
        position: moved, viewport: { width: 300, height: 200 } }))
      : new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    const badge = await screen.findByRole('button', { name: 'Open pin #4: div' });
    expect(badge.getAttribute('aria-current')).toBeNull();
    fireEvent.click(badge);
    const input = await screen.findByPlaceholderText('Comment on this element…') as HTMLTextAreaElement;
    expect(input.value).toBe('Hero note');
    expect(screen.getByRole('button', { name: 'Open pin #4: div' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Hero note, tightened' } });
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBe('Hero note, tightened');
    expect(save.mock.calls[0]![4]).toBe('cmt-badge');
    // Fresh geometry from the live pin, element text from the row: the
    // position-only measurement must not blank what the row already knows.
    expect(save.mock.calls[0]![0]).toMatchObject({ position: moved, text: 'Hero' });
    expect(screen.getAllByTestId(/^db-comment-marker-/)).toHaveLength(1);
  });

  it('keeps external browser mutation and annotation tools hidden', () => {
    render(
      <DesignBrowserPanel
        projectId="proj-webview-more-tools"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Tune element' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit live DOM' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Screenshot' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));

    expect(screen.queryByRole('menuitem', { name: /Tune Element/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Edit Live DOM/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Edit HTML/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Mark' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Comment' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Copy screenshot/i })).toBeTruthy();
  });

  it('opens the browser menu and highlights Download Page for attention requests', async () => {
    const navigateRequest = { url: 'https://example.com', nonce: 1 };
    const attentionRequest = { action: 'download-page' as const, nonce: 1 };
    const view = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-attention"
        initialTitle="Example"
        initialUrl="https://example.com"
        navigateRequest={navigateRequest}
        attentionRequest={attentionRequest}
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    const downloadItem = await screen.findByRole('menuitem', { name: 'Download Page' });
    expect(downloadItem.classList.contains('is-attention')).toBe(true);
    const assistGuide = view.container.querySelector('.db-download-assist');
    expect(assistGuide).toBeTruthy();
    expect(assistGuide?.textContent).toContain('When the page is ready, click Download Page');
    expect(view.container.querySelector('.db-status')).toBeNull();

    view.rerender(
      <DesignBrowserPanel
        projectId="proj-webview-download-attention"
        initialTitle="Example"
        initialUrl="https://example.com"
        navigateRequest={{ ...navigateRequest }}
        attentionRequest={attentionRequest}
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('menuitem', { name: 'Download Page' })).toBeTruthy();
  });

  it('closes the browser menu and uses the status toast while downloading a page snapshot', async () => {
    let resolveCapture: (value: unknown) => void = () => {};
    const capturePromise = new Promise<unknown>((resolve) => {
      resolveCapture = resolve;
    });
    vi.mocked(writeProjectTextFile).mockImplementation(async (_projectId, name) => ({
      kind: 'code',
      mime: 'application/json',
      mtime: 1,
      name,
      size: 1,
      type: 'file',
    }));
    const onOpenFile = vi.fn();
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-toast"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={onOpenFile}
        onRefreshFiles={() => {}}
      />,
    );
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn(() => capturePromise);

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    const downloadItem = screen.getByRole('menuitem', { name: 'Download Page' });
    expect(downloadItem.classList.contains('is-loading')).toBe(false);

    fireEvent.click(downloadItem);

    expect(screen.queryByRole('menuitem', { name: 'Download Page' })).toBeNull();
    expect(screen.getByText(/Saving page snapshot/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    expect((screen.getByRole('menuitem', { name: /Copy screenshot/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('menuitem', { name: 'Save Page Brief' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('menuitem', { name: 'Download Page' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveCapture({
        title: 'Example',
        url: 'https://example.com',
        html: '<!doctype html><html><body>Example</body></html>',
        css: '',
        resources: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/Saved page snapshot/)).toBeTruthy();
    });
    expect(onOpenFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Design Files' }));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile.mock.calls[0]?.[0]).toMatch(/^browser\/snapshots\/example\.com-/);
    expect(onOpenFile.mock.calls[0]?.[0]).toMatch(/\/manifest\.json$/);
  });

  it('shows elapsed snapshot time and cancels a pending page snapshot', async () => {
    vi.useFakeTimers();
    let resolveCapture: (value: unknown) => void = () => {};
    const capturePromise = new Promise<unknown>((resolve) => {
      resolveCapture = resolve;
    });
    vi.mocked(writeProjectTextFile).mockImplementation(async (_projectId, name) => ({
      kind: 'code',
      mime: 'application/json',
      mtime: 1,
      name,
      size: 1,
      type: 'file',
    }));
    const onPageSnapshotToast = vi.fn();
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-cancel"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
        onPageSnapshotToast={onPageSnapshotToast}
      />,
    );
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn(() => capturePromise);

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Page' }));

    expect(container.querySelector('.db-status')).toBeNull();
    expect(onPageSnapshotToast).toHaveBeenLastCalledWith(expect.objectContaining({
      elapsedSeconds: 0,
      status: 'loading',
    }));

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(container.querySelector('.db-status')).toBeNull();
    expect(onPageSnapshotToast).toHaveBeenLastCalledWith(expect.objectContaining({
      elapsedSeconds: 2,
      status: 'loading',
    }));

    const latestToast = onPageSnapshotToast.mock.calls.at(-1)?.[0];
    expect(latestToast?.onCancel).toEqual(expect.any(Function));
    act(() => {
      latestToast?.onCancel?.();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.db-status')).toBeNull();
    expect(onPageSnapshotToast).toHaveBeenLastCalledWith(expect.objectContaining({
      elapsedSeconds: 2,
      status: 'canceled',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    expect((screen.getByRole('menuitem', { name: 'Download Page' }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolveCapture({
        title: 'Example',
        url: 'https://example.com',
        html: '<!doctype html><html><body>Example</body></html>',
        css: '',
        resources: [],
      });
      await Promise.resolve();
    });
  });

  it('does not restart the snapshot progress effect when the parent toast callback changes identity', async () => {
    function UnstableToastCallbackHarness() {
      const [toastEventCount, setToastEventCount] = useState(0);
      return (
        <>
          <span data-testid="toast-event-count">{toastEventCount}</span>
          <DesignBrowserPanel
            projectId="proj-webview-download-unstable-toast"
            initialTitle="Example"
            initialUrl="https://example.com"
            onOpenFile={() => {}}
            onRefreshFiles={() => {}}
            onPageSnapshotToast={() => setToastEventCount((count) => count + 1)}
          />
        </>
      );
    }

    const capturePromise = new Promise<unknown>(() => {});
    const { container } = render(<UnstableToastCallbackHarness />);
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn(() => capturePromise);

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Page' }));

    await waitFor(() => {
      expect(screen.getByTestId('toast-event-count').textContent).toBe('1');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('toast-event-count').textContent).toBe('1');
  });

  it('saves only HTML + CSS and never fetches page assets', async () => {
    // Design-system extraction reads back nothing but page.html + styles.css
    // (ProjectView.readLocalBrowserPageArchiveSnapshot → extract-from-html posts
    // only { html, css, baseUrl }), so Download Page must not fan out to the
    // page's images/fonts/scripts even when the capture lists them.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not fetch assets'));
    const writes: Array<{ name: string; content: string }> = [];
    vi.mocked(writeProjectTextFile).mockImplementation(async (_projectId, name, content) => {
      writes.push({ name, content: String(content ?? '') });
      return { kind: 'code', mime: 'application/json', mtime: 1, name, size: 1, type: 'file' };
    });
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-essentials"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn().mockResolvedValue({
      title: 'Example',
      url: 'https://example.com',
      html: '<!doctype html><html><body>Example</body></html>',
      css: 'body{color:#111}',
      resources: [{ kind: 'image', url: 'https://cdn.example.test/hero.png' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Page' }));

    await waitFor(() => {
      expect(screen.getByText(/Saved page snapshot/)).toBeTruthy();
    });

    // The listed image is never fetched, and the manifest records no resources.
    // (`/api/workspace/context` is the unrelated workspace-identity read every
    // mounted DesignBrowserPanel now fires via useWorkspaceContext — filtered
    // out here since it isn't a page asset.)
    const assetFetchCalls = fetchMock.mock.calls.filter(
      ([url]) => url !== '/api/workspace/context',
    );
    expect(assetFetchCalls).toEqual([]);
    expect(writes.find((w) => w.name.endsWith('/page.html'))?.content).toContain('Example');
    expect(writes.find((w) => w.name.endsWith('/styles.css'))?.content).toContain('#111');
    const manifestWrite = writes.find((w) => w.name.endsWith('/manifest.json'));
    expect(manifestWrite).toBeTruthy();
    expect(JSON.parse(manifestWrite!.content).resources).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    expect((screen.getByRole('menuitem', { name: 'Download Page' }) as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockRestore();
  });

  it('does not re-fire the snapshot ticker when the parent recreates onPageSnapshotToast', async () => {
    // Regression for "Maximum update depth exceeded": the 1s progress ticker's
    // publish() emits a toast → the parent's setState re-renders and hands back a
    // fresh onPageSnapshotToast identity. While that identity was an effect dep,
    // every such render tore down and re-ran the effect, whose immediate publish()
    // looped the cycle. The effect must subscribe to `archiveSaving` only.
    let resolveCapture: (value: unknown) => void = () => {};
    const capturePromise = new Promise<unknown>((resolve) => {
      resolveCapture = resolve;
    });
    vi.mocked(writeProjectTextFile).mockResolvedValue({
      kind: 'code',
      mime: 'application/json',
      mtime: 1,
      name: 'x',
      size: 1,
      type: 'file',
    });
    const toastSpy = vi.fn();
    // Mirrors FileWorkspace: a brand-new onPageSnapshotToast on every render.
    function Harness({ nonce }: { nonce: number }) {
      void nonce;
      return (
        <DesignBrowserPanel
          projectId="proj-snapshot-ticker-stable"
          initialTitle="Example"
          initialUrl="https://example.com"
          onOpenFile={() => {}}
          onRefreshFiles={() => {}}
          onPageSnapshotToast={(event) => toastSpy(event)}
        />
      );
    }
    const view = render(<Harness nonce={0} />);
    const webview = view.container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    // Leave the capture pending so the snapshot stays in-progress (archiveSaving
    // true) across the parent re-renders below.
    webview.executeJavaScript = vi.fn(() => capturePromise);

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Page' }));

    const baseline = toastSpy.mock.calls.length;
    for (let i = 1; i <= 5; i += 1) {
      view.rerender(<Harness nonce={i} />);
    }

    // No timer advanced, so any growth here means the effect re-ran per render —
    // the regressed behavior. The fixed effect ignores onPageSnapshotToast churn.
    expect(toastSpy.mock.calls.length).toBe(baseline);

    resolveCapture({
      title: 'Example',
      url: 'https://example.com',
      html: '<!doctype html><html><body>Example</body></html>',
      css: '',
      resources: [],
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('searches inspiration actions and adds an operation prompt for the current browser tab', () => {
    const onRequestBrowserUsePrompt = vi.fn();

    render(
      <I18nProvider initial="zh-CN">
        <DesignBrowserPanel
          projectId="proj-webview-browser-use"
          initialTitle="Example"
          initialUrl="https://example.com"
          onOpenFile={() => {}}
          onRefreshFiles={() => {}}
          onRequestBrowserUsePrompt={onRequestBrowserUsePrompt}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '灵感' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索灵感' }), {
      target: { value: '字体' },
    });
    expect(screen.queryByRole('menuitem', { name: /validate_view/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /extract_fonts/ }));

    expect(onRequestBrowserUsePrompt).toHaveBeenCalledTimes(1);
    const prompt = onRequestBrowserUsePrompt.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('@agent-browser');
    expect(prompt).toContain('Operation: extract_fonts');
    expect(prompt).toContain('- title: Example');
    expect(prompt).toContain('- url: https://example.com');
    expect(prompt).toContain('browser-use / browser-harness style evidence');
  });

  it('pins the webview src to the load target when the guest commits a redirected URL', () => {
    // Regression guard for the blank-page bug: the embedded <webview> rendered
    // but never painted because did-navigate fed the committed (trailing-slash)
    // URL straight back into the src prop, so Electron re-navigated and aborted
    // the in-flight load (ERR_ABORTED -3). The load target (src) must stay put
    // while only the address bar follows the committed URL.
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement | null;
    expect(webview).not.toBeNull();
    // The bare domain is normalized to https and becomes the load target.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
    expect(getAddressDisplay(container).url).toBe('https://example.com');

    // The guest commits a redirect that appends a trailing slash.
    dispatchWebviewNavigate(webview!, 'https://example.com/');

    // The address bar follows the committed URL...
    expect(getAddressDisplay(container).url).toBe('https://example.com/');
    // ...but the src remains the original target, so no abort/reload loop.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
  });

  it('changes the src only when the user navigates to a new target', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-2" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://gsap.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement;
    expect(webview.getAttribute('src')).toBe('https://gsap.com');

    // An in-page navigation event must not move the load target.
    dispatchWebviewNavigate(webview, 'https://gsap.com/docs/');
    expect(webview.getAttribute('src')).toBe('https://gsap.com');
    expect(getAddressDisplay(container).url).toBe('https://gsap.com/docs/');

    // A fresh user navigation does move it.
    fireEvent.change(input, { target: { value: 'unsplash.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(webview.getAttribute('src')).toBe('https://unsplash.com');
  });

  it('swallows benign Electron webview ERR_ABORTED loadURL rejections', async () => {
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-aborted-load"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      loadURL?: (url: string) => Promise<void>;
    };
    const loadURL = vi.fn().mockRejectedValue(
      new Error("ERR_ABORTED (-3) loading 'https://mobbin.com/'"),
    );
    webview.loadURL = loadURL;

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mobbin.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(loadURL).toHaveBeenCalledWith('https://mobbin.com'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(webview.getAttribute('src')).toBe('https://example.com');
    expect(getAddressDisplay(container).url).toBe('https://mobbin.com');
  });

  it('derives back and forward availability from the committed navigation stack', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-3" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      loadURL?: (url: string) => void;
    };
    const loadURL = vi.fn();
    webview.loadURL = loadURL;

    const backButton = screen.getByRole('button', { name: 'Go Back' }) as HTMLButtonElement;
    const forwardButton = screen.getByRole('button', { name: 'Go Forward' }) as HTMLButtonElement;
    expect(backButton.disabled).toBe(false);
    expect(backButton.parentElement?.getAttribute('data-tooltip')).toBe('Go Back');

    dispatchWebviewNavigate(webview, 'https://example.com/');
    expect(backButton.disabled).toBe(false);

    dispatchWebviewNavigate(webview, 'https://example.com/docs/');
    expect(getAddressDisplay(container).url).toBe('https://example.com/docs/');
    expect(backButton.disabled).toBe(false);
    expect(forwardButton.disabled).toBe(true);

    fireEvent.click(backButton);
    expect(loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(forwardButton.disabled).toBe(false);
  });

  it('treats the start page as the previous browser step after the first address navigation', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-home-back" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    expect(screen.getByText('Reference Board')).toBeTruthy();

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://dribbble.com/' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement | null;
    expect(webview?.getAttribute('src')).toBe('https://dribbble.com/');

    const backButton = screen.getByRole('button', { name: 'Go Back' }) as HTMLButtonElement;
    const forwardButton = screen.getByRole('button', { name: 'Go Forward' }) as HTMLButtonElement;
    expect(backButton.disabled).toBe(false);
    expect(forwardButton.disabled).toBe(true);

    fireEvent.click(backButton);

    expect(screen.getByText('Reference Board')).toBeTruthy();
    expect(container.querySelector('webview.db-webview')).toBeNull();
    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe('');
    expect(backButton.disabled).toBe(true);
    expect(forwardButton.disabled).toBe(false);

    fireEvent.click(forwardButton);

    expect(container.querySelector('webview.db-webview')?.getAttribute('src')).toBe('https://dribbble.com/');
  });

  it('uses native webview history for back navigation when Chromium has it cached', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-native" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      canGoBack?: () => boolean;
      goBack?: () => void;
      loadURL?: (url: string) => void;
    };
    dispatchWebviewNavigate(webview, 'https://example.com/');
    dispatchWebviewNavigate(webview, 'https://example.com/docs/');

    const goBack = vi.fn();
    const loadURL = vi.fn();
    webview.canGoBack = () => true;
    webview.goBack = goBack;
    webview.loadURL = loadURL;

    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('shows extracted page titles in the passive address display and history suggestions', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-title" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://www.baidu.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      getTitle?: () => string;
      getURL?: () => string;
    };
    webview.getURL = () => 'https://www.baidu.com/';
    webview.getTitle = () => '百度一下，你就知道';
    dispatchWebviewNavigate(webview, 'https://www.baidu.com/');
    dispatchWebviewTitle(webview, '百度一下，你就知道');
    fireEvent.blur(input);

    expect(getAddressDisplay(container)).toMatchObject({
      title: '百度一下，你就知道',
      url: 'https://www.baidu.com',
    });

    fireEvent.focus(input);
    expect(input.value).toBe('https://www.baidu.com/');
    expect(screen.getByRole('option', { name: /百度一下，你就知道/ })).toBeTruthy();
  });

  it('opens all reference suggestions by default from the address bar', () => {
    render(
      <DesignBrowserPanel projectId="proj-webview-suggestions" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    fireEvent.focus(screen.getByLabelText('Browser address'));

    expect(screen.getByRole('option', { name: /Whirrls/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Startups Gallery/ })).toBeTruthy();
  });

  it('closes address suggestions when the address input blurs outside the address bar', () => {
    render(
      <DesignBrowserPanel projectId="proj-webview-suggestions-blur" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address');
    fireEvent.focus(input);

    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.blur(input, { relatedTarget: null });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps the browser fallback content free of desktop-only overlay banners', () => {
    restoreHost?.();
    restoreHost = null;

    const { container } = render(
      <DesignBrowserPanel projectId="proj-browser-fallback" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.submit(input.closest('form')!);

    expect(container.querySelector('iframe')).not.toBeNull();
    expect(screen.queryByText('Embedded browser controls are available in the desktop app.')).toBeNull();
  });

  it('does not render saved comment markers in the browser fallback iframe', () => {
    restoreHost?.();
    restoreHost = null;

    const previewComments = [{
      id: 'comment-fallback-1',
      projectId: 'proj-browser-fallback-comments',
      conversationId: 'conv-1',
      filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#card',
      selector: '#card',
      label: 'article.card',
      note: 'Review this card',
      text: 'Card',
      position: { x: 24, y: 32, width: 240, height: 160 },
      htmlHint: '<article id="card">',
      status: 'open' as const,
      createdAt: 1,
      updatedAt: 1,
    }];

    const { container } = render(
      <DesignBrowserPanel
        initialUrl="https://example.com"
        projectId="proj-browser-fallback-comments"
        previewComments={previewComments}
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.db-comment-layer')).toBeNull();
    expect(container.querySelector('.db-comment-marker')).toBeNull();
  });

  it('does not expose page annotation controls in the external browser', () => {
    const { container } = render(
      <I18nProvider initial="zh-CN">
        <DesignBrowserPanel
          initialUrl="https://example.com"
          projectId="proj-webview-mark-i18n"
          onOpenFile={() => {}}
          onRefreshFiles={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.queryByRole('button', { name: '标记' })).toBeNull();
    expect(screen.queryByRole('button', { name: '评论' })).toBeNull();
    expect(container.querySelector('.ri-pencil-line')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Annotate page' })).toBeNull();
  });

  it('does not start browser element comments from the external browser toolbar', () => {
    const onSendBoardCommentAttachments = vi.fn(async (_attachments: unknown[], _images?: File[]) => ({
      status: 'queued' as const,
      commentIds: [],
    }));
    const { container } = render(
      <DesignBrowserPanel
        initialUrl="https://example.com"
        projectId="proj-webview-comment-queue"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
        onSendBoardCommentAttachments={onSendBoardCommentAttachments}
        sendDisabled
      />,
    );

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn();

    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Comment' })).toBeNull();
    expect(screen.queryByTestId('comment-popover-input')).toBeNull();
    expect(onSendBoardCommentAttachments).not.toHaveBeenCalled();
    expect(webview.executeJavaScript).not.toHaveBeenCalled();
  });

  it('keeps Download Page guidance inside the Browser panel when the workspace owns snapshot toasts', async () => {
    const attentionRequest = { action: 'download-page' as const, nonce: 1 };
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-attention-parent-toast"
        initialTitle="Example"
        initialUrl="https://example.com"
        attentionRequest={attentionRequest}
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
        onPageSnapshotToast={() => {}}
      />,
    );

    const downloadItem = await screen.findByRole('menuitem', { name: 'Download Page' });
    expect(downloadItem.classList.contains('is-attention')).toBe(true);
    expect(container.querySelector('.db-download-assist')).toBeTruthy();
    expect(container.querySelector('.db-status')).toBeNull();
  });

  it('does not render saved browser comment markers in the external browser', async () => {
    const previewComments = [{
      id: 'comment-1',
      projectId: 'proj-webview-live-comment-marker',
      conversationId: 'conv-1',
      filePath: browserCommentFilePath('https://example.com'),
      elementId: 'dom:#card',
      selector: '#card',
      label: 'article.card',
      note: 'Review this card',
      text: 'Card',
      position: { x: 24, y: 32, width: 240, height: 160 },
      htmlHint: '<article id="card">',
      status: 'open' as const,
      createdAt: 1,
      updatedAt: 1,
    }];
    const { container } = render(
      <DesignBrowserPanel
        initialUrl="https://example.com"
        projectId="proj-webview-live-comment-marker"
        previewComments={previewComments}
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
    };
    webview.executeJavaScript = vi.fn(async () => []);

    await act(async () => {
      await Promise.resolve();
    });

    expect(webview.executeJavaScript).not.toHaveBeenCalled();
    expect(container.querySelector('.db-comment-layer')).toBeNull();
    expect(container.querySelector('.db-comment-marker')).toBeNull();
  });

  it('keeps browser screenshot capture available after hiding annotation tools', async () => {
    restoreHost?.();
    const capturePage = vi.fn(async () => {
      expect(document.querySelector('.preview-draw-toolbar')).toBeNull();
      return { ok: true as const, dataUrl: 'data:image/png;base64,cG5n', w: 10, h: 10 };
    });
    restoreHost = installMockOpenDesignHost({
      host: { capture: { page: capturePage } },
    });

    const { container } = render(
      <DesignBrowserPanel
        initialUrl="https://example.com"
        projectId="proj-webview-screenshot-hides-tools"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Mark' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));

    await waitFor(() => expect(capturePage).toHaveBeenCalledTimes(1));
  });

  it('turns the reload button into a stop control while the page is loading', () => {
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-stop-loading"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      stop?: ReturnType<typeof vi.fn>;
    };
    const stop = vi.fn();
    webview.stop = stop;

    // Idle: the control reloads.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop loading' })).toBeNull();

    // While loading, the same control becomes a Chrome-style stop affordance.
    act(() => {
      webview.dispatchEvent(new Event('did-start-loading'));
    });
    const stopButton = screen.getByRole('button', { name: 'Stop loading' });
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    fireEvent.click(stopButton);

    // Clicking halts the in-flight navigation and returns to the reload control.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('stops a stuck load before capturing the page snapshot', async () => {
    vi.mocked(writeProjectTextFile).mockImplementation(async (_projectId, name) => ({
      kind: 'code',
      mime: 'application/json',
      mtime: 1,
      name,
      size: 1,
      type: 'file',
    }));
    const { container } = render(
      <DesignBrowserPanel
        projectId="proj-webview-download-stops-load"
        initialTitle="Example"
        initialUrl="https://example.com"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>;
      stop?: ReturnType<typeof vi.fn>;
    };
    const stop = vi.fn();
    webview.stop = stop;
    webview.executeJavaScript = vi.fn().mockResolvedValue({
      title: 'Example',
      url: 'https://example.com',
      html: '<!doctype html><html><body>Example</body></html>',
      css: '',
      resources: [],
    });

    // The page is wedged mid-load (perpetual top-left spinner), which is exactly
    // when Download Page would otherwise hang waiting on a load that never ends.
    act(() => {
      webview.dispatchEvent(new Event('did-start-loading'));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Page' }));

    // The download halts the in-flight load first, then captures the current DOM.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(webview.executeJavaScript).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByText(/Saved page snapshot/)).toBeTruthy();
    });
  });
});


describe('DesignBrowserPanel compact style edits', () => {
  it.each([true, false])('posts only confirmed live style changes: %s', async (applied) => {
    let options: browserControl.EmbeddedBrowserControlSessionOptions | undefined;
    vi.spyOn(browserControl, 'createEmbeddedBrowserControlSession').mockImplementation((value) => {
      options = value; value.onStatus?.('connected');
      return { ready: Promise.resolve(true), stop: async () => {}, updateTarget: () => {} };
    });
    vi.spyOn(browserControl, 'executeEmbeddedBrowserOperation').mockImplementation(async (_project, request) => {
      if (request.operation !== 'style') throw new Error('Unexpected fixture operation');
      return { commandId: 'fixture-style', tab: { projectId: 'style-context', tabId: 'tab-style', url: 'https://example.com', title: 'Fixture' }, result: { operation: 'style', applied: true,
        inspection: await options!.applyStyle!(request) } };
    });
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { capture: { page: async () => ({ ok: false as const, reason: 'fixture unavailable' }) } } });
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true,
      json: async () => ({ projectId: 'style-context', conversationId: 'c1', id: '11111111-1111-4111-8111-111111111111', replayed: false }) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    const save = savePreviewCommentMock();
    const { container } = render(<DesignBrowserPanel projectId="style-context" conversationId="c1" browserTabId="tab-style"
      initialUrl="https://example.com" onOpenFile={() => {}} onRefreshFiles={() => {}} onSavePreviewComment={save} />);
    const node = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    const target = { elementId: 'dom:#heading', selector: '#heading', label: 'h1', text: 'Heading', htmlHint: 'h1',
      style: { color: '#0D0C22' }, position: { x: 10, y: 10, width: 100, height: 30 },
      maskRects: [], viewport: { width: 300, height: 200 } };
    node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 200,
      right: 300, bottom: 200, toJSON() {} } as DOMRect);
    let mutated = false;
    node.executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('function snapshotFor(el, ev)')) return target;
      if (script.includes('const targets =')) return [{ ...target, style: { color: mutated ? '#ff0000' : '#0D0C22' }, key: 'capture' }];
      if (script.includes('el.style[')) { mutated = applied; return applied; }
      if (script.includes('el.textContent =')) return true;
      return null;
    });
    Object.assign(node, { getWebContentsId: () => 77, getURL: () => 'https://example.com' });
    fireEvent(node, new Event('dom-ready'));
    await waitFor(() => expect(options?.applyStyle).toBeTypeOf('function'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    fireEvent.change(screen.getByPlaceholderText('Comment on this element…'), { target: { value: 'Update the heading' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Computed styles' }));
    await act(async () => { fireEvent.change(screen.getByLabelText('Text', { selector: 'input' }), { target: { value: '#ff0000' } }); });
    expect(screen.getByPlaceholderText('Comment on this element…')).toHaveProperty('value', 'Update the heading');
    if (applied) {
      const textInput = screen.getByRole('textbox', { name: 'Element text' });
      await act(async () => { fireEvent.change(textInput, { target: { value: 'hello ' } }); });
      await act(async () => { fireEvent.blur(textInput); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(screen.getByRole('textbox', { name: 'Element text' })).toHaveProperty('value', 'hello ');
    }
    await act(async () => { fireEvent.click(screen.getByTestId('comment-popover-save')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [savedTarget, note, attachAfterSave] = save.mock.calls[0]!;
    expect(savedTarget.style?.color).toBe(applied ? '#ff0000' : '#0D0C22');
    expect(note).toBe('Update the heading');
    expect(attachAfterSave).toBe(false);
  });

  it('awaits capture cleanup and rejects same-node navigation before applying a style', async () => {
    let options: browserControl.EmbeddedBrowserControlSessionOptions | undefined;
    vi.spyOn(browserControl, 'createEmbeddedBrowserControlSession').mockImplementation((value) => {
      options = value; value.onStatus?.('connected');
      return { ready: Promise.resolve(true), stop: async () => {}, updateTarget: () => {} };
    });
    let finishCapture!: (value: { ok: false; reason: string }) => void;
    const capturePage = vi.fn(async () => ({ ok: false as const, reason: 'fixture complete' }))
      .mockImplementationOnce(() => new Promise<{ ok: false; reason: string }>((resolve) => { finishCapture = resolve; }));
    restoreHost?.(); restoreHost = installMockOpenDesignHost({ host: { capture: { page: capturePage } } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    const { container } = render(<DesignBrowserPanel projectId="style-cleanup" conversationId="c1" browserTabId="tab-style"
      initialUrl="https://example.com" onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    const node = container.querySelector('webview')! as HTMLElement & { executeJavaScript: ReturnType<typeof vi.fn> };
    const target = { elementId: 'dom:#heading', selector: '#heading', label: 'h1', text: 'Heading', htmlHint: 'h1',
      style: { color: '#0D0C22' }, position: { x: 10, y: 10, width: 100, height: 30 },
      maskRects: [], viewport: { width: 300, height: 200 } };
    let url = 'https://example.com';
    let mutations = 0;
    Object.assign(node, { getWebContentsId: () => 77, getURL: () => url });
    node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 200,
      right: 300, bottom: 200, toJSON() {} } as DOMRect);
    node.executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('function snapshotFor(el, ev)')) return target;
      if (script.includes('const targets =')) return [{ ...target, key: 'capture' }];
      if (script.includes('el.style[')) { mutations += 1; return true; }
      return null;
    });
    fireEvent(node, new Event('dom-ready'));
    await waitFor(() => expect(options?.applyStyle).toBeTypeOf('function'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Annotate' })); });
    await waitFor(() => expect(capturePage).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Computed styles' }, { timeout: 3000 });
    let outcome!: Promise<unknown>;
    await act(async () => { outcome = options!.applyStyle!({ operation: 'style', approved: true,
      target: { selector: '#heading' }, styles: { color: '#ff0000' } }).catch((error: Error) => error.message); });
    expect(mutations).toBe(0);
    url = 'https://example.com/another-page';
    await act(async () => { finishCapture({ ok: false, reason: 'fixture complete' }); await outcome; });
    expect(await outcome).toBe('Browser selection changed or command expired');
    expect(mutations).toBe(0);
  });
});

describe('DesignBrowserPanel native popup surface', () => {
  it('hides the original native popup while the viewport listbox is open and restores it on dismissal', async () => {
    const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:viewport-menu', projectId: 'p1', openerTabId: '__browser__:1',
      ancestorTabIds: ['__browser__:1'], tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Written child',
      loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
    const presentPopup = vi.fn(async (request: { visible: boolean; revision: number; bounds: unknown }) => ({ ok: true as const,
      value: { revision: request.revision, bounds: request.bounds } }));
    const popupCommand = vi.fn(async () => ({ ok: true as const, value: 'data:image/png;base64,cG9wdXA=' }));
    restoreHost?.(); restoreHost = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }),
      subscribePopups: () => () => {}, bindPopup: async () => ({ ok: true }), presentPopup, popupCommand } } });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const view = render(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
      onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    const original = view.container.querySelector('[data-popup-surface]');
    await waitFor(() => expect(presentPopup.mock.calls.at(-1)?.[0].visible).toBe(true));
    const trigger = screen.getByRole('combobox', { name: /^Browser viewport/ });
    fireEvent.click(trigger);
    await waitFor(() => expect(presentPopup.mock.calls.at(-1)?.[0].visible).toBe(false));
    expect(screen.getByRole('listbox', { name: 'Browser viewport' })).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(presentPopup.mock.calls.at(-1)?.[0].visible).toBe(true));
    expect(screen.queryByRole('listbox', { name: 'Browser viewport' })).toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => expect(presentPopup.mock.calls.at(-1)?.[0].visible).toBe(false));
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(presentPopup.mock.calls.at(-1)?.[0].visible).toBe(true));
    expect(view.container.querySelector('[data-popup-surface]')).toBe(original);
    expect(view.container.querySelector('webview')).toBeNull();
  });

  it('fits responsive presets, retains the live page node and restores the project selection', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = Math.min(({ mobile: 390, tablet: 820 } as Record<string, number>)[this.dataset.viewport ?? ''] ?? 500, 500);
      return { x: 0, y: 0, width, height: 650 } as DOMRect;
    });
    const props = { projectId: 'responsive', initialUrl: 'https://example.com/form', onOpenFile: () => {}, onRefreshFiles: () => {} };
    const view = render(<DesignBrowserPanel {...props} />);
    const page = view.container.querySelector('webview');
    fireEvent.click(screen.getByRole('combobox', { name: 'Browser viewport: Desktop' }));
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));
    await waitFor(() => expect(view.container.querySelector('output')?.textContent).toBe('390 × 650'));
    expect(view.container.querySelector('webview')).toBe(page);
    expect(page?.getAttribute('src')).toBe(props.initialUrl);
    fireEvent.click(screen.getByRole('combobox', { name: 'Browser viewport: Mobile' }));
    fireEvent.click(screen.getByRole('option', { name: 'Tablet' }));
    await waitFor(() => expect(view.container.querySelector('output')?.textContent).toBe('500 × 650'));
    expect(window.localStorage.getItem('od:design-browser:responsive:viewport:v1')).toBe('tablet');
    view.unmount();
    const restored = render(<DesignBrowserPanel {...props} />);
    expect((screen.getByRole('combobox', { name: 'Browser viewport: Tablet' }) as HTMLButtonElement).value).toBe('tablet');
    expect(restored.container.querySelector('.db-viewport-frame')?.getAttribute('data-viewport')).toBe('tablet');
  });

  it('waits for the requested preset and rejects superseded viewport commands', async () => {
    let options: browserControl.EmbeddedBrowserControlSessionOptions | undefined;
    vi.spyOn(browserControl, 'createEmbeddedBrowserControlSession').mockImplementation((value) => {
      options = value; return { ready: Promise.resolve(true), stop: async () => {}, updateTarget: () => {} };
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const frame = this.closest('.db-viewport-frame') as HTMLElement | null;
      return { x: 0, y: 0, width: (frame ?? this).dataset.viewport === 'mobile' ? 390 : 529, height: 536 } as DOMRect;
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:commit', projectId: 'p1', openerTabId: '__browser__:1',
      ancestorTabIds: ['__browser__:1'], tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Child',
      loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
    const commandBounds: number[] = [];
    let record = false;
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }),
      subscribePopups: () => () => {}, bindPopup: async () => ({ ok: true }), popupCommand: async () => ({ ok: true }),
      presentPopup: async (request) => {
        if (record) commandBounds.push(request.bounds.width);
        // Exercise asynchronous native presentation without synchronous ACK.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return { ok: true, value: { revision: request.revision, bounds: request.bounds } };
      } } } });
    render(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
      onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    await waitFor(() => expect(options?.applyViewport).toBeTypeOf('function'));
    record = true;
    let applying!: ReturnType<NonNullable<browserControl.EmbeddedBrowserControlSessionOptions['applyViewport']>>;
    await act(async () => {
      applying = options!.applyViewport!('mobile');
      await Promise.resolve();
      await Promise.resolve();
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await applying.then((value) => ({ value }), (error: Error) => ({ error: error.message }));
    });
    expect(outcome).toEqual({ value: { preset: 'mobile', width: 390, height: 536 } });
    expect(commandBounds.length).toBeGreaterThan(0);
    expect(commandBounds.every((width) => width === 390)).toBe(true);

    let superseded: Promise<unknown> | undefined;
    let replacement: typeof applying | undefined;
    await act(async () => {
      superseded = options!.applyViewport!('desktop').catch((error: Error) => error.message);
      replacement = options!.applyViewport!('mobile');
      await Promise.resolve();
    });
    await act(async () => {
      await expect(superseded).resolves.toContain('changed while applying');
      await expect(replacement).resolves.toEqual({ preset: 'mobile', width: 390, height: 536 });
    });
  });

  it('waits for fitted layout when the DOM preset and style commit before actual geometry', async () => {
    let options: browserControl.EmbeddedBrowserControlSessionOptions | undefined;
    vi.spyOn(browserControl, 'createEmbeddedBrowserControlSession').mockImplementation((value) => {
      options = value; return { ready: Promise.resolve(true), stop: async () => {}, updateTarget: () => {} };
    });
    let actualWidth = 529;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isFrame = this.classList.contains('db-viewport-frame') || Boolean(this.closest('.db-viewport-frame'));
      return { x: 0, y: 0, width: isFrame ? actualWidth : 529, height: 536 } as DOMRect;
    });
    const observations = new Map<Element, () => void>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(node: Element) { observations.set(node, this.callback); }
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:layout', projectId: 'p1', openerTabId: '__browser__:1',
      ancestorTabIds: ['__browser__:1'], tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Child',
      loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
    const presentedWidths: number[] = [];
    let record = false;
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { browser: {
      listPopups: async () => ({ ok: true, popups: [popup] }), subscribePopups: () => () => {},
      bindPopup: async () => ({ ok: true }), popupCommand: async () => ({ ok: true }),
      presentPopup: async (request) => {
        if (record) presentedWidths.push(request.bounds.width);
        return { ok: true, value: { revision: request.revision, bounds: request.bounds } };
      },
    } } });
    const view = render(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
      onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    await waitFor(() => expect(options?.applyViewport).toBeTypeOf('function'));
    record = true;
    let applying!: Promise<unknown>;
    await act(async () => { applying = options!.applyViewport!('mobile').catch((error: Error) => ({ error: error.message })); });
    const frame = view.container.querySelector('.db-viewport-frame') as HTMLElement;
    expect(frame.dataset.viewport).toBe('mobile');
    // jsdom does not accept CSS min() width. Real mounted diagnostics verify
    // the committed inline style; geometry here stays independently controlled.
    expect(frame.getBoundingClientRect().width).toBe(529);
    expect(presentedWidths).toEqual([]);
    await act(async () => {
      actualWidth = 390;
      observations.get(frame)?.();
      await expect(applying).resolves.toEqual({ preset: 'mobile', width: 390, height: 536 });
    });
    expect(presentedWidths).toEqual([390]);

    await act(async () => {
      const expired = options!.applyViewport!('desktop', Date.now() + 25);
      await expect(expired).rejects.toThrow('Browser command expired before execution.');
    });
    expect(presentedWidths).toEqual([390]);

    let hidden!: Promise<unknown>;
    await act(async () => { hidden = options!.applyViewport!('tablet').catch((error: Error) => error.message); });
    act(() => {
      view.rerender(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
        browserTabActive={false} onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    });
    await act(async () => {
      await expect(hidden).resolves.toBe('Browser viewport is no longer available');
    });
    act(() => {
      view.rerender(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
        onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    });
    let unmounted!: Promise<unknown>;
    await act(async () => { unmounted = options!.applyViewport!('tablet').catch((error: Error) => error.message); });
    act(() => { view.unmount(); });
    await expect(unmounted).resolves.toBe('Browser viewport is no longer available');
  });

  it('keeps its lease callback stable and refuses a frame that changes during native ACK', async () => {
    let options: browserControl.EmbeddedBrowserControlSessionOptions | undefined;
    const session = vi.spyOn(browserControl, 'createEmbeddedBrowserControlSession').mockImplementation((value) => {
      options = value; value.onStatus?.('connected');
      return { ready: Promise.resolve(true), stop: async () => {}, updateTarget: () => {} };
    });
    let availableWidth = 900;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const frame = this.closest('.db-viewport-frame') as HTMLElement | null;
      const width = Math.min(({ mobile: 390, tablet: 820 } as Record<string, number>)[(frame ?? this).dataset.viewport ?? ''] ?? availableWidth, availableWidth);
      return { x: 0, y: 0, width, height: 650 } as DOMRect;
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:race', projectId: 'p1', openerTabId: '__browser__:1', ancestorTabIds: ['__browser__:1'],
      tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Child', loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
    let block = false; let release: (() => void) | undefined;
    restoreHost?.();
    restoreHost = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }), subscribePopups: () => () => {},
      bindPopup: async () => ({ ok: true }), popupCommand: async () => ({ ok: true }),
      presentPopup: async (request) => { if (block) await new Promise<void>((resolve) => { release = resolve; });
        return { ok: true, value: { revision: request.revision, bounds: request.bounds } }; } } } });
    render(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup} onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    await waitFor(() => expect(options?.applyViewport).toBeTypeOf('function'));
    block = true;
    let applying!: ReturnType<NonNullable<browserControl.EmbeddedBrowserControlSessionOptions['applyViewport']>>;
    act(() => { applying = options!.applyViewport!('mobile'); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    availableWidth = 300;
    await act(async () => { release!(); await expect(applying).rejects.toThrow('changed while applying'); });
    expect(session).toHaveBeenCalledTimes(1);
  });
  it('keeps a written blank document, uses native pre-adoption history and hides/restores around overlapping menus', async () => {
    restoreHost?.();
    const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:1', projectId: 'p1', openerTabId: '__browser__:1',
      ancestorTabIds: ['__browser__:1'], tabId: '__browser__:2', webContentsId: 77, url: 'about:blank', title: 'Written child',
      loading: false, canGoBack: true, canGoForward: false, disposition: 'new-window' };
    const popupCommand = vi.fn(async (request: OpenDesignHostBrowserPopupCommand) => ({ ok: true as const,
      value: request.kind === 'capture' ? 'data:image/png;base64,popup' : undefined }));
    const presentPopup = vi.fn(async (request: { visible: boolean; revision: number; bounds: unknown }) => ({ ok: true as const,
      value: { revision: request.revision, bounds: request.bounds } }));
    restoreHost = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }),
      subscribePopups: () => () => {}, bindPopup: async () => ({ ok: true }), presentPopup, popupCommand } } });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const resizeCallbacks = new Map<Element, () => void>();
    vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) {} observe(node: Element) { resizeCallbacks.set(node, this.callback); } disconnect() {} });
    const view = render(<DesignBrowserPanel projectId="p1" browserTabId="__browser__:2" popup={popup}
      initialUrl="about:blank" initialTitle="Written child" onOpenFile={() => {}} onRefreshFiles={() => {}} />);
    expect(view.container.querySelector('[data-popup-surface="popup:1"]')).not.toBeNull();
    expect(view.container.querySelector('webview')).toBeNull();
    expect(view.container.querySelector('.db-start')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    expect(popupCommand).toHaveBeenCalledWith({ projectId: 'p1', surfaceId: 'popup:1', kind: 'back' });
    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    await waitFor(() => expect(view.container.querySelector('[data-popup-surface] img')).not.toBeNull());
    expect(presentPopup.mock.calls.some((call) => (call[0] as { visible: boolean }).visible === false)).toBe(true);
    const surface = view.container.querySelector('[data-popup-surface]')!;
    const capturesBeforeResize = popupCommand.mock.calls.filter(([request]) => request.kind === 'capture').length;
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 390, height: 600 } as DOMRect);
    act(() => resizeCallbacks.get(surface)?.());
    await waitFor(() => expect(popupCommand.mock.calls.filter(([request]) => request.kind === 'capture').length).toBeGreaterThan(capturesBeforeResize));
    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    await waitFor(() => expect(view.container.querySelector('[data-popup-surface] img')).toBeNull());
    expect((presentPopup.mock.calls.at(-1)?.[0] as { visible: boolean }).visible).toBe(true);
    view.unmount();
    expect((presentPopup.mock.calls.at(-1)?.[0] as { visible: boolean }).visible).toBe(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

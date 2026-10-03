// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import type { OpenDesignHostBrowserPopup, OpenDesignHostBrowserPopupEvent } from '@open-design/host';
import { createPopupBrowserSurface } from '../../src/components/browser-popup-surface';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });
it('forwards image-hover console messages only from the owned child context', () => {
  let receive: ((event: OpenDesignHostBrowserPopupEvent) => void) | undefined;
  const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:1', projectId: 'p1', openerTabId: '__browser__:1', ancestorTabIds: ['__browser__:1'],
    webContentsId: 42, url: 'about:blank', title: 'Written child', loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
  restore = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }),
    bindPopup: async () => ({ ok: true }), presentPopup: async () => ({ ok: true }), popupCommand: async () => ({ ok: true }),
    subscribePopups: (listener) => { receive = listener; return () => {}; } } } });
  const surface = createPopupBrowserSurface(document.createElement('div'), popup);
  surface.connect();
  const observe = vi.fn(); surface.page.addEventListener('console-message', observe);
  const message = '__open_design_add_image_to_chat__:{"x":0,"y":0,"width":100,"height":100}';
  receive?.({ kind: 'console', popup: { ...popup, projectId: 'foreign' }, message });
  receive?.({ kind: 'console', popup: { ...popup, surfaceId: 'popup:foreign' }, message });
  expect(observe).not.toHaveBeenCalled();
  receive?.({ kind: 'console', popup, message });
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0]?.[0].message).toBe(message);
});

it('requires the native ACK to apply the requested revision and frame bounds', async () => {
  const popup: OpenDesignHostBrowserPopup = { surfaceId: 'popup:ack', projectId: 'p1', openerTabId: '__browser__:1', ancestorTabIds: ['__browser__:1'],
    webContentsId: 42, url: 'about:blank', title: 'Child', loading: false, canGoBack: false, canGoForward: false, disposition: 'new-window' };
  const presentPopup = vi.fn(async (request: { revision: number; bounds: unknown }) => ({ ok: true as const,
    value: { revision: request.revision, bounds: request.bounds } }));
  restore = installMockOpenDesignHost({ host: { browser: { listPopups: async () => ({ ok: true, popups: [popup] }), bindPopup: async () => ({ ok: true }),
    subscribePopups: () => () => {}, popupCommand: async () => ({ ok: true }), presentPopup } } });
  const node = document.createElement('div');
  node.getBoundingClientRect = () => ({ x: 10, y: 20, width: 390, height: 600 } as DOMRect);
  const surface = createPopupBrowserSurface(node, popup);
  await expect(surface.present(true)).resolves.toBeUndefined();
  presentPopup.mockResolvedValueOnce({ ok: true, value: { revision: -1, bounds: { x: 10, y: 20, width: 390, height: 600 } } });
  await expect(surface.present(true)).rejects.toThrow('did not apply');
  presentPopup.mockImplementationOnce(async (request) => ({ ok: true, value: { revision: request.revision, bounds: { x: 10, y: 20, width: 300, height: 600 } } }));
  await expect(surface.present(true)).rejects.toThrow('did not apply');
});

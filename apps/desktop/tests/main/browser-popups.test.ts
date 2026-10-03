import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Session, WebContents } from 'electron';
import type { OpenDesignHostBrowserPopupEvent } from '@open-design/host';
import { createDesignBrowserCdpController, type DesignBrowserCdpController } from '../../src/main/browser-cdp.js';
import { createDesignBrowserPopupController } from '../../src/main/browser-popups.js';

const viewState = vi.hoisted(() => ({ views: [] as Array<{ webContents: unknown; visible: boolean; bounds: unknown }> }));
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: unknown;
    visible = true;
    bounds: unknown;
    constructor(options: { webContents?: unknown }) { this.webContents = options.webContents ?? freshGuest(); viewState.views.push(this); }
    setVisible(value: boolean) { this.visible = value; }
    setBounds(value: unknown) { this.bounds = value; }
  },
}));
type OpenHandler = Parameters<WebContents['setWindowOpenHandler']>[0];
let nextId = 1;
const browserSession = {} as Session;
function freshGuest() {
  const debuggerApi = Object.assign(new EventEmitter(), {
    attached: false,
    attach: vi.fn(() => { debuggerApi.attached = true; }),
    detach: vi.fn(() => { debuggerApi.attached = false; debuggerApi.emit('detach', {}, 'target closed'); }),
    isAttached: () => debuggerApi.attached,
    sendCommand: vi.fn(async () => ({})),
  });
  const guest = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    id: nextId++, session: browserSession, destroyed: false, url: 'about:blank', zoom: 1,
    handler: null as OpenHandler | null,
    getType: () => 'webview', isDestroyed: () => guest.destroyed,
    getURL: () => guest.url, getTitle: () => 'Written child', isLoading: () => false,
    getZoomFactor: () => guest.zoom,
    setZoomFactor: vi.fn((zoom: number) => { guest.zoom = zoom; }),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: (handler: OpenHandler) => { guest.handler = handler; },
    loadURL: vi.fn(async (url: string, _options?: Electron.LoadURLOptions) => { guest.url = url; }),
    close: vi.fn(() => { if (!guest.destroyed) { guest.destroyed = true; guest.emit('destroyed'); } }),
    capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,sentinel' })),
    executeJavaScript: vi.fn(async () => 'written-sentinel'),
  });
  return guest;
}
function setup() {
  viewState.views.length = 0;
  const window = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false, getContentSize: () => [800, 600], webContents: { getZoomFactor: () => 1.25 } };
  const cdp = { attachPopup: vi.fn(async () => {}), registerTarget: vi.fn((target) => ({ ok: true, target: { ...target, attached: true } })) };
  const events: OpenDesignHostBrowserPopupEvent[] = [];
  const controller = createDesignBrowserPopupController(window as unknown as BrowserWindow, browserSession, cdp as unknown as DesignBrowserCdpController, (event) => events.push(event));
  const opener = freshGuest(); controller.attachGuest(opener as unknown as WebContents);
  return { controller, opener, cdp, window, events };
}
function open(opener: ReturnType<typeof freshGuest>, child?: ReturnType<typeof freshGuest>, overrides: Partial<Electron.HandlerDetails> = {}) {
  const result = opener.handler!({ url: 'about:blank', frameName: '', features: '', disposition: 'new-window', referrer: { url: '', policy: 'default' }, ...overrides });
  expect(result.action).toBe('allow');
  if (result.action !== 'allow' || !result.createWindow) throw new Error('missing native child adoption');
  return result.createWindow({ ...(child ? { webContents: child } : {}) } as Electron.BrowserWindowConstructorOptions);
}
function register(context: ReturnType<typeof setup>) {
  context.controller.registerOpener({ projectId: 'p1', tabId: '__browser__:1', url: 'about:blank', webContentsId: context.opener.id });
}
function setupWithRealCdp() {
  const context = setup();
  const cdp = createDesignBrowserCdpController(browserSession);
  Object.assign(context.cdp, { attachPopup: vi.fn(cdp.attachPopup), registerTarget: vi.fn(cdp.registerTarget) });
  return { ...context, realCdp: cdp };
}

describe('owned browser popup contexts', () => {
  it('waits for an empty supplied child to commit its own navigation before strict CDP registration', async () => {
    const context = setupWithRealCdp();
    const child = freshGuest(); child.url = '';
    open(context.opener, child, { url: 'https://example.com/child' }); register(context);
    const popup = context.controller.list('p1').popups[0];
    const binding = context.controller.bind({ ...popup, tabId: '__browser__:2' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(child.destroyed).toBe(false);
    expect(context.cdp.registerTarget).not.toHaveBeenCalled();
    child.url = 'https://example.com/child';
    child.emit('did-navigate', {}, child.url);
    await expect(binding).resolves.toEqual({ ok: true });
    expect(context.cdp.registerTarget).toHaveBeenCalledWith(expect.objectContaining({ url: child.url, webContentsId: child.id }));
    expect(context.realCdp.listTargets()).toMatchObject({ ok: true, targets: [{ webContentsId: child.id, tabId: '__browser__:2' }] });
    expect(viewState.views[0].webContents).toBe(child);
    expect(child.loadURL).not.toHaveBeenCalled();
    context.controller.close(); context.realCdp.close();
  });

  it.each(['destroyed', 'timeout'] as const)('cleans an empty child navigation wait after %s', async (outcome) => {
    vi.useFakeTimers();
    const context = setupWithRealCdp();
    const child = freshGuest(); child.url = '';
    open(context.opener, child, { url: 'https://example.com/child' }); register(context);
    const baseline = child.listenerCount('did-navigate');
    const popup = context.controller.list('p1').popups[0];
    const binding = context.controller.bind({ ...popup, tabId: '__browser__:2' });
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'destroyed') child.close();
      else await vi.advanceTimersByTimeAsync(30_001);
      await expect(binding).resolves.toEqual({ ok: false, reason: outcome === 'destroyed'
        ? 'popup closed before initial navigation' : 'popup initial navigation timed out' });
      expect(child.destroyed).toBe(true);
      expect(context.controller.list('p1').popups).toEqual([]);
      expect(context.cdp.registerTarget).not.toHaveBeenCalled();
      expect(child.listenerCount('did-navigate')).toBe(baseline);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.loadURL).not.toHaveBeenCalled();
    } finally { context.controller.close(); context.realCdp.close(); vi.useRealTimers(); }
  });

  it('fits the child CSS viewport to its frame when host and child start at unequal zoom', async () => {
    const context = setup(); context.window.webContents.getZoomFactor = () => 1.2;
    const child = freshGuest(); open(context.opener, child); register(context);
    const popup = context.controller.list('p1').popups[0];
    await context.controller.bind({ ...popup, tabId: '__browser__:2' });
    const requested = { x: 30, y: 40, width: 390, height: 400 };
    expect(child.getZoomFactor()).toBe(1);
    expect(context.controller.present({ ...popup, revision: 1, visible: true, bounds: requested })).toMatchObject({ ok: true });
    const native = viewState.views[0].bounds as typeof requested;
    expect({ width: native.width / child.getZoomFactor(), height: native.height / child.getZoomFactor() })
      .toEqual({ width: requested.width, height: requested.height });
    expect(viewState.views[0].webContents).toBe(child);
    expect(child.loadURL).not.toHaveBeenCalled();
    context.controller.close();
  });

  it('adopts the exact supplied child without replaying navigation; stages early nested children and binds once', async () => {
    const context = setup(); const child = freshGuest(); const nested = freshGuest();
    expect(open(context.opener, child)).toBe(child);
    expect(open(child, nested)).toBe(nested);
    expect(child.loadURL).not.toHaveBeenCalled(); expect(nested.loadURL).not.toHaveBeenCalled();
    expect(context.controller.list('p1').popups).toEqual([]);
    register(context);
    const parent = context.controller.list('p1').popups[0];
    expect(parent.ancestorTabIds).toEqual(['__browser__:1']);
    expect(await context.controller.command({ projectId: 'p1', surfaceId: parent.surfaceId, kind: 'capture' })).toMatchObject({ ok: false });
    expect(await context.controller.bind({ projectId: 'foreign', surfaceId: parent.surfaceId, tabId: '__browser__:2' })).toMatchObject({ ok: false });
    expect(await context.controller.bind({ projectId: 'p1', surfaceId: parent.surfaceId, tabId: '__browser__:2' })).toEqual({ ok: true });
    child.emit('console-message', { message: '__open_design_add_image_to_chat__:{"x":0}' });
    expect(context.events.at(-1)).toMatchObject({ kind: 'console', popup: { surfaceId: parent.surfaceId, projectId: 'p1' }, message: '__open_design_add_image_to_chat__:{"x":0}' });
    expect(context.controller.list('p1').popups).toHaveLength(2);
    expect(context.controller.list('p1').popups[1]).toMatchObject({ openerTabId: '__browser__:2', ancestorTabIds: ['__browser__:1', '__browser__:2'] });
    expect(await context.controller.command({ projectId: 'foreign', surfaceId: parent.surfaceId, kind: 'capture' })).toMatchObject({ ok: false });
    expect(await context.controller.command({ projectId: 'p1', surfaceId: parent.surfaceId, kind: 'navigate', url: 'file:///private' })).toMatchObject({ ok: false });
    child.close();
    expect(context.controller.list('p1').popups).toEqual([]); expect(nested.destroyed).toBe(true);
    expect(context.events.filter((event) => event.kind === 'closed')).toHaveLength(2);
  });
  it('replays a no-guest POST exactly once with its content type, boundary and referrer', () => {
    const context = setup();
    const postBody = { data: [{ type: 'rawData' as const, bytes: Buffer.from('sentinel') }], contentType: 'multipart/form-data', boundary: 'fixture-boundary' };
    const created = open(context.opener, undefined, { url: 'https://example.com/post', postBody, referrer: { url: 'https://example.com/form', policy: 'default' } }) as unknown as ReturnType<typeof freshGuest>;
    expect(created.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.com/post', {
      httpReferrer: { url: 'https://example.com/form', policy: 'default' }, postData: postBody.data, extraHeaders: 'Content-Type: multipart/form-data; boundary=fixture-boundary',
    });
    context.controller.close();
  });
  it('rejects foreign openers, hides by default, clamps zoomed bounds and ignores late activation', async () => {
    const context = setup();
    const foreign = freshGuest(); foreign.session = {} as Session;
    expect(() => context.controller.attachGuest(foreign as unknown as WebContents)).toThrow('unapproved');
    expect(context.opener.handler!({ url: 'file:///private' } as Electron.HandlerDetails)).toEqual({ action: 'deny' });
    register(context); const first = freshGuest(); const second = freshGuest(); open(context.opener, first); open(context.opener, second);
    const [a, b] = context.controller.list('p1').popups;
    await context.controller.bind({ ...a, tabId: '__browser__:2' }); await context.controller.bind({ ...b, tabId: '__browser__:3' });
    expect(viewState.views.every((view) => !view.visible)).toBe(true);
    const request = { projectId: 'p1', visible: true, bounds: { x: 100, y: 100, width: 1000, height: 1000 } };
    expect(context.controller.present({ ...request, surfaceId: a.surfaceId, revision: 1 })).toEqual({ ok: true,
      value: { revision: 1, bounds: { x: 100, y: 100, width: 540, height: 380 } } });
    expect(viewState.views[0].bounds).toEqual({ x: 125, y: 125, width: 675, height: 475 });
    context.controller.present({ ...request, surfaceId: b.surfaceId, revision: 3 });
    expect(context.controller.present({ ...request, surfaceId: a.surfaceId, revision: 2 })).toEqual({ ok: false, reason: 'popup presentation was superseded' });
    expect(viewState.views.map((view) => view.visible)).toEqual([false, true]);
    context.controller.closeProject('p1'); expect(context.controller.list('p1').popups).toEqual([]);
    expect(context.window.contentView.removeChildView).toHaveBeenCalledTimes(2);
  });
  it('closes a failed adoption and staged descendants rather than leaving invisible orphan contents', async () => {
    const context = setup(); const child = freshGuest(); open(context.opener, child); register(context);
    context.cdp.attachPopup.mockRejectedValueOnce(new Error('debugger unavailable'));
    const popup = context.controller.list('p1').popups[0];
    expect(await context.controller.bind({ ...popup, tabId: '__browser__:2' })).toEqual({ ok: false, reason: 'debugger unavailable' });
    expect(child.destroyed).toBe(true); expect(context.controller.list('p1').popups).toEqual([]);
    const staged = freshGuest(); open(context.opener, staged); context.controller.closeProject('p1'); expect(staged.destroyed).toBe(true);
  });
});

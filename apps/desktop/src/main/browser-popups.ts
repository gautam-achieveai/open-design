import { WebContentsView } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import type { OpenDesignHostBrowserPopup, OpenDesignHostBrowserPopupEvent, OpenDesignHostBrowserPopupResult, OpenDesignHostBrowserTargetRegistration } from '@open-design/host';
import { isAllowedDesignBrowserUrl, type DesignBrowserCdpController } from './browser-cdp.js';

type Entry = {
  id: string; contents: WebContents; view: WebContentsView; opener: number;
  projectId?: string; openerTabId?: string; tabId?: string; ancestors: string[];
  disposition: string; revision: number; ready: boolean;
};
const failure = (reason: string): OpenDesignHostBrowserPopupResult => ({ ok: false, reason });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keep a supplied child's pending Chromium navigation intact until it has a committed URL. */
async function waitForPopupNavigation(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) throw new Error('popup closed before initial navigation');
  if (contents.getURL() !== '') return;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      contents.removeListener('did-navigate', check);
      contents.removeListener('did-navigate-in-page', check);
      contents.removeListener('did-stop-loading', check);
      contents.removeListener('destroyed', destroyed);
      if (error) reject(error); else resolve();
    };
    const destroyed = () => finish(new Error('popup closed before initial navigation'));
    const check = () => {
      if (contents.isDestroyed()) return destroyed();
      const url = contents.getURL();
      if (url !== '') finish(isAllowedDesignBrowserUrl(url) ? undefined : new Error('disallowed popup navigation'));
    };
    const timer = setTimeout(() => finish(new Error('popup initial navigation timed out')), 30_000);
    contents.on('did-navigate', check); contents.on('did-navigate-in-page', check);
    contents.on('did-stop-loading', check); contents.on('destroyed', destroyed);
    check(); // Recheck after subscribing so an early native commit cannot be missed.
  });
}

/** Own original Chromium child contexts; renderer IDs cannot grant provenance. */
export function createDesignBrowserPopupController(
  window: BrowserWindow,
  browserSession: Session,
  cdp: DesignBrowserCdpController,
  publish: (event: OpenDesignHostBrowserPopupEvent) => void,
) {
  const entries = new Map<string, Entry>();
  const openers = new Map<number, WebContents>();
  const registrations = new Map<number, OpenDesignHostBrowserTargetRegistration>();
  let sequence = 0;
  let latestVisibleRevision = -1;
  let presentationDiagnostics = 0;
  let lastPresentationDiagnostic = '';
  let openDiagnostics = 0;
  const diagnoseOpen = (event: 'entry' | 'created' | 'published' | 'bind', fields: {
    openerId: number; childId?: number; allowed?: boolean; supplied?: boolean; ready?: boolean;
    disposition?: string; protocol?: string; phase?: 'started' | 'cdp-attached' | 'completed'; ok?: boolean; reason?: string;
    sourceUrlEmpty?: boolean; sourceUrlBlank?: boolean; latestUrlSame?: boolean;
  }) => {
    if (openDiagnostics++ < 60) console.info(JSON.stringify({ logger: 'browser.popup.open', event, ...fields }));
  };
  const bindReason = (reason: string) => [
    'unapproved popup session', 'embedded browser guest is not approved for CDP',
    'invalid browser target registration', 'browser target is not an attached approved Design Browser guest',
    'browser target URL does not match the attached guest', 'browser guest is already registered to another tab',
    'browser tab registration identity does not match',
    'popup closed before initial navigation', 'popup initial navigation timed out', 'disallowed popup navigation',
  ].includes(reason) ? reason : 'unclassified-bind-failure';
  const snapshot = (entry: Entry): OpenDesignHostBrowserPopup | null => {
    if (!entry.projectId || !entry.openerTabId || entry.contents.isDestroyed()) return null;
    const wc = entry.contents;
    return { surfaceId: entry.id, projectId: entry.projectId, openerTabId: entry.openerTabId,
      ancestorTabIds: [...entry.ancestors], ...(entry.tabId ? { tabId: entry.tabId } : {}),
      webContentsId: wc.id, url: wc.getURL() || 'about:blank', title: wc.getTitle(),
      loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(), disposition: entry.disposition };
  };
  const emit = (entry: Entry) => { const popup = snapshot(entry); if (popup) {
    diagnoseOpen('published', { openerId: entry.opener, childId: entry.contents.id, ready: entry.ready });
    publish({ kind: 'updated', popup });
  } };
  const hideAll = () => { for (const entry of entries.values()) entry.view.setVisible(false); };
  const closeDescendants = (opener: number) => {
    for (const entry of [...entries.values()]) if (entry.opener === opener && !entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
  };
  const resolveBindings = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries.values()) {
        if (entry.projectId && entry.openerTabId) continue;
        const parent = [...entries.values()].find((candidate) => candidate.contents.id === entry.opener);
        const ordinary = registrations.get(entry.opener);
        const projectId = parent?.projectId ?? ordinary?.projectId;
        const openerTabId = (parent?.ready ? parent.tabId : undefined) ?? ordinary?.tabId;
        if (!projectId || !openerTabId) continue;
        entry.projectId = projectId; entry.openerTabId = openerTabId;
        entry.ancestors = parent ? [...parent.ancestors, openerTabId] : [openerTabId];
        changed = true; emit(entry);
      }
    }
  };
  const install = (opener: WebContents) => {
    openers.set(opener.id, opener);
    opener.once('destroyed', () => { closeDescendants(opener.id); openers.delete(opener.id); registrations.delete(opener.id); });
    opener.setWindowOpenHandler((details) => {
      const allowed = openers.has(opener.id) && isAllowedDesignBrowserUrl(details.url || 'about:blank');
      let protocol = 'invalid';
      try { const value = new URL(details.url || 'about:blank').protocol;
        protocol = ['http:', 'https:', 'about:'].includes(value) ? value : 'other'; } catch { /* Fixed category only. */ }
      diagnoseOpen('entry', { openerId: opener.id, allowed, protocol,
        disposition: ['default', 'foreground-tab', 'background-tab', 'new-window', 'other'].includes(details.disposition)
          ? details.disposition : 'unclassified' });
      if (!allowed) return { action: 'deny' };
      return { action: 'allow', outlivesOpener: false,
        overrideBrowserWindowOptions: { webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } },
        createWindow: (options) => {
          // Electron supplies the Chromium child internally; the public options type omits it.
          const supplied = (options as typeof options & { webContents?: WebContents }).webContents;
          const view = new WebContentsView({ ...(supplied ? { webContents: supplied } : {}),
            webPreferences: { ...options.webPreferences, session: browserSession, preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
          const contents = view.webContents;
          diagnoseOpen('created', { openerId: opener.id, childId: contents.id, supplied: Boolean(supplied) });
          const entry: Entry = { id: `popup:${++sequence}`, contents, view, opener: opener.id, ancestors: [], disposition: details.disposition, revision: -1, ready: false };
          entries.set(entry.id, entry); window.contentView.addChildView(view); view.setVisible(false);
          const guard = (event: Electron.Event, url: string) => { if (!isAllowedDesignBrowserUrl(url)) event.preventDefault(); };
          contents.on('will-navigate', guard); contents.on('will-redirect', guard);
          install(contents);
          const update = () => emit(entry);
          contents.on('console-message', (event) => {
            // Preserve the panel's existing image-hover channel; do not forward arbitrary page logs.
            const message = event.message;
            if (!entry.ready || !message.startsWith('__open_design_add_image_to_chat__:') || message.length > 16_384) return;
            const popup = snapshot(entry);
            if (popup) publish({ kind: 'console', popup, message });
          });
          contents.on('did-navigate', update); contents.on('did-navigate-in-page', update);
          contents.on('page-title-updated', update); contents.on('did-start-loading', update); contents.on('did-stop-loading', update);
          contents.once('destroyed', () => {
            const popup = entry.projectId && entry.openerTabId ? { surfaceId: entry.id, projectId: entry.projectId, openerTabId: entry.openerTabId,
              ancestorTabIds: entry.ancestors, tabId: entry.tabId, webContentsId: contents.id, url: '', title: '', loading: false,
              canGoBack: false, canGoForward: false, disposition: entry.disposition } : null;
            entries.delete(entry.id);
            if (!window.isDestroyed()) window.contentView.removeChildView(view);
            if (popup) publish({ kind: 'closed', popup });
          });
          resolveBindings();
          if (!supplied) {
            const post = details.postBody;
            void contents.loadURL(details.url || 'about:blank', { httpReferrer: details.referrer,
              ...(post ? { postData: post.data, extraHeaders: `Content-Type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ''}` } : {}) }).catch(() => contents.close());
          }
          return contents;
        },
      };
    });
  };
  const owned = (raw: unknown): Entry | null => {
    if (!record(raw) || typeof raw.surfaceId !== 'string' || typeof raw.projectId !== 'string') return null;
    const entry = entries.get(raw.surfaceId);
    return entry?.projectId === raw.projectId && entry.tabId && entry.ready && !entry.contents.isDestroyed() ? entry : null;
  };
  return {
    attachGuest(guest: WebContents) {
      if (guest.getType() !== 'webview' || guest.session !== browserSession || guest.isDestroyed()) throw new Error('unapproved popup opener');
      install(guest);
    },
    registerOpener(registration: OpenDesignHostBrowserTargetRegistration) {
      if (!openers.has(registration.webContentsId)) return;
      registrations.set(registration.webContentsId, registration); resolveBindings();
    },
    list(projectId: unknown) { return { ok: true as const, popups: [...entries.values()].map(snapshot).filter((popup): popup is OpenDesignHostBrowserPopup => popup !== null && popup.projectId === projectId) }; },
    async bind(raw: unknown): Promise<OpenDesignHostBrowserPopupResult> {
      if (!record(raw) || typeof raw.tabId !== 'string' || !/^__browser__:[1-9]\d*$/.test(raw.tabId)) return failure('invalid popup binding');
      const entry = typeof raw.surfaceId === 'string' ? entries.get(raw.surfaceId) : undefined;
      if (!entry || !entry.projectId || entry.projectId !== raw.projectId || !entry.openerTabId || entry.contents.isDestroyed() || (entry.tabId && entry.tabId !== raw.tabId)) return failure('popup is not owned by this project');
      if ([...entries.values()].some((candidate) => candidate !== entry && candidate.tabId === raw.tabId)) return failure('popup tab is already bound');
      entry.tabId = raw.tabId;
      diagnoseOpen('bind', { openerId: entry.opener, childId: entry.contents.id, phase: 'started' });
      try {
        await cdp.attachPopup(entry.contents);
        diagnoseOpen('bind', { openerId: entry.opener, childId: entry.contents.id, phase: 'cdp-attached' });
        await waitForPopupNavigation(entry.contents);
        const registrationUrl = entry.contents.getURL();
        const result = cdp.registerTarget({ projectId: entry.projectId, tabId: entry.tabId, url: registrationUrl || 'about:blank', webContentsId: entry.contents.id });
        diagnoseOpen('bind', { openerId: entry.opener, childId: entry.contents.id, phase: 'completed', ok: result.ok,
          sourceUrlEmpty: registrationUrl === '', sourceUrlBlank: registrationUrl === 'about:blank',
          latestUrlSame: registrationUrl === entry.contents.getURL(),
          ...(!result.ok ? { reason: bindReason(result.reason) } : {}) });
        if (!result.ok) { if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false }); return result; }
        entry.ready = true; emit(entry); resolveBindings(); return { ok: true };
      } catch (error) {
        diagnoseOpen('bind', { openerId: entry.opener, childId: entry.contents.id, phase: 'completed', ok: false,
          reason: bindReason(error instanceof Error ? error.message : '') });
        if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
    present(raw: unknown): OpenDesignHostBrowserPopupResult {
      const entry = owned(raw);
      if (!entry || !record(raw) || !record(raw.bounds) || typeof raw.visible !== 'boolean' || !Number.isSafeInteger(raw.revision)) return failure('invalid popup presentation');
      if ((raw.revision as number) < entry.revision) return failure('popup presentation was superseded');
      const b = raw.bounds;
      if (![b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return failure('invalid popup bounds');
      entry.revision = raw.revision as number;
      const zoom = window.webContents.getZoomFactor(); const [width, height] = window.getContentSize();
      const x = Math.max(0, Math.min(width, Math.round((b.x as number) * zoom)));
      const y = Math.max(0, Math.min(height, Math.round((b.y as number) * zoom)));
      const bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round((b.width as number) * zoom))), height: Math.max(0, Math.min(height - y, Math.round((b.height as number) * zoom))) };
      if (raw.visible && entry.revision < latestVisibleRevision) return failure('popup presentation was superseded');
      if (raw.visible) { latestVisibleRevision = entry.revision; hideAll(); }
      // Native bounds use the host's zoom. Match the owned child's CSS scale so
      // the same frame describes its responsive viewport without reloading it.
      const previousChildZoom = entry.contents.getZoomFactor();
      if (previousChildZoom !== zoom) entry.contents.setZoomFactor(zoom);
      entry.view.setBounds(bounds); entry.view.setVisible(raw.visible && bounds.width > 0 && bounds.height > 0);
      const childZoom = entry.contents.getZoomFactor?.() ?? null;
      const diagnostic = JSON.stringify([raw.visible, zoom, childZoom, b.x, b.y, b.width, b.height,
        bounds.x, bounds.y, bounds.width, bounds.height]);
      if (diagnostic !== lastPresentationDiagnostic && presentationDiagnostics < 40) {
        lastPresentationDiagnostic = diagnostic; presentationDiagnostics++;
        console.info(JSON.stringify({ logger: 'browser.popup.viewport',
        event: 'presentation', revision: entry.revision, visible: raw.visible,
        parentZoom: zoom, childZoom, previousChildZoom,
        requestedBounds: { x: b.x, y: b.y, width: b.width, height: b.height }, appliedBounds: bounds }));
      }
      return { ok: true, value: { revision: entry.revision, bounds: { x: bounds.x / zoom, y: bounds.y / zoom,
        width: bounds.width / zoom, height: bounds.height / zoom } } };
    },
    async command(raw: unknown): Promise<OpenDesignHostBrowserPopupResult> {
      const entry = owned(raw);
      if (!entry || !record(raw)) return failure('popup is not bound to this project');
      const wc = entry.contents;
      try {
        switch (raw.kind) {
          case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
          case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
          case 'reload': wc.reload(); break;
          case 'reload-hard': wc.reloadIgnoringCache(); break;
          case 'stop': wc.stop(); break;
          case 'focus': wc.focus(); break;
          case 'close': entry.view.setVisible(false); wc.close({ waitForBeforeUnload: false }); break;
          case 'navigate': if (typeof raw.url !== 'string' || !isAllowedDesignBrowserUrl(raw.url)) return failure('disallowed popup navigation'); await wc.loadURL(raw.url); break;
          case 'capture': return { ok: true, value: (await wc.capturePage()).toDataURL() };
          case 'evaluate':
            if (typeof raw.code !== 'string' || raw.code.length > 1_000_000 || !isAllowedDesignBrowserUrl(wc.getURL() || 'about:blank')) return failure('invalid popup UI script');
            return { ok: true, value: await wc.executeJavaScript(raw.code, raw.userGesture === true) };
          default: return failure('unknown popup command');
        }
        return { ok: true };
      } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
    },
    closeTab(tabId: string) {
      const ordinary = [...registrations.values()].find((registration) => registration.tabId === tabId);
      if (ordinary) closeDescendants(ordinary.webContentsId);
    },
    closeProject(projectId: unknown) {
      for (const registration of registrations.values()) if (registration.projectId === projectId) closeDescendants(registration.webContentsId);
      for (const entry of [...entries.values()]) if (entry.projectId === projectId && !entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
      return { ok: true as const };
    },
    hideAll,
    close() { hideAll(); for (const entry of [...entries.values()]) if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false }); registrations.clear(); openers.clear(); },
  };
}

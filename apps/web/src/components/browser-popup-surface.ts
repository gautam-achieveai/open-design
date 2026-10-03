import { getHostBrowserPopups, type OpenDesignHostBrowserPopup, type OpenDesignHostBrowserPopupCommand } from '@open-design/host';

let presentationRevision = 0;

/** Existing panel page operations, backed by the owned native child context. */
export function createPopupBrowserSurface(node: HTMLDivElement, initial: OpenDesignHostBrowserPopup) {
  const host = getHostBrowserPopups();
  let popup = initial;
  const identity = { projectId: initial.projectId, surfaceId: initial.surfaceId };
  const command = async (operation: Omit<OpenDesignHostBrowserPopupCommand, 'projectId' | 'surfaceId'>) => {
    const result = await host?.popupCommand?.({ ...identity, ...operation } as OpenDesignHostBrowserPopupCommand);
    if (!result?.ok) throw new Error(result && !result.ok ? result.reason : 'Native popup support is unavailable');
    return result.value;
  };
  const action = (kind: 'back' | 'forward' | 'reload' | 'reload-hard' | 'stop') => {
    void command({ kind }).catch(() => node.dispatchEvent(new Event('did-fail-load')));
  };
  const page = Object.assign(node, {
    canGoBack: () => popup.canGoBack,
    canGoForward: () => popup.canGoForward,
    getTitle: () => popup.title,
    getURL: () => popup.url,
    getWebContentsId: () => popup.webContentsId,
    isLoading: () => popup.loading,
    executeJavaScript: async <T = unknown>(code: string, userGesture?: boolean): Promise<T> => command({ kind: 'evaluate', code, userGesture } as Omit<OpenDesignHostBrowserPopupCommand, 'projectId' | 'surfaceId'>) as Promise<T>,
    capturePage: async () => { const image = await command({ kind: 'capture' }); return { toDataURL: () => String(image) }; },
    loadURL: (url: string) => command({ kind: 'navigate', url } as Omit<OpenDesignHostBrowserPopupCommand, 'projectId' | 'surfaceId'>).then(() => undefined),
    goBack: () => action('back'),
    goForward: () => action('forward'),
    reload: () => action('reload'),
    reloadIgnoringCache: () => action('reload-hard'),
    stop: () => action('stop'),
  });
  return {
    page,
    connect() {
      return host?.subscribePopups?.((event) => {
        if (event.kind === 'console' && event.popup.surfaceId === identity.surfaceId && event.popup.projectId === identity.projectId) {
          page.dispatchEvent(Object.assign(new Event('console-message'), { message: event.message }));
        }
      }) ?? (() => {});
    },
    update(next: OpenDesignHostBrowserPopup) {
      const previous = popup; popup = next;
      if (previous.url !== next.url) page.dispatchEvent(Object.assign(new Event('did-navigate'), { url: next.url }));
      if (previous.title !== next.title) page.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: next.title }));
      if (previous.loading !== next.loading) page.dispatchEvent(new Event(next.loading ? 'did-start-loading' : 'did-stop-loading'));
    },
    async present(visible: boolean) {
      const rect = node.getBoundingClientRect();
      const revision = ++presentationRevision;
      const result = await host?.presentPopup?.({ ...identity, visible, revision,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      if (!result?.ok) throw new Error(result && !result.ok ? result.reason : 'Native popup support is unavailable');
      const applied = result.value as { revision?: number; bounds?: { x: number; y: number; width: number; height: number } } | undefined;
      if (applied?.revision !== revision || !applied.bounds
        || ['x', 'y', 'width', 'height'].some((key) => {
          const actual = applied.bounds![key as keyof typeof applied.bounds];
          return !Number.isFinite(actual) || Math.abs(actual - rect[key as 'x' | 'y' | 'width' | 'height']) > 1;
        })) throw new Error('Native popup did not apply the requested viewport bounds');
    },
  };
}

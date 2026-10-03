import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, removeHandler } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, options?: unknown) => Promise<unknown>>(),
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: { sender: unknown }, options?: unknown) => Promise<unknown>) => handlers.set(channel, handler), removeHandler },
  BrowserWindow: vi.fn(), WebContentsView: vi.fn(), app: {}, dialog: {}, nativeImage: {}, nativeTheme: {},
  screen: {}, session: {}, shell: {}, webFrameMain: {},
}));
import { registerHostPageCapture } from '../../src/main/runtime.js';

function captureHost(zoom: number) {
  const image = { getSize: () => ({ width: 576, height: 384 }), toDataURL: () => 'data:image/png;base64,cGl4ZWxz' };
  const contents = { getZoomFactor: vi.fn(() => zoom), capturePage: vi.fn(async (_clip?: Electron.Rectangle) => image) };
  registerHostPageCapture({ webContents: contents } as unknown as BrowserWindow);
  const handler = handlers.get('od:capture-page')!;
  return { contents, capture: (options?: unknown, sender: unknown = contents) => handler({ sender }, options) };
}

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); });

describe('native host page capture IPC', () => {
  it('captures the selected CSS rectangle at the actual host zoom without reducing native image detail', async () => {
    const host = captureHost(1.2);
    const result = await host.capture({ clip: { x: 200, y: 200, width: 240, height: 160 } });
    expect(host.contents.capturePage).toHaveBeenCalledWith({ x: 240, y: 240, width: 288, height: 192 });
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,cGl4ZWxz', w: 576, h: 384,
      capturedCssRect: { x: 200, y: 200, width: 240, height: 160 } });
    expect(removeHandler).toHaveBeenCalledWith('od:capture-page');
  });

  it('keeps the default zoom rectangle and full-page capture unchanged', async () => {
    const host = captureHost(1);
    await host.capture({ clip: { x: 200, y: 200, width: 240, height: 160 } });
    expect(host.contents.capturePage).toHaveBeenLastCalledWith({ x: 200, y: 200, width: 240, height: 160 });
    await host.capture();
    expect(host.contents.capturePage).toHaveBeenLastCalledWith();
  });

  it('rounds fractional native edges inward within the accepted CSS rectangle', async () => {
    const host = captureHost(1.25);
    const result = await host.capture({ clip: { x: 11, y: 17, width: 31, height: 19 } });
    expect(host.contents.capturePage).toHaveBeenCalledWith({ x: 14, y: 22, width: 38, height: 23 });
    expect(result).toMatchObject({ capturedCssRect: { x: 11.2, y: 17.6, width: 30.4, height: 18.4 } });
  });

  it('preserves existing CSS rounding and minimum clip normalization at default zoom', async () => {
    const host = captureHost(1);
    await host.capture({ clip: { x: 10.4, y: 20.6, width: 30.2, height: 40.8 } });
    expect(host.contents.capturePage).toHaveBeenLastCalledWith({ x: 10, y: 21, width: 30, height: 41 });
    await host.capture({ clip: { x: -3, y: -4, width: 0, height: -5 } });
    expect(host.contents.capturePage).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('fails closed when no whole native pixel fits instead of enlarging a tiny private clip', async () => {
    const host = captureHost(0.25);
    expect(await host.capture({ clip: { x: 1, y: 1, width: 1, height: 1 } }))
      .toEqual({ ok: false, reason: 'capture clip is smaller than one native pixel' });
    expect(host.contents.capturePage).not.toHaveBeenCalled();
  });

  it('keeps unclipped captures independent of zoom', async () => {
    const host = captureHost(1.2);
    const result = await host.capture();
    expect(host.contents.capturePage).toHaveBeenCalledWith();
    expect(host.contents.getZoomFactor).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('capturedCssRect');
  });

  it('rejects a foreign sender before reading zoom or capturing pixels', async () => {
    const host = captureHost(1.2);
    expect(await host.capture({ clip: { x: 0, y: 0, width: 20, height: 20 } }, {}))
      .toEqual({ ok: false, reason: 'capture sender not allowed' });
    expect(host.contents.getZoomFactor).not.toHaveBeenCalled();
    expect(host.contents.capturePage).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { clip: [] }, { clip: { x: NaN, y: 0, width: 20, height: 20 } },
    { clip: { x: 0, y: 0, width: '20', height: 20 } }])('preserves invalid clip fallback: %j', async (options) => {
    const host = captureHost(1.2);
    await host.capture(options);
    expect(host.contents.capturePage).toHaveBeenCalledWith();
  });
});

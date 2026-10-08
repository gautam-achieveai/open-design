import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const workerSource = readFileSync(join(import.meta.dirname, '..', 'background.js'), 'utf8');

type MessageHandler = (message: unknown, sender: unknown, respond: (response: unknown) => void) => boolean;
type Request = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function worker(options: { paired?: boolean; tabUrl?: string; screenshot?: boolean; oversized?: boolean;
  captureGate?: Promise<void>; session?: Record<string, unknown>; sessionGate?: Promise<void>;
  redeemGate?: Promise<void>; content?: { contentWidth: number; contentHeight: number }; pinStatus?: number; pinRefusal?: unknown; inspectQueue?: Array<{ requestId: string; operation: string; selector?: string }> } = {}) {
  let handler: MessageHandler | undefined;
  let onTabUpdated: ((id: number, changes: { url?: string; status?: string }) => void) | undefined;
  let onTabActivated: (() => void) | undefined;
  let onWindowFocused: (() => void) | undefined;
  const requests: Request[] = [];
  const tab = { id: 17, windowId: 3, active: true, title: 'App', url: options.tabUrl ?? 'https://app.example.test/dashboard' };
  let childDocument = 'child-document-1';
  let childUrl = 'https://child.example.test/frame';
  let screenshotCount = 0;
  let barHidden = false;
  let windowFocused = true;
  const inspectMessages: Array<{ message: Record<string, unknown>; options?: { documentId?: string; frameId?: number } }> = [];
  let inspectionRead: ((message: Record<string, unknown>) => unknown) | undefined;
  let captureSafety: ((message: Record<string, unknown>) => { ok: boolean }) | undefined;
  let postCaptureSafety: ((message: Record<string, unknown>) => { ok: boolean }) | undefined;
  let inspectionSafety: ((message: Record<string, unknown>) => { ok: boolean; maskRects?: unknown[]; viewportWidth?: number; viewportHeight?: number }) | undefined;
  let screenshotReadyCount = 0;
  const session = options.session || {};
  const local: Record<string, unknown> = {};
  const chrome = {
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
    runtime: { id: 'a'.repeat(32), getURL: (path: string) => `chrome-extension://${'a'.repeat(32)}/${path}`,
      onInstalled: { addListener: () => {} }, onMessage: { addListener: (fn: MessageHandler) => { handler = fn; } } },
    windows: { get: async () => ({ focused: windowFocused }),
      onFocusChanged: { addListener: (fn: typeof onWindowFocused) => { onWindowFocused = fn; } } },
    storage: { local: { get: async () => local, set: async (data: object) => { Object.assign(local, data); } },
      session: { get: async () => { await options.sessionGate; return session; },
        set: async (data: object) => { Object.assign(session, data); } } },
    tabs: {
      get: async (id: number) => id === tab.id ? tab : null,
      query: async () => [tab],
      captureVisibleTab: async () => {
        screenshotCount += 1;
        assert.ok(barHidden, 'Clipper UI must be hidden before capture');
        if (!options.screenshot) throw new Error('capture blocked');
        await options.captureGate;
        return 'data:image/png;base64,AA==';
      },
      sendMessage: (_tabId: number, message: { type: string; nonce?: string }, optionsOrCallback: unknown,
        explicitCallback?: (result: { ok: boolean }) => void) => {
        const callback = explicitCallback || (typeof optionsOrCallback === 'function' ? optionsOrCallback as (result: { ok: boolean }) => void : null);
        const targeting = callback ? undefined : optionsOrCallback as { documentId?: string; frameId?: number };
        inspectMessages.push({ message: message as Record<string, unknown>, options: targeting });
        if (message.type === 'odAnnotation:identify') {
          const child = targeting?.documentId !== 'parent-document-1';
          if (child && targeting?.documentId !== childDocument) return Promise.resolve({ ok: false });
          const url = child ? childUrl : tab.url;
          void send({ type: 'odAnnotation:identity', nonce: message.nonce, url },
            { id: 'a'.repeat(32), tab, frameId: child ? 2 : 0,
              documentId: child ? childDocument : 'parent-document-1', url });
          return Promise.resolve({ ok: true });
        }
        if (message.type === 'odInspect:identify') {
          void send({ type: 'odInspect:identity', nonce: message.nonce, url: tab.url },
            { id: 'a'.repeat(32), tab, frameId: 0, documentId: 'chrome-document-1', url: tab.url });
          return Promise.resolve({ ok: true });
        }
        if (message.type === 'odInspect:read') return Promise.resolve(inspectionRead?.(message as Record<string, unknown>)
          ?? { ok: true, result: { html: '<main>Read</main>', url: tab.url, title: tab.title } });
        if (message.type === 'odInspect:screenshotReady') {
          screenshotReadyCount += 1;
          return Promise.resolve(inspectionSafety?.(message as Record<string, unknown>)
            ?? { ok: true, maskRects: [], viewportWidth: 200, viewportHeight: 150 });
        }
        if (message.type === 'odClipper:verifyAfterCapture' && callback) {
          callback(postCaptureSafety?.(message as Record<string, unknown>) ?? { ok: true });
          return;
        }
        if (message.type === 'odClipper:hideForCapture') barHidden = true;
        if (message.type === 'odClipper:restoreAfterCapture') barHidden = false;
        if (callback) callback(message.type === 'odClipper:hideForCapture'
          ? captureSafety?.(message as Record<string, unknown>) ?? { ok: true } : { ok: true });
        else return Promise.resolve({ ok: true });
      },
      onActivated: { addListener: (fn: typeof onTabActivated) => { onTabActivated = fn; } },
      onUpdated: { addListener: (fn: typeof onTabUpdated) => { onTabUpdated = fn; } },
      onRemoved: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
    },
    scripting: { executeScript: async () => [{ result: { width: 200, height: 150, x: 0, y: 0, ...options.content } }] },
  };
  const fetch = async (url: URL, init: Request['init']) => {
    requests.push({ url: String(url), init });
    const pathname = new URL(url).pathname;
    if (!options.paired) return { ok: false, status: 403, json: async () => ({ error: { message: 'not paired' } }) };
    const body = init.body && JSON.parse(init.body);
    if (/comment-(list|upsert|delete)$/.test(pathname) && options.pinStatus) {
      return { ok: false, status: options.pinStatus,
        json: async () => options.pinRefusal ?? { error: { code: 'FORBIDDEN', message: 'annotation evidence is malformed' } } };
    }
    if (pathname.endsWith('/redeem') && body.code === 'other-id.invalid-secret') {
      return { ok: false, status: 404, json: async () => ({ error: { message: 'pairing code expired' } }) };
    }
    if (pathname.endsWith('/redeem') && body.code === 'other-id.valid-secret') await options.redeemGate;
    let value: Record<string, unknown> = {};
    if (pathname.endsWith('/redeem')) value = {
      grant: { grantId: 'grant-1', projectId: 'project-1', conversationId: 'c1', tabId: body.tabId,
        documentId: body.documentId, origin: body.origin, expiresAt: Date.now() + 10_000 },
      token: 'worker-only-secret', projectName: 'Project One',
    };
    else if (pathname.endsWith('/status')) value = {
      grant: { grantId: body.grantId, projectId: body.projectId,
        tabId: body.tabId, documentId: body.documentId },
    };
    else if (pathname.endsWith('/comment-list')) value = { filePath: 'browser:x',
      comments: [{ id: 'pin-1', pinSeq: 1, selector: target.selector, elementId: target.selector }] };
    else if (pathname.endsWith('/comment-upsert')) value = { comment: { id: body.id || 'pin-9', pinSeq: body.id ? 1 : 2 } };
    else if (pathname.endsWith('/comment-delete')) value = { deleted: true };
    else if (pathname.endsWith('/inspect/poll')) value = options.inspectQueue?.length
      ? { request: options.inspectQueue.shift()! } : { request: null };
    return { ok: true, status: 200, json: async () => value };
  };
  let serial = 0;
  const bitmap = { width: 400, height: 300, close: () => {} };
  const drawCalls: unknown[][] = [];
  const maskCalls: unknown[][] = [];
  const strokeCalls: unknown[][] = [];
  class Canvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return { drawImage: (...args: unknown[]) => { drawCalls.push(args); },
      fillRect: (...args: unknown[]) => { maskCalls.push(args); },
      strokeRect: (...args: unknown[]) => { strokeCalls.push(args); } }; }
    async convertToBlob() { return new Blob([new Uint8Array(options.oversized ? 256 * 1024 + 1 : 32)], { type: 'image/png' }); }
  }
  const scope: Record<string, unknown> = {
    chrome, URL, URLSearchParams, Buffer, Blob, console, setTimeout, clearTimeout, TextEncoder,
    OffscreenCanvas: Canvas, createImageBitmap: async () => bitmap,
    btoa: (input: string) => Buffer.from(input, 'binary').toString('base64'),
    crypto: { randomUUID: () => `epoch-${++serial}` },
    AbortController, fetch: async (url: URL | string, init?: Request['init']) => {
      if (String(url).startsWith('data:image/png;')) return { blob: async () => new Blob([0], { type: 'image/png' }) };
      return fetch(url as URL, init!);
    },
  };
  runInNewContext(workerSource, scope);
  assert.ok(handler);
  const send = (message: unknown, sender: unknown = { tab, frameId: 0 }) => new Promise<Record<string, unknown>>((resolve) => {
    handler!(message, sender, (response) => resolve(response as Record<string, unknown>));
  });
  return { requests, send, tab, drawCalls, maskCalls, strokeCalls, scope, session, local, inspectMessages,
    screenshotCount: () => screenshotCount, screenshotReadyCount: () => screenshotReadyCount,
    hidden: () => barHidden,
    replaceChild(url = childUrl) { childDocument = 'child-document-2'; childUrl = url; },
    setInspectionRead(fn: typeof inspectionRead) { inspectionRead = fn; },
    setCaptureSafety(fn: typeof captureSafety) { captureSafety = fn; },
    setPostCaptureSafety(fn: typeof postCaptureSafety) { postCaptureSafety = fn; },
    setInspectionSafety(fn: typeof inspectionSafety) { inspectionSafety = fn; },
    focus(focused: boolean) { windowFocused = focused; onWindowFocused?.(); },
    activate(active: boolean) { tab.active = active; onTabActivated?.(); },
    navigate(url: string) { tab.url = url; onTabUpdated?.(tab.id, { url }); } };
}

// Same cases as apps/web/tests/components/pin-capture-frame.test.ts: the
// Clipper mirrors the in-app browser's pin picture framing.
test('frames pin pictures with the same rules as the in-app browser', () => {
  const { scope } = worker();
  const frame = scope.pinCaptureFrame as (element: object, viewport: object) => unknown;
  const trim = scope.pinCaptureTrim as (image: object, minScale?: number) => unknown;
  const viewport = { width: 1200, height: 800 };
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(frame({ x: 100, y: 100, width: 300, height: 200 }, viewport)),
    { frame: { x: 100, y: 100, width: 300, height: 200 }, highlight: null });
  assert.deepEqual(plain(frame({ x: 500, y: 300, width: 24, height: 24 }, viewport)),
    { frame: { x: 432, y: 262, width: 160, height: 100 }, highlight: { x: 68, y: 38, width: 24, height: 24 } });
  assert.deepEqual(plain(frame({ x: 0, y: 0, width: 1200, height: 48 }, viewport)),
    { frame: { x: 0, y: 0, width: 1200, height: 400 }, highlight: { x: 0, y: 0, width: 1200, height: 48 } });
  assert.deepEqual(plain(frame({ x: 1190, y: 0, width: 10, height: 600 }, viewport)).frame,
    { x: 1000, y: 0, width: 200, height: 600 });
  assert.deepEqual(plain(frame({ x: 100, y: -500, width: 400, height: 900 }, viewport)).frame,
    { x: 100, y: 0, width: 400, height: 400 });
  assert.equal(frame({ x: 0, y: 900, width: 50, height: 50 }, viewport), null);
  const image = (width: number, height: number, content?: { x: number; y: number; width: number; height: number }) => {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    if (content) {
      for (let y = content.y; y < content.y + content.height; y += 1) {
        for (let x = content.x; x < content.x + content.width; x += 1) data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    }
    return { width, height, data };
  };
  assert.deepEqual(plain(trim(image(800, 600, { x: 50, y: 40, width: 120, height: 30 }))),
    { x: 30, y: 5, width: 160, height: 100 });
  assert.equal(trim(image(300, 200, { x: 10, y: 10, width: 280, height: 180 })), null);
  assert.equal(trim(image(300, 200)), null);
  const pale = image(800, 600, { x: 50, y: 40, width: 120, height: 30 });
  for (let i = 0; i < pale.data.length; i += 4) if (pale.data[i] === 20) pale.data.fill(243, i, i + 3);
  assert.deepEqual(plain(trim(pale)), { x: 30, y: 5, width: 160, height: 100 });
  assert.deepEqual(plain(trim(image(1600, 1200, { x: 100, y: 80, width: 240, height: 60 }), 2)),
    { x: 60, y: 10, width: 320, height: 200 });
});

const popupSender = { id: 'a'.repeat(32), url: `chrome-extension://${'a'.repeat(32)}/popup.html` };

const target = {
  url: 'https://app.example.test/dashboard', title: 'Page', selector: 'main > button',
  label: 'button', text: 'Save', domOutline: 'button Save', position: { x: 10, y: 12, width: 40, height: 20 },
  htmlHint: 'button',
  ancestors: [{ tag: 'main', selector: 'main', role: 'main' }],
  style: { color: 'rgb(10, 20, 30)', fontSize: '16px' },
};
const capture = {
  type: 'odAnnotation:capture', eventId: 'event-1', target,
  rect: { x: 5, y: 7, width: 50, height: 60 }, maskRects: [],
  viewportWidth: 200, viewportHeight: 150, scrollX: 0, scrollY: 0,
};

async function prepare(app: ReturnType<typeof worker>) {
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const result = await app.send(capture);
  assert.equal(result.ok, true, String(result.error));
  assert.match(String(result.cropDataUrl), /^data:image\/png;base64,/);
}

const code = 'pair-id.secret-value';

function frameSenders(app: ReturnType<typeof worker>) {
  const parent = { id: 'a'.repeat(32), tab: app.tab, frameId: 0,
    documentId: 'parent-document-1', url: app.tab.url };
  const child = { ...parent, frameId: 2, documentId: 'child-document-1', url: 'https://child.example.test/frame' };
  return { parent, child };
}
async function enterChild(app: ReturnType<typeof worker>) {
  const { parent, child } = frameSenders(app);
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const requested = await app.send({ type: 'odAnnotation:frameRequest' }, parent);
  assert.equal(requested.ok, true);
  const identified = await app.send({ type: 'odAnnotation:frameIdentity', nonce: requested.nonce, url: child.url }, child);
  assert.equal(identified.ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:frameConfirm', nonce: requested.nonce, proof: identified.proof }, parent)).ok, true);
  const scoped = { ...target, url: child.url, scope: { frame: 'child', url: child.url,
    selectorRoot: 'document', shadowHosts: [], screenshot: 'not-supported' } };
  assert.equal((await app.send({ type: 'odAnnotation:review', eventId: 'child-event', target: scoped }, child)).ok, true);
  return { parent, child, scoped };
}

test('authorized child notes preserve top grant and scoped JSON without taking screenshots', async () => {
  const app = worker({ paired: true });
  const { child, scoped } = await enterChild(app);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'child-event', target: scoped,
    note: 'Improve this frame', omitScreenshot: true }, child)).ok, true);
  const body = JSON.parse(app.requests.find(request => request.url.endsWith('/comment-upsert'))!.init.body!);
  assert.equal(body.url, target.url);
  assert.equal(body.documentId, 'epoch-1');
  assert.equal(body.target.scope.url, child.url);
  assert.equal(body.target.scope.frame, 'child');
  assert.equal(body.screenshotDataUrl, undefined);
  assert.equal(JSON.stringify(body).includes('child-document'), false);
  assert.equal(app.screenshotCount(), 0);
  assert.ok(app.inspectMessages.find(entry => entry.message.type === 'odAnnotation:arm')!.options?.documentId === child.documentId);
});

test('child event ownership, sender identity and replacement are fenced before staging', async () => {
  const app = worker({ paired: true });
  const { child, scoped } = await enterChild(app);
  const submit = { type: 'odAnnotation:savePin', eventId: 'child-event', target: scoped, note: 'Change', omitScreenshot: true };
  assert.equal((await app.send({ ...submit, eventId: 'wrong-event' }, child)).ok, false);
  assert.equal((await app.send(submit, { ...child, documentId: 'guessed' })).ok, false);
  assert.equal((await app.send(submit, { ...child, frameId: 3 })).ok, false);
  app.replaceChild();
  assert.equal((await app.send(submit, child)).ok, false);
  assert.equal(app.requests.filter(request => request.url.endsWith('/comment-upsert')).length, 0);
});

test('fresh frame challenge refuses guessed nonce, restricted child and stale parent epoch', async () => {
  const app = worker({ paired: true });
  const { parent, child } = frameSenders(app);
  await app.send({ type: 'odAnnotation:pair', code }, popupSender);
  const requested = await app.send({ type: 'odAnnotation:frameRequest' }, parent);
  const identify = { type: 'odAnnotation:frameIdentity', nonce: requested.nonce, url: child.url };
  assert.equal((await app.send({ ...identify, nonce: 'guess' }, child)).ok, false);
  assert.equal((await app.send({ ...identify, url: 'https://accounts.google.com/' },
    { ...child, url: 'https://accounts.google.com/' })).ok, false);
  const identified = await app.send(identify, child);
  assert.equal(identified.ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:frameConfirm', nonce: requested.nonce, proof: 'guess' }, parent)).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:frameConfirm', nonce: requested.nonce, proof: identified.proof },
    { ...parent, documentId: 'other-parent' })).ok, false);
  app.replaceChild();
  assert.equal((await app.send({ type: 'odAnnotation:frameConfirm', nonce: requested.nonce, proof: identified.proof }, parent)).ok, false);
  const next = await app.send({ type: 'odAnnotation:frameRequest' }, parent);
  app.navigate('https://app.example.test/next');
  assert.equal((await app.send({ ...identify, nonce: next.nonce }, child)).ok, false);
});

test('project annotations fail closed without a redeemed grant', async () => {
  const app = worker();
  assert.equal((await app.send({ type: 'odAnnotation:status' })).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', target, note: 'Change color' })).ok, false);
  assert.equal(app.requests.length, 0);
});

test('pairing sends code only to loopback; stores token only in extension session storage', async () => {
  const app = worker({ paired: true });
  const response = await app.send({ type: 'odAnnotation:pair', code }, popupSender);
  assert.equal(response.ok, true);
  assert.deepEqual(app.requests.map((request) => new URL(request.url).pathname), ['/api/edge-annotations/redeem']);
  const request = JSON.parse(app.requests[0]!.init.body!);
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    code, tabId: 17, documentId: 'epoch-1', origin: 'https://app.example.test',
    url: 'https://app.example.test/dashboard',
  });
  assert.ok(!JSON.stringify(response).includes('worker-only-secret'));
  assert.equal((await app.send({ type: 'odAnnotation:status' })).ok, true);
  const status = app.requests.at(-1)!;
  assert.equal(new URL(status.url).pathname, '/api/edge-annotations/status');
  assert.equal(new URL(status.url).search, '');
  assert.equal(status.init.method, 'POST');
  assert.equal(status.init.headers?.authorization, 'Bearer worker-only-secret');
  assert.deepEqual(JSON.parse(status.init.body!), {
    projectId: 'project-1', grantId: 'grant-1', tabId: 17,
    documentId: 'epoch-1', url: 'https://app.example.test/dashboard',
  });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code: 'wrong' }, popupSender)).ok, false);
});

test('failed replacement pairing keeps the working tab connected', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:pair', code: 'other-id.invalid-secret' }, popupSender)).ok, false);
  const status = await app.send({ type: 'odAnnotation:status' }, popupSender);
  assert.equal(status.ok, true);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/revoke')).length, 0);
  assert.equal((app.session.annotationConnections as unknown[][]).length, 1);
});

test('navigation during replacement revokes the new server grant and drops the stale old grant', async () => {
  let releaseRedeem!: () => void;
  const redeemGate = new Promise<void>((resolve) => { releaseRedeem = resolve; });
  const app = worker({ paired: true, redeemGate });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const replacing = app.send({ type: 'odAnnotation:pair', code: 'other-id.valid-secret' }, popupSender);
  await new Promise<void>((resolve) => setImmediate(resolve));
  app.navigate('https://app.example.test/next');
  releaseRedeem();
  assert.equal((await replacing).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:status' }, popupSender)).ok, false);
  assert.equal((app.session.annotationConnections as unknown[][]).length, 0);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/revoke')).length, 2);
});

test('an extension popup with sender.tab checks the paired website tab, not itself', async () => {
  const app = worker({ paired: true });
  const popupTabSender = { ...popupSender, tab: { id: 99, url: popupSender.url } };
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupTabSender)).ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:status' }, popupTabSender)).ok, true);
});

test('pairing refuses website scripts even when a tab is active', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code })).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, {
    id: 'a'.repeat(32), url: 'https://app.example.test/page', tab: app.tab,
  })).ok, false);
  assert.equal(app.requests.length, 0);
});

test('savePin includes reviewed cropped PNG and bounded structural/style evidence', async () => {
  const app = worker({ paired: true, screenshot: true, tabUrl: 'https://app.example.test/dashboard?view=designer&access_token=secret#panel=hero&code=private' });
  const reviewedTarget = { ...target, url: 'https://app.example.test/dashboard?view=designer#panel=hero' };
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const captured = await app.send({ ...capture, target: reviewedTarget });
  assert.equal(captured.ok, true, String(captured.error));
  assert.equal(app.screenshotCount(), 1);
  assert.equal(app.hidden(), false);
  // The 50x60 element is under the 160x100 minimum: the crop is that frame
  // from the viewport corner (2x pixels) and a ring marks the element in it.
  assert.deepEqual(app.drawCalls[0]?.slice(1, 5), [0, 0, 320, 200]);
  assert.deepEqual(app.strokeCalls.at(-1), [4, 8, 112, 132]);
  const response = await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target: reviewedTarget, note: 'Change color' });
  assert.equal(response.ok, true);
  assert.deepEqual(app.requests.map((request) => new URL(request.url).pathname), [
    '/api/edge-annotations/redeem', '/api/edge-annotations/status', '/api/edge-annotations/status', '/api/edge-annotations/comment-upsert',
  ]);
  const submit = app.requests.find((request) => request.url.endsWith('/comment-upsert'))!;
  assert.equal(submit.init.headers?.authorization, 'Bearer worker-only-secret');
  const body = JSON.parse(submit.init.body!);
  assert.equal(body.url, 'https://app.example.test/dashboard?view=designer#panel=hero');
  assert.equal(body.grantId, 'grant-1');
  assert.equal(body.tabId, 17);
  assert.equal(body.documentId, 'epoch-1');
  assert.equal(body.eventId, 'event-1');
  assert.equal(body.projectId, undefined);
  assert.equal(body.title, undefined);
  assert.match(body.screenshotDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(body.target.ancestors, target.ancestors);
  assert.equal(body.target.style.color, target.style.color);
  assert.equal(body.target.text, 'Save');
  assert.equal(body.target.domOutline, 'button Save');
  assert.equal(JSON.stringify(body).includes('code=private'), false);
  assert.equal(JSON.stringify(body).includes('access_token'), false);
  assert.ok(!JSON.stringify(response).includes('worker-only-secret'));
});

test('optional long or credential-shaped text is bounded or omitted without blocking notes', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const sent = await app.send({ type: 'odAnnotation:savePin', eventId: 'optional-copy',
    target: { ...target, text: 'Use <Enter> to save\n' + 'A'.repeat(400),
      label: 'B'.repeat(200), domOutline: 'div\n token=private-value' },
    note: 'Improve spacing', omitScreenshot: true });
  assert.equal(sent.ok, true, String(sent.error));
  const body = JSON.parse(app.requests.find((request) => request.url.endsWith('/comment-upsert'))!.init.body!);
  assert.equal(body.target.text.length, 300);
  assert.ok(body.target.text.startsWith('Use Enter to save'));
  assert.equal(body.target.label.length, 160);
  assert.equal(body.target.domOutline, '');
  assert.equal(body.note, 'Improve spacing');
});

test('a submission validation error preserves pairing and the reviewed retry', async () => {
  const app = worker({ paired: true, screenshot: true, pinStatus: 400 });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  assert.equal((await app.send(capture)).ok, true);
  const message = { type: 'odAnnotation:savePin', eventId: capture.eventId, target, note: 'Improve spacing' };
  assert.equal((await app.send(message)).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:status' }, popupSender)).ok, true);
  assert.equal((await app.send(message)).ok, false);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/comment-upsert')).length, 2);
});

test('opt-in diagnostics export only bounded operational metadata to the popup', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:diagnostics', enabled: true })).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:diagnostics', enabled: true }, popupSender)).ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  await app.send({ type: 'odAnnotation:savePin', eventId: 'diag', target,
    note: 'private developer note', omitScreenshot: true });
  const response = await app.send({ type: 'odAnnotation:diagnostics' }, popupSender);
  assert.equal(response.ok, true);
  const serialized = JSON.stringify(response);
  for (const secret of [code, 'worker-only-secret', 'private developer note', target.url, target.text]) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.ok(serialized.includes('odAnnotation:savePin'));
  assert.ok(serialized.includes('server:comment-upsert'));
  assert.ok(serialized.includes('pin-9'));
  const submit = app.requests.find((request) => request.url.endsWith('/comment-upsert'))!;
  assert.ok(submit.init.headers?.['x-od-annotation-correlation']);
  assert.equal((await app.send({ type: 'odAnnotation:diagnostics', enabled: false }, popupSender)).report.events.length, 0);
});

test('optional ancestor metadata cannot block a reviewed annotation', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const sent = await app.send({ type: 'odAnnotation:savePin', eventId: 'optional-ancestors',
    target: { ...target, ancestors: [null, ...Array(10).fill({ tag: 'main', selector: 'main' })] },
    note: 'Improve spacing', omitScreenshot: true });
  assert.equal(sent.ok, true, String(sent.error));
  const submit = app.requests.find((request) => request.url.endsWith('/comment-upsert'))!;
  const body = JSON.parse(submit.init.body!);
  assert.equal(body.target.ancestors.length, 7);
  assert.equal(body.note, 'Improve spacing');
});

test('crop frames inside the page content box, leaving the scrollbar out', async () => {
  const app = worker({ paired: true, screenshot: true, content: { contentWidth: 185, contentHeight: 150 } });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const result = await app.send({ ...capture, rect: { x: 150, y: 7, width: 40, height: 60 } });
  assert.equal(result.ok, true, String(result.error));
  // The 160x100 frame ends at the 185px content edge, not the 200px viewport.
  assert.deepEqual(app.drawCalls[0]?.slice(1, 5), [50, 0, 320, 200]);
});

test('crop masks a selected field and a neighboring field before sending', async () => {
  const app = worker({ paired: true, screenshot: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const maskRects = [{ x: 15, y: 17, width: 10, height: 12 }, { x: 30, y: 40, width: 15, height: 15 }];
  const result = await app.send({ ...capture, maskRects });
  assert.equal(result.ok, true, String(result.error));
  // Masks map into the framed crop, which starts at the viewport corner (2x pixels).
  assert.deepEqual(app.maskCalls, [[30, 34, 20, 24], [60, 80, 30, 30]]);
  const submitted = await app.send({ type: 'odAnnotation:savePin', eventId: capture.eventId,
    target, note: 'Improve the field design' });
  assert.equal(submitted.ok, true, String(submitted.error));
});

test('crop discards pixels if a field moves after capture paint', async () => {
  const app = worker({ paired: true, screenshot: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  app.setPostCaptureSafety((message) => {
    assert.deepEqual(JSON.parse(JSON.stringify(message.annotation)), {
      url: target.url, selector: target.selector, rect: capture.rect, maskRects: [],
      viewportWidth: capture.viewportWidth, viewportHeight: capture.viewportHeight,
      scrollX: capture.scrollX, scrollY: capture.scrollY,
    });
    return { ok: false };
  });
  const result = await app.send(capture);
  assert.equal(result.ok, false);
  assert.equal(app.screenshotCount(), 1);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: capture.eventId,
    target, note: 'Change', omitScreenshot: true })).ok, true);
});

test('crop blocks pixels if the page becomes unsafe during capture paint', async () => {
  const app = worker({ paired: true, screenshot: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  app.setCaptureSafety((message) => {
    assert.deepEqual(JSON.parse(JSON.stringify(message.annotation)), {
      url: target.url, selector: target.selector, rect: capture.rect, maskRects: [],
    });
    return { ok: false };
  });
  const result = await app.send(capture);
  assert.equal(result.ok, false);
  assert.equal(app.screenshotCount(), 0);
  assert.equal(app.hidden(), false);
});

test('worker accepts design labels containing password and token words without assigned secrets', async () => {
  const app = worker({ paired: true, screenshot: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const designTarget = { ...target, text: 'Password: increase contrast', domOutline: 'button Password: increase contrast' };
  assert.equal((await app.send({ ...capture, target: designTarget })).ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: capture.eventId,
    target: designTarget, note: 'Make the sign-in field clearer' })).ok, true);
});

test('nested element outline reaches the crop and post without accepting unsafe controls', async () => {
  const app = worker({ paired: true, screenshot: true });
  const nestedTarget = { ...target, label: 'div', text: '', htmlHint: 'div',
    domOutline: 'div\n  h1 Marketplaces\n  p Discover UI kits' };
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const captured = await app.send({ ...capture, target: nestedTarget });
  assert.equal(captured.ok, true, String(captured.error));
  assert.equal(app.screenshotCount(), 1);
  const sent = await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1',
    target: nestedTarget, note: 'Make the heading clearer' });
  assert.equal(sent.ok, true, String(sent.error));
  assert.equal(JSON.parse(app.requests.at(-1)!.init.body!).target.domOutline, nestedTarget.domOutline);
  for (const domOutline of ['div\r  h1 Title', 'div\t h1 Title', 'div\u0000 h1 Title',
    'div\n  input token=private', 'div\n  <input>']) {
    const result = await app.send({ type: 'odAnnotation:savePin', eventId: `safe-${app.requests.length}`,
      target: { ...nestedTarget, domOutline }, note: 'Improve layout', omitScreenshot: true });
    assert.equal(result.ok, true, String(result.error));
    const evidence = JSON.parse(app.requests.at(-1)!.init.body!).target.domOutline;
    assert.doesNotMatch(evidence, /[<>\r\t\u0000]/);
    assert.ok(!evidence.includes('token=private'));
  }
  assert.equal(app.screenshotCount(), 1);
});

test('reviewed URL can omit query and fragment but cannot silently change the page', async () => {
  const app = worker({ paired: true, screenshot: true, tabUrl: 'https://app.example.test/dashboard?view=designer#panel=hero' });
  const reviewedTarget = { ...target, url: 'https://app.example.test/dashboard?view=designer#panel=hero' };
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  assert.equal((await app.send({ ...capture, target: reviewedTarget })).ok, true);
  const response = await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target: reviewedTarget,
    note: 'Change color', omitUrlDetails: true });
  assert.equal(response.ok, true);
  const body = JSON.parse(app.requests.at(-1)!.init.body!);
  assert.equal(body.url, 'https://app.example.test/dashboard');
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1',
    target: { ...reviewedTarget, text: 'Another selection' }, note: 'Changed' })).ok, false);
});

test('failed screenshot can be explicitly omitted from a chat post', async () => {
  const blocked = worker({ paired: true });
  assert.equal((await blocked.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  assert.equal((await blocked.send(capture)).ok, false);
  assert.equal((await blocked.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target, note: 'Change' })).ok, false);
  assert.equal(blocked.requests.filter((request) => request.url.endsWith('/comment-upsert')).length, 0);
  assert.equal(blocked.hidden(), false);
  assert.equal((await blocked.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target,
    note: 'Change', omitScreenshot: true })).ok, true);
  const posted = JSON.parse(blocked.requests.at(-1)!.init.body!);
  assert.equal(posted.note, 'Change');
  assert.equal(posted.screenshotDataUrl, undefined);

  const large = worker({ paired: true, screenshot: true, oversized: true });
  assert.equal((await large.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  assert.equal((await large.send(capture)).ok, false);
  assert.equal(large.hidden(), false);
});

test('discard during screenshot prevents late crop from being submitted', async () => {
  let releaseCapture!: () => void;
  const gate = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const app = worker({ paired: true, screenshot: true, captureGate: gate });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const pending = app.send(capture);
  for (let attempt = 0; attempt < 30 && app.screenshotCount() === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(app.screenshotCount(), 1);
  assert.equal((await app.send({ type: 'odAnnotation:discard', eventId: 'event-1' })).ok, true);
  releaseCapture();
  assert.equal((await pending).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target,
    note: 'Change' })).ok, false);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/comment-upsert')).length, 0);
  assert.equal(app.hidden(), false);
});

test('identity-provider pages and credential-bearing paths refuse project pairing', async () => {
  for (const url of [
    'https://accounts.google.com/',
    'https://app.example.test/oauth/callback?code=private',
    'https://app.example.test/%6fauth/callback',
    'https://app.example.test/%2563allback',
    'https://app.example.test/dashboard?%2561ccess_token=private',
    'https://app.example.test/dashboard#%2563ode=private',
    'https://app.example.test/path/eyJabcdefgh.eyJabcdefgh.signature',
  ]) {
    const app = worker({ paired: true, tabUrl: url });
    assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, false, url);
    assert.equal(app.requests.length, 0, url);
  }
});

test('pairs a sign-in form on an ordinary app origin without admitting identity-provider pages', async () => {
  const app = worker({ paired: true, tabUrl: 'https://app.example.test/signin?view=form' });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const signInField = { ...target, url: app.tab.url, selector: 'main > input',
    label: 'input', text: '', domOutline: 'input', htmlHint: 'input' };
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1',
    target: signInField, note: 'Improve the sign-in field', omitScreenshot: true })).ok, true);
  const submission = app.requests.find((request) => request.url.endsWith('/comment-upsert'))!;
  assert.equal(JSON.parse(submission.init.body!).target.htmlHint, 'input');
});

test('navigation revokes in-memory tab capability; blocks auth pages and untrusted targets', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  app.navigate('https://other.test/');
  assert.equal((await app.send({ type: 'odAnnotation:savePin', target, note: 'Change color' })).ok, false);
  assert.deepEqual(app.requests.map((request) => new URL(request.url).pathname), [
    '/api/edge-annotations/redeem',
  ]);
  const auth = worker({ paired: true, tabUrl: 'https://login.microsoftonline.com/' });
  assert.equal((await auth.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, false);
  assert.equal(auth.requests.length, 0);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', target: { ...target, url: 'https://other.test/' }, note: 'x' })).ok, false);
});

test('paired tab inspection polls with bearer and returns bounded read from the exact document', async () => {
  const app = worker({ paired: true, inspectQueue: [{ requestId: 'read-1', operation: 'snapshot' }] });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  for (let attempt = 0; attempt < 30 && !app.requests.some((req) => req.url.endsWith('/inspect/result')); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = app.requests.find((req) => req.url.endsWith('/inspect/result'))!;
  assert.ok(result);
  assert.equal(result.init.headers?.authorization, 'Bearer worker-only-secret');
  assert.deepEqual(JSON.parse(result.init.body!), {
    projectId: 'project-1', grantId: 'grant-1', tabId: 17,
    documentId: 'epoch-1', url: app.tab.url, requestId: 'read-1', ok: true,
    result: { html: '<main>Read</main>', title: 'App', url: app.tab.url },
  });
  assert.equal(app.inspectMessages.find(({ message }) => message.type === 'odInspect:read')?.options?.documentId,
    'chrome-document-1');
  assert.ok(!JSON.stringify(app.inspectMessages).includes('worker-only-secret'));
  app.navigate('https://other.test/');
});

test('worker wake does not restore inspection consent after navigation during session hydration', async () => {
  let release!: () => void;
  const sessionGate = new Promise<void>((resolve) => { release = resolve; });
  const session = { annotationConnections: [[17, {
    grantId: 'grant-1', projectId: 'project-1', conversationId: 'c1', tabId: 17,
    documentId: 'old-epoch', origin: 'https://app.example.test',
    url: 'https://app.example.test/dashboard', expiresAt: Date.now() + 10_000,
    token: 'worker-only-secret',
  }]] };
  const app = worker({ paired: true, session, sessionGate,
    inspectQueue: [{ requestId: 'read-after-reload', operation: 'snapshot' }] });
  app.navigate(app.tab.url);
  release();
  await app.send({ type: 'odAnnotation:status' });
  for (let attempt = 0; attempt < 5; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.filter((request) => request.url.endsWith('/inspect/poll')).length, 0);
  assert.equal(app.requests.filter((request) => request.url.endsWith('/inspect/result')).length, 0);
  const status = app.requests.find((request) => request.url.endsWith('/status'));
  if (status) assert.notEqual(JSON.parse(status.init.body!).documentId, 'old-epoch');
});

test('navigation during an async DOM read discards the previous document result', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = worker({ paired: true, inspectQueue: [{ requestId: 'read-1', operation: 'inspect', selector: 'main' }] });
  app.setInspectionRead(async () => {
    await gate;
    return { ok: true, result: { html: '<main>Old document</main>', url: 'https://app.example.test/dashboard' } };
  });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  for (let attempt = 0; attempt < 30 && !app.inspectMessages.some(({ message }) => message.type === 'odInspect:read'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(app.inspectMessages.some(({ message }) => message.type === 'odInspect:read'));
  app.navigate('https://app.example.test/other');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.filter((req) => req.url.endsWith('/inspect/result')).length, 0);
});

test('inspection screenshot discards pixels if a field moves during capture', async () => {
  let release!: () => void;
  const app = worker({ paired: true, screenshot: true,
    captureGate: new Promise<void>((resolve) => { release = resolve; }),
    inspectQueue: [{ requestId: 'shot-moved', operation: 'screenshot' }] });
  app.setInspectionSafety(() => ({ ok: true,
    maskRects: app.screenshotReadyCount() === 1
      ? [{ x: 10, y: 20, width: 50, height: 30 }]
      : [{ x: 15, y: 20, width: 50, height: 30 }],
    viewportWidth: 200, viewportHeight: 150 }));
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  for (let attempt = 0; attempt < 30 && app.screenshotCount() === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(app.screenshotCount(), 1);
  release();
  for (let attempt = 0; attempt < 30 && !app.requests.some((req) => req.url.endsWith('/inspect/result')); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = JSON.parse(app.requests.find((req) => req.url.endsWith('/inspect/result'))!.init.body!);
  assert.equal(result.ok, false);
  assert.equal(result.result, undefined);
  assert.equal(app.screenshotReadyCount(), 2);
  app.navigate('https://other.test/');
});

test('screenshot drops pixels when focus changes during capture', async () => {
  let release!: () => void;
  const app = worker({ paired: true, screenshot: true,
    captureGate: new Promise<void>((resolve) => { release = resolve; }),
    inspectQueue: [{ requestId: 'shot-1', operation: 'screenshot' }] });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  for (let attempt = 0; attempt < 30 && app.screenshotCount() === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(app.screenshotCount(), 1);
  app.focus(false);
  release();
  for (let attempt = 0; attempt < 30 && !app.requests.some((req) => req.url.endsWith('/inspect/result')); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = JSON.parse(app.requests.find((req) => req.url.endsWith('/inspect/result'))!.init.body!);
  assert.equal(result.ok, false);
  assert.equal(result.result, undefined);
  assert.equal(app.hidden(), false);
  app.navigate('https://other.test/');
});

 test('one connection URL configures the daemon and survives worker wake and same-origin navigation', async () => {
  const app = worker({ paired: true });
  assert.equal((await app.send({ type: 'odAnnotation:pair', code: `http://127.0.0.1:53318/#od-annotation=${code}` }, popupSender)).ok, true);
  assert.equal(app.local.daemonUrl, 'http://127.0.0.1:53318');
  assert.equal(new URL(app.requests[0]!.url).hash, '');
  assert.ok(!JSON.stringify(app.local).includes('secret'));
  const restored = worker({ paired: true, session: app.session });
  assert.equal((await restored.send({ type: 'odAnnotation:status' })).ok, true);
  restored.navigate('https://app.example.test/next');
  assert.equal((await restored.send({ type: 'odAnnotation:status' })).ok, true);
  assert.equal((await restored.send({ type: 'odAnnotation:savePin', eventId: 'after-navigation',
    target: { ...target, url: restored.tab.url }, note: 'Next page', omitScreenshot: true })).ok, true);
 });

const bodyOf = (app: ReturnType<typeof worker>, suffix: string) =>
  JSON.parse(app.requests.filter((request) => request.url.endsWith(suffix)).at(-1)!.init.body!);

test('pins, savePin and deletePin carry only the grant proof plus their own fields', async () => {
  const app = worker({ paired: true, screenshot: true });
  await prepare(app);
  const listed = await app.send({ type: 'odAnnotation:pins' });
  assert.equal(listed.ok, true, String(listed.error));
  assert.deepEqual(listed.comments, [{ id: 'pin-1', pinSeq: 1, selector: target.selector, elementId: target.selector }]);
  assert.deepEqual(bodyOf(app, '/comment-list'), { grantId: 'grant-1', tabId: 17, documentId: 'epoch-1', url: target.url });
  assert.equal(app.requests.find((request) => request.url.endsWith('/comment-list'))!.init.headers?.authorization, 'Bearer worker-only-secret');
  const saved = await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target, note: 'First', omitScreenshot: false });
  assert.equal(saved.ok, true, String(saved.error));
  assert.equal(saved.comment.pinSeq, 2);
  const created = bodyOf(app, '/comment-upsert');
  assert.deepEqual(Object.keys(created).sort(), ['documentId', 'eventId', 'grantId', 'note', 'screenshotDataUrl', 'tabId', 'target', 'url']);
  assert.equal(created.target.elementId, target.selector);
  // Editing sends the id and, without a fresh crop, no screenshot; the daemon keeps the stored one.
  const edited = await app.send({ type: 'odAnnotation:savePin', eventId: 'event-2', id: 'pin-1', target, note: 'Edited', omitScreenshot: true });
  assert.equal(edited.ok, true, String(edited.error));
  assert.equal(edited.comment.id, 'pin-1');
  const edit = bodyOf(app, '/comment-upsert');
  assert.equal(edit.id, 'pin-1');
  assert.equal(edit.screenshotDataUrl, undefined);
  const removed = await app.send({ type: 'odAnnotation:deletePin', id: 'pin-1' });
  assert.deepEqual([removed.ok, removed.deleted], [true, true]);
  assert.deepEqual(bodyOf(app, '/comment-delete'), { grantId: 'grant-1', tabId: 17, documentId: 'epoch-1', url: target.url, id: 'pin-1' });
});

// Review finding: the upsert body dropped `eventId`, so a Save retried after a
// lost response created a second numbered row. The daemon replays
// (grantId, eventId) → the existing row; the worker only has to forward it.
test('the upsert body carries the popover eventId on create, on edit and on a retry of the same submit', async () => {
  const app = worker({ paired: true, screenshot: true });
  await prepare(app);
  const upserts = () => app.requests.filter((request) => request.url.endsWith('/comment-upsert'))
    .map((request) => JSON.parse(request.init.body!) as { eventId?: unknown; id?: unknown });
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target, note: 'First', omitScreenshot: false })).ok, true);
  // The same popover submit again (the first answer was lost): same eventId.
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'event-1', target, note: 'First', omitScreenshot: true })).ok, true);
  assert.equal((await app.send({ type: 'odAnnotation:savePin', eventId: 'edit-7', id: 'pin-1', target, note: 'Edited', omitScreenshot: true })).ok, true);
  assert.deepEqual(upserts().map(({ eventId, id }) => [eventId, id]), [['event-1', undefined], ['event-1', undefined], ['edit-7', 'pin-1']]);
});

test('a refused pin proof drops the grant so later lists stay local', async () => {
  const app = worker({ paired: true, screenshot: true, pinStatus: 403 });
  await prepare(app);
  const listed = await app.send({ type: 'odAnnotation:pins' });
  assert.deepEqual([listed.ok, listed.status], [false, 403]);
  assert.equal((app.session.annotationConnections as unknown[]).length, 0);
  const before = app.requests.length;
  assert.equal((await app.send({ type: 'odAnnotation:pins' })).error, 'not paired');
  assert.equal(app.requests.length, before, 'an unpaired tab lists without a request');
});

// Review finding: the daemon's origin guard answers 403 with a bare string
// error; only the broker's structured refusal means the grant is dead.
test('a bare 403 without the broker error code keeps the grant and reports the failure', async () => {
  const app = worker({ paired: true, screenshot: true, pinStatus: 403, pinRefusal: { error: 'Cross-origin requests are not allowed' } });
  await prepare(app);
  const listed = await app.send({ type: 'odAnnotation:pins' });
  assert.deepEqual([listed.ok, listed.status, listed.error], [false, 403, 'Cross-origin requests are not allowed']);
  assert.equal((app.session.annotationConnections as unknown[]).length, 1, 'grant kept');
  const lists = () => app.requests.filter((request) => /comment-list$/.test(request.url)).length;
  const before = lists();
  assert.equal((await app.send({ type: 'odAnnotation:pins' })).status, 403);
  assert.equal(lists(), before + 1, 'a still-paired tab asks the daemon again');
});

test('pin messages from a child frame or an unpaired tab never reach the daemon', async () => {
  const app = worker({ paired: true, screenshot: true });
  await prepare(app);
  const child = { id: 'a'.repeat(32), tab: app.tab, frameId: 2, documentId: 'child-document-1', url: 'https://child.example.test/frame' };
  assert.equal((await app.send({ type: 'odAnnotation:pins' }, child)).ok, false);
  assert.equal((await app.send({ type: 'odAnnotation:deletePin', id: 'pin-1' }, child)).ok, false);
  const unpaired = worker({ paired: false });
  assert.equal((await unpaired.send({ type: 'odAnnotation:pins' })).error, 'not paired');
  assert.equal(app.requests.filter((request) => /comment-/.test(request.url)).length, 0);
  assert.equal(unpaired.requests.length, 0);
});

test('a successful pairing tells the page to list its pins without waiting for a reload', async () => {
  const app = worker({ paired: true });
  assert.equal(app.inspectMessages.some((entry) => entry.message.type === 'odClipper:pinsChanged'), false);
  assert.equal((await app.send({ type: 'odAnnotation:pair', code }, popupSender)).ok, true);
  const pushed = app.inspectMessages.find((entry) => entry.message.type === 'odClipper:pinsChanged');
  assert.ok(pushed, 'worker pushes odClipper:pinsChanged to the paired tab');
  const refused = worker({ paired: true });
  assert.equal((await refused.send({ type: 'odAnnotation:pair', code: 'other-id.invalid-secret' }, popupSender)).ok, false);
  assert.equal(refused.inspectMessages.some((entry) => entry.message.type === 'odClipper:pinsChanged'), false);
});

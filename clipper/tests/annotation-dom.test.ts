import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The extension is not a workspace package; borrow the web test harness's DOM dependency.
const requireFromWeb = createRequire(join(import.meta.dirname, '../../apps/web/package.json'));
const { JSDOM } = requireFromWeb('jsdom') as typeof import('jsdom');
const source = readFileSync(join(import.meta.dirname, '../content.js'), 'utf8');
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';

type Sent = { type: string; target?: { url: string; text: string; domOutline: string; selector: string;
  scope: { selectorRoot: string; shadowHosts: string[] } }; eventId?: string; note?: string;
  omitUrlDetails?: boolean; omitScreenshot?: boolean };

test('open-shadow internals retain root-local selectors and suppress sensitive host text', async () => {
  const app = page('<div id="save" data-sensitive></div>');
  try {
    const host = app.document.getElementById('save')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="internal">private host copy</button>';
    const button = root.querySelector('button')!;
    button.getBoundingClientRect = () => host.getBoundingClientRect();
    root.elementFromPoint = () => button;
    root.elementsFromPoint = () => [app.document.getElementById('od-clipper-picker')!, button];
    const review = await app.start();
    assert.ok(review);
    const sent = app.messages.find(message => message.type === 'odAnnotation:review')!;
    assert.ok(sent);
    assert.equal(sent.target?.selector, 'button');
    assert.equal(sent.target?.text, '');
    assert.equal(sent.target?.scope.selectorRoot, 'open-shadow');
    assert.deepEqual(Array.from(sent.target!.scope.shadowHosts), ['body > div']);
    assert.equal(app.messages.some(message => message.type === 'odAnnotation:capture'), false);
    assert.match(review.querySelector('.capture-status')!.textContent!, /not supported|annotationScopedScreenshot/);
    const color = review.querySelector('[data-style="color"]') as HTMLInputElement;
    color.value = '#112233'; color.dispatchEvent(new app.window.Event('change'));
    (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Improve button';
    (review.querySelector('[data-act="send"]') as HTMLElement).click();
    await app.waitFor(() => app.messages.some(message => message.type === 'odAnnotation:submit'));
    const reviews = app.messages.filter(message => message.type === 'odAnnotation:review');
    assert.equal(reviews.length, 2);
    assert.deepEqual(app.messages.find(message => message.type === 'odAnnotation:submit')!.target, reviews[1].target);
    assert.equal(app.messages.find(message => message.type === 'odAnnotation:submit')!.omitScreenshot, true);
  } finally { app.window.close(); }
});

test('editable controls remain annotatable while their entered contents are omitted', async () => {
  const fixture = page('<div id="save" contenteditable="true">private-entered-copy</div>');
  const review = await fixture.start();
  assert.ok(review);
  const capture = fixture.messages.find(message => message.type === 'odAnnotation:capture');
  assert.ok(capture);
  assert.ok(!JSON.stringify(capture).includes('private-entered-copy'));
  (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Improve editor design';
  review.querySelector('textarea')!.dispatchEvent(new fixture.window.Event('input', { bubbles: true }));
  (review.querySelector('[data-act="send"]') as HTMLElement).click();
  await fixture.waitFor(() => fixture.messages.some(message => message.type === 'odAnnotation:submit'));
});

function page(html: string, options: { captureError?: string; nearbyField?: boolean; submitError?: string; recaptureGate?: Promise<void> } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Example</title></head><body>${html}</body></html>`, {
    url: 'https://app.example.test/page?view=designer&access_token=private#panel=hero&code=secret',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (options.submitError) {
    window.eval(readFileSync(join(import.meta.dirname, '../i18n.js'), 'utf8'));
  }
  const { document } = window;
  const messages: Sent[] = [];
  let listener: ((message: Record<string, unknown>, sender: unknown, respond: (result: unknown) => void) => void) | undefined;
  const shadowRoots = new Map<string, ShadowRoot>();
  const attachShadow = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    if (this.id) shadowRoots.set(this.id, root);
    return root;
  };
  const rect = { x: 40, y: 40, left: 40, top: 40, right: 130, bottom: 70, width: 90, height: 30 };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'save') return rect;
    if (options.nearbyField && this.id === 'nearby') {
      return { x: 145, y: 42, left: 145, top: 42, right: 205, bottom: 72, width: 60, height: 30 };
    }
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  document.elementsFromPoint = () => [document.getElementById('save')!] as Element[];
  window.requestAnimationFrame = (callback) => { queueMicrotask(() => callback(0)); return 1; };
  Object.defineProperty(window, 'innerWidth', { value: 800 });
  Object.defineProperty(window, 'innerHeight', { value: 600 });
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
      sendMessage: async (message: Sent) => {
        messages.push(message);
        if (message.type === 'odAnnotation:status') return { ok: true };
        if (message.type === 'odAnnotation:capture') {
          if (messages.filter(item => item.type === 'odAnnotation:capture').length > 1) await options.recaptureGate;
          return options.captureError ? { ok: false, error: options.captureError } : { ok: true, cropDataUrl: screenshot };
        }
        if (message.type === 'odAnnotation:submit') return options.submitError
          ? { ok: false, error: options.submitError } : { ok: true, messageId: 'message-1' };
        return { ok: true };
      },
    },
  };
  Object.assign(window, { chrome, ...(!options.submitError ? {
    OD_CLIPPER_I18N: { currentLocale: () => 'en', t: (key: string) => key },
  } : {}) });
  Object.assign(window, { CSS: { supports: (property: string, value: string) => {
    const style = document.createElement('div').style;
    style.setProperty(property, value);
    return style.getPropertyValue(property) !== '';
  } } });
  window.crypto.randomUUID = () => 'event-1';
  window.eval(source);
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), `content script did not reach the expected review state: ${JSON.stringify(messages.map(({ type }) => type))}`);
  };
  const start = async () => {
    const toolbar = shadowRoots.get('od-clipper-root')!;
    (toolbar.querySelector('[data-act="annotate"]') as HTMLElement).click();
    await waitFor(() => Boolean(shadowRoots.get('od-clipper-picker')));
    (shadowRoots.get('od-clipper-picker')!.querySelector('.surface') as HTMLElement).click();
    await waitFor(() => Boolean(shadowRoots.get('od-clipper-annotation')));
    return shadowRoots.get('od-clipper-annotation')!;
  };
  const inspect = (message: Record<string, unknown>) => {
    let response: unknown;
    listener?.(message, {}, (result) => { response = result; });
    return response as { ok: boolean; result?: { html: string; truncated: boolean; url: string }; error?: string };
  };
  const message = (value: Record<string, unknown>) => new Promise<{ ok: boolean }>((resolve) => {
    listener?.(value, {}, (result) => resolve(result as { ok: boolean }));
  });
  return { window, document, messages, start, waitFor, inspect, message };
}

test('inspection screenshot is available with visible fields whose pixels are masked', () => {
  const app = page('<main><div id="host"></div></main>', { nearbyField: true });
  try {
    const root = app.document.getElementById('host')!.attachShadow({ mode: 'open' });
    const password = app.document.createElement('input');
    password.type = 'password';
    password.id = 'nearby';
    root.append(password);
    const url = app.window.location.href;
    const ready = app.inspect({ type: 'odInspect:screenshotReady', url });
    assert.equal(ready.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(ready.maskRects)), [{ x: 145, y: 42, width: 60, height: 30, textHidden: true }]);
  } finally { app.window.close(); }
});

test('on-demand DOM inspection omits sensitive fields and never runs page code', () => {
  const app = page(`<main id="public" onclick="steal()"><h1>Visible text</h1><input value="private">
    <span data-sensitive>private data</span><div contenteditable="true">private edit</div>
    <script>globalThis.__executed = true</script><p hidden>private hidden</p>
    <span>token=private</span><p>Public detail</p><form id="sign-in"><label>Email<input name="username" value="person@example.test"></label><button type="submit">Sign in</button></form></main>`);
  try {
    const safeUrl = 'https://app.example.test/page?view=designer#panel=hero';
    app.window.history.replaceState(null, '', safeUrl);
    const result = app.inspect({ type: 'odInspect:read', operation: 'inspect', selector: '#public',
      url: safeUrl });
    assert.equal(result.ok, true);
    assert.match(result.result!.html, /Visible text/);
    assert.match(result.result!.html, /Public detail/);
    assert.doesNotMatch(result.result!.html, /private|onclick|__executed|value=|contenteditable|script>/);
    assert.equal((app.window as unknown as { __executed?: boolean }).__executed, undefined);
    const field = app.inspect({ type: 'odInspect:read', operation: 'inspect', selector: 'input',
      url: app.window.location.href });
    assert.equal(field.ok, true);
    assert.match(field.result!.html, /<input/);
    assert.doesNotMatch(field.result!.html, /private|value=/);
    assert.match(result.result!.html, /<input/);
    assert.match(result.result!.html, /<form[^>]*>/);
    assert.match(result.result!.html, /<button[^>]*>Sign in<\/button>/);
    assert.doesNotMatch(result.result!.html, /person@example|username|type="submit"/);
    assert.equal(app.inspect({ type: 'odInspect:read', operation: 'snapshot', url: 'https://other.test/' }).ok, false);
  } finally { app.window.close(); }
});

test('reviewed DOM evidence contains safe nested text but not hidden, form, editable, or iframe content', async () => {
  const app = page(`<button id="save">Save <span>changes</span>
    <span hidden>private hidden</span><span style="display:none">private CSS</span>
    <span contenteditable="true">private draft</span><span data-sensitive>private attribute</span>
    <input value="private field"><iframe src="about:blank"></iframe>
  </button>`);
  try {
    const review = await app.start();
    const captured = app.messages.find((message) => message.type === 'odAnnotation:capture')!;
    assert.equal(captured.target?.text, 'Save');
    assert.equal(captured.target?.domOutline, 'button Save\n  span changes');
    assert.equal(captured.target?.url, 'https://app.example.test/page?view=designer#panel=hero');
    assert.equal(review.querySelector('.review-url'), null);
    assert.equal(review.querySelector('.review-text'), null);
    assert.equal(review.querySelector('.review-outline'), null);
    assert.equal((review.querySelector('.preview') as HTMLImageElement).src, screenshot);
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Make this clearer';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.some((message) => message.type === 'odAnnotation:submit'));
    const posted = app.messages.find((message) => message.type === 'odAnnotation:submit')!;
    assert.deepEqual(posted.target, captured.target);
    assert.equal(posted.note, 'Make this clearer');
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:submit').length, 1);
  } finally { app.window.close(); }
});

test('empty sign-in inputs show a masked crop without copying field attributes or values', async () => {
  const app = page('<main><input id="save" type="password" name="password" autocomplete="current-password" placeholder="Password"></main>');
  try {
    app.window.history.replaceState(null, '', '/signin?view=form');
    const review = await app.start();
    const captured = app.messages.find((message) => message.type === 'odAnnotation:capture');
    assert.ok(captured);
    assert.equal((review.querySelector('.preview') as HTMLImageElement).src, screenshot);
    assert.ok(review.querySelector('textarea'));
    assert.equal(review.querySelector('.capture-status')!.textContent, '');
    assert.equal(app.window.location.pathname, '/signin');
    (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Improve the password field styling';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.some((message) => message.type === 'odAnnotation:submit'));
    const sent = app.messages.find((message) => message.type === 'odAnnotation:submit')!;
    assert.equal(sent.note, 'Improve the password field styling');
    assert.equal(sent.target?.url, 'https://app.example.test/signin?view=form');
    assert.equal(sent.target?.domOutline, 'input');
    assert.equal(sent.target?.text, '');
    assert.equal(sent.omitScreenshot, false);
    assert.doesNotMatch(JSON.stringify(sent.target), /"name"|autocomplete|placeholder|value|current-password/);
  } finally { app.window.close(); }
});

test('filled sign-in inputs stage design feedback without capturing typed pixels or field values', async () => {
  const app = page('<main><input id="save" type="email" value="person@example.test" autocomplete="username"></main>');
  try {
    const review = await app.start();
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
    assert.equal((review.querySelector('.preview') as HTMLImageElement).src, screenshot);
    (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Increase the text box contrast';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.some((message) => message.type === 'odAnnotation:submit'));
    const sent = app.messages.find((message) => message.type === 'odAnnotation:submit')!;
    assert.equal(sent.omitScreenshot, false);
    assert.equal(sent.target?.domOutline, 'input');
    assert.equal(sent.target?.text, '');
    assert.doesNotMatch(JSON.stringify(sent.target), /person@example|autocomplete|username|value/);
  } finally { app.window.close(); }
});

test('textareas and selects remain selectable without serializing their contents', async () => {
  for (const html of [
    '<textarea id="save">Private draft text</textarea>',
    '<select id="save"><option value="private" selected>Private choice</option></select>',
  ]) {
    const app = page(`<main>${html}</main>`);
    try {
      const review = await app.start();
      assert.ok(review.querySelector('textarea'));
      assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
      (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Improve this control';
      (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
      await app.waitFor(() => app.messages.some((message) => message.type === 'odAnnotation:submit'));
      const sent = app.messages.find((message) => message.type === 'odAnnotation:submit')!;
      assert.equal(sent.target?.text, '');
      assert.doesNotMatch(JSON.stringify(sent.target), /Private draft text|Private choice|private/);
    } finally { app.window.close(); }
  }
});

test('extension review shows screenshot and note without technical text', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    app.window.eval(readFileSync(join(import.meta.dirname, '../i18n.js'), 'utf8'));
    const review = await app.start();
    assert.deepEqual(Array.from(review.querySelectorAll('button'), (button) => button.getAttribute('data-act')), ['styles', 'send', 'close', 'cancel']);
    assert.equal((review.querySelector('.details') as HTMLElement).hidden, true);
    assert.equal(review.querySelector('[data-act="styles"]')!.getAttribute('aria-expanded'), 'false');
    assert.equal((review.querySelector('.preview') as HTMLImageElement).src, screenshot);
    assert.ok(review.querySelector('textarea'));
    assert.equal(review.querySelector('.review-url'), null);
    assert.equal(review.querySelector('.review-outline'), null);
    assert.doesNotMatch(review.textContent || '', /computed styles|selector|nested element outline|browser page/i);
    const i18n = (app.window as unknown as { OD_CLIPPER_I18N: { t: (key: string) => string } }).OD_CLIPPER_I18N;
    assert.equal(i18n.t('annotationSend'), 'Send to chat');
  } finally { app.window.close(); }
});

test('compact switches preserve the comment and expose styles without exposing the shadow root', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    const review = await app.start();
    const note = review.querySelector('textarea')!;
    note.value = 'Keep this draft';
    const switches = review.querySelector('[data-act="styles"]') as HTMLButtonElement;
    switches.click();
    assert.equal(switches.getAttribute('aria-expanded'), 'true');
    assert.equal((review.querySelector('.details') as HTMLElement).hidden, false);
    assert.ok(review.querySelector('[data-style="fontSize"]'));
    switches.click();
    assert.equal(note.value, 'Keep this draft');
    assert.equal(app.document.getElementById('od-clipper-annotation')!.shadowRoot, null);
    note.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(app.document.getElementById('od-clipper-annotation'), null);
  } finally { app.window.close(); }
});

test('style-only feedback recaptures the updated target and restores temporary preview after staging', async () => {
  const app = page('<button id="save" style="font-size:16px!important">Save</button>');
  try {
    const review = await app.start();
    const input = review.querySelector('[data-style="fontSize"]') as HTMLInputElement;
    input.value = '24px'; input.dispatchEvent(new app.window.Event('change'));
    assert.equal(app.window.getComputedStyle(app.document.getElementById('save')!).fontSize, '24px');
    assert.equal((review.querySelector('.preview') as HTMLImageElement).hidden, true);
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.some(message => message.type === 'odAnnotation:submit'));
    const captures = app.messages.filter(message => message.type === 'odAnnotation:capture');
    assert.equal(captures.length, 2);
    const sent = app.messages.find(message => message.type === 'odAnnotation:submit')!;
    assert.deepEqual(sent.target, captures[1].target);
    assert.match(sent.note!, /fontSize: 24px/);
    assert.equal(sent.omitScreenshot, false);
    await app.waitFor(() => !app.document.getElementById('od-clipper-annotation'));
    const element = app.document.getElementById('save')!;
    assert.equal(element.style.fontSize, '16px');
    assert.equal(element.style.getPropertyPriority('font-size'), 'important');
  } finally { app.window.close(); }
});

test('cancel restores preview styles and text while preserving concurrent page style changes', async () => {
  const app = page('<button id="save" style="font-size:16px">Save</button>');
  try {
    const review = await app.start();
    const edit = (key: string, value: string) => {
      const input = review.querySelector(`[data-style="${key}"]`) as HTMLInputElement;
      input.value = value; input.dispatchEvent(new app.window.Event('change'));
    };
    edit('fontSize', '24px'); edit('text', 'Save changes');
    const element = app.document.getElementById('save')!;
    element.style.fontSize = '30px';
    (review.querySelector('[data-act="cancel"]') as HTMLButtonElement).click();
    assert.equal(element.textContent, 'Save');
    assert.equal(element.style.fontSize, '30px');
    assert.equal(app.messages.some(message => message.type === 'odAnnotation:submit'), false);
  } finally { app.window.close(); }
});

test('unsafe CSS is rejected and corrected styles allow feedback without submitting stale screenshots', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    const review = await app.start();
    const input = review.querySelector('[data-style="backgroundColor"]') as HTMLInputElement;
    input.value = 'url(https://evil.test/image)'; input.dispatchEvent(new app.window.Event('change'));
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, true);
    assert.equal(app.document.getElementById('save')!.style.backgroundColor, '');
    input.value = '#ff0000'; input.dispatchEvent(new app.window.Event('change'));
    assert.equal(input.getAttribute('aria-invalid'), 'false');
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    app.document.getElementById('save')!.textContent = 'Changed by page';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    assert.equal(app.messages.some(message => message.type === 'odAnnotation:submit'), false);
  } finally { app.window.close(); }
});

test('cancel preserves a concurrent page write that changes only the preview CSS priority', async () => {
  const app = page('<button id="save" style="font-size:16px">Save</button>');
  try {
    const review = await app.start();
    const input = review.querySelector('[data-style="fontSize"]') as HTMLInputElement;
    input.value = '24px'; input.dispatchEvent(new app.window.Event('change'));
    const element = app.document.getElementById('save')!;
    assert.equal(element.style.getPropertyPriority('font-size'), 'important');
    element.style.setProperty('font-size', '24px', '');
    (review.querySelector('[data-act="cancel"]') as HTMLButtonElement).click();
    assert.equal(element.style.fontSize, '24px');
    assert.equal(element.style.getPropertyPriority('font-size'), '');
  } finally { app.window.close(); }
});

test('style menu for a password field never contains entered text', async () => {
  const app = page('<input id="save" type="password" value="private-entered-value">');
  try {
    const review = await app.start();
    assert.equal(review.querySelector('[data-style="text"]'), null);
    assert.doesNotMatch(review.textContent || '', /private-entered-value/);
    assert.ok(review.querySelector('[data-style="borderRadius"]'));
  } finally { app.window.close(); }
});

test('Escape during style-field IME composition preserves the annotation and note', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    const review = await app.start();
    review.querySelector('textarea')!.value = 'Keep my feedback';
    const input = review.querySelector('[data-style="fontFamily"]') as HTMLInputElement;
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    assert.ok(app.document.getElementById('od-clipper-annotation'));
    assert.equal(review.querySelector('textarea')!.value, 'Keep my feedback');
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(app.document.getElementById('od-clipper-annotation'), null);
  } finally { app.window.close(); }
});

test('navigation during preview recapture prevents posting and leaves the stale review closable', async () => {
  let release!: () => void;
  const app = page('<button id="save">Save</button>', { recaptureGate: new Promise<void>(resolve => { release = resolve; }) });
  try {
    const review = await app.start();
    const input = review.querySelector('[data-style="fontSize"]') as HTMLInputElement;
    input.value = '24px'; input.dispatchEvent(new app.window.Event('change'));
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.filter(message => message.type === 'odAnnotation:capture').length === 2);
    app.window.history.replaceState(null, '', '/different-page');
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(app.messages.some(message => message.type === 'odAnnotation:submit'), false);
    assert.equal((review.querySelector('[data-act="close"]') as HTMLButtonElement).disabled, false);
    (review.querySelector('[data-act="close"]') as HTMLButtonElement).click();
    assert.equal(app.document.getElementById('od-clipper-annotation'), null);
  } finally { release(); app.window.close(); }
});

test('submission failure stays inline and retains the note and screenshot for retry', async () => {
  const app = page('<button id="save">Save</button>', { submitError: 'Connection unavailable' });
  try {
    const review = await app.start();
    const textarea = review.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Make Save clearer';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => Boolean(review.querySelector('.submit-error')?.textContent));
    assert.match(review.querySelector('[role="alert"]')!.textContent || '', /Connection unavailable/);
    assert.equal(textarea.value, 'Make Save clearer');
    assert.equal((review.querySelector('.preview') as HTMLImageElement).src, screenshot);
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:discard').length, 0);
  } finally { app.window.close(); }
});

test('Cancel discards the optional screenshot and closes the review', async () => {
  const app = page('<button id="save">Save <span>changes</span></button>');
  try {
    const review = await app.start();
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    (review.querySelector('[data-act="cancel"]') as HTMLButtonElement).click();
    assert.equal(app.document.getElementById('od-clipper-annotation'), null);
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:submit').length, 0);
    assert.equal(app.messages.at(-1)?.type, 'odAnnotation:discard');
  } finally { app.window.close(); }
});

test('closing the review also discards its optional screenshot', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    const review = await app.start();
    (review.querySelector('[data-act="close"]') as HTMLButtonElement).click();
    assert.equal(app.document.getElementById('od-clipper-annotation'), null);
    assert.equal(app.messages.at(-1)?.type, 'odAnnotation:discard');
  } finally { app.window.close(); }
});

test('review allows posting note and context after a capture failure', async () => {
  const app = page('<button id="save">Save</button>', { captureError: 'Annotation tab is not ready for screenshot' });
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, 'annotationScreenshotTabNotReady');
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    (review.querySelector('textarea') as HTMLTextAreaElement).value = 'Make it clearer';
    (review.querySelector('[data-act="send"]') as HTMLButtonElement).click();
    await app.waitFor(() => app.messages.some((message) => message.type === 'odAnnotation:submit'));
    assert.equal(app.messages.find((message) => message.type === 'odAnnotation:submit')?.omitScreenshot, true);
  } finally { app.window.close(); }
});

test('review captures a neighboring field with its contents masked', async () => {
  const app = page('<button id="save">Save</button><input id="nearby">', { nearbyField: true });
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, '');
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
    assert.equal((review.querySelector('[data-act="send"]') as HTMLButtonElement).disabled, false);
    assert.equal(review.querySelector('[data-act="retry"]'), null);
    assert.equal(review.querySelector('[data-act="remove"]'), null);
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
  } finally { app.window.close(); }
});

test('review captures design near a shadow-root field with its contents masked', async () => {
  const app = page('<button id="save">Save</button><div id="host"></div>', { nearbyField: true });
  try {
    const root = app.document.getElementById('host')!.attachShadow({ mode: 'open' });
    const password = app.document.createElement('input');
    password.type = 'password';
    password.id = 'nearby';
    root.append(password);
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, '');
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
  } finally { app.window.close(); }
});

test('review refuses a crop next to a sensitive field inside a custom element', async () => {
  const app = page('<button id="save">Save</button><secret-field id="nearby"></secret-field>', { nearbyField: true });
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, 'annotationScreenshotNearbyField');
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 0);
  } finally { app.window.close(); }
});

test('inspection capture hides the open annotation review and restores it afterward', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    await app.start();
    const host = app.document.getElementById('od-clipper-annotation')!;
    assert.notEqual(host.style.display, 'none');
    assert.equal((await app.message({ type: 'odClipper:hideForCapture' })).ok, true);
    assert.equal(host.style.display, 'none');
    assert.equal((await app.message({ type: 'odClipper:restoreAfterCapture' })).ok, true);
    assert.notEqual(host.style.display, 'none');
  } finally { app.window.close(); }
});

test('post-capture check refuses a field that moves after the first paint acknowledgment', async () => {
  const app = page('<button id="save">Save</button><div id="slot"></div>', { nearbyField: true });
  try {
    await app.start();
    const initial = app.messages.find((item) => item.type === 'odAnnotation:capture') as Sent & {
      rect: Record<string, number>; maskRects: unknown[]; viewportWidth: number; viewportHeight: number;
      scrollX: number; scrollY: number;
    };
    assert.ok(initial);
    assert.deepEqual(JSON.parse(JSON.stringify(initial.maskRects)), []);
    const password = app.document.createElement('input');
    password.id = 'nearby'; password.type = 'password';
    app.document.getElementById('slot')!.append(password);
    const verified = await app.message({ type: 'odClipper:verifyAfterCapture', annotation: {
      url: app.window.location.href, selector: 'body > button', rect: initial.rect,
      maskRects: initial.maskRects, viewportWidth: initial.viewportWidth,
      viewportHeight: initial.viewportHeight, scrollX: initial.scrollX, scrollY: initial.scrollY,
    } });
    assert.equal(verified.ok, false);
  } finally { app.window.close(); }
});

test('capture paint acknowledgment accepts an unchanged safe crop', async () => {
  const app = page('<button id="save">Save</button>');
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, '');
    const result = await app.message({ type: 'odClipper:hideForCapture', annotation: {
      url: app.window.location.href, selector: 'body > button',
      rect: { x: 16, y: 16, width: 138, height: 78 }, maskRects: [],
    } });
    assert.equal(result.ok, true);
  } finally { app.window.close(); }
});

test('capture paint acknowledgment refuses a newly visible sensitive field', async () => {
  const app = page('<button id="save">Save</button><div id="slot"></div>', { nearbyField: true });
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, '');
    const password = app.document.createElement('input');
    password.id = 'nearby';
    password.type = 'password';
    app.document.getElementById('slot')!.append(password);
    const result = await app.message({ type: 'odClipper:hideForCapture', annotation: {
      url: app.window.location.href, selector: 'body > button',
      rect: { x: 16, y: 16, width: 138, height: 78 }, maskRects: [],
    } });
    assert.equal(result.ok, false);
  } finally { app.window.close(); }
});

test('review refuses a crop when an opaque custom element can draw outside its box', async () => {
  const app = page('<button id="save">Save</button><secret-field id="host"></secret-field>');
  try {
    const review = await app.start();
    assert.equal(review.querySelector('.capture-status')!.textContent, 'annotationScreenshotNearbyField');
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 0);
  } finally { app.window.close(); }
});

test('long visible text remains annotatable with bounded evidence', async () => {
  const app = page(`<button id="save">Save <span>${'visible '.repeat(50)}</span></button>`);
  try {
    const review = await app.start();
    assert.ok(review.querySelector('textarea'));
    const captured = app.messages.find((message) => message.type === 'odAnnotation:capture')!;
    assert.ok(captured.target!.domOutline.length <= 1200);
  } finally { app.window.close(); }
});

test('design feedback labels survive evidence sanitization', async () => {
  const app = page('<button id="save">Password: increase contrast</button>');
  try {
    await app.start();
    const captured = app.messages.find((message) => message.type === 'odAnnotation:capture');
    assert.equal(captured?.target?.text, 'Password: increase contrast');
  } finally { app.window.close(); }
});

test('credential-shaped direct text is omitted without refusing the design review', async () => {
  const app = page('<button id="save">token=private</button>');
  try {
    const review = await app.start();
    assert.ok(review.querySelector('textarea'));
    const captured = app.messages.find((message) => message.type === 'odAnnotation:capture')!;
    assert.equal(captured.target!.text, '');
    assert.doesNotMatch(captured.target!.domOutline, /private/);
    assert.equal(app.messages.filter((message) => message.type === 'odAnnotation:capture').length, 1);
  } finally { app.window.close(); }
});

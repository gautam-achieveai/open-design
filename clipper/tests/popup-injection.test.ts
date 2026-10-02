import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const requireFromWeb = createRequire(join(import.meta.dirname, '../../apps/web/package.json'));
const { JSDOM } = requireFromWeb('jsdom') as typeof import('jsdom');
const read = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8');

test('popup exposes opt-in diagnostics and warns about a stale page script', async () => {
  const dom = new JSDOM(read('popup.html'), { url: 'https://extension.test/popup.html', runScripts: 'outside-only' });
  Object.assign(dom.window, {
    chrome: {
      runtime: { sendMessage: (message: { type: string }, reply: (value: unknown) => void) =>
        reply(message.type === 'odAnnotation:diagnostics' ? { ok: true, enabled: false,
          report: { build: 'annotation-evidence-20260930', extensionVersion: '0.2.0', events: [] } } : { ok: false }) },
      storage: { local: { get: async () => ({}) } },
      tabs: {
        query: (_query: unknown, reply: (tabs: unknown[]) => void) => reply([{ id: 42 }]),
        sendMessage: (_id: number, _message: unknown, options: { frameId: number }, reply: (value: unknown) => void) =>
          reply({ ok: true, build: 'old-build' }),
      },
    },
  });
  try {
    dom.window.eval(read('i18n.js'));
    dom.window.eval(read('popup.js'));
    await dom.window.eval('refreshAnnotationDiagnostics()');
    assert.equal((dom.window.document.getElementById('annotation-diagnostics') as HTMLInputElement).checked, false);
    assert.match(dom.window.document.getElementById('annotation-version')!.textContent!, /old-build/);
    assert.match(dom.window.document.getElementById('msg')!.textContent!, /older extension script/);
  } finally { dom.window.close(); }
});

test('attaching to an already-open tab loads translations before the content script without reloading', async () => {
  const dom = new JSDOM(read('popup.html'), { url: 'https://extension.test/popup.html', runScripts: 'outside-only' });
  const injected: string[][] = [];
  const tabMessages: string[] = [];
  let attached = false;
  Object.assign(dom.window, {
    chrome: {
      runtime: {
        sendMessage: (_message: unknown, reply: (value: unknown) => void) => reply({ ok: false }),
      },
      storage: { local: { get: async () => ({}) } },
      tabs: {
        query: (_query: unknown, reply: (tabs: unknown[]) => void) => reply([]),
        sendMessage: (_tabId: number, message: { type: string }, options: { frameId: number }, reply: (value: unknown) => void) => {
          assert.equal(options.frameId, 0);
          tabMessages.push(message.type);
          reply(attached ? { ok: true } : undefined);
        },
        reload: () => assert.fail('attaching must preserve the existing page'),
      },
      scripting: {
        executeScript: async ({ files }: { files: string[] }) => {
          injected.push(files);
          attached = true;
        },
      },
    },
  });
  try {
    dom.window.eval(read('i18n.js'));
    dom.window.eval(read('popup.js'));
    const response = await dom.window.eval('sendToTabEnsuringScript(42, "https://example.test/", { type: "odClipper:annotateElement" })');
    assert.equal(response.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(injected)), [['i18n.js', 'content.js']]);
    assert.deepEqual(tabMessages, ['odClipper:annotateElement', 'odClipper:annotateElement']);
  } finally {
    dom.window.close();
  }
});

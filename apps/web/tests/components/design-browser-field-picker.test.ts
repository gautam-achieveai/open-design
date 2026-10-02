// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { browserAnnotationPixelMasks, browserAnnotationTextPaintScript, browserElementPickerScript, browserMeasureTargetsScript } from '../../src/components/design-browser-tools';

const oldRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = oldRect;
  document.body.replaceChildren();
  document.querySelectorAll('style[data-od-annotation-text]').forEach((style) => style.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('verifies interrupted text suppression without reapplying it and restores open shadows', () => {
  document.body.innerHTML = '<input value="private-123"><div id="host"></div>';
  const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<textarea>private-456</textarea>';
  const input = document.querySelector('input')!;
  const textarea = root.querySelector('textarea')!;
  const inputEvent = vi.fn();
  input.addEventListener('input', inputEvent);
  input.addEventListener('change', inputEvent);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node) => ({
    display: 'block', visibility: 'visible', textShadow: 'none',
    webkitTextFillColor: node.getRootNode() === document
      ? (document.querySelector('style[data-od-annotation-text]') ? 'transparent' : 'red')
      : (root.querySelector('style[data-od-annotation-text]') ? 'transparent' : 'red'),
  } as CSSStyleDeclaration));
  expect(window.eval(browserAnnotationTextPaintScript(true))).toBe(true);
  expect(root.querySelector('style[data-od-annotation-text]')).not.toBeNull();
  document.querySelector('style[data-od-annotation-text]')!.remove();
  expect(window.eval(browserAnnotationTextPaintScript(true, true))).toBe(false);
  expect(document.querySelector('style[data-od-annotation-text]')).toBeNull();
  expect(window.eval(browserAnnotationTextPaintScript(false))).toBe(true);
  expect(root.querySelector('style[data-od-annotation-text]')).toBeNull();
  expect(input.value).toBe('private-123');
  expect(textarea.value).toBe('private-456');
  expect(inputEvent).not.toHaveBeenCalled();
});

it('bounds stalled suppression without an older timer removing a newer capture', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<input value="private-123">';
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    display: 'block', visibility: 'visible', textShadow: 'none', webkitTextFillColor: 'transparent',
  } as CSSStyleDeclaration));
  window.eval(browserAnnotationTextPaintScript(true));
  vi.advanceTimersByTime(3000);
  window.eval(browserAnnotationTextPaintScript(true));
  vi.advanceTimersByTime(2000);
  expect(document.querySelectorAll('style[data-od-annotation-text]')).toHaveLength(1);
  vi.advanceTimersByTime(2999);
  expect(document.querySelectorAll('style[data-od-annotation-text]')).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(document.querySelectorAll('style[data-od-annotation-text]')).toHaveLength(0);
  expect(document.querySelector('input')!.value).toBe('private-123');
});

it('picks a password field without reading its value or sensitive attributes', async () => {
  document.body.innerHTML = '<form id="private-ancestor"><input id="password" type="password" name="password" value="private-123" placeholder="Secret"></form>';
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 160, height: 30,
    left: 10, top: 20, right: 170, bottom: 50, toJSON() {} } as DOMRect);
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('password')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(target).toMatchObject({ label: 'input', text: '', htmlHint: 'input', isFormField: true,
    maskRects: [{ x: 0, y: 0, width: 160, height: 30 }] });
  expect(JSON.stringify(target)).not.toMatch(/private-123|private-ancestor|name=|placeholder=|type="password"/);

  const refreshed = window.eval(browserMeasureTargetsScript('browser:https://example.test', [
    { elementId: String(target.elementId), selector: String(target.selector), key: 'active' },
  ])) as Array<Record<string, unknown>>;
  expect(refreshed[0]).toMatchObject({ label: 'input', text: '', htmlHint: 'input', isFormField: true,
    maskRects: [{ x: 0, y: 0, width: 160, height: 30 }] });
  expect(JSON.stringify(refreshed)).not.toMatch(/private-123|name=|placeholder=|type="password"/);
});

it('scales and clips masks to a high-DPI capture of a partly offscreen field', () => {
  expect(browserAnnotationPixelMasks({ x: -10, y: 20, width: 100, height: 40 },
    { x: 0, y: 0, width: 300, height: 200 }, { w: 180, h: 80 },
    [{ x: 0, y: 0, width: 100, height: 40 }])).toEqual([
    { x: 0, y: 0, width: 180, height: 80 },
  ]);
  expect(browserAnnotationPixelMasks({ x: 10, y: 20, width: 100, height: 40 },
    { x: 0, y: 0, width: 300, height: 200 }, { w: 200, h: 80 },
    [{ x: 50, y: 10, width: 20, height: 10 }])).toEqual([
    { x: 100, y: 20, width: 40, height: 20 },
  ]);
});

it('does not serialize sensitive descendants when selecting a containing button', async () => {
  document.body.innerHTML = '<button id="container">Save <input value="private-123"><span data-sensitive>hidden-secret</span></button>';
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20,
    right: 170, bottom: 60, width: 160, height: 40, toJSON() {} } as DOMRect);
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('container')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(JSON.stringify(target)).not.toMatch(/private-123|hidden-secret/);
});

it('omits nested hidden and private content while retaining surrounding design text', async () => {
  document.body.innerHTML = '<main id="area">Design <section data-sensitive><b>internal secret</b></section><div hidden><span>hidden secret</span></div><span>around fields</span></main>';
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20,
    right: 170, bottom: 60, width: 160, height: 40, toJSON() {} } as DOMRect);
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('area')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(String(target.text)).toContain('Design');
  expect(String(target.text)).toContain('around fields');
  expect(JSON.stringify(target)).not.toMatch(/internal secret|hidden secret/);
});

it('masks a field inside an open shadow root and avoids opaque custom hosts', async () => {
  document.body.innerHTML = '<main><button id="button">Save</button><div id="host"></div></main>';
  const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<input type="password" value="private-123">';
  HTMLElement.prototype.getBoundingClientRect = function () {
    const x = this.matches('input') ? 55 : 10;
    return { x, y: 20, left: x, top: 20, right: x + 100, bottom: 50, width: 100, height: 30,
      toJSON() {} } as DOMRect;
  };
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(target.maskRects).toEqual([{ x: 45, y: 0, width: 55, height: 30, textHidden: true }]);
  expect(JSON.stringify(target)).not.toContain('private-123');
});

it('does not produce mask metadata when an opaque frame intersects the crop', async () => {
  document.body.innerHTML = '<main><button id="button">Save</button><iframe id="frame"></iframe></main>';
  HTMLElement.prototype.getBoundingClientRect = function () {
    const x = this.id === 'frame' ? 50 : 10;
    return { x, y: 20, left: x, top: 20, right: x + 100, bottom: 50, width: 100, height: 30,
      toJSON() {} } as DOMRect;
  };
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(target.maskRects).toBeNull();
});

it('retains ordinary design copy while excluding credential assignments', async () => {
  document.body.innerHTML = '<main><button id="design">Password: increase contrast</button><span>token=private</span></main>';
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20,
    right: 170, bottom: 60, width: 160, height: 40, toJSON() {} } as DOMRect);
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.getElementById('design')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect((await picked).text).toBe('Password: increase contrast');
});

it('picks a select without returning selected option text or markup', async () => {
  document.body.innerHTML = '<form><select id="account"><option value="private" selected>Private choice</option></select></form>';
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 160, height: 30,
    left: 10, top: 20, right: 170, bottom: 50, toJSON() {} } as DOMRect);
  const picked = window.eval(browserElementPickerScript('browser:https://example.test')) as Promise<Record<string, unknown>>;
  document.querySelector('select')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const target = await picked;
  expect(target).toMatchObject({ label: 'select', text: '', domOutline: 'select', htmlHint: 'select', isFormField: true });
  expect(JSON.stringify(target)).not.toMatch(/Private choice|private/);

  const refreshed = window.eval(browserMeasureTargetsScript('browser:https://example.test', [
    { elementId: String(target.elementId), selector: String(target.selector), key: 'active' },
  ])) as Array<Record<string, unknown>>;
  expect(refreshed[0]).toMatchObject({ label: 'select', text: '', htmlHint: 'select', isFormField: true });
  expect(JSON.stringify(refreshed)).not.toMatch(/Private choice|private/);
});

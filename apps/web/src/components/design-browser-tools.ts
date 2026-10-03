import type { PreviewAnnotationStyle } from '../types';

import type { BrowserViewportId } from '@open-design/contracts';
export type { BrowserViewportId } from '@open-design/contracts';

export interface BrowserViewportPreset {
  id: BrowserViewportId;
  width: number | null;
  height: number | null;
}

// Labels/titles are looked up from i18n at render time (see `viewportLabel`
// / `viewportTitle` in DesignBrowserPanel.tsx) rather than baked in here —
// this module has no i18n context of its own.
export const BROWSER_VIEWPORT_PRESETS: BrowserViewportPreset[] = [
  { id: 'desktop', width: null, height: null },
  { id: 'tablet', width: 820, height: 1180 },
  { id: 'mobile', width: 390, height: 844 },
];

export const BROWSER_PAGE_ARCHIVE_SCHEMA = 'open-design.browser-page-archive.v1';
export const BROWSER_PAGE_ARCHIVE_INDEX_FILE = 'browser/latest-page-snapshot.json';

export type BrowserPageArchiveResourceKind =
  | 'image'
  | 'stylesheet'
  | 'script'
  | 'font'
  | 'media'
  | 'icon'
  | 'document'
  | 'other';

export interface BrowserPageArchiveCaptureResource {
  url: string;
  kind: BrowserPageArchiveResourceKind;
  tag?: string;
  rel?: string;
  source?: string;
}

export interface BrowserPageArchiveCapture {
  title: string;
  url: string;
  html: string;
  css: string;
  resources: BrowserPageArchiveCaptureResource[];
}

export interface BrowserPageArchiveManifestResource extends BrowserPageArchiveCaptureResource {
  file?: string;
  mime?: string;
  size?: number;
  status: 'saved' | 'failed' | 'skipped';
  error?: string;
}

export interface BrowserPageArchiveManifest {
  schema: typeof BROWSER_PAGE_ARCHIVE_SCHEMA;
  capturedAt: number;
  title: string;
  url: string;
  baseUrl: string;
  htmlFile: string;
  cssFile: string;
  manifestFile: string;
  resources: BrowserPageArchiveManifestResource[];
}

export interface BrowserElementSnapshot {
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: { x: number; y: number; width: number; height: number };
  hoverPoint?: { x: number; y: number };
  htmlHint: string;
  domOutline?: string;
  ancestors?: Array<{ tag: string; selector: string }>;
  style?: PreviewAnnotationStyle;
  selectionKind?: 'element';
  isFormField?: boolean;
  maskRects?: Array<{ x: number; y: number; width: number; height: number; textHidden?: boolean }> | null;
  viewport?: { width: number; height: number };
}

type BrowserRect = { x: number; y: number; width: number; height: number; textHidden?: boolean };

export function browserAnnotationPixelMasks(
  element: BrowserRect,
  frame: BrowserRect,
  image: { w: number; h: number },
  masks: BrowserRect[],
  actualCrop?: BrowserRect,
): BrowserRect[] | null {
  const clipped = {
    x: Math.max(0, element.x),
    y: Math.max(0, element.y),
    right: Math.min(frame.width, element.x + element.width),
    bottom: Math.min(frame.height, element.y + element.height),
  };
  const width = clipped.right - clipped.x;
  const height = clipped.bottom - clipped.y;
  if (![element.x, element.y, element.width, element.height, frame.width, frame.height,
    image.w, image.h].every(Number.isFinite) || width <= 0 || height <= 0
    || image.w <= 0 || image.h <= 0 || masks.length > 200) return null;
  const crop = actualCrop ?? { x: clipped.x, y: clipped.y, width, height };
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0
    || crop.x >= clipped.right || crop.y >= clipped.bottom
    || crop.x + crop.width <= clipped.x || crop.y + crop.height <= clipped.y) return null;
  const sx = image.w / crop.width;
  const sy = image.h / crop.height;
  const result: BrowserRect[] = [];
  for (const mask of masks) {
    if (![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite)
      || mask.width <= 0 || mask.height <= 0) return null;
    const x0 = Math.max(0, Math.floor((element.x + mask.x - crop.x) * sx));
    const y0 = Math.max(0, Math.floor((element.y + mask.y - crop.y) * sy));
    const x1 = Math.min(image.w, Math.ceil((element.x + mask.x + mask.width - crop.x) * sx));
    const y1 = Math.min(image.h, Math.ceil((element.y + mask.y + mask.height - crop.y) * sy));
    if (x1 > x0 && y1 > y0) result.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0,
      ...(mask.textHidden === true ? { textHidden: true } : {}) });
  }
  return result;
}

export function browserAnnotationTextPaintScript(hide: boolean, verifyOnly = false): string {
  return `(() => {
    const selector = 'input:not([type]),input[type="text"],input[type="email"],input[type="password"],input[type="search"],input[type="tel"],input[type="url"],textarea';
    const visit = (root) => {
      root.querySelectorAll('style[data-od-annotation-text]').forEach((style) => style.remove());
      if (${hide}) {
        const style = document.createElement('style');
        style.setAttribute('data-od-annotation-text', '');
        style.textContent = 'input,textarea,input::placeholder,textarea::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
        (root === document ? document.documentElement : root).appendChild(style);
        setTimeout(() => style.remove(), 5000);
      }
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) visit(node.shadowRoot);
    };
    if (!${verifyOnly}) visit(document);
    const verify = (root) => {
      for (const node of root.querySelectorAll(selector)) {
        const style = getComputedStyle(node);
        if (style.display !== 'none' && style.visibility !== 'hidden'
          && (!['transparent', 'rgba(0, 0, 0, 0)'].includes(style.webkitTextFillColor) || style.textShadow !== 'none')) return false;
      }
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot && !verify(node.shadowRoot)) return false;
      return true;
    };
    return ${hide} ? verify(document) : true;
  })()`;
}

export interface BrowserMeasureTargetRequest {
  elementId: string;
  key: string;
  selector: string;
}

export function projectRelativePathFromBrowserUrl(
  url: string,
  resolvedDir?: string | null,
): string | null {
  const root = normalizeLocalFsPath(resolvedDir);
  if (!root || !/^file:\/\//i.test(url.trim())) return null;
  try {
    const parsed = new URL(url);
    const filePath = normalizeLocalFsPath(decodeURIComponent(parsed.pathname));
    if (!filePath || filePath === root || !filePath.startsWith(`${root}/`)) return null;
    const relativePath = filePath.slice(root.length + 1).replace(/^\/+/u, '');
    if (!relativePath || relativePath.includes('\0')) return null;
    return relativePath;
  } catch {
    return null;
  }
}

export function browserCommentFilePath(url: string, resolvedDir?: string | null): string {
  const projectPath = projectRelativePathFromBrowserUrl(url, resolvedDir);
  if (projectPath) return projectPath;
  const cleanUrl = url.trim();
  return cleanUrl && cleanUrl !== 'about:blank' ? `browser:${cleanUrl}` : 'browser:about:blank';
}

export function isProjectHtmlBrowserUrl(url: string, resolvedDir?: string | null): boolean {
  const projectPath = projectRelativePathFromBrowserUrl(url, resolvedDir);
  return Boolean(projectPath && /\.html?$/i.test(projectPath));
}

function normalizeLocalFsPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return normalized || null;
}

export const BROWSER_CANCEL_PICKER_SCRIPT = `
(() => {
  const cancel = window.__openDesignBrowserPickerCancel;
  if (typeof cancel === 'function') {
    try { cancel(); } catch (_) {}
  }
  return true;
})()
`;

export const BROWSER_SERIALIZE_HTML_SCRIPT = `
(() => {
  const doctype = document.doctype
    ? '<!DOCTYPE ' + document.doctype.name + '>'
    : '<!doctype html>';
  return doctype + '\\n' + document.documentElement.outerHTML;
})()
`;

// Collect a CSS digest from a rendered page for the brand harvest: readable
// stylesheet rules PLUS a computed-style sweep. The computed sweep matters
// because cross-origin stylesheets (CDN-hosted, Google Fonts) throw on
// `cssRules`, so their colors/fonts would otherwise be invisible — but
// getComputedStyle resolves them on every element regardless of origin. The
// daemon's regex harvest (extractColors / extractFonts) reads the resulting
// `color:` / `background-color:` / `font-family:` declarations, and the
// frequency of repeated computed colors usefully ranks the real palette.
export const BROWSER_SERIALIZE_STYLES_SCRIPT = `
(() => {
  const out = [];
  for (const sheet of Array.from(document.styleSheets || [])) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule && rule.cssText) out.push(rule.cssText);
      }
    } catch (_) {
      // Cross-origin stylesheet — rules are not readable; computed styles cover it.
    }
  }
  try {
    const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent', '']);
    const els = Array.from(document.querySelectorAll('body *')).slice(0, 2500);
    for (const el of els) {
      const cs = window.getComputedStyle(el);
      if (!cs) continue;
      const decl = [];
      if (cs.color) decl.push('color:' + cs.color);
      if (!TRANSPARENT.has(cs.backgroundColor)) decl.push('background-color:' + cs.backgroundColor);
      if (!TRANSPARENT.has(cs.borderTopColor)) decl.push('border-color:' + cs.borderTopColor);
      if (cs.fontFamily) decl.push('font-family:' + cs.fontFamily);
      if (decl.length) out.push('x{' + decl.join(';') + '}');
    }
  } catch (_) {
    // getComputedStyle unavailable — fall back to whatever sheet rules we got.
  }
  return out.join('\\n');
})()
`;

export const BROWSER_CAPTURE_PAGE_ARCHIVE_SCRIPT = `
(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const doctype = document.doctype
    ? '<!DOCTYPE ' + document.doctype.name + '>'
    : '<!doctype html>';
  const absoluteUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#')) return '';
    if (/^(?:javascript|mailto|tel):/i.test(raw)) return '';
    try {
      const resolved = new URL(raw, document.baseURI || location.href).href;
      if (/^(?:https?:|data:)/i.test(resolved)) return resolved;
    } catch (_) {}
    return '';
  };
  const srcsetUrls = (value) => String(value || '')
    .split(',')
    .map((part) => absoluteUrl(part.trim().split(/\\s+/)[0] || ''))
    .filter(Boolean);
  const resources = [];
  const seen = new Set();
  const add = (url, kind, meta) => {
    const resolved = absoluteUrl(url);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    resources.push(Object.assign({ url: resolved, kind }, meta || {}));
  };
  const addSrcset = (value, kind, meta) => {
    for (const url of srcsetUrls(value)) add(url, kind, meta);
  };
  const cssUrlValues = (value) => {
    const urls = [];
    String(value || '').replace(/url\\((['"]?)(.*?)\\1\\)/g, (_, _quote, rawUrl) => {
      const resolved = absoluteUrl(rawUrl);
      if (resolved) urls.push(resolved);
      return '';
    });
    return urls;
  };
  const kindForLink = (rel, asValue, href) => {
    const r = String(rel || '').toLowerCase();
    const as = String(asValue || '').toLowerCase();
    if (r.includes('stylesheet') || as === 'style') return 'stylesheet';
    if (r.includes('icon')) return 'icon';
    if (as === 'font' || /\\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(href)) return 'font';
    if (as === 'image') return 'image';
    if (as === 'script' || r.includes('modulepreload')) return 'script';
    return 'other';
  };
  for (const link of Array.from(document.querySelectorAll('link[href]'))) {
    const href = link.getAttribute('href') || '';
    const rel = link.getAttribute('rel') || '';
    const asValue = link.getAttribute('as') || '';
    add(href, kindForLink(rel, asValue, href), { tag: 'link', rel: clean(rel), source: 'link[href]' });
  }
  for (const image of Array.from(document.images || [])) {
    add(image.currentSrc || image.src, 'image', { tag: 'img', source: 'img.currentSrc' });
    addSrcset(image.getAttribute('srcset'), 'image', { tag: 'img', source: 'img[srcset]' });
  }
  for (const source of Array.from(document.querySelectorAll('source'))) {
    const parent = source.parentElement?.tagName?.toLowerCase() || '';
    const kind = parent === 'video' || parent === 'audio' || source.getAttribute('type')?.startsWith('video/')
      ? 'media'
      : 'image';
    add(source.getAttribute('src'), kind, { tag: 'source', source: 'source[src]' });
    addSrcset(source.getAttribute('srcset'), kind, { tag: 'source', source: 'source[srcset]' });
  }
  for (const media of Array.from(document.querySelectorAll('video[src], audio[src], video[poster]'))) {
    add(media.getAttribute('src'), 'media', { tag: media.tagName.toLowerCase(), source: 'media[src]' });
    add(media.getAttribute('poster'), 'image', { tag: media.tagName.toLowerCase(), source: 'video[poster]' });
  }
  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    add(script.getAttribute('src'), 'script', { tag: 'script', source: 'script[src]' });
  }
  for (const node of Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]'))) {
    add(node.getAttribute('src') || node.getAttribute('data'), 'document', {
      tag: node.tagName.toLowerCase(),
      source: node.tagName.toLowerCase() + '[src]',
    });
  }
  for (const node of Array.from(document.querySelectorAll('[style]')).slice(0, 2500)) {
    for (const url of cssUrlValues(node.getAttribute('style'))) {
      add(url, 'image', { tag: node.tagName.toLowerCase(), source: 'inline-style-url' });
    }
  }
  for (const sheet of Array.from(document.styleSheets || [])) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const cssText = rule && rule.cssText ? String(rule.cssText) : '';
        const isFont = /^\\s*@font-face/i.test(cssText);
        for (const url of cssUrlValues(cssText)) {
          add(url, isFont ? 'font' : 'image', { source: isFont ? '@font-face' : 'css-url' });
        }
      }
    } catch (_) {
      // Cross-origin stylesheet rules are unreadable; link[href] still records them.
    }
  }
  const cssOut = [];
  for (const sheet of Array.from(document.styleSheets || [])) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule && rule.cssText) cssOut.push(rule.cssText);
      }
    } catch (_) {}
  }
  try {
    const transparent = new Set(['rgba(0, 0, 0, 0)', 'transparent', '']);
    const els = Array.from(document.querySelectorAll('body *')).slice(0, 2500);
    for (const el of els) {
      const cs = window.getComputedStyle(el);
      if (!cs) continue;
      const decl = [];
      if (cs.color) decl.push('color:' + cs.color);
      if (!transparent.has(cs.backgroundColor)) decl.push('background-color:' + cs.backgroundColor);
      if (!transparent.has(cs.borderTopColor)) decl.push('border-color:' + cs.borderTopColor);
      if (cs.fontFamily) decl.push('font-family:' + cs.fontFamily);
      if (decl.length) cssOut.push('x{' + decl.join(';') + '}');
    }
  } catch (_) {}
  return {
    title: clean(document.title),
    url: location.href,
    html: doctype + '\\n' + document.documentElement.outerHTML,
    css: cssOut.join('\\n'),
    resources,
  };
})()
`;

export function isBrowserPageArchiveManifest(value: unknown): value is BrowserPageArchiveManifest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BrowserPageArchiveManifest>;
  return (
    item.schema === BROWSER_PAGE_ARCHIVE_SCHEMA &&
    typeof item.url === 'string' &&
    typeof item.baseUrl === 'string' &&
    typeof item.htmlFile === 'string' &&
    typeof item.cssFile === 'string' &&
    typeof item.manifestFile === 'string' &&
    Array.isArray(item.resources)
  );
}

export function browserElementPickerScript(filePath: string): string {
  return `
(() => new Promise((resolve) => {
  const previousCancel = window.__openDesignBrowserPickerCancel;
  if (typeof previousCancel === 'function') {
    try { previousCancel(); } catch (_) {}
  }
  const filePath = ${JSON.stringify(filePath)};
  const style = document.createElement('style');
  style.setAttribute('data-open-design-browser-picker', 'true');
  style.textContent = [
    '* { cursor: crosshair !important; }',
    '.__open_design_browser_pick_hover__ { outline: 2px solid #1677ff !important; outline-offset: 2px !important; }',
    '.__open_design_browser_pick_hover__::selection { background: rgba(22, 119, 255, 0.22) !important; }'
  ].join('\\n');
  document.head.appendChild(style);

  let hovered = null;
  let finished = false;

  function visibleRect(el) {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }
  function elementFor(node) {
    let el = node && node.nodeType === 1 ? node : null;
    while (el && el !== document.documentElement) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!/^(script|style|template|meta|link|title|noscript)$/i.test(tag) && visibleRect(el)) return el;
      el = el.parentElement;
    }
    return visibleRect(document.body) ? document.body : document.documentElement;
  }
  function domSelectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let prev = node.previousElementSibling;
      while (prev) {
        if (prev.tagName === node.tagName) index += 1;
        prev = prev.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  }
  function selectorFor(el) {
    const selector = domSelectorFor(el);
    return { elementId: 'dom:' + selector, selector };
  }
  function maskRectsFor(rect) {
    const masks = [];
    const visit = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = node.getBoundingClientRect();
        const x = Math.max(rect.left, box.left);
        const y = Math.max(rect.top, box.top);
        const right = Math.min(rect.right, box.right);
        const bottom = Math.min(rect.bottom, box.bottom);
        if (right <= x || bottom <= y) continue;
        if (node.matches('iframe,object,embed,[data-sensitive]')
          || (node.localName.includes('-') && !node.shadowRoot)) return false;
        if (node.matches('input,textarea,select,[contenteditable]')) {
          masks.push({ x: x - rect.left, y: y - rect.top,
            width: right - x, height: bottom - y,
            ...(node.matches('textarea,input:not([type]),input[type="text"],input[type="email"],input[type="password"],input[type="search"],input[type="tel"],input[type="url"]') ? { textHidden: true } : {}) });
          if (masks.length > 200) return false;
        }
        if (node.shadowRoot && !visit(node.shadowRoot)) return false;
      }
      return true;
    };
    return visit(document) ? masks : null;
  }
  function safeText(el) {
    let length = 0;
    const parts = [];
    const visit = (node) => {
      if (length >= 240) return;
      if (node.nodeType === 3) {
        const text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (text && !/(?:eyJ[A-Za-z0-9_-]{8,}\\.eyJ|bearer\\s+\\S+|(?:password|secret|token|api[_-]?key|credential)(?:\\s*=\\s*\\S{6,}|\\s*:\\s*\\S{6,}(?=\\s*(?:$|[\\n;,]))))/i.test(text)) {
          const bounded = text.slice(0, 240 - length);
          parts.push(bounded); length += bounded.length;
        }
        return;
      }
      if (node.nodeType !== 1 || node.matches('input,textarea,select,[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"],iframe,object,embed,script,style')
        || node.closest('[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"]')) return;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      for (const child of node.childNodes) visit(child);
    };
    visit(el);
    return parts.join(' ').slice(0, 240);
  }
  function styleSnapshot(el) {
    const s = window.getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      textAlign: s.textAlign,
      fontFamily: s.fontFamily,
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      borderRadius: s.borderRadius,
      opacity: s.opacity,
      borderColor: s.borderColor,
      borderWidth: s.borderWidth,
      width: s.width,
      height: s.height,
      marginTop: s.marginTop,
      marginRight: s.marginRight,
      marginBottom: s.marginBottom,
      marginLeft: s.marginLeft
    };
  }
  function snapshotFor(el, ev) {
    const rect = el.getBoundingClientRect();
    const identity = selectorFor(el);
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    const field = el.matches('input,textarea,select');
    const htmlHint = tag;
    return {
      filePath,
      elementId: identity.elementId,
      selector: identity.selector,
      label: tag,
      text: field ? '' : safeText(el),
      position: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      hoverPoint: ev ? { x: Math.round(ev.clientX), y: Math.round(ev.clientY) } : undefined,
      domOutline: field ? tag : [el, ...Array.from(el.querySelectorAll('*')).slice(0, 30)]
        .filter(node => !node.matches('script,style,input,textarea,select,[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"],iframe,object,embed')
          && !node.closest('[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"]'))
        .map(node => node.localName + ' ' + Array.from(node.childNodes)
          .filter(child => child.nodeType === 3).map(child => {
            const text = String(child.nodeValue || '').replace(/\\s+/g, ' ').trim();
            return /(?:eyJ[A-Za-z0-9_-]{8,}\\.eyJ|bearer\\s+\\S+|(?:password|secret|token|api[_-]?key|credential)(?:\\s*=\\s*\\S{6,}|\\s*:\\s*\\S{6,}(?=\\s*(?:$|[\\n;,]))))/i.test(text) ? '' : text;
          }).join(' ').trim().slice(0, 160))
        .join('\\n').slice(0, 8000),
      ancestors: (() => {
        const parents = [];
        for (let node = el.parentElement; node && node !== document.documentElement && parents.length < 8; node = node.parentElement) {
          parents.push({ tag: node.localName, selector: domSelectorFor(node) });
        }
        return parents;
      })(),
      htmlHint: htmlHint.slice(0, 220),
      style: styleSnapshot(el),
      selectionKind: 'element',
      isFormField: field,
      maskRects: maskRectsFor(rect),
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }
  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.classList.remove('__open_design_browser_pick_hover__');
    hovered = el;
    if (hovered) hovered.classList.add('__open_design_browser_pick_hover__');
  }
  function cleanup(result) {
    if (finished) return;
    finished = true;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (hovered) hovered.classList.remove('__open_design_browser_pick_hover__');
    style.remove();
    window.__openDesignBrowserPickerCancel = null;
    resolve(result || null);
  }
  function onMove(ev) {
    setHover(elementFor(ev.target));
  }
  function onClick(ev) {
    const el = elementFor(ev.target);
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    cleanup(snapshotFor(el, ev));
  }
  function onKeyDown(ev) {
    if (ev.key === 'Escape') cleanup(null);
  }

  window.__openDesignBrowserPickerCancel = () => cleanup(null);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}))()
`;
}

export function browserMeasureTargetsScript(
  filePath: string,
  targets: BrowserMeasureTargetRequest[],
): string {
  return `
(() => {
  const filePath = ${JSON.stringify(filePath)};
  const targets = ${JSON.stringify(targets)};
  function visibleRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }
  function maskRectsFor(rect) {
    const masks = [];
    const visit = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = node.getBoundingClientRect();
        const x = Math.max(rect.left, box.left);
        const y = Math.max(rect.top, box.top);
        const right = Math.min(rect.right, box.right);
        const bottom = Math.min(rect.bottom, box.bottom);
        if (right <= x || bottom <= y) continue;
        if (node.matches('iframe,object,embed,[data-sensitive]')
          || (node.localName.includes('-') && !node.shadowRoot)) return false;
        if (node.matches('input,textarea,select,[contenteditable]')) {
          masks.push({ x: x - rect.left, y: y - rect.top,
            width: right - x, height: bottom - y,
            ...(node.matches('textarea,input:not([type]),input[type="text"],input[type="email"],input[type="password"],input[type="search"],input[type="tel"],input[type="url"]') ? { textHidden: true } : {}) });
          if (masks.length > 200) return false;
        }
        if (node.shadowRoot && !visit(node.shadowRoot)) return false;
      }
      return true;
    };
    return visit(document) ? masks : null;
  }
  function safeText(el) {
    let length = 0;
    const parts = [];
    const visit = (node) => {
      if (length >= 240) return;
      if (node.nodeType === 3) {
        const text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (text && !/(?:eyJ[A-Za-z0-9_-]{8,}\\.eyJ|bearer\\s+\\S+|(?:password|secret|token|api[_-]?key|credential)(?:\\s*=\\s*\\S{6,}|\\s*:\\s*\\S{6,}(?=\\s*(?:$|[\\n;,]))))/i.test(text)) {
          const bounded = text.slice(0, 240 - length);
          parts.push(bounded); length += bounded.length;
        }
        return;
      }
      if (node.nodeType !== 1 || node.matches('input,textarea,select,[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"],iframe,object,embed,script,style')
        || node.closest('[contenteditable],[data-sensitive],[hidden],[inert],[aria-hidden="true"]')) return;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      for (const child of node.childNodes) visit(child);
    };
    visit(el);
    return parts.join(' ').slice(0, 240);
  }
  function styleSnapshot(el) {
    const s = window.getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      textAlign: s.textAlign,
      fontFamily: s.fontFamily,
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      borderRadius: s.borderRadius,
      opacity: s.opacity,
      borderColor: s.borderColor,
      borderWidth: s.borderWidth,
      width: s.width,
      height: s.height,
      marginTop: s.marginTop,
      marginRight: s.marginRight,
      marginBottom: s.marginBottom,
      marginLeft: s.marginLeft
    };
  }
  function snapshotFor(target) {
    let el = null;
    try { el = document.querySelector(String(target.selector || '')); } catch (_) { el = null; }
    const rect = visibleRect(el);
    if (!el || !rect) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    const field = el.matches('input,textarea,select');
    const htmlHint = tag;
    return {
      key: String(target.key || ''),
      filePath,
      elementId: String(target.elementId || ''),
      selector: String(target.selector || ''),
      label: tag,
      text: field ? '' : safeText(el),
      position: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      htmlHint: htmlHint.slice(0, 220),
      style: styleSnapshot(el),
      selectionKind: 'element',
      isFormField: field,
      maskRects: maskRectsFor(rect),
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }
  return targets.map(snapshotFor).filter(Boolean);
})()
`;
}

export function browserApplyStyleScript(
  selector: string,
  prop: keyof PreviewAnnotationStyle,
  value: string,
): string {
  return `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el || !el.style) return false;
  el.style[${JSON.stringify(prop)}] = ${JSON.stringify(value)};
  return true;
})()
`;
}

export function browserApplyStylesScript(selector: string, styles: Partial<PreviewAnnotationStyle>): string {
  return `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el || !el.style) return false;
  const patch = ${JSON.stringify(styles)};
  const entries = Object.entries(patch);
  const propertyName = (key) => key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
  if (!entries.length || entries.some(([key, value]) => !CSS.supports(propertyName(key), value))) return false;
  const previous = el.getAttribute('style');
  try {
    for (const [key, value] of entries) el.style[key] = value;
    return true;
  } catch (_) {
    if (previous === null) el.removeAttribute('style'); else el.setAttribute('style', previous);
    return false;
  }
})()
`;
}

export function browserApplyTextScript(selector: string, value: string): string {
  return `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.textContent = ${JSON.stringify(value)};
  return true;
})()
`;
}

export function browserSnapshotFromUnknown(
  value: unknown,
  filePath: string,
): BrowserElementSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const position = normalizePosition(record.position);
  const elementId = String(record.elementId || '').trim();
  const selector = String(record.selector || '').trim();
  if (!elementId || !selector || !position) return null;
  return {
    filePath,
    elementId,
    selector,
    label: String(record.label || ''),
    text: String(record.text || ''),
    position,
    hoverPoint: normalizePoint(record.hoverPoint),
    htmlHint: String(record.htmlHint || ''),
    ...(typeof record.domOutline === 'string' ? { domOutline: record.domOutline.slice(0, 8000) } : {}),
    ...(Array.isArray(record.ancestors) ? { ancestors: record.ancestors.slice(0, 8)
      .filter((item): item is { tag: string; selector: string } => Boolean(item)
        && typeof item.tag === 'string' && typeof item.selector === 'string')
      .map((item) => ({ tag: item.tag.slice(0, 64), selector: item.selector.slice(0, 4096) })) } : {}),
    style: normalizeAnnotationStyle(record.style),
    selectionKind: 'element',
    isFormField: record.isFormField === true,
    ...(record.maskRects === null ? { maskRects: null }
      : Array.isArray(record.maskRects) && record.maskRects.length <= 200
        && record.maskRects.every((item) => Boolean(item) && typeof item === 'object'
          && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((item as Record<string, number>)[key]))
          && (item as { width: number; height: number }).width > 0
          && (item as { width: number; height: number }).height > 0)
        ? { maskRects: (record.maskRects as BrowserRect[])
          .map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height,
            ...(item.textHidden === true ? { textHidden: true } : {}) })) } : {}),
    ...(record.viewport && typeof record.viewport === 'object'
      && Number.isFinite((record.viewport as { width?: number }).width)
      && Number.isFinite((record.viewport as { height?: number }).height)
      ? { viewport: { width: (record.viewport as { width: number }).width,
        height: (record.viewport as { height: number }).height } } : {}),
  };
}

function normalizePosition(value: unknown): BrowserElementSnapshot['position'] | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const position = {
    x: finiteCoordinate(record.x),
    y: finiteCoordinate(record.y),
    width: finiteCoordinate(record.width),
    height: finiteCoordinate(record.height),
  };
  if (position.width <= 0 || position.height <= 0) return null;
  return position;
}

function normalizePoint(value: unknown): BrowserElementSnapshot['hoverPoint'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    x: finiteCoordinate(record.x),
    y: finiteCoordinate(record.y),
  };
}

function finiteCoordinate(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1_000_000, Math.min(1_000_000, Math.round(number)));
}

function normalizeAnnotationStyle(value: unknown): PreviewAnnotationStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const style: PreviewAnnotationStyle = {};
  for (const key of [
    'color',
    'backgroundColor',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'textAlign',
    'fontFamily',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderRadius',
    'opacity',
    'borderColor',
    'borderWidth',
    'width',
    'height',
    'marginTop',
    'marginRight',
    'marginBottom',
    'marginLeft',
  ] as Array<keyof PreviewAnnotationStyle>) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim()) style[key] = raw.trim();
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

// OpenDesign web clipper service worker.
//
// Library capture is zero-config on a loopback daemon. Project annotations
// use a separate one-time pairing code and a tab-scoped token held only in this
// service worker; Library's extension-origin bootstrap cannot authorize project
// operations. The daemon URL is configurable in the popup.
//
// The popup and the on-page toolbar both message this worker rather than
// talking to the daemon directly, so all daemon traffic lives in one place.

try {
  if (typeof importScripts === 'function') importScripts('i18n.js');
} catch {
  // The extension still works with English fallback if the helper cannot load.
}

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7456';
const ANNOTATION_MAX_NOTE = 2000;
const ANNOTATION_MAX_SELECTOR = 1024;
const ANNOTATION_MAX_CROP_BYTES = 256 * 1024;
const ANNOTATION_MAX_CROP_SIDE = 1200;
const ANNOTATION_REQUEST_TIMEOUT_MS = 5000;
const AUTH_HOSTS = [
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net',
  'login.microsoft.com', 'account.microsoft.com', 'mysignins.microsoft.com',
  'login.microsoftonline.us', 'login.chinacloudapi.cn',
  'accounts.google.com', 'sts.windows.net',
];
const ANNOTATION_AUTH_PATH = /(?:^|\/)(?:oauth2?|authorize|saml2?|callback|token)(?:\/|$)/i;
const ANNOTATION_CREDENTIAL_KEY = /(?:token|code|secret|password|passwd|key|credential|signature|sig|assertion|state|nonce|ticket|sso|authorization|session|jwt|bearer)/i;
const ANNOTATION_CREDENTIAL_VALUE = /(?:eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|\b(?:sk-|gh[opsur]_|AKIA)[A-Za-z0-9_-]{16,}\b|bearer\s+\S+)/i;

function annotationUrl(raw) {
  try {
    const url = new URL(raw);
    const allowedProtocol = url.protocol === 'https:' || (
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
    const path = decodeURIComponent(url.pathname);
    if (/%[0-9a-f]{2}/i.test(path)) return null; // Refuse ambiguous nested encoding.
    if (!allowedProtocol || url.username || url.password || AUTH_HOSTS.some((host) => (
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    )) || ANNOTATION_AUTH_PATH.test(path) || ANNOTATION_CREDENTIAL_VALUE.test(path)) return null;
    const query = [...url.searchParams];
    if (query.some(([key, value]) => /%[0-9a-f]{2}/i.test(key) || /%[0-9a-f]{2}/i.test(value))) return null;
    if (query.some(([key, value]) => ANNOTATION_CREDENTIAL_KEY.test(key) || ANNOTATION_CREDENTIAL_VALUE.test(value))) {
      url.search = '';
      for (const [key, value] of query) {
        if (!ANNOTATION_CREDENTIAL_KEY.test(key) && !ANNOTATION_CREDENTIAL_VALUE.test(value)) url.searchParams.append(key, value);
      }
    }
    if (url.hash) {
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (/%[0-9a-f]{2}/i.test(fragment)) return null;
      if (ANNOTATION_CREDENTIAL_VALUE.test(fragment)) url.hash = '';
      else if (fragment.includes('=')) {
        const parts = fragment.split(/[&?]/);
        if (parts.some((part) => ANNOTATION_CREDENTIAL_KEY.test(part.split('=', 1)[0] || ''))) {
          url.hash = parts.filter((part) => !ANNOTATION_CREDENTIAL_KEY.test(part.split('=', 1)[0] || '')).join('&');
        }
      } else if (ANNOTATION_CREDENTIAL_KEY.test(fragment)) url.hash = '';
    }
    return url.href.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
}

function annotationTab(tab) {
  if (!Number.isSafeInteger(tab?.id)) return null;
  const url = annotationUrl(tab.url);
  return url ? { id: tab.id, url, title: String(tab.title || '').slice(0, 256) } : null;
}

// Connection survives worker sleep. Tokens remain in extension-only session
// storage; screenshots stay memory-only and are discarded on navigation.
const annotationGrants = new Map();
const annotationEpochs = new Map();
const annotationCrops = new Map();
const annotationFrameRequests = new Map();
const annotationFrameAgents = new Map();
const annotationReviews = new Map();
const annotationIdentities = new Map();
const annotationCapturePending = new Map();
const annotationSubmitPending = new Set();
const inspectionPolls = new Map();
const inspectionDocuments = new Map();
const inspectionDocumentIds = new Map();
const inspectionLocks = new Set();
let inspectionGeneration = 0;
let annotationSave = Promise.resolve();
let annotationDiagnosticsEnabled = false;
let annotationDiagnosticEvents = [];
const ANNOTATION_BUILD = 'annotation-editable-20260930';
function recordAnnotationDiagnostic(operation, result, correlationId) {
  if (!annotationDiagnosticsEnabled) return;
  annotationDiagnosticEvents.push({ at: Date.now(), operation, correlationId,
    ok: result?.ok === true,
    ...(Number.isInteger(result?.status) ? { status: result.status } : {}),
    ...(typeof result?.serverBuild === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(result.serverBuild)
      ? { serverBuild: result.serverBuild } : {}),
    ...(typeof result?.correlated === 'boolean' ? { correlated: result.correlated } : {}),
    ...(typeof result?.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.id)
      ? { draftId: result.id } : {}),
    ...(typeof result?.conversationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.conversationId)
      ? { destinationId: result.conversationId } : {}),
  });
  annotationDiagnosticEvents = annotationDiagnosticEvents.slice(-100);
  void chrome.storage.session?.set({ annotationDiagnosticEvents });
}
const annotationDiagnosticsReady = (async () => {
  const saved = await chrome.storage.session?.get(['annotationDiagnosticsEnabled', 'annotationDiagnosticEvents']);
  annotationDiagnosticsEnabled = saved?.annotationDiagnosticsEnabled === true;
  if (annotationDiagnosticsEnabled && Array.isArray(saved.annotationDiagnosticEvents)) {
    annotationDiagnosticEvents = saved.annotationDiagnosticEvents.slice(-100).filter((event) =>
      event && typeof event.operation === 'string' && /^(?:odAnnotation:(pair|capture|submit|status)|server:(redeem|status|submit|revoke|poll|result))$/.test(event.operation)
      && Number.isFinite(event.at) && typeof event.correlationId === 'string'
      && /^[a-zA-Z0-9_-]{1,128}$/.test(event.correlationId)
      && typeof event.ok === 'boolean').map(({ at, operation, correlationId, ok, status, serverBuild, correlated, draftId, destinationId }) =>
      ({ at, operation, correlationId, ok, ...(Number.isInteger(status) ? { status } : {}),
        ...(typeof serverBuild === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(serverBuild) ? { serverBuild } : {}),
        ...(typeof correlated === 'boolean' ? { correlated } : {}),
        ...(typeof draftId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(draftId) ? { draftId } : {}),
        ...(typeof destinationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(destinationId) ? { destinationId } : {}),
      }));
  }
})().catch(() => {});
const annotationReady = (async () => {
  if (!chrome.storage.session) return;
  const saved = await chrome.storage.session.get('annotationConnections');
  for (const [tabId, grant] of saved.annotationConnections || []) {
    if (grant.expiresAt > Date.now()) {
      // Annotation status may rebind after navigation; inspection stays on the originally paired document.
      annotationGrants.set(tabId, { ...grant, inspectionDocumentId: grant.inspectionDocumentId || grant.documentId });
      if (!annotationEpochs.has(tabId)) annotationEpochs.set(tabId, grant.documentId);
    }
  }
})().catch(() => {});
function persistAnnotationConnections() {
  const entries = [...annotationGrants.entries()];
  annotationSave = annotationSave.catch(() => {}).then(() =>
    chrome.storage.session?.set({ annotationConnections: entries }));
  return annotationSave;
}
function discardAnnotationCrop(tabId, eventId) {
  const pending = annotationCapturePending.get(tabId);
  if (pending?.eventId === eventId) pending.cancelled = true;
  const crop = annotationCrops.get(tabId);
  if (crop?.eventId === eventId) annotationCrops.delete(tabId);
}
function annotationEpoch(tabId) {
  let epoch = annotationEpochs.get(tabId);
  if (!epoch) {
    epoch = crypto.randomUUID();
    annotationEpochs.set(tabId, epoch);
  }
  return epoch;
}
function clearAnnotationTab(tabId) {
  annotationFrameRequests.delete(tabId);
  annotationFrameAgents.delete(tabId);
  annotationReviews.delete(tabId);
  const grant = annotationGrants.get(tabId);
  const pending = annotationCapturePending.get(tabId);
  if (pending) pending.cancelled = true;
  annotationGrants.delete(tabId);
  inspectionDocuments.delete(tabId);
  inspectionDocumentIds.delete(tabId);
  inspectionPolls.delete(tabId);
  inspectionLocks.delete(tabId);
  inspectionGeneration += 1;
  annotationCrops.delete(tabId);
  annotationEpochs.delete(tabId);
  void persistAnnotationConnections();
  if (grant) {
    void annotationRequest('/api/edge-annotations/revoke', {
      token: grant.token,
      body: { grantId: grant.grantId, tabId, documentId: grant.documentId, url: grant.url },
    });
  }
}
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo?.url || changeInfo?.status === 'loading') {
    inspectionGeneration += 1;
    annotationFrameRequests.delete(tabId);
    annotationFrameAgents.delete(tabId);
    annotationReviews.delete(tabId);
    inspectionDocuments.delete(tabId);
    inspectionDocumentIds.delete(tabId);
    inspectionPolls.delete(tabId);
    inspectionLocks.delete(tabId);
    const pending = annotationCapturePending.get(tabId);
    if (pending) pending.cancelled = true;
    annotationCrops.delete(tabId);
    annotationEpochs.set(tabId, crypto.randomUUID());
  }
});
chrome.tabs.onActivated?.addListener(() => { inspectionGeneration += 1; });
chrome.windows.onFocusChanged?.addListener(() => { inspectionGeneration += 1; });
chrome.tabs.onRemoved?.addListener(clearAnnotationTab);
chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  clearAnnotationTab(addedTabId);
  clearAnnotationTab(removedTabId);
});

async function annotationRequest(path, { token, body, method = 'POST', daemonUrl = null } = {}) {
  daemonUrl ||= await getDaemonUrl();
  const parsed = new URL(daemonUrl);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, error: 'invalid local daemon URL' };
  }
  const correlation = annotationDiagnosticsEnabled ? crypto.randomUUID() : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANNOTATION_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, parsed), {
      method,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(correlation ? { 'x-od-annotation-correlation': correlation } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (correlation) {
      recordAnnotationDiagnostic(`server:${path.split('/').pop()}`, {
        ok: response.ok, status: response.status,
        serverBuild: response.headers?.get('x-od-annotation-build'),
        correlated: response.headers?.get('x-od-annotation-correlation') === correlation,
      }, correlation);
    }
    return response.ok && payload && typeof payload === 'object'
      ? { ok: true, ...payload }
      : { ok: false, status: response.status,
        error: payload?.error?.message || payload?.message || `HTTP ${response.status}` };
  } catch {
    if (correlation) recordAnnotationDiagnostic(`server:${path.split('/').pop()}`, { ok: false }, correlation);
    return { ok: false, error: 'Open Design is unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function grantForTab(tab) {
  const trustedTab = annotationTab(tab);
  const granted = annotationGrants.get(tab?.id);
  if (!trustedTab || !granted || granted.documentId !== annotationEpoch(tab.id)
    || granted.url !== trustedTab.url
    || granted.origin !== new URL(trustedTab.url).origin || granted.expiresAt <= Date.now()) {
    if (tab?.id) annotationGrants.delete(tab.id);
    return null;
  }
  return granted;
}

// Inspection does not inherit the more permissive annotation URL comparison:
// credentials in the original URL cannot be included in a remote read request.
function inspectionGrant(tab, expected) {
  const grant = annotationGrants.get(tab?.id);
  if (!grant || !tab || annotationUrl(tab.url) !== tab.url
    || !Number.isSafeInteger(tab.windowId) || !grant.projectId || !grant.grantId
    || grant.documentId !== grant.inspectionDocumentId
    || grant.documentId !== annotationEpochs.get(tab.id) || grant.url !== tab.url
    || grant.origin !== new URL(tab.url).origin || grant.expiresAt <= Date.now()
    || (expected && (grant !== expected.grant || tab.id !== expected.tabId
      || grant.documentId !== expected.documentId || grant.url !== expected.url
      || grant.origin !== expected.origin))) return null;
  return grant;
}

async function inspectionLive(expected, screenshot = false) {
  const tab = await chrome.tabs.get(expected.tabId).catch(() => null);
  if (!inspectionGrant(tab, expected)) throw new Error('Paired document changed');
  if (screenshot) {
    const window = await chrome.windows.get(tab.windowId).catch(() => null);
    const focusedTab = await chrome.tabs.get(expected.tabId).catch(() => null);
    if (!window?.focused || !tab.active || !focusedTab?.active
      || inspectionGeneration !== expected.generation
      || !inspectionGrant(focusedTab, expected)) throw new Error('Paired tab lost focus');
  }
  return tab;
}

async function inspectionDocument(expected) {
  const nonce = crypto.randomUUID();
  let timeout;
  const promise = new Promise((resolve) => {
    inspectionDocuments.set(expected.tabId, { nonce, resolve, grant: expected.grant });
    timeout = setTimeout(() => {
      if (inspectionDocuments.get(expected.tabId)?.nonce === nonce) {
        inspectionDocuments.delete(expected.tabId);
        resolve(null);
      }
    }, 1000);
  });
  try {
    await chrome.tabs.sendMessage(expected.tabId, { type: 'odInspect:identify', nonce }, { frameId: 0 });
    const documentId = await promise;
    if (!documentId || (inspectionDocumentIds.has(expected.tabId)
      && inspectionDocumentIds.get(expected.tabId) !== documentId)) throw new Error('Paired document changed');
    await inspectionLive(expected);
    inspectionDocumentIds.set(expected.tabId, documentId);
    return documentId;
  } finally {
    clearTimeout(timeout);
    if (inspectionDocuments.get(expected.tabId)?.nonce === nonce) inspectionDocuments.delete(expected.tabId);
  }
}

async function inspectionRead(expected, operation, selector) {
  const screenshot = operation === 'screenshot';
  await inspectionLive(expected, screenshot);
  const documentId = await inspectionDocument(expected);
  await inspectionLive(expected, screenshot);
  if (screenshot) {
    const safety = await chrome.tabs.sendMessage(expected.tabId,
      { type: 'odInspect:screenshotReady', url: expected.url }, { documentId });
    if (!safety?.ok) throw new Error(safety?.error || 'Screenshot unavailable');
    const masks = safety.maskRects;
    const viewportWidth = safety.viewportWidth;
    const viewportHeight = safety.viewportHeight;
    if (!Array.isArray(masks) || masks.length > 200
      || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
      || viewportWidth <= 0 || viewportHeight <= 0) throw new Error('Screenshot mask unavailable');
    const tab = await inspectionLive(expected, true);
    const hidden = await chrome.tabs.sendMessage(tab.id, { type: 'odClipper:hideForCapture' }, { documentId });
    try {
      if (!hidden?.ok) throw new Error('Screenshot unavailable');
      await inspectionLive(expected, true);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      await inspectionLive(expected, true);
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
        || dataUrl.length > 4 * Math.ceil(1024 * 1024 / 3) + 22) {
        throw new Error('Screenshot too large');
      }
      const after = await chrome.tabs.sendMessage(tab.id,
        { type: 'odInspect:screenshotReady', url: expected.url }, { documentId });
      if (!after?.ok || after.viewportWidth !== viewportWidth
        || after.viewportHeight !== viewportHeight
        || JSON.stringify(after.maskRects) !== JSON.stringify(masks)) {
        throw new Error('Screenshot masks changed during capture');
      }
      return { dataUrl: await maskScreenshot(dataUrl, masks, viewportWidth, viewportHeight) };
    } finally {
      await chrome.tabs.sendMessage(tab.id, { type: 'odClipper:restoreAfterCapture' }, { documentId }).catch(() => {});
      await inspectionLive(expected, true);
    }
  }
  const response = await chrome.tabs.sendMessage(expected.tabId,
    { type: 'odInspect:read', operation, selector, url: expected.url }, { documentId });
  await inspectionLive(expected);
  if (!response?.ok || !response.result || response.result.url !== expected.url
    || typeof response.result.html !== 'string'
    || response.result.html.length > 450 * 1024) throw new Error('Document read unavailable');
  return response.result;
}

async function inspectionPoll(tabId) {
  await annotationReady;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const grant = inspectionGrant(tab);
  if (!grant || inspectionLocks.has(tabId)) return;
  inspectionLocks.add(tabId);
  const expected = { grant, tabId, documentId: grant.documentId, url: grant.url,
    origin: grant.origin, generation: inspectionGeneration };
  const loop = (async () => {
    while (inspectionGrant(await chrome.tabs.get(tabId).catch(() => null), expected)) {
      const identity = { projectId: grant.projectId, grantId: grant.grantId,
        tabId, documentId: grant.documentId, url: grant.url };
      const poll = await annotationRequest('/api/edge-annotations/inspect/poll',
        { token: grant.token, body: identity });
      if (!inspectionGrant(await chrome.tabs.get(tabId).catch(() => null), expected)) break;
      if (!poll.ok && poll.error !== 'Open Design is unavailable') break;
      const request = poll.request && typeof poll.request === 'object' ? poll.request : poll;
      if (poll.ok && request && typeof request.requestId === 'string'
        && /^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId)) {
        const readExpected = { ...expected, generation: inspectionGeneration };
        let reply;
        try {
          if (!['screenshot', 'snapshot', 'inspect'].includes(request.operation)) throw new Error('Unsupported read');
          const result = await inspectionRead(readExpected, request.operation, request.selector);
          await inspectionLive(readExpected, request.operation === 'screenshot');
          reply = { requestId: request.requestId, ok: true, result };
        } catch (error) {
          reply = { requestId: request.requestId, ok: false, error: error?.message || 'Read unavailable' };
        }
        if (!inspectionGrant(await chrome.tabs.get(tabId).catch(() => null), expected)) break;
        if (request.operation === 'screenshot') {
          try { await inspectionLive(readExpected, true); }
          catch { reply = { requestId: request.requestId, ok: false, error: 'Paired tab lost focus' }; }
        }
        await annotationRequest('/api/edge-annotations/inspect/result',
          { token: grant.token, body: { ...identity, ...reply } });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  inspectionPolls.set(tabId, loop);
  void loop.finally(() => {
    if (inspectionPolls.get(tabId) === loop) {
      inspectionPolls.delete(tabId);
      inspectionLocks.delete(tabId);
    }
  });
}

function annotationEvidenceText(value, max, multiline = false) {
  if (typeof value !== 'string'
    || /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|session|credential|otp|one.time|auth.code|bearer)(?:\s*=\s*\S{6,}|\s*:\s*\S{6,}(?=\s*(?:$|[\n;,])))/i.test(value)) return '';
  return value.replace(/[<>\u0000-\u0009\u000b-\u001f]/g, '')
    .replace(/\n/g, multiline ? '\n' : ' ').slice(0, max);
}

// Mirrors the pure contracts scope whitelist; browser document IDs stay worker-only.
function annotationScope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !['top', 'child'].includes(raw.frame) || !['document', 'open-shadow'].includes(raw.selectorRoot)
    || raw.screenshot !== 'not-supported' || annotationUrl(raw.url) !== raw.url
    || !Array.isArray(raw.shadowHosts) || raw.shadowHosts.length > 8
    || raw.shadowHosts.some(host => typeof host !== 'string' || !host || host.length > 512
      || !/^[a-zA-Z0-9\s>:+\-().,#_\[\]]*$/.test(host))
    || (raw.selectorRoot === 'open-shadow') !== (raw.shadowHosts.length > 0)) return null;
  return { frame: raw.frame, url: raw.url, selectorRoot: raw.selectorRoot,
    shadowHosts: [...raw.shadowHosts], screenshot: 'not-supported' };
}
function annotationSender(sender) {
  return sender?.id === chrome.runtime.id && Number.isSafeInteger(sender?.tab?.id)
    && Number.isSafeInteger(sender.frameId) && sender.frameId >= 0
    && typeof sender.documentId === 'string' && sender.documentId.length > 0
    && typeof sender.url === 'string' && Boolean(annotationUrl(sender.url));
}
function sameAnnotationSender(sender, expected) {
  return annotationSender(sender) && sender.tab.id === expected.tabId
    && sender.frameId === expected.frameId && sender.documentId === expected.documentId
    && sender.url === expected.url;
}
function annotationSenderIdentity(sender) {
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, url: sender.url };
}
async function verifyAnnotationDocument(expected) {
  const nonce = crypto.randomUUID();
  let resolve;
  const acknowledgment = new Promise(done => { resolve = done; });
  const timer = setTimeout(() => resolve(false), 3000);
  annotationIdentities.set(nonce, { expected, resolve });
  try {
    const reply = await chrome.tabs.sendMessage(expected.tabId,
      { type: 'odAnnotation:identify', nonce }, { documentId: expected.documentId });
    if (!reply?.ok) return false;
    return await acknowledgment;
  } catch { return false; }
  finally { clearTimeout(timer); annotationIdentities.delete(nonce); }
}
async function annotationFrameRequest(sender) {
  if (!annotationSender(sender) || sender.frameId !== 0) return { ok: false };
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  const grant = grantForTab(tab);
  const parent = annotationSenderIdentity(sender);
  if (!grant || tab.url !== sender.url || !await verifyAnnotationDocument(parent)
    || grantForTab(await chrome.tabs.get(tab.id)) !== grant) return { ok: false };
  const nonce = crypto.randomUUID();
  annotationFrameRequests.set(tab.id, { nonce, parent, grant, epoch: grant.documentId, expiresAt: Date.now() + 3000 });
  return { ok: true, nonce };
}
async function annotationFrameIdentity(message, sender) {
  const pending = annotationFrameRequests.get(sender?.tab?.id);
  if (!pending || pending.nonce !== message.nonce || pending.expiresAt <= Date.now()
    || !annotationSender(sender) || sender.frameId === 0 || sender.url !== message.url
    || pending.child || grantForTab(await chrome.tabs.get(sender.tab.id)) !== pending.grant
    || annotationEpochs.get(sender.tab.id) !== pending.epoch) return { ok: false };
  pending.child = annotationSenderIdentity(sender);
  pending.proof = crypto.randomUUID();
  return { ok: true, proof: pending.proof };
}
async function annotationFrameConfirm(message, sender) {
  const pending = annotationFrameRequests.get(sender?.tab?.id);
  if (!pending || pending.nonce !== message.nonce || pending.expiresAt <= Date.now()
    || !sameAnnotationSender(sender, pending.parent) || !pending.child
    || message.proof !== pending.proof) return { ok: false };
  annotationFrameRequests.delete(sender.tab.id); // One-use discovery, never a bearer capability.
  if (!await verifyAnnotationDocument(pending.parent) || !await verifyAnnotationDocument(pending.child)
    || grantForTab(await chrome.tabs.get(sender.tab.id)) !== pending.grant
    || annotationEpochs.get(sender.tab.id) !== pending.epoch) return { ok: false };
  const agent = { ...pending.child, parent: pending.parent, grant: pending.grant, epoch: pending.epoch };
  annotationFrameAgents.set(sender.tab.id, agent);
  const armed = await chrome.tabs.sendMessage(sender.tab.id, { type: 'odAnnotation:arm' },
    { documentId: agent.documentId }).catch(() => null);
  if (!armed?.ok) annotationFrameAgents.delete(sender.tab.id);
  return { ok: armed?.ok === true };
}
async function reviewAnnotation(message, sender) {
  if (!annotationSender(sender) || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.eventId || '')) return { ok: false };
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  const grant = grantForTab(tab);
  const agent = sender.frameId === 0 ? null : annotationFrameAgents.get(sender.tab.id);
  if (!grant || (agent && (agent.grant !== grant || agent.epoch !== grant.documentId))
    || (sender.frameId !== 0 && (!agent || !sameAnnotationSender(sender, agent)))) return { ok: false };
  const identity = annotationSenderIdentity(sender);
  const scope = annotationScope(message.target?.scope);
  if (!scope || scope.frame !== (sender.frameId === 0 ? 'top' : 'child')
    || scope.url !== annotationUrl(sender.url) || (sender.frameId === 0 && sender.url !== tab.url)
    || !await verifyAnnotationDocument(identity)) return { ok: false };
  const target = annotationTarget(message.target, { url: scope.url, title: message.target.title });
  const pending = annotationReviews.get(sender.tab.id);
  if (!target || (pending && pending.eventId !== message.eventId)) return { ok: false };
  annotationReviews.set(sender.tab.id, { identity, parent: agent?.parent, eventId: message.eventId,
    grant, epoch: grant.documentId, target: JSON.stringify(target) });
  return { ok: true };
}
async function scopedAnnotationReview(message, sender, grant) {
  const review = annotationReviews.get(sender?.tab?.id);
  if (!review || review.grant !== grant || review.epoch !== grant.documentId
    || review.eventId !== message.eventId || !sameAnnotationSender(sender, review.identity)
    || !await verifyAnnotationDocument(review.identity)
    || (review.parent && !await verifyAnnotationDocument(review.parent))) return null;
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (grantForTab(tab) !== grant || annotationEpochs.get(sender.tab.id) !== review.epoch) return null;
  const target = annotationTarget(message.target,
    { url: annotationUrl(review.identity.url), title: message.target?.title });
  return target && JSON.stringify(target) === review.target ? target : null;
}

function annotationTarget(raw, tab) {
  if (!raw || typeof raw !== 'object' || raw.url !== tab.url) return null;
  const selector = typeof raw.selector === 'string' ? raw.selector : '';
  if (!selector || selector.length > ANNOTATION_MAX_SELECTOR
    || /[<\u0000-\u001f]/.test(selector)) return null;
  const position = raw.position;
  if (!position || typeof position !== 'object' || !['x', 'y', 'width', 'height'].every((key) => (
    Number.isFinite(position[key]) && position[key] >= 0 && position[key] <= 100_000
  ))) return null;
  const text = annotationEvidenceText(raw.text, 300);
  const domOutline = annotationEvidenceText(raw.domOutline, 1200, true);
  if (typeof raw.htmlHint !== 'string' || raw.htmlHint.length > 120
    || /[<>\u0000-\u001f]/.test(raw.htmlHint)) return null;
  const label = annotationEvidenceText(raw.label, 160);
  const htmlHint = raw.htmlHint;
  const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.slice(0, 8).map((item) => {
    if (!item || !/^[a-z][a-z0-9-]*$/i.test(item.tag)
      || typeof item.selector !== 'string' || !item.selector || item.selector.length > 512
      || !/^[a-zA-Z0-9\s>:+\-().,#_\[\]]*$/.test(item.selector)) return null;
    return { tag: item.tag, selector: item.selector,
      ...(typeof item.role === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(item.role)
        ? { role: item.role } : {}) };
  }).filter(Boolean) : [];
  const style = {};
  for (const key of [
    'color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight',
    'fontFamily', 'textAlign', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderRadius',
  ]) {
    const value = raw.style?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 160
      && !/[<>\r\n]/.test(value)) style[key] = value;
  }
  const scope = raw.scope === undefined ? undefined : annotationScope(raw.scope);
  if (raw.scope !== undefined && !scope) return null;
  return { url: tab.url, title: tab.title, selector, label, text, domOutline, position,
    ...(scope ? { scope } : {}),
    htmlHint, ancestors, style };
}

async function captureAnnotationCrop(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isSafeInteger(tabId) || sender.frameId !== 0) {
    return { ok: false, error: 'Annotation tab changed' };
  }
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentTab || sender.tab.url !== currentTab.url) {
    return { ok: false, error: 'Annotation tab changed' };
  }
  await annotationStatus(currentTab);
  const tab = annotationTab(currentTab);
  const grant = grantForTab(currentTab);
  const target = tab && annotationTarget(message.target, tab);
  const eventId = message.eventId;
  if (!tab || !grant || !target || typeof eventId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(eventId)
    || !Number.isSafeInteger(currentTab.windowId) || !currentTab.active
    || !Number.isFinite(message.viewportWidth) || !Number.isFinite(message.viewportHeight)
    || message.viewportWidth <= 0 || message.viewportHeight <= 0
    || !Number.isFinite(message.scrollX) || !Number.isFinite(message.scrollY)
    || !message.rect || ![message.rect.x, message.rect.y,
      message.rect.width, message.rect.height].every(Number.isFinite)
    || message.rect.x < 0 || message.rect.y < 0
    || message.rect.width <= 0 || message.rect.height <= 0
    || message.rect.x + message.rect.width > message.viewportWidth
    || message.rect.y + message.rect.height > message.viewportHeight
    || !Array.isArray(message.maskRects) || message.maskRects.length > 200
    || message.maskRects.some((mask) => !mask || ![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite)
      || mask.width <= 0 || mask.height <= 0 || mask.x < message.rect.x || mask.y < message.rect.y
      || mask.x + mask.width > message.rect.x + message.rect.width
      || mask.y + mask.height > message.rect.y + message.rect.height)) {
    return { ok: false, error: 'Annotation tab is not ready for screenshot' };
  }
  const documentId = grant.documentId;
  const originalUrl = currentTab.url;
  const reviewedTarget = JSON.stringify(target);
  const currentCrop = annotationCrops.get(tabId);
  if (currentCrop && currentCrop.eventId !== eventId) return { ok: false, error: 'Another annotation is pending' };
  if (annotationCapturePending.has(tabId)) return { ok: false, error: 'Another screenshot is pending' };
  annotationCrops.delete(tabId);
  const lease = { eventId, cancelled: false };
  annotationCapturePending.set(tabId, lease);
  // Content script must have torn down its picker. Await its paint acknowledgment
  // before capturing, then restore the optional on-page bar in all cases.
  try {
    const hidden = await sendToTab(tabId, { type: 'odClipper:hideForCapture',
      annotation: { url: originalUrl, selector: target.selector, rect: message.rect,
        maskRects: message.maskRects } });
    if (!hidden?.ok || lease.cancelled) throw new Error('Could not hide annotation controls');
    const before = await chrome.tabs.get(tabId);
    if (!before.active || before.url !== originalUrl || !grantForTab(before)
      || lease.cancelled || annotationEpochs.get(tabId) !== documentId) throw new Error('Annotation tab changed');
    const pixels = await chrome.tabs.captureVisibleTab(before.windowId, { format: 'png' });
    const verified = await sendToTab(tabId, { type: 'odClipper:verifyAfterCapture',
      annotation: { url: originalUrl, selector: target.selector, rect: message.rect,
        maskRects: message.maskRects, viewportWidth: message.viewportWidth,
        viewportHeight: message.viewportHeight, scrollX: message.scrollX, scrollY: message.scrollY } });
    if (!verified?.ok) throw new Error('Page moved during screenshot');
    const after = await chrome.tabs.get(tabId);
    if (!after.active || after.url !== originalUrl || !grantForTab(after)
      || lease.cancelled || annotationEpochs.get(tabId) !== documentId) throw new Error('Annotation tab changed');
    const [page] = await chrome.scripting.executeScript({ target: { tabId },
      func: () => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }) });
    if (!page?.result || page.result.width !== message.viewportWidth
      || page.result.height !== message.viewportHeight
      || page.result.x !== message.scrollX || page.result.y !== message.scrollY) {
      throw new Error('Page moved during screenshot');
    }
    const cropDataUrl = await cropAnnotationScreenshot(pixels, message.rect,
      message.viewportWidth, message.viewportHeight, message.maskRects);
    // Never accept a crop from another tab/document after async bitmap work.
    const finalTab = await chrome.tabs.get(tabId);
    if (!finalTab.active || finalTab.url !== originalUrl
      || annotationEpochs.get(tabId) !== documentId || !grantForTab(finalTab)
      || lease.cancelled || annotationCapturePending.get(tabId) !== lease) {
      throw new Error('Annotation tab changed or screenshot discarded');
    }
    annotationCrops.set(tabId, { eventId, cropDataUrl, documentId, url: tab.url,
      originalUrl, reviewedTarget, scrollX: message.scrollX, scrollY: message.scrollY });
    return { ok: true, cropDataUrl, textHidden: message.maskRects.some((mask) => mask.textHidden === true) };
  } catch (error) {
    return { ok: false, error: error?.message || 'Screenshot failed' };
  } finally {
    if (annotationCapturePending.get(tabId) === lease) annotationCapturePending.delete(tabId);
    await sendToTab(tabId, { type: 'odClipper:restoreAfterCapture' });
  }
}

async function annotationStatus(tab) {
  const liveTab = tab?.id && await chrome.tabs.get(tab.id).catch(() => null);
  await annotationReady;
  const current = annotationTab(liveTab);
  const granted = annotationGrants.get(liveTab?.id);
  if (!current || !granted || granted.expiresAt <= Date.now()
    || new URL(current.url).origin !== granted.origin) return { ok: false, error: 'not paired' };
  const response = await annotationRequest('/api/edge-annotations/status', {
    token: granted.token,
    body: {
      projectId: granted.projectId, grantId: granted.grantId, tabId: liveTab.id,
      documentId: annotationEpoch(liveTab.id), url: current.url,
    },
  });
  if (!response.ok || response.grant?.grantId !== granted.grantId
    || response.grant?.projectId !== granted.projectId
    || response.grant?.tabId !== liveTab.id
    || response.grant?.documentId !== annotationEpoch(liveTab.id)) {
    if (response.error !== 'Open Design is unavailable') {
      annotationGrants.delete(liveTab.id);
      await persistAnnotationConnections();
    }
    return { ok: false, error: response.error || 'not paired' };
  }
  if ((await chrome.tabs.get(liveTab.id).catch(() => null))?.url !== liveTab.url) return { ok: false, error: 'tab changed' };
  Object.assign(granted, { documentId: response.grant.documentId, url: current.url,
    conversationId: response.grant.conversationId,
    projectName: response.projectName || granted.projectName,
    conversationName: response.conversationName || granted.conversationName,
    chatUrl: response.chatUrl || granted.chatUrl });
  await persistAnnotationConnections();
  void inspectionPoll(liveTab.id);
  return { ok: true, projectId: granted.projectId, projectName: granted.projectName || '',
    conversationId: granted.conversationId, conversationName: granted.conversationName || '', chatUrl: granted.chatUrl };

}
const I18N = globalThis.OD_CLIPPER_I18N;
const currentLocale = () => (I18N?.currentLocale ? I18N.currentLocale() : 'en');
const t = (key, vars) => (I18N?.t ? I18N.t(key, vars, currentLocale()) : key);

async function getDaemonUrl() {
  const { daemonUrl } = await chrome.storage.local.get(['daemonUrl']);
  return daemonUrl || DEFAULT_DAEMON_URL;
}

// Is OpenDesign running and reachable? We probe the narrow clipper route the
// daemon auto-trusts for extension origins and treat any 2xx as connected.
async function probe() {
  const daemonUrl = await getDaemonUrl();
  try {
    const resp = await fetch(`${daemonUrl}/api/library/clipper-probe`, { method: 'GET' });
    return resp.ok;
  } catch {
    return false;
  }
}

async function ingest(body) {
  const daemonUrl = await getDaemonUrl();
  let resp;
  try {
    resp = await fetch(`${daemonUrl}/api/library/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Network-level failure → the daemon almost certainly isn't running.
    throw new Error('not running');
  }
  if (!resp.ok) {
    // 413 means the capture is bigger than the daemon will accept — surface a
    // concise, actionable message instead of the server's full HTML error page.
    if (resp.status === 413) {
      throw new Error(t('errorCaptureTooLarge'));
    }
    const raw = await resp.text().catch(() => '');
    // Strip any HTML (Express error pages) and collapse whitespace so the popup
    // never shows a wall of markup.
    const snippet = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`ingest ${resp.status}${snippet ? `: ${snippet}` : ''}`);
  }
  return resp.json();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab;
}

// Best-effort message to a tab's content script. Resolves regardless of whether
// a receiver exists (e.g. chrome:// pages have no content script).
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (res) => {
        void chrome.runtime.lastError; // swallow "no receiving end"
        resolve(res);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function captureScreenshot() {
  const tab = await activeTab();
  // Pull our own on-page bar out of frame so it never lands in the screenshot.
  await sendToTab(tab.id, { type: 'odClipper:hideForCapture' });
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    await sendToTab(tab.id, { type: 'odClipper:restoreAfterCapture' });
  }
  return ingest({
    dataUrl,
    kind: 'image',
    sourceUrl: tab.url,
    sourceTitle: tab.title,
    tags: ['screenshot'],
  });
}

// Runs in the page context (serialized by executeScript) — keep self-contained.
function collectImages() {
  const out = [];
  const seen = new Set();
  for (const el of document.images) {
    const src = el.currentSrc || el.src;
    if (!src || seen.has(src)) continue;
    if (!/^https?:/i.test(src)) continue;
    if ((el.naturalWidth || 0) < 64 || (el.naturalHeight || 0) < 64) continue;
    seen.add(src);
    out.push({ src, alt: el.alt || '' });
  }
  return out;
}

async function grabImages() {
  const tab = await activeTab();
  const [first] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectImages,
  });
  const images = Array.isArray(first?.result) ? first.result.slice(0, 30) : [];
  let count = 0;
  for (const img of images) {
    try {
      await ingest({ url: img.src, kind: 'image', sourceUrl: tab.url, sourceTitle: img.alt || tab.title });
      count += 1;
    } catch {
      // skip individual failures (hotlink-protected / oversized)
    }
  }
  return { count, total: images.length };
}

// --- page capture (high-fidelity HTML + Figma IR) --------------------------
//
// capture.js runs in the page and returns the snapshot with cross-origin
// resource URLs left intact; only the service worker can fetch those without
// CORS, so it does the fetch-and-inline pass here. One fetch per resource feeds
// both the HTML string and the Figma IR's image fills.

// Page captures inline cross-origin resources as base64 data URIs into both the
// HTML and the Figma IR before one JSON POST to the daemon (128MB ingest limit).
// To make a capture ALWAYS fit — even an image-heavy news front page — we:
//   1. compress large raster images (downscale + WebP) before inlining,
//   2. inline smallest-first within a fixed budget, leaving the largest as live
//      URLs (the HTML skeleton + styles are preserved either way),
//   3. drop the secondary Figma IR if the combined body would still be too big,
// so the HTML page itself can never fail to save.
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024; // per-resource fetch ceiling
const MAX_TOTAL_INLINE_BYTES = 40 * 1024 * 1024; // total inlined data-URI budget
const SAFE_BODY_BYTES = 100 * 1024 * 1024; // drop the Figma IR past this body size

// Raster images above the threshold are re-encoded smaller; vectors (SVG),
// animations (GIF), small icons, and non-images are left untouched.
const COMPRESSIBLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp']);
const IMAGE_COMPRESS_OVER_BYTES = 150 * 1024;
const MAX_IMAGE_DIM = 2000;
const COMPRESS_MIME = 'image/webp';
const COMPRESS_QUALITY = 0.8;

// Service workers have no FileReader/createObjectURL — base64 the bytes by hand.
function bytesToDataUri(bytes, mime) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// Re-encode a large raster image to a smaller, downscaled WebP so an image-heavy
// page's inlined payload stays small enough to always ingest. Service workers
// expose createImageBitmap + OffscreenCanvas, and because we fetched the bytes
// ourselves (not read them off a cross-origin <img>) the canvas isn't tainted,
// so convertToBlob works. Returns a data URI, or null to fall back to the
// original (decode failed, or re-encoding wasn't actually smaller).
async function compressImageToDataUri(buf, originalBase64Len) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buf]), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: COMPRESS_MIME, quality: COMPRESS_QUALITY });
    const dataUri = bytesToDataUri(new Uint8Array(await blob.arrayBuffer()), COMPRESS_MIME);
    return dataUri.length < originalBase64Len ? dataUri : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

async function fetchAsDataUri(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(String(resp.status));
  const declared = Number(resp.headers.get('content-length') || '0');
  if (declared && declared > MAX_RESOURCE_BYTES) throw new Error('too large');
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_RESOURCE_BYTES) throw new Error('too large');
  const mime = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  if (COMPRESSIBLE_MIMES.has(mime) && buf.byteLength > IMAGE_COMPRESS_OVER_BYTES) {
    const approxBase64Len = Math.ceil(buf.byteLength / 3) * 4;
    const compressed = await compressImageToDataUri(buf, approxBase64Len);
    if (compressed) return compressed;
  }
  return bytesToDataUri(new Uint8Array(buf), mime);
}

// Run an async fn over items with a bounded number in flight at once. Decoding
// and re-encoding images is memory-hungry, so a 300-image page must not fan all
// of them out at once or the service worker can OOM mid-capture.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function buildResourceMap(urls, includeImages) {
  const map = new Map();
  let skipped = 0;
  if (!includeImages || !Array.isArray(urls) || !urls.length) return { map, skipped };
  // Fetch (and compress) every candidate, then inline SMALLEST-FIRST until the
  // budget is spent — so we keep the most images and the ones we drop (left as
  // live URLs) are the largest. This bounds the inlined total by construction,
  // so the page's images can never push the body over the ingest limit.
  const candidates = await mapWithConcurrency(urls, 6, async (url) => {
    try {
      const dataUri = await fetchAsDataUri(url);
      return { url, dataUri, size: dataUri.length };
    } catch {
      return null; // hotlink-protected / oversized / offline — leave the URL
    }
  });
  let used = 0;
  for (const c of candidates.filter(Boolean).sort((a, b) => a.size - b.size)) {
    if (used + c.size > MAX_TOTAL_INLINE_BYTES) {
      skipped += 1; // budget spent — this (larger) resource stays a live URL
      continue;
    }
    used += c.size;
    map.set(c.url, c.dataUri);
  }
  return { map, skipped };
}

function inlineHtml(html, map) {
  let out = html;
  for (const [url, data] of map) out = out.split(url).join(data);
  return out;
}

function inlineFigmaIr(ir, map) {
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.fills)) {
      node.fills = node.fills
        .map((f) => {
          if (f && f.type === 'IMAGE' && f.url) {
            const data = map.get(f.url);
            return data ? { type: 'IMAGE', scaleMode: f.scaleMode || 'FILL', dataUri: data } : null;
          }
          return f;
        })
        .filter(Boolean);
      if (!node.fills.length) delete node.fills;
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  if (ir && ir.root) walk(ir.root);
  return ir;
}

function slugify(title) {
  const slug = String(title || '')
    .slice(0, 60)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'capture';
}

// Run capture.js in the active tab and inline its cross-origin resources.
async function capturePage(opts) {
  const includeImages = !opts || opts.includeImages !== false;
  const tab = await activeTab();
  // No hideForCapture here: this is a DOM/IR snapshot, not a pixel screenshot,
  // and capture.js already strips our own on-page UI by id ([id^="od-clipper-"])
  // from both the HTML clone and the Figma IR. So the bar stays put and keeps
  // showing its in-progress strip through the whole (often slow) snapshot —
  // hiding it here is what used to make the toolbar vanish mid-capture.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
  const [out] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (o) => window.__odCapture(o),
    args: [{ includeImages }],
  });
  const cap = out && out.result;
  if (!cap || !cap.html) throw new Error('capture failed');
  const { map, skipped } = await buildResourceMap(cap.resources, includeImages);
  return {
    html: inlineHtml(cap.html, map),
    figmaIr: cap.figmaIr ? inlineFigmaIr(cap.figmaIr, map) : null,
    figmaNodeCount: cap.figmaNodeCount || 0,
    truncated: Boolean(cap.figmaTruncated),
    partialImages: skipped, // resources left as live URLs to fit the size budget
    title: cap.title || tab.title,
    url: cap.url || tab.url,
  };
}

async function capturePageToLibrary(opts) {
  const cap = await capturePage(opts);
  let figmaCapture = cap.figmaIr ? JSON.stringify(cap.figmaIr) : undefined;
  // The HTML page is the primary artifact. The Figma IR carries the same inlined
  // images a second time, so if pairing the two would push the body past the
  // safe ingest size, drop the IR — the page itself then always saves.
  let figmaDropped = false;
  if (figmaCapture && cap.html.length + figmaCapture.length > SAFE_BODY_BYTES) {
    figmaCapture = undefined;
    figmaDropped = true;
  }
  const r = await ingest({
    text: cap.html,
    kind: 'html',
    mime: 'text/html',
    sourceUrl: cap.url,
    sourceTitle: cap.title,
    tags: ['page-capture'],
    figmaCapture,
    figmaNodeCount: figmaCapture ? cap.figmaNodeCount : 0,
  });
  return {
    deduped: Boolean(r.deduped),
    hasFigma: Boolean(figmaCapture),
    truncated: cap.truncated,
    partialImages: cap.partialImages || 0,
    figmaDropped,
  };
}

async function downloadFigma(opts) {
  const cap = await capturePage(opts);
  if (!cap.figmaIr) throw new Error('no figma capture produced');
  const json = JSON.stringify(cap.figmaIr, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  await chrome.downloads.download({
    url: dataUrl,
    filename: `${slugify(cap.title)}.od-figma.json`,
    saveAs: false,
  });
  return { truncated: cap.truncated, partialImages: cap.partialImages || 0 };
}

// --- design-system capture -------------------------------------------------
//
// brand-capture.js does not snapshot the page. It extracts brand/product
// signals and fills a stable HTML template, then the worker inlines the
// discovered logos/images/fonts exactly like the full-page capture path.

async function captureDesignSystem(opts) {
  const includeImages = !opts || opts.includeImages !== false;
  const tab = await activeTab();
  const locale = currentLocale();
  // No hideForCapture: brand-capture.js reads the page through the light DOM
  // (our toolbar lives in a shadow root it can't see) and skips any
  // [id^="od-clipper-"] node, so the bar stays visible with its progress strip
  // through the whole extraction instead of disappearing for several seconds.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['i18n.js', 'brand-capture.js'] });
  const [out] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (captureLocale) => window.__odBrandCapture({ locale: captureLocale }),
    args: [locale],
  });
  const cap = out && out.result;
  if (!cap || !cap.html) throw new Error(t('errorDesignSystemCaptureFailed'));
  const { map, skipped } = await buildResourceMap(cap.resources, includeImages);
  return {
    html: inlineHtml(cap.html, map),
    partialImages: skipped,
    title: cap.title || t('brandFileTitle', { title: tab.title || t('brandFallbackTitle') }),
    url: cap.url || tab.url,
    summary: cap.summary || {},
  };
}

async function captureDesignSystemToLibrary(opts) {
  const cap = await captureDesignSystem(opts);
  const r = await ingest({
    text: cap.html,
    kind: 'design-system',
    mime: 'text/html',
    sourceUrl: cap.url,
    sourceTitle: cap.title,
    tags: ['design-system', 'brand-capture'],
    metadata: {
      designSystemCapture: {
        version: 1,
        capturedAt: Date.now(),
        ...cap.summary,
      },
    },
  });
  return { deduped: Boolean(r.deduped), partialImages: cap.partialImages || 0 };
}

// --- element + selected-image capture --------------------------------------

// Blob → base64 data URL (service workers have no FileReader).
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

// Annotation-only crop: screenshot bytes stay in worker memory until the user
// confirms. Full-tab pixels never enter the daemon, Library, or page scripts.
async function maskScreenshot(dataUrl, masks, viewportWidth, viewportHeight) {
  const source = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot mask unavailable');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#7f7f7f';
    for (const mask of masks) {
      if (!mask || ![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite)
        || mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0
        || mask.x + mask.width > viewportWidth || mask.y + mask.height > viewportHeight) {
        throw new Error('Screenshot mask is invalid');
      }
      const x0 = Math.max(0, Math.floor(mask.x * bitmap.width / viewportWidth));
      const y0 = Math.max(0, Math.floor(mask.y * bitmap.height / viewportHeight));
      const x1 = Math.min(bitmap.width, Math.ceil((mask.x + mask.width) * bitmap.width / viewportWidth));
      const y1 = Math.min(bitmap.height, Math.ceil((mask.y + mask.height) * bitmap.height / viewportHeight));
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    const masked = await canvas.convertToBlob({ type: 'image/png' });
    if (masked.size > 1024 * 1024 || masked.size === 0) throw new Error('Screenshot too large');
    return blobToDataUrl(masked);
  } finally {
    bitmap.close();
  }
}

async function cropAnnotationScreenshot(tabDataUrl, rect, viewportWidth, viewportHeight, maskRects) {
  if (!/^data:image\/png;base64,/.test(tabDataUrl) || !rect
    || ![rect.x, rect.y, rect.width, rect.height, viewportWidth, viewportHeight].every(Number.isFinite)
    || viewportWidth <= 0 || viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Screenshot crop is unavailable');
  }
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewportWidth, rect.x + rect.width);
  const bottom = Math.min(viewportHeight, rect.y + rect.height);
  if (right - left < 2 || bottom - top < 2) throw new Error('Element is outside the visible viewport');
  const source = await (await fetch(tabDataUrl)).blob();
  const bitmap = await createImageBitmap(source);
  try {
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    const x0 = Math.max(0, Math.min(bitmap.width - 1, Math.floor(left * scaleX)));
    const y0 = Math.max(0, Math.min(bitmap.height - 1, Math.floor(top * scaleY)));
    const x1 = Math.min(bitmap.width, Math.ceil(right * scaleX));
    const y1 = Math.min(bitmap.height, Math.ceil(bottom * scaleY));
    if (x1 <= x0 || y1 <= y0) throw new Error('Element crop is outside the screenshot');
    const pixelWidth = x1 - x0;
    const pixelHeight = y1 - y0;
    const fit = Math.min(1, ANNOTATION_MAX_CROP_SIDE / pixelWidth,
      ANNOTATION_MAX_CROP_SIDE / pixelHeight);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(pixelWidth * fit)),
      Math.max(1, Math.round(pixelHeight * fit)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot crop is unavailable');
    context.drawImage(bitmap, x0, y0, pixelWidth, pixelHeight,
      0, 0, canvas.width, canvas.height);
    context.fillStyle = '#7f7f7f';
    for (const mask of maskRects) {
      if (mask.textHidden === true) continue;
      const mx0 = Math.max(0, Math.floor((mask.x * scaleX - x0) * canvas.width / pixelWidth));
      const my0 = Math.max(0, Math.floor((mask.y * scaleY - y0) * canvas.height / pixelHeight));
      const mx1 = Math.min(canvas.width, Math.ceil(((mask.x + mask.width) * scaleX - x0) * canvas.width / pixelWidth));
      const my1 = Math.min(canvas.height, Math.ceil(((mask.y + mask.height) * scaleY - y0) * canvas.height / pixelHeight));
      context.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
    }
    const cropped = await canvas.convertToBlob({ type: 'image/png' });
    if (cropped.type !== 'image/png' || cropped.size === 0
      || cropped.size > ANNOTATION_MAX_CROP_BYTES) throw new Error('Element screenshot is too large');
    return blobToDataUrl(cropped);
  } finally {
    bitmap.close();
  }
}

// Crop a captured-tab PNG (data URL) to a viewport rect given in CSS pixels.
// The captured image is the visible viewport scaled by the device/zoom factor,
// so we derive the scale from the real image width vs the reported viewport
// width (robust against retina + page zoom, which a raw devicePixelRatio is
// not) and fall back to dpr when the viewport width is unknown.
async function cropToRect(tabDataUrl, rect, viewportWidth, dpr) {
  const blob = await (await fetch(tabDataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = viewportWidth && bmp.width ? bmp.width / viewportWidth : dpr || 1;
  const sx = Math.max(0, Math.round((rect.x || 0) * scale));
  const sy = Math.max(0, Math.round((rect.y || 0) * scale));
  const sw = Math.max(1, Math.min(Math.round((rect.width || 0) * scale), bmp.width - sx));
  const sh = Math.max(1, Math.min(Math.round((rect.height || 0) * scale), bmp.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(out);
}

// Capture the picked element as ONE self-contained HTML asset. The content
// script marks the element with `data-od-clip-target` on the live DOM, then
// capture.js prunes the page to just that element (keeping the page CSS so its
// cascade resolves) and returns scoped HTML + the resources to inline. No
// screenshot, no separate `.element.html` markup sidecar — a single HTML file
// that opens, shares, and distributes as the element, styled as it was on the
// page. The worker inlines the element's own images exactly like a page capture.
async function captureElementHtml(payload) {
  const includeImages = !payload || payload.includeImages !== false;
  const tab = await activeTab();
  // A DOM snapshot, not a pixel screenshot: capture.js strips our own on-page UI
  // by id, so the bar never needs to leave the frame and keeps its progress strip.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
  const [out] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (o) => window.__odCaptureElement(o),
    args: [{ includeImages, marker: 'data-od-clip-target' }],
  });
  const cap = out && out.result;
  if (!cap || !cap.html) throw new Error('element capture failed');
  const { map } = await buildResourceMap(cap.resources, includeImages);
  const html = inlineHtml(cap.html, map);
  const meta = payload.meta || {};
  const r = await ingest({
    text: html,
    kind: 'html',
    mime: 'text/html',
    sourceUrl: payload.sourceUrl || tab.url,
    sourceTitle: payload.sourceTitle || tab.title,
    tags: ['element', meta.tag].filter(Boolean),
    // The HTML asset IS the markup now, so there is no sidecar to advertise —
    // the lightweight element summary still rides along for the Library badge.
    metadata: { element: { ...meta, hasHtml: false } },
  });
  return { deduped: Boolean(r.deduped) };
}

// Screenshot a user-dragged region (cropped from the visible tab). A flat pixel
// asset — unlike element capture, which saves the picked node as live HTML.
async function captureRegion(payload) {
  const tab = await activeTab();
  // Hide the bar for the screenshot only if it would land inside the cropped
  // region; otherwise it stays put with its progress strip.
  const hideBar = Boolean(payload.hideBar);
  if (hideBar) await sendToTab(tab.id, { type: 'odClipper:hideForCapture' });
  let tabDataUrl;
  try {
    tabDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (hideBar) await sendToTab(tab.id, { type: 'odClipper:restoreAfterCapture' });
  }
  const cropped = await cropToRect(tabDataUrl, payload.rect || {}, payload.viewportWidth, payload.dpr);
  const r = await ingest({
    dataUrl: cropped,
    kind: 'image',
    sourceUrl: payload.sourceUrl || tab.url,
    sourceTitle: payload.sourceTitle || tab.title,
    tags: ['region', 'screenshot'],
  });
  return { deduped: Boolean(r.deduped) };
}

// Ingest a user-chosen subset of page images (from the on-page picker).
async function ingestImages(payload) {
  const tab = await activeTab().catch(() => null);
  const images = Array.isArray(payload.images) ? payload.images.slice(0, 100) : [];
  let count = 0;
  for (const img of images) {
    if (!img || !img.src) continue;
    try {
      await ingest({
        url: img.src,
        kind: 'image',
        sourceUrl: payload.sourceUrl || (tab && tab.url),
        sourceTitle: img.alt || payload.sourceTitle || (tab && tab.title),
      });
      count += 1;
    } catch {
      // skip individual failures (hotlink-protected / oversized)
    }
  }
  return { count, total: images.length };
}

// Capture messages that should show a progress indicator. The on-page toolbar
// shows a rich step strip, but it dies if the page reloads mid-capture (hostile
// paywall sites do this). A per-tab badge on the EXTENSION ICON survives the
// reload — it's the one progress surface a page navigation can't take down.
const CAPTURE_TYPES = new Set([
  'captureScreenshot', 'capturePageToLibrary', 'downloadFigma',
  'captureDesignSystemToLibrary', 'captureElementHtml', 'captureRegion',
  'ingestImages', 'grabImages',
]);

async function setCaptureBadge(tabId, on) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    await chrome.action.setBadgeText({ tabId, text: on ? '•••' : '' });
  } catch {
    // chrome.action may be unavailable in some embeds; the in-page strip still shows
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const diagnosticOperation = /^odAnnotation:(pair|capture|submit|status)$/.test(msg?.type || '') ? msg.type : null;
  const sendResponse = (result) => {
    if (diagnosticOperation && annotationDiagnosticsEnabled) {
      recordAnnotationDiagnostic(diagnosticOperation, result, crypto.randomUUID());
    }
    respond(result);
  };
  (async () => {
    await annotationDiagnosticsReady;
    const isCapture = Boolean(msg && CAPTURE_TYPES.has(msg.type));
    let badgeTabId = null;
    if (isCapture) {
      badgeTabId = (_sender && _sender.tab && _sender.tab.id) ||
        (await activeTab().catch(() => null))?.id || null;
      setCaptureBadge(badgeTabId, true);
    }
    try {
      switch (msg && msg.type) {
        case 'odAnnotation:diagnostics': {
          if (_sender?.id !== chrome.runtime.id || _sender?.url !== chrome.runtime.getURL('popup.html')) {
            sendResponse({ ok: false, error: 'Diagnostics are available only in the extension popup' });
            break;
          }
          if (typeof msg.enabled === 'boolean') {
            annotationDiagnosticsEnabled = msg.enabled;
            annotationDiagnosticEvents = [];
            await chrome.storage.session?.set({ annotationDiagnosticsEnabled, annotationDiagnosticEvents });
          }
          sendResponse({ ok: true, enabled: annotationDiagnosticsEnabled,
            report: { schemaVersion: 1, build: ANNOTATION_BUILD,
              extensionVersion: chrome.runtime.getManifest?.().version || 'unknown',
              events: annotationDiagnosticEvents.map((event) => ({ ...event })),
              pairedTabs: annotationGrants.size,
            } });
          break;
        }
        case 'getStatus': {
          const [daemonUrl, connected] = await Promise.all([getDaemonUrl(), probe()]);
          sendResponse({ ok: true, connected, daemonUrl });
          break;
        }
        case 'odInspect:identity': {
          const pending = inspectionDocuments.get(_sender?.tab?.id);
          if (pending?.nonce === msg.nonce && _sender?.id === chrome.runtime.id
            && _sender.frameId === 0 && typeof _sender.documentId === 'string'
            && _sender.url === msg.url) {
            const tab = await chrome.tabs.get(_sender.tab.id).catch(() => null);
            if (inspectionGrant(tab) === pending.grant && tab.url === _sender.url) {
              pending.resolve(_sender.documentId);
              sendResponse({ ok: true });
              break;
            }
          }
          sendResponse({ ok: false });
          break;
        }
        case 'odAnnotation:status': {
          // A popup opened in its own tab has sender.tab, but pairing belongs
          // to the active website tab; website content still checks itself.
          const fromPopup = _sender?.id === chrome.runtime.id
            && _sender?.url === chrome.runtime.getURL('popup.html');
          const tab = fromPopup || !_sender?.tab
            ? await activeTab().catch(() => null)
            : await chrome.tabs.get(_sender.tab.id).catch(() => null);
          sendResponse(await annotationStatus(tab));
          break;
        }
        case 'odAnnotation:pair': {
          await annotationReady;
          // The popup provides a one-use code, never a project ID or a bearer
          // token. The worker binds Edge's real active tab and a new epoch.
          // A popup opened in its own tab can still carry sender.tab.
          if (_sender?.id !== chrome.runtime.id
            || _sender?.url !== chrome.runtime.getURL('popup.html')) {
            sendResponse({ ok: false, error: 'pairing must start from the extension popup' });
            break;
          }
          const liveTab = await activeTab().catch(() => null);
          const tab = annotationTab(liveTab);
          let code = typeof msg.code === 'string' ? msg.code.trim() : '';
          let daemonUrl = await getDaemonUrl();
          if (code.includes('://')) {
            try {
              const connection = new URL(code);
              if (connection.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname)
                || connection.username || connection.password || connection.pathname !== '/' || connection.search) throw new Error();
              code = new URLSearchParams(connection.hash.slice(1)).get('od-annotation') || '';
              daemonUrl = connection.origin;
            } catch { sendResponse({ ok: false, error: 'Paste the connection URL copied from Open Design' }); break; }
          }
          if (!tab || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code) || code.length > 256) {
            sendResponse({ ok: false, error: 'invalid pairing code or page' });
            break;
          }
          const documentId = annotationEpoch(tab.id);
          const response = await annotationRequest('/api/edge-annotations/redeem', {
            daemonUrl,
            body: { code, tabId: tab.id, documentId, origin: new URL(tab.url).origin, url: tab.url },
          });
          if (!response.ok || !response.grant || typeof response.token !== 'string'
            || response.grant.tabId !== tab.id || response.grant.documentId !== documentId
            || response.grant.origin !== new URL(tab.url).origin) {
            sendResponse({ ok: false, error: response.error || 'pairing failed' });
            break;
          }
          const refreshed = await chrome.tabs.get(tab.id).catch(() => null);
          if (annotationTab(refreshed)?.url !== tab.url || annotationEpochs.get(tab.id) !== documentId) {
            // Redeeming may already have replaced the old server grant. Do not
            // retain a stale local capability or strand the new grant there.
            clearAnnotationTab(tab.id);
            void annotationRequest('/api/edge-annotations/revoke', {
              daemonUrl, token: response.token,
              body: { grantId: response.grant.grantId, tabId: tab.id,
                documentId, url: tab.url },
            });
            sendResponse({ ok: false, error: 'tab changed during pairing' });
            break;
          }
          clearAnnotationTab(tab.id);
          annotationEpochs.set(tab.id, documentId);
          if (daemonUrl !== await getDaemonUrl()) annotationGrants.clear();
          await chrome.storage.local.set({ daemonUrl });
          annotationGrants.set(tab.id, {
            grantId: response.grant.grantId, projectId: response.grant.projectId,
            projectName: response.projectName, conversationName: response.conversationName,
            conversationId: response.grant.conversationId, chatUrl: response.chatUrl,
            documentId, inspectionDocumentId: documentId, origin: response.grant.origin,
            url: tab.url, expiresAt: response.grant.expiresAt, token: response.token,
          });
          await persistAnnotationConnections();
          void inspectionPoll(tab.id);
          sendResponse({ ok: true, projectId: response.grant.projectId });
          break;
        }
        case 'odAnnotation:identity': {
          const pending = annotationIdentities.get(msg.nonce);
          const accepted = Boolean(pending && sameAnnotationSender(_sender, pending.expected) && msg.url === _sender.url);
          if (accepted) pending.resolve(true);
          sendResponse({ ok: accepted });
          break;
        }
        case 'odAnnotation:frameRequest': sendResponse(await annotationFrameRequest(_sender)); break;
        case 'odAnnotation:frameIdentity': sendResponse(await annotationFrameIdentity(msg, _sender)); break;
        case 'odAnnotation:frameConfirm': sendResponse(await annotationFrameConfirm(msg, _sender)); break;
        case 'odAnnotation:review': sendResponse(await reviewAnnotation(msg, _sender)); break;
        case 'odAnnotation:capture': {
          sendResponse(await captureAnnotationCrop(msg, _sender));
          break;
        }
        case 'odAnnotation:discard': {
          const review = annotationReviews.get(_sender?.tab?.id);
          if (review?.eventId === msg.eventId && sameAnnotationSender(_sender, review.identity)) {
            annotationReviews.delete(_sender.tab.id);
          }
          if (_sender?.tab && _sender.frameId === 0) discardAnnotationCrop(_sender.tab.id, msg.eventId);
          sendResponse({ ok: true });
          break;
        }
        case 'odAnnotation:submit': {
          const liveTab = _sender?.tab && await chrome.tabs.get(_sender.tab.id).catch(() => null);
          await annotationStatus(liveTab);
          const tab = annotationTab(liveTab);
          const note = typeof msg.note === 'string' ? msg.note.trim() : '';
          const grant = grantForTab(liveTab);
          const scoped = msg.target?.scope !== undefined || _sender?.frameId !== 0;
          const target = tab && grant && (scoped
            ? await scopedAnnotationReview(msg, _sender, grant) : annotationTarget(msg.target, tab));
          if (!tab || !target || !note || note.length > ANNOTATION_MAX_NOTE
            || (!scoped && (_sender?.frameId !== 0 || _sender.tab.url !== liveTab.url))) {
            sendResponse({ ok: false, error: 'invalid annotation' });
            break;
          }
          const crop = annotationCrops.get(tab.id);
          const omitScreenshot = msg.omitScreenshot === true || scoped;
          if (!grant || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.eventId || '')
            || annotationCapturePending.has(tab.id) || !liveTab.active
            || (!omitScreenshot && (!crop || crop.eventId !== msg.eventId
              || crop.documentId !== grant.documentId || crop.url !== tab.url
              || crop.originalUrl !== liveTab.url
              || crop.reviewedTarget !== JSON.stringify(target)
              || !/^data:image\/png;base64,/.test(crop.cropDataUrl)
              || crop.cropDataUrl.length > 4 * Math.ceil(ANNOTATION_MAX_CROP_BYTES / 3) + 40))) {
            sendResponse({ ok: false, error: 'Reviewed screenshot required' });
            break;
          }
          if (annotationSubmitPending.has(tab.id)) {
            sendResponse({ ok: false, error: 'Annotation is already posting' });
            break;
          }
          const reviewedUrl = msg.omitUrlDetails === true
            ? `${new URL(tab.url).origin}${new URL(tab.url).pathname}` : tab.url;
          annotationSubmitPending.add(tab.id);
          try {
            const response = await annotationRequest('/api/edge-annotations/submit', {
              token: grant.token,
              body: {
                projectId: grant.projectId, grantId: grant.grantId, tabId: tab.id,
                documentId: grant.documentId, url: reviewedUrl, title: tab.title,
                eventId: typeof msg.eventId === 'string' ? msg.eventId : '',
                target: { selector: target.selector, elementId: target.selector.slice(0, 128),
                  label: target.label, text: target.text, domOutline: target.domOutline,
                  position: target.position, htmlHint: target.htmlHint, ancestors: target.ancestors,
                  style: target.style, ...(target.scope ? { scope: target.scope } : {}) },
                ...(!omitScreenshot ? { screenshotDataUrl: crop.cropDataUrl } : {}), note,
              },
            });
            if (response.ok && !response.id) { sendResponse({ ok: false, error: 'Open Design did not confirm a draft annotation' }); break; }
            if (response.ok) {
              annotationCrops.delete(tab.id);
              annotationReviews.delete(tab.id);
              await chrome.storage.session?.set({ annotationReceipt: response });
            }
            else if (response.status === 401 || response.status === 403) {
              annotationGrants.delete(tab.id);
              await persistAnnotationConnections();
            }
            sendResponse(response);
          } finally {
            annotationSubmitPending.delete(tab.id);
          }
          break;
        }
        case 'setDaemonUrl': {
          annotationGrants.clear();
          annotationFrameRequests.clear();
          annotationFrameAgents.clear();
          annotationReviews.clear();
          annotationEpochs.clear();
          annotationCrops.clear();
          inspectionDocuments.clear();
          inspectionDocumentIds.clear();
          inspectionPolls.clear();
          inspectionLocks.clear();
          inspectionGeneration += 1;
          for (const lease of annotationCapturePending.values()) lease.cancelled = true;
          await persistAnnotationConnections();
          await chrome.storage.local.set({ daemonUrl: msg.url || DEFAULT_DAEMON_URL });
          const connected = await probe();
          sendResponse({ ok: true, connected });
          break;
        }
        case 'captureScreenshot': {
          const r = await captureScreenshot();
          sendResponse({ ok: true, deduped: Boolean(r.deduped) });
          break;
        }
        case 'grabImages': {
          const r = await grabImages();
          sendResponse({ ok: true, count: r.count, total: r.total });
          break;
        }
        case 'capturePageToLibrary': {
          const r = await capturePageToLibrary(msg.opts);
          sendResponse({
            ok: true,
            deduped: r.deduped,
            hasFigma: r.hasFigma,
            truncated: r.truncated,
            partialImages: r.partialImages,
            figmaDropped: r.figmaDropped,
          });
          break;
        }
        case 'downloadFigma': {
          const r = await downloadFigma(msg.opts);
          sendResponse({ ok: true, truncated: r.truncated, partialImages: r.partialImages });
          break;
        }
        case 'captureDesignSystemToLibrary': {
          const r = await captureDesignSystemToLibrary(msg.opts);
          sendResponse({ ok: true, deduped: r.deduped, partialImages: r.partialImages });
          break;
        }
        case 'captureElementHtml': {
          const r = await captureElementHtml(msg);
          sendResponse({ ok: true, deduped: r.deduped });
          break;
        }
        case 'captureRegion': {
          const r = await captureRegion(msg);
          sendResponse({ ok: true, deduped: r.deduped });
          break;
        }
        case 'ingestImages': {
          const r = await ingestImages(msg);
          sendResponse({ ok: true, count: r.count, total: r.total });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    } finally {
      if (isCapture) setCaptureBadge(badgeTabId, false);
    }
  })();
  return true; // keep the message channel open for the async response
});

// Right-click any image → save straight to the library.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'od-save-image',
    title: t('saveImageToLibrary'),
    contexts: ['image'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'od-save-image' || !info.srcUrl) return;
  try {
    await ingest({
      url: info.srcUrl,
      kind: 'image',
      sourceUrl: tab && tab.url,
      sourceTitle: tab && tab.title,
    });
  } catch {
    // best-effort; the popup surfaces detailed errors
  }
});

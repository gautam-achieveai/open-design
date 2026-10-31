import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpApprovalStore, LOCAL_PERFORMANCE_PRINCIPAL_ID, type ApprovalAction } from '../src/mcp-http/approval-store.js';
import { registerMcpApprovalRoutes } from '../src/mcp-http/approval-routes.js';

function fixture() {
  let now = 1_800_000_000_000;
  const store = createMcpApprovalStore({ now: () => now });
  const principal = { kind: 'run' as const, id: 'run-1', projectId: 'p1', scope: { workspaceId: 'w1', workspaceMemberId: 'm1' } };
  const target = store.captureTarget('p1', 'tab-1', 'lease-private', 'https://example.invalid/page?code=private-code#state=private-state');
  const action: ApprovalAction = { principal, target, operation: 'evaluate', args: { expression: 'return "odtt_synthetic_marker_0123456789"' } };
  return { store, principal, target, action, setNow: (value: number) => { now = value; }, now: () => now };
}

function create(f: ReturnType<typeof fixture>) {
  const result = f.store.create(f.action);
  if (!result.ok) throw new Error(result.code);
  return result.approval;
}

describe('local MCP approval store', () => {
  it('binds approval to the exact principal, scope, tab, lease, URL, operation and normalized arguments', () => {
    const f = fixture();
    const item = create(f);
    expect(f.store.decide(item.id, 'approve', () => true).ok).toBe(true);
    const changes: ApprovalAction[] = [
      { ...f.action, principal: { ...f.principal, id: 'run-2' } },
      { ...f.action, principal: { ...f.principal, scope: { workspaceId: 'w2', workspaceMemberId: 'm1' } } },
      { ...f.action, target: f.store.captureTarget('p1', 'tab-2', 'lease-private', 'https://example.invalid/page?code=private-code#state=private-state') },
      { ...f.action, target: f.store.captureTarget('p1', 'tab-1', 'other-lease', 'https://example.invalid/page?code=private-code#state=private-state') },
      { ...f.action, target: f.store.captureTarget('p1', 'tab-1', 'lease-private', 'https://example.invalid/other') },
      { ...f.action, operation: 'click' },
      { ...f.action, args: { expression: 'return "changed"' } },
    ];
    for (const changed of changes) expect(f.store.consume(item.id, changed)).toEqual({ ok: false, code: 'MISMATCH' });
    expect(f.store.consume(item.id, f.action)).toMatchObject({ ok: true, approval: { status: 'consumed' } });
    expect(f.store.consume(item.id, f.action)).toEqual({ ok: false, code: 'CONSUMED' });
  });

  it('keeps no raw token, action, lease, query or fragment in approval DTOs', () => {
    const f = fixture();
    const item = create(f);
    expect(item.preview).toContain('[redacted]');
    expect(item.partial).toBe(true);
    expect(item.location).toBe('https://example.invalid/page');
    const serialized = JSON.stringify({ item, listed: f.store.list(), target: f.store.getTarget(item.id) });
    expect(serialized).not.toContain('synthetic_marker');
    expect(serialized).not.toContain('private-code');
    expect(serialized).not.toContain('private-state');
    expect(serialized).not.toContain('lease-private');
  });

  it('redacts credential-bearing URL values in actionable script excerpts', () => {
    const f = fixture();
    const result = f.store.create({ ...f.action, args: { expression: 'fetch("https://example.invalid/cb?code=synthetic_code&state=synthetic_state")' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approval.preview).toContain('fetch(');
    expect(result.approval.preview).not.toContain('synthetic_code');
    expect(result.approval.preview).not.toContain('synthetic_state');
    expect(result.approval.partial).toBe(true);
  });

  it('redacts URL userinfo in evaluate and selector previews', () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    for (const action of [
      { ...f.action, target, args: { expression: 'fetch("https://alice:synthetic-secret@example.invalid/api")' } },
      { ...f.action, target, operation: 'click', args: { target: { selector: '[href="https://alice:synthetic-secret@example.invalid/api"]' } } },
    ]) {
      const result = f.store.create(action);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const views = [result.approval, f.store.get(result.approval.id), ...f.store.list()];
      expect(JSON.stringify(views)).not.toContain('alice:synthetic-secret');
      expect(result.approval.preview).toContain(action.operation === 'click' ? '[selector hidden]' : 'example.invalid/api');
      expect(result.approval.partial).toBe(true);
    }
  });

  it('distinguishes style changes and cache directions in the approval preview', () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const actions: ApprovalAction[] = [
      { ...f.action, target, operation: 'browser_style', args: { target: { selector: '#title' }, styles: { color: 'red' } } },
      { ...f.action, target, operation: 'browser_style', args: { target: { selector: '#footer' }, styles: { opacity: '0' } } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'cache-disable', params: { disabled: true } } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'cache-disable', params: { disabled: false } } },
    ];
    const items = actions.map((action) => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      return result.approval;
    });
    expect(items.map((item) => item.preview)).toEqual([
      'Style #title: color: red', 'Style #footer: opacity: 0',
      'DevTools cache-disable: disabled: true', 'DevTools cache-disable: disabled: false',
    ]);
    expect(f.store.decide(items[0]!.id, 'approve', () => true).ok).toBe(true);
    expect(f.store.consume(items[0]!.id, actions[1]!)).toEqual({ ok: false, code: 'MISMATCH' });
    f.store.close();
  });

  it('redacts known tokens in otherwise simple selectors', () => {
    const f = fixture();
    const result = f.store.create({ ...f.action, operation: 'browser_click', args: { target: { selector: '#odtt_synthetic_token' } } });
    if (!result.ok) throw new Error(result.code);
    expect(result.approval.preview).not.toContain('odtt_synthetic_token');
    expect(result.approval.preview).toContain('[redacted]');
    expect(result.approval.preview).toContain('[details hidden]');
    expect(result.approval.partial).toBe(true);
    f.store.close();
  });

  it('marks hidden or truncated style and DevTools details without returning synthetic secrets', () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const actions: ApprovalAction[] = [
      { ...f.action, target, operation: 'browser_style', args: { target: { selector: '[href="https://alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]' }, styles: { fontFamily: 'synthetic-private', color: 'red' } } },
      { ...f.action, target, operation: 'browser_style', args: { target: { selector: `#${'a'.repeat(400)}` }, styles: { color: 'blue' } } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'storage-clear', params: { types: ['cookies', 'local-storage'], secret: 'synthetic-private' } } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'force-state', params: { selector: '[data-token="odtt_synthetic_token"]', states: ['hover'] } } },
    ];
    const items = actions.map((action) => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      return result.approval;
    });
    for (const item of items) {
      expect(item.partial).toBe(true);
      expect(item.preview).toContain('[details hidden]');
    }
    expect(items[0]!.preview).toContain('fontFamily: [value hidden]');
    expect(items[2]!.preview).toContain('types: cookies, local-storage');
    const output = JSON.stringify({ items, listed: f.store.list() });
    for (const secret of ['synthetic-pass', 'synthetic-code', 'synthetic-fragment', 'synthetic-private', 'odtt_synthetic_token']) expect(output).not.toContain(secret);
    f.store.close();
  });

  it('sanitizes absolute and protocol-relative selector URLs and still binds hidden arguments', () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const selectors = [
      '[href="https://alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="//alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="https://example.invalid/path#synthetic-fragment"]',
      '[href="//example.invalid/path#synthetic-fragment"]',
    ];
    const actions = selectors.flatMap((selector): ApprovalAction[] => [
      { ...f.action, target, operation: 'browser_style', args: { target: { selector }, styles: { color: 'red' } } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'force-state', params: { selector, states: ['hover'] } } },
    ]);
    const approvals = actions.map((action) => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      expect(result.approval.partial).toBe(true);
      expect(result.approval.preview).toContain('[details hidden]');
      expect(result.approval.preview).toContain('[selector hidden]');
      return result.approval;
    });
    const output = JSON.stringify({ approvals, list: f.store.list() });
    for (const secret of ['alice', 'synthetic-pass', 'synthetic-code', 'synthetic-fragment']) expect(output).not.toContain(secret);
    for (const index of [0, 1]) {
      expect(f.store.decide(approvals[index]!.id, 'approve', () => true).ok).toBe(true);
      expect(f.store.consume(approvals[index]!.id, actions[index + 2]!)).toEqual({ ok: false, code: 'MISMATCH' });
      expect(f.store.consume(approvals[index]!.id, actions[index]!).ok).toBe(true);
    }
    f.store.close();
  });

  it('makes denial, expiry and principal invalidation terminal', () => {
    const f = fixture();
    const denied = create(f);
    expect(f.store.decide(denied.id, 'deny', () => true)).toMatchObject({ ok: true, approval: { status: 'denied' } });
    expect(f.store.decide(denied.id, 'approve', () => true)).toEqual({ ok: false, code: 'CONFLICT' });
    expect(f.store.consume(denied.id, f.action)).toEqual({ ok: false, code: 'DENIED' });
    const expired = create(f);
    f.setNow(f.now() + 120_000);
    expect(f.store.consume(expired.id, f.action)).toEqual({ ok: false, code: 'EXPIRED' });
    const invalidated = create(f);
    f.store.invalidatePrincipal('run', 'run-1');
    expect(f.store.decide(invalidated.id, 'approve', () => true)).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('refuses changed targets and does not accept more than ten approvals for one principal', () => {
    const f = fixture();
    const first = create(f);
    expect(f.store.decide(first.id, 'approve', () => false)).toEqual({ ok: false, code: 'TARGET_CHANGED' });
    for (let i = 0; i < 9; i++) create(f);
    expect(f.store.create(f.action)).toEqual({ ok: false, code: 'CAPACITY' });
  });

  it('enforces the global capacity without evicting another principal', () => {
    const f = fixture();
    const first = create(f);
    for (let i = 1; i < 100; i++) {
      expect(f.store.create({ ...f.action, principal: { ...f.principal, id: `run-${i + 1}` } }).ok).toBe(true);
    }
    expect(f.store.create({ ...f.action, principal: { ...f.principal, id: 'another' } })).toEqual({ ok: false, code: 'CAPACITY' });
    expect(f.store.get(first.id)?.status).toBe('pending');
  });
});

describe('local MCP approval routes', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('requires the exact native decision signature, rejects replay and changed targets, and consumes only the approved action', async () => {
    const f = fixture();
    const secret = randomBytes(32);
    const action: ApprovalAction = { ...f.action, operation: 'browser_devtools',
      principal: { ...f.principal, kind: 'local', id: LOCAL_PERFORMANCE_PRINCIPAL_ID },
      args: { action: 'capture-throttle', params: { reportId: randomUUID(), cpu: 2 } } };
    const createNative = () => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      return result.approval;
    };
    expect(f.store.create({ ...action, operation: 'browser_evaluate', args: { expression: '1' } }).ok).toBe(false);
    expect(f.store.create({ ...action, args: { action: 'capture-throttle',
      params: { ...(action.args.params as object), nativeApprovalId: randomUUID() } } }).ok).toBe(false);
    let targetCurrent = true;
    const app = express();
    app.use(express.json());
    registerMcpApprovalRoutes(app, { store: f.store, authorize: async () => true, authorizeCurrent: () => true,
      targetCurrent: () => targetCurrent, desktopSecret: () => secret });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    const item = createNative();
    const response = await fetch(`${base}/${item.id}/native-challenge`);
    expect(response.status).toBe(200);
    const { challenge } = await response.json() as { challenge: { bindingDigest: string; approvalId: string } };
    expect(challenge.approvalId).toBe(item.id);
    const sign = (id = item.id, decision = 'approve', purpose = 'od.capture-throttle.native-decision.v1', key = secret) => ({
      bindingDigest: challenge.bindingDigest,
      signature: createHmac('sha256', key).update(JSON.stringify([purpose, id, decision, challenge.bindingDigest])).digest('base64url'),
    });
    const decide = (id: string, nativeConfirmation?: unknown) => fetch(`${base}/${id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nativeConfirmation === undefined ? {} : { nativeConfirmation }),
    });
    for (const invalid of [undefined, sign(randomUUID()), sign(item.id, 'deny'), sign(item.id, 'approve', 'import-token'),
      sign(item.id, 'approve', 'od.capture-throttle.native-decision.v1', randomBytes(32)),
      { ...sign(), bindingDigest: 'changed' }]) {
      const denied = await decide(item.id, invalid);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: 'NATIVE_CONFIRMATION_REQUIRED' } });
      expect(f.store.get(item.id)?.status).toBe('pending');
    }
    expect((await decide(item.id, sign())).status).toBe(200);
    expect((await decide(item.id, sign())).status).toBe(403);
    expect(f.store.get(item.id)?.status).toBe('approved');
    expect(f.store.consume(item.id, { ...action, principal: f.principal })).toEqual({ ok: false, code: 'MISMATCH' });
    expect(f.store.consume(item.id, action).ok).toBe(true);
    expect(f.store.consume(item.id, action)).toEqual({ ok: false, code: 'CONSUMED' });

    const changed = createNative();
    const next = await fetch(`${base}/${changed.id}/native-challenge`);
    const nextBody = await next.json() as { challenge: { bindingDigest: string } };
    const signed = { bindingDigest: nextBody.challenge.bindingDigest,
      signature: createHmac('sha256', secret).update(JSON.stringify([
        'od.capture-throttle.native-decision.v1', changed.id, 'approve', nextBody.challenge.bindingDigest,
      ])).digest('base64url') };
    targetCurrent = false;
    expect((await decide(changed.id, signed)).status).toBe(409);
    expect(f.store.get(changed.id)?.status).toBe('pending');
    expect((await fetch(`${base}/${changed.id}/native-challenge`)).status).toBe(404);
    f.store.close();
  });

  it('filters inaccessible projects, rejects scope in decision bodies, and allows only one decision', async () => {
    const f = fixture();
    const item = create(f);
    const app = express();
    app.use(express.json());
    registerMcpApprovalRoutes(app, {
      store: f.store,
      authorize: async (req, approval) => req.get('x-test-member') === approval.scope?.workspaceMemberId,
      authorizeCurrent: (req, approval) => req.get('x-test-member') === approval.scope?.workspaceMemberId,
      targetCurrent: (expected) => f.store.targetMatches(expected, f.target),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = await fetch(`${base}/api/mcp/approvals`);
    expect(await read.json()).toEqual({ approvals: [] });
    const inaccessible = await fetch(`${base}/api/mcp/approvals/${item.id}`);
    expect(inaccessible.status).toBe(404);
    const visible = await fetch(`${base}/api/mcp/approvals`, { headers: { 'x-test-member': 'm1' } });
    expect(await visible.json()).toMatchObject({ approvals: [{ id: item.id }] });
    const body = await fetch(`${base}/api/mcp/approvals/${item.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-member': 'm1' }, body: JSON.stringify({ projectId: 'other' }),
    });
    expect(body.status).toBe(400);
    const post = (decision: string) => fetch(`${base}/api/mcp/approvals/${item.id}/${decision}`, { method: 'POST', headers: { 'x-test-member': 'm1' } });
    const responses = await Promise.all([post('approve'), post('deny')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });
  it('rechecks current authority after an asynchronous authorization for list, detail and decision', async () => {
    const f = fixture();
    const item = create(f);
    let allowed = true;
    let release!: () => void;
    let entered!: () => void;
    let barrier!: Promise<void>;
    let inside!: Promise<void>;
    const reset = () => {
      allowed = true;
      barrier = new Promise<void>((resolve) => { release = resolve; });
      inside = new Promise<void>((resolve) => { entered = resolve; });
    };
    const app = express();
    registerMcpApprovalRoutes(app, {
      store: f.store,
      authorize: async () => { const snapshot = allowed; entered(); await barrier; return snapshot; },
      authorizeCurrent: () => allowed,
      targetCurrent: () => true,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    for (const [path, method] of [['', 'GET'], [`/${item.id}`, 'GET'], [`/${item.id}/approve`, 'POST']] as const) {
      reset();
      const pending = fetch(`${base}${path}`, { method });
      await inside;
      allowed = false;
      release();
      const response = await pending;
      const body = await response.json();
      if (path === '') expect(body).toEqual({ approvals: [] });
      else { expect(response.status).toBe(404); expect(JSON.stringify(body)).not.toContain(item.id); }
      expect(f.store.get(item.id)?.status).toBe('pending');
    }
  });

  it('does not return URL userinfo in approval HTTP responses', async () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const result = f.store.create({ ...f.action, target, args: { expression: 'fetch("https://alice:synthetic-secret@example.invalid/api")' } });
    if (!result.ok) throw new Error(result.code);
    const selector = f.store.create({ ...f.action, target, operation: 'click', args: { target: { selector: '[href="https://alice:synthetic-secret@example.invalid/api"]' } } });
    if (!selector.ok) throw new Error(selector.code);
    const style = f.store.create({ ...f.action, target, operation: 'browser_style', args: { target: { selector: '[href="https://alice:synthetic-secret@example.invalid/api?code=synthetic-code#synthetic-fragment"]' }, styles: { fontFamily: 'synthetic-private' } } });
    if (!style.ok) throw new Error(style.code);
    const devtools = f.store.create({ ...f.action, target, operation: 'browser_devtools', args: { action: 'storage-clear', params: { types: ['cookies'], secret: 'synthetic-private' } } });
    if (!devtools.ok) throw new Error(devtools.code);
    const app = express();
    registerMcpApprovalRoutes(app, { store: f.store, authorize: async () => true, authorizeCurrent: () => true, targetCurrent: () => true });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    for (const path of ['', `/${result.approval.id}`, `/${selector.approval.id}`, `/${style.approval.id}`, `/${devtools.approval.id}`]) {
      const response = await fetch(`${base}${path}`);
      const payload = await response.text();
      expect(payload).not.toContain('alice:synthetic-secret');
      expect(payload).not.toContain('synthetic-code');
      expect(payload).not.toContain('synthetic-fragment');
      expect(payload).not.toContain('synthetic-private');
      if (!path || path === `/${result.approval.id}`) expect(payload).toContain('example.invalid/api');
      if (path === `/${selector.approval.id}` || path === `/${style.approval.id}`) expect(payload).toContain('[selector hidden]');
      expect(payload).toContain('"partial":true');
    }
  });

  it('does not expose absolute or protocol-relative selector credentials in list or detail responses', async () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const selectors = [
      '[href="https://alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="//alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="https://example.invalid/path#synthetic-fragment"]',
      '[href="//example.invalid/path#synthetic-fragment"]',
    ];
    const items = selectors.flatMap((selector) => [
      { operation: 'browser_style', args: { target: { selector }, styles: { color: 'red' } } },
      { operation: 'browser_devtools', args: { action: 'force-state', params: { selector, states: ['hover'] } } },
    ]).map((item) => {
      const created = f.store.create({ ...f.action, target, ...item });
      if (!created.ok) throw new Error(created.code);
      return created.approval;
    });
    const app = express();
    registerMcpApprovalRoutes(app, { store: f.store, authorize: async () => true, authorizeCurrent: () => true, targetCurrent: () => true });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    for (const path of ['', ...items.map((item) => `/${item.id}`)]) {
      const response = await fetch(`${base}${path}`);
      const payload = await response.text();
      expect(response.status).toBe(200);
      for (const secret of ['alice', 'synthetic-pass', 'synthetic-code', 'synthetic-fragment']) expect(payload).not.toContain(secret);
      expect(payload).toContain('[selector hidden]');
      expect(payload).toContain('"partial":true');
      expect(payload).toContain('[details hidden]');
    }
    f.store.close();
  });

  it('sanitizes click, type and scroll selectors in list and detail without changing action binding', async () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const selectors = [
      '[href="https://alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="//alice:synthetic-pass@example.invalid/path?code=synthetic-code#synthetic-fragment"]',
      '[href="//example.invalid/path#synthetic-fragment"]',
    ];
    const actions = selectors.flatMap((selector): ApprovalAction[] => [
      { ...f.action, target, operation: 'browser_click', args: { target: { selector }, button: 'left', clickCount: 1 } },
      { ...f.action, target, operation: 'browser_type', args: { target: { selector }, text: 'synthetic-private' } },
      { ...f.action, target, operation: 'browser_scroll', args: { target: { selector }, deltaX: 0, deltaY: 20 } },
    ]);
    const items = actions.map((action) => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      expect(result.approval.partial).toBe(true);
      expect(result.approval.preview).toContain('[details hidden]');
      return result.approval;
    });
    const app = express();
    registerMcpApprovalRoutes(app, { store: f.store, authorize: async () => true, authorizeCurrent: () => true, targetCurrent: () => true });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    for (const path of ['', ...items.map((item) => `/${item.id}`)]) {
      const response = await fetch(`${base}${path}`);
      const payload = await response.text();
      expect(response.status).toBe(200);
      for (const secret of ['alice', 'synthetic-pass', 'synthetic-code', 'synthetic-fragment', 'synthetic-private']) expect(payload).not.toContain(secret);
      expect(payload).toContain('[selector hidden]');
      expect(payload).toContain('"partial":true');
      expect(payload).toContain('[details hidden]');
    }
    for (const index of [0, 1, 2]) {
      expect(f.store.decide(items[index]!.id, 'approve', () => true).ok).toBe(true);
      expect(f.store.consume(items[index]!.id, actions[index + 3]!)).toEqual({ ok: false, code: 'MISMATCH' });
      expect(f.store.consume(items[index]!.id, actions[index]!).ok).toBe(true);
    }
    f.store.close();
  });

  it('hides relative fragments and CSS escapes for every selector action through list and detail', async () => {
    const f = fixture();
    const target = f.store.captureTarget('p1', 'tab-1', 'lease', 'https://example.invalid/page');
    const selectors = [
      '[href="/callback#synthetic-fragment"]',
      '[href="https\\3a //alice\\3a synthetic-pass@example.invalid/path#synthetic-fragment"]',
    ];
    const actions = selectors.flatMap((selector): ApprovalAction[] => [
      { ...f.action, target, operation: 'browser_style', args: { target: { selector }, styles: { color: 'red' } } },
      { ...f.action, target, operation: 'browser_click', args: { target: { selector }, button: 'left', clickCount: 1 } },
      { ...f.action, target, operation: 'browser_type', args: { target: { selector }, text: 'synthetic-private' } },
      { ...f.action, target, operation: 'browser_scroll', args: { target: { selector }, deltaX: 0, deltaY: 20 } },
      { ...f.action, target, operation: 'browser_devtools', args: { action: 'force-state', params: { selector, states: ['hover'] } } },
    ]);
    const items = actions.map((action) => {
      const result = f.store.create(action);
      if (!result.ok) throw new Error(result.code);
      expect(result.approval).toMatchObject({ partial: true });
      expect(result.approval.preview).toContain('[selector hidden]');
      expect(result.approval.preview).toContain('[details hidden]');
      return result.approval;
    });
    const app = express();
    registerMcpApprovalRoutes(app, { store: f.store, authorize: async () => true, authorizeCurrent: () => true, targetCurrent: () => true });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/approvals`;
    for (const path of ['', ...items.map((item) => `/${item.id}`)]) {
      const response = await fetch(`${base}${path}`);
      const payload = await response.text();
      expect(response.status).toBe(200);
      for (const secret of ['synthetic-fragment', 'synthetic-pass', 'synthetic-private', 'alice']) expect(payload).not.toContain(secret);
      expect(payload).toContain('[selector hidden]');
      expect(payload).toContain('[details hidden]');
      expect(payload).toContain('"partial":true');
    }
    for (let index = 0; index < 5; index++) {
      expect(f.store.decide(items[index]!.id, 'approve', () => true).ok).toBe(true);
      expect(f.store.consume(items[index]!.id, actions[index + 5]!)).toEqual({ ok: false, code: 'MISMATCH' });
      expect(f.store.consume(items[index]!.id, actions[index]!).ok).toBe(true);
    }
    f.store.close();
  });

});

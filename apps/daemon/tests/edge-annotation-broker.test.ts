import { describe, expect, it } from 'vitest';

import { createEdgeAnnotationBroker } from '../src/services/edge-annotation-broker.js';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAAFUlEQVR4nGM4ceLEf0oww6gBw8EAACA2q5Dak2CeAAAAAElFTkSuQmCC';

const target = {
  selector: 'main button[data-action="save"]',
  elementId: 'save',
  label: 'Save',
  text: 'Save changes',
  position: { x: 10, y: 20, width: 90, height: 36 },
  htmlHint: 'button',
};

function fixture() {
  let now = 1_000;
  const broker = createEdgeAnnotationBroker({ now: () => now, ttlMs: 1_000 });
  const pair = broker.createPendingPair({ projectId: 'project-1', conversationId: 'conversation-1', extensionId: 'a'.repeat(32) });
  const grant = broker.redeemPair({
    ...pair, tabId: 12, documentId: 'document-1', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN,
  });
  const submission = {
    projectId: 'project-1',
    grantId: grant.grant.grantId,
    token: grant.token,
    extensionOrigin: EXTENSION_ORIGIN,
    tabId: 12,
    documentId: 'document-1',
    url: 'https://app.contoso.test/editor?view=details#changes',
    title: 'Editor',
    target,
    note: 'Make the save action clearer',
    eventId: 'event-1',
    screenshotDataUrl,
  };
  return { broker, grant, submission, advance: (milliseconds: number) => { now += milliseconds; } };
}

function hasCode(code: string) {
  return expect.objectContaining({ code });
}

describe('Edge annotation broker', () => {
  it('keeps normalized child scope while the grant remains bound to the top document', () => {
    const { broker, submission } = fixture();
    const scope = { frame: 'child' as const, url: 'https://child.contoso.test/frame',
      selectorRoot: 'open-shadow' as const, shadowHosts: ['body > x-card'], screenshot: 'not-supported' as const };
    const { screenshotDataUrl: _screenshot, ...withoutScreenshot } = submission;
    const accepted = broker.submit({ ...withoutScreenshot,
      target: { ...target, scope: { ...scope, documentId: 'discard' } as typeof scope } });
    expect(accepted.target.scope).toEqual(scope);
    expect(accepted.grant.documentId).toBe(submission.documentId);
    expect(accepted.url).toBe(submission.url);
    expect(accepted.screenshot).toBeUndefined();
    expect(() => broker.submit({ ...submission, target: { ...target,
      scope: { ...scope, url: 'https://accounts.google.com/' } } })).toThrowError(hasCode('INVALID_ANNOTATION'));
  });
  it('requires exact paired identity and conversation for bounded inspection results', async () => {
    const { broker, grant } = fixture();
    const identity = { projectId: grant.grant.projectId, grantId: grant.grant.grantId,
      token: grant.token, extensionOrigin: EXTENSION_ORIGIN,
      tabId: grant.grant.tabId, documentId: grant.grant.documentId,
      url: 'https://app.contoso.test/editor' };
    expect(broker.pollInspection(identity)).toBeNull();
    expect(() => broker.requestInspection({ projectId: identity.projectId,
      conversationId: 'wrong', grantId: identity.grantId, operation: 'snapshot' }))
      .toThrowError(hasCode('GRANT_NOT_FOUND'));
    expect(() => broker.requestInspection({ projectId: identity.projectId,
      conversationId: grant.grant.conversationId, grantId: identity.grantId,
      operation: 'navigate' as 'snapshot' })).toThrowError(hasCode('INVALID_INSPECTION'));
    const pending = broker.requestInspection({ projectId: identity.projectId,
      conversationId: grant.grant.conversationId, grantId: identity.grantId, operation: 'inspect',
      selector: 'main' });
    expect(() => broker.requestInspection({ projectId: identity.projectId,
      conversationId: grant.grant.conversationId, grantId: identity.grantId, operation: 'snapshot' }))
      .toThrowError(hasCode('INSPECTION_BUSY'));
    expect(broker.pollInspection(identity)).toEqual({ requestId: pending.requestId,
      operation: 'inspect', selector: 'main' });
    expect(broker.pollInspection(identity)).toBeNull();
    expect(() => broker.submitInspectionResult({ ...identity, documentId: 'other',
      requestId: pending.requestId, ok: true, result: {} })).toThrowError(hasCode('GRANT_MISMATCH'));
    broker.submitInspectionResult({ ...identity, requestId: pending.requestId, ok: true,
      result: { html: '<main>OK</main>', url: identity.url, title: 'Editor', truncated: false } });
    expect(await pending.promise).toMatchObject({ ok: true, result: { html: '<main>OK</main>' } });
    expect(broker.inspectionStillPaired(identity.projectId, identity.grantId,
      grant.grant.conversationId, identity.documentId, identity.url)).toBe(true);
    broker.shutdown();
  });

  it('rejects oversized DOM and malformed PNG without retaining inspection data', async () => {
    const { broker, grant } = fixture();
    const identity = { projectId: grant.grant.projectId, grantId: grant.grant.grantId,
      token: grant.token, extensionOrigin: EXTENSION_ORIGIN,
      tabId: grant.grant.tabId, documentId: grant.grant.documentId,
      url: 'https://app.contoso.test/editor' };
    broker.pollInspection(identity);
    const pending = broker.requestInspection({ projectId: identity.projectId,
      conversationId: grant.grant.conversationId, grantId: identity.grantId, operation: 'snapshot' });
    broker.pollInspection(identity);
    const rejection = expect(pending.promise).rejects.toMatchObject({ code: 'INVALID_INSPECTION' });
    expect(() => broker.submitInspectionResult({ ...identity, requestId: pending.requestId,
      ok: true, result: { html: 'é'.repeat(262_145), title: 'Editor', url: identity.url,
        truncated: false } })).toThrowError(hasCode('INVALID_INSPECTION'));
    await rejection;
    const second = broker.requestInspection({ projectId: identity.projectId,
      conversationId: grant.grant.conversationId, grantId: identity.grantId, operation: 'screenshot' });
    broker.pollInspection(identity);
    const screenshotRejection = expect(second.promise).rejects.toMatchObject({ code: 'INVALID_INSPECTION' });
    expect(() => broker.submitInspectionResult({ ...identity, requestId: second.requestId,
      ok: true, result: { dataUrl: 'data:image/png;base64,QUJD' } }))
      .toThrowError(hasCode('INVALID_INSPECTION'));
    await screenshotRejection;
    broker.shutdown();
  });

  it('cancels pending reads on revoke, document rebind, and timeout', async () => {
    let now = 1_000;
    const broker = createEdgeAnnotationBroker({ now: () => now, ttlMs: 1_000,
      inspectionTimeoutMs: 20 });
    const pair = broker.createPendingPair({ projectId: 'p', conversationId: 'c' });
    const grant = broker.redeemPair({ code: pair.code, tabId: 1, documentId: 'doc',
      origin: 'https://example.test', extensionOrigin: EXTENSION_ORIGIN });
    const identity = { projectId: 'p', grantId: grant.grant.grantId, token: grant.token,
      extensionOrigin: EXTENSION_ORIGIN, tabId: 1, documentId: 'doc',
      url: 'https://example.test/page' };
    broker.pollInspection(identity);
    const expired = broker.requestInspection({ projectId: 'p', conversationId: 'c',
      grantId: identity.grantId, operation: 'snapshot' });
    broker.pollInspection(identity);
    const cancelled = expect(expired.promise).rejects.toMatchObject({ code: 'INSPECTION_UNAVAILABLE' });
    broker.requireGrant({ ...identity, documentId: 'new-doc' }, { rebindDocument: true });
    await cancelled;
    expect(() => broker.pollInspection({ ...identity, documentId: 'new-doc' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.requestInspection({ projectId: 'p', conversationId: 'c',
      grantId: identity.grantId, operation: 'snapshot' }))
      .toThrowError(hasCode('INSPECTION_UNAVAILABLE'));
    expect(broker.revoke('p', identity.grantId)).toBe(true);
    now += 1_000;
    expect(broker.inspectionStillPaired('p', identity.grantId, 'c', 'new-doc', identity.url)).toBe(false);

    const replacement = broker.redeemPair({ code: broker.createPendingPair({ projectId: 'p', conversationId: 'c' }).code,
      tabId: 1, documentId: 'new-doc', origin: 'https://example.test', extensionOrigin: EXTENSION_ORIGIN });
    const replacementIdentity = { ...identity, grantId: replacement.grant.grantId, token: replacement.token,
      documentId: 'new-doc' };
    broker.pollInspection(replacementIdentity);
    const timeout = broker.requestInspection({ projectId: 'p', conversationId: 'c',
      grantId: replacementIdentity.grantId, operation: 'snapshot' });
    await expect(timeout.promise).rejects.toMatchObject({ code: 'INSPECTION_TIMEOUT' });
    broker.shutdown();
    broker.shutdown();
  });

  it('pairs without an extension ID and keeps the connection through a same-origin document change', () => {
    const broker = createEdgeAnnotationBroker();
    const pair = broker.createPendingPair({ projectId: 'p1', conversationId: 'c1' });
    const connected = broker.redeemPair({ ...pair, tabId: 1, documentId: 'first',
      origin: 'https://example.test', extensionOrigin: EXTENSION_ORIGIN });
    expect(connected.grant.expiresAt - connected.grant.createdAt).toBeGreaterThanOrEqual(8 * 60 * 60_000);
    const input = { grantId: connected.grant.grantId, token: connected.token, tabId: 1,
      documentId: 'second', url: 'https://example.test/next', extensionOrigin: EXTENSION_ORIGIN };
    expect(broker.requireGrant(input, { rebindDocument: true }).documentId).toBe('second');
    expect(() => broker.pollInspection({ projectId: 'p1', ...input }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.requireGrant({ ...input, documentId: 'first' })).toThrow();
    expect(() => broker.requireGrant({ ...input, url: 'https://other.test' }, { rebindDocument: true })).toThrow();
    broker.shutdown();
  });

  it('binds a one-use pairing code to the browser tab that redeems it', () => {
    const { broker, grant } = fixture();
    const pair = broker.createPendingPair({ projectId: 'project-2', conversationId: 'conversation-2', extensionId: 'a'.repeat(32) });
    expect(() => broker.redeemPair({ code: `${pair.pairId}.wrong-code`, tabId: 1, documentId: 'document', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN }))
      .toThrowError(hasCode('PAIR_NOT_FOUND'));
    expect(() => broker.redeemPair({ ...pair, tabId: 1, documentId: 'document', origin: 'https://app.contoso.test', extensionOrigin: `chrome-extension://${'b'.repeat(32)}` }))
      .toThrowError(hasCode('PAIR_NOT_FOUND'));
    const redeemed = broker.redeemPair({ ...pair, tabId: 1, documentId: 'document', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN });
    expect(redeemed.grant.projectId).toBe('project-2');
    expect(() => broker.redeemPair({ ...pair, tabId: 2, documentId: 'other', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN }))
      .toThrowError(hasCode('PAIR_NOT_FOUND'));
    expect(broker.listGrants('project-1')).toEqual([grant.grant]);
    expect(JSON.stringify(broker.listGrants('project-2'))).not.toContain(redeemed.token);
    broker.shutdown();
  });

  it('expires unused pairing codes before any browser tab can redeem them', () => {
    const { broker, advance } = fixture();
    const pair = broker.createPendingPair({ projectId: 'project-2', conversationId: 'conversation-2', extensionId: 'a'.repeat(32) });
    advance(120_000);
    expect(() => broker.redeemPair({ ...pair, tabId: 1, documentId: 'document', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN }))
      .toThrowError(hasCode('PAIR_EXPIRED'));
    broker.shutdown();
  });

  it('allows HTTPS and local loopback HTTP, but refuses remote plaintext sites', () => {
    const { broker } = fixture();
    const pair = broker.createPendingPair({ projectId: 'local', conversationId: 'conversation-1', extensionId: 'a'.repeat(32) });
    const granted = broker.redeemPair({
      code: pair.code, tabId: 33, documentId: 'local-doc', origin: 'http://127.0.0.1:3000',
      extensionOrigin: EXTENSION_ORIGIN,
    });
    expect(granted.grant.origin).toBe('http://127.0.0.1:3000');
    const remotePair = broker.createPendingPair({ projectId: 'remote', conversationId: 'conversation-1', extensionId: 'a'.repeat(32) });
    expect(() => broker.redeemPair({
      code: remotePair.code, tabId: 34, documentId: 'remote-doc', origin: 'http://example.test',
      extensionOrigin: EXTENSION_ORIGIN,
    })).toThrowError(hasCode('INVALID_GRANT'));
    broker.shutdown();
  });

  it('validates reviewed annotations without staging chat messages or pixels', () => {
    const { broker, grant, submission } = fixture();
    const validated = broker.submit(submission);
    expect(validated.grant).toEqual(grant.grant);
    expect(validated.eventId).toBe('event-1');
    expect(validated.url).toBe('https://app.contoso.test/editor?view=details#changes');
    expect(validated.target.selector).toBe(target.selector);
    expect(validated.screenshot!.metadata).toMatchObject({ mimeType: 'image/png', width: 16, height: 8 });
    expect(validated.screenshot!.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(broker.listGrants('project-1')).toEqual([grant.grant]);
    expect(JSON.stringify(broker.listGrants('project-1'))).not.toContain(grant.token);
    expect(JSON.stringify(broker.listGrants('project-1'))).not.toContain('iVBORw');
    broker.shutdown();
  });

  it('accepts a nested DOM outline separated by LF but rejects unsafe evidence', () => {
    const { broker, submission } = fixture();
    const domOutline = 'div\n  h1 Marketplaces\n  p Discover UI kits';
    expect(broker.submit({ ...submission, target: { ...target, domOutline } }).target.domOutline)
      .toBe(domOutline);
    const designOutline = 'div\n  label Password: increase contrast';
    expect(broker.submit({ ...submission, target: { ...target, domOutline: designOutline } }).target.domOutline)
      .toBe(designOutline);
    for (const unsafe of ['div\r  h1 Title', 'div\t h1 Title', 'div\u0000 h1 Title',
      'div\n  input token=private', 'div\n  <input>']) {
      const accepted = broker.submit({ ...submission, target: { ...target, domOutline: unsafe } });
      expect(accepted.target.domOutline).not.toMatch(/[<>\r\t\u0000]/);
      expect(accepted.target.domOutline).not.toContain('token=private');
      expect(accepted.note).toBe(submission.note);
    }
    broker.shutdown();
  });

  it('expires the grant rather than retaining a staged annotation', () => {
    const { broker, submission, advance } = fixture();
    broker.submit(submission);
    advance(30 * 60_000);
    expect(broker.listGrants('project-1')).toEqual([]);
    expect(() => broker.submit(submission)).toThrowError(hasCode('GRANT_NOT_FOUND'));
    broker.shutdown();
  });

  it('requires exact project, tab, document and constant-time-checked secret', () => {
    const { broker, submission } = fixture();
    expect(() => broker.submit({ ...submission, projectId: 'project-2' })).toThrowError(hasCode('GRANT_NOT_FOUND'));
    expect(() => broker.submit({ ...submission, tabId: 13 })).toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, documentId: 'document-2' })).toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, token: 'invalid' })).toThrowError(hasCode('GRANT_NOT_FOUND'));
    broker.shutdown();
  });

  it('rejects submission after expiry and clears grants on shutdown', () => {
    const { broker, grant, submission, advance } = fixture();
    advance(1_000);
    expect(() => broker.submit(submission)).toThrowError(hasCode('GRANT_EXPIRED'));
    expect(broker.listGrants('project-1')).toEqual([]);
    const pair = broker.createPendingPair({ projectId: 'project-1', conversationId: 'conversation-1', extensionId: 'a'.repeat(32) });
    const replacement = broker.redeemPair({ ...pair, tabId: 12, documentId: 'document-1', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN });
    broker.shutdown();
    expect(() => broker.submit({ ...submission, grantId: replacement.grant.grantId, token: replacement.token }))
      .toThrowError(hasCode('GRANT_NOT_FOUND'));
  });

  it('revokes on navigation, document replacement, project switch and explicit stop', () => {
    const { broker, grant, submission } = fixture();
    broker.invalidateTab('project-1', 12);
    expect(() => broker.submit(submission)).toThrowError(hasCode('GRANT_NOT_FOUND'));
    const pair = broker.createPendingPair({ projectId: 'project-1', conversationId: 'conversation-1', extensionId: 'a'.repeat(32) });
    const next = broker.redeemPair({
      ...pair, tabId: 12, documentId: 'document-2', origin: 'https://app.contoso.test', extensionOrigin: EXTENSION_ORIGIN,
    });
    expect(broker.revoke('project-2', next.grant.grantId)).toBe(false);
    expect(broker.revoke('project-1', next.grant.grantId)).toBe(true);
    expect(broker.listGrants('project-1')).toEqual([]);
    broker.shutdown();
    expect(grant.token).not.toBe(next.token);
  });

  it('denies origin changes, identity hosts, and credential-bearing callback paths', () => {
    const { broker, submission } = fixture();
    expect(() => broker.submit({ ...submission, url: 'https://outlook.office.com/mail/' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    const pair = broker.createPendingPair({ projectId: 'p', conversationId: 'c', extensionId: 'a'.repeat(32) });
    expect(() => broker.redeemPair({ ...pair, tabId: 1, documentId: 'd', origin: 'https://login.microsoftonline.com', extensionOrigin: EXTENSION_ORIGIN }))
      .toThrowError(hasCode('INVALID_GRANT'));
    expect(broker.submit({ ...submission, url: 'https://app.contoso.test/signin' }).target)
      .toMatchObject({ selector: target.selector });
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/oauth/callback' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/editor?access_token=secret' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/editor?view=ok#code=private' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/%6f%61uth/callback' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/%2563allback' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/editor#%2563ode=private' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    expect(() => broker.submit({ ...submission, url: 'https://app.contoso.test/editor?%2561ccess_token=private' }))
      .toThrowError(hasCode('GRANT_MISMATCH'));
    broker.shutdown();
  });

  it('requires a bounded, genuine cropped PNG rather than a full screenshot or spoofed MIME', () => {
    const { broker, submission } = fixture();
    expect(() => broker.submit({ ...submission, screenshotDataUrl: '' }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    expect(() => broker.submit({ ...submission, screenshotDataUrl: 'data:image/png;base64,YWJj' }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    expect(() => broker.submit({ ...submission, screenshotDataUrl: `data:image/png;base64,${'A'.repeat(400_000)}` }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    const oversizedPixels = Buffer.from(screenshotDataUrl.split(',')[1]!, 'base64');
    oversizedPixels.writeUInt32BE(4_000, 16);
    expect(() => broker.submit({ ...submission, screenshotDataUrl: `data:image/png;base64,${oversizedPixels.toString('base64')}` }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    broker.shutdown();
  });

  it('validates bounded ancestors and styles without retaining untrusted nested references', () => {
    const { broker, submission } = fixture();
    const ancestors = [{ tag: 'section', selector: 'main > section:nth-of-type(2)', role: 'region' }];
    const style = { color: 'rgb(12, 13, 14)', fontSize: '16px' };
    const validated = broker.submit({ ...submission, target: { ...target, ancestors, style } });
    ancestors[0]!.selector = 'changed';
    style.color = 'changed';
    expect(validated.target).toMatchObject({
      ancestors: [{ tag: 'section', selector: 'main > section:nth-of-type(2)', role: 'region' }],
      style: { color: 'rgb(12, 13, 14)' },
    });
    expect(validated.screenshot!.metadata.bytes).toBeGreaterThan(0);
    expect(broker.submit({ ...submission, eventId: 'other', target: { ...target,
      ancestors: Array(9).fill({ tag: 'main', selector: 'main' }) } }).target.ancestors).toHaveLength(8);
    expect(broker.submit({ ...submission, eventId: 'third', target: { ...target,
      style: { password: 'abc' } as never } }).target.style).toEqual({});
    expect(broker.submit({ ...submission, target: { ...target, ancestors: [
      { tag: 'main', selector: 'main' }, { tag: 'div', selector: '<private>' },
    ], style: [] as never } }).target).toMatchObject({
      ancestors: [{ tag: 'main', selector: 'main' }], style: {},
    });
    broker.shutdown();
  });

  it('keeps safe computed styles and omits unsupported values without refusing the annotation', () => {
    const { broker, submission } = fixture();
    const validated = broker.submit({ ...submission, target: { ...target, style: {
      color: 'rgb(12, 13, 14)',
      fontFamily: '"Segoe UI", Arial, sans-serif',
    } } });
    expect(validated.target.style).toEqual({ color: 'rgb(12, 13, 14)',
      fontFamily: '"Segoe UI", Arial, sans-serif' });
    const withLongFont = broker.submit({ ...submission, target: { ...target, style: {
      color: 'rgb(12, 13, 14)', fontFamily: 'A'.repeat(161),
    } } });
    expect(withLongFont.target.style).toEqual({ color: 'rgb(12, 13, 14)' });
    const withCredential = broker.submit({ ...submission, target: { ...target, style: {
      color: 'rgb(12, 13, 14)', fontFamily: 'token=private-value',
    } } });
    expect(withCredential.target.style).toEqual({ color: 'rgb(12, 13, 14)' });
    const withMarkup = broker.submit({ ...submission, target: { ...target, style: {
      color: 'rgb(12, 13, 14)', fontFamily: 'url(<private>)',
    } } });
    expect(withMarkup.target.style).toEqual({ color: 'rgb(12, 13, 14)' });
    expect(broker.submit({ ...submission, target: { ...target,
      style: { color: 'rgb(12, 13, 14)', unknown: 'ignored' } as never } }).target.style)
      .toEqual({ color: 'rgb(12, 13, 14)' });
    broker.shutdown();
  });

  it('accepts a design-only sign-in field but rejects leaked values and raw HTML', () => {
    const { broker, submission } = fixture();
    const field = { ...target, selector: 'main > input', label: 'input', text: '',
      htmlHint: 'input', domOutline: 'input' };
    const accepted = broker.submit({ ...submission, target: field,
      note: 'Password: increase contrast and add a reveal icon' });
    expect(accepted.target).toMatchObject(field);
    expect(accepted.note).toBe('Password: increase contrast and add a reveal icon');
    expect(() => broker.submit({ ...submission, target: { ...field, htmlHint: '<input value="password">' } }))
      .toThrowError(hasCode('SENSITIVE_TARGET'));
    expect(broker.submit({ ...submission, target: { ...field, text: 'my token: abcdef' } }).target.text)
      .toBe('');
    broker.shutdown();
  });

  it('bounds optional design copy without rejecting a valid note', () => {
    const { broker, submission } = fixture();
    const accepted = broker.submit({ ...submission, target: { ...target,
      text: 'Use <Enter> to save\n' + 'A'.repeat(400),
      label: 'B'.repeat(200), domOutline: 'main\n' + 'C'.repeat(1400),
    } });
    expect(accepted.target.text).toHaveLength(300);
    expect(accepted.target.text).toContain('Use Enter to save');
    expect(accepted.target.label).toHaveLength(160);
    expect(accepted.target.domOutline).toHaveLength(1200);
    expect(accepted.note).toBe(submission.note);
    broker.shutdown();
  });

  it('rejects unbounded notes, selectors and unsafe position values', () => {
    const { broker, submission } = fixture();
    expect(() => broker.submit({ ...submission, note: 'x'.repeat(4_097) }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    expect(() => broker.submit({ ...submission, target: { ...target, selector: 'a'.repeat(4_097) } }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    expect(() => broker.submit({ ...submission, target: { ...target, position: { x: NaN, y: 0, width: 10, height: 10 } } }))
      .toThrowError(hasCode('INVALID_ANNOTATION'));
    broker.shutdown();
  });
});

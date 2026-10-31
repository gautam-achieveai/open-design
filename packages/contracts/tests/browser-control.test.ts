import { describe, expect, it } from 'vitest';

import {
  BROWSER_OPERATION_NAMES,
  isBrowserOperationName,
  isBrowserStylePatch,
  isBrowserStyleInspection,
  type BrowserOperationRequest,
  type BrowserOperationResult,
} from '../src/index.js';

describe('embedded browser control contracts', () => {
  it('bounds style patches and requires measured style results', () => {
    expect(isBrowserStylePatch({ color: 'rgb(32, 33, 36)', marginLeft: '-2px' })).toBe(true);
    for (const value of [null, [], {}, { arbitrary: 'red' }, { color: '' }, { width: 20 },
      { color: 'red; display: none' }, { fontFamily: 'token=private-value' },
      { width: '1'.repeat(161) }, JSON.parse('{"__proto__":"red"}'), { constructor: 'red' }]) {
      expect(isBrowserStylePatch(value)).toBe(false);
    }
    const inspection = { selector: 'h1', position: { x: -1, y: 20, width: 160, height: 30 }, style: { color: 'red' } };
    expect(isBrowserStyleInspection(inspection)).toBe(true);
    expect(isBrowserStyleInspection({ ...inspection, style: { color: 'red', fontFamily: '"宋体"' } })).toBe(true);
    for (const value of [null, false, {}, { ...inspection, style: {} },
      { ...inspection, style: { color: 'token=private-value' } },
      { ...inspection, position: { ...inspection.position, width: 0 } }]) {
      expect(isBrowserStyleInspection(value)).toBe(false);
    }
    const request: BrowserOperationRequest = { operation: 'style', approved: true, target: { selector: 'h1' }, styles: { color: 'red' } };
    const result: BrowserOperationResult = { operation: 'style', applied: true, inspection };
    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({ request, result });
  });

  it('pins the complete operation vocabulary', () => {
    expect(BROWSER_OPERATION_NAMES).toEqual([
      'snapshot',
      'inspect',
      'style',
      'screenshot',
      'click',
      'type',
      'scroll',
      'navigate',
      'viewport',
      'console',
      'network-list',
      'network-get',
      'network-failures',
      'evaluate',
      'devtools',
    ]);
    expect(BROWSER_OPERATION_NAMES.every(isBrowserOperationName)).toBe(true);
    expect(isBrowserOperationName('unknown-operation')).toBe(false);
  });

  it('keeps requests and results JSON-safe', () => {
    const request: BrowserOperationRequest = {
      operation: 'type',
      approved: true,
      target: { selector: '[data-testid="email"]' },
      text: 'person@example.com',
      clear: true,
    };
    const result: BrowserOperationResult = {
      operation: 'network-failures',
      entries: [{ requestId: 'r1', status: 503, retryable: true }],
    };

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('requires explicit approval on every consequential operation', () => {
    // @ts-expect-error Consequential operations cannot be constructed without approval.
    const unapprovedClick: BrowserOperationRequest = {
      operation: 'click',
      target: { selector: '#submit' },
    };
    const consequential: BrowserOperationRequest[] = [
      {
        operation: 'click',
        approved: true,
        target: { selector: '#submit' },
      },
      {
        operation: 'type',
        approved: true,
        target: { selector: '#email' },
        text: 'person@example.com',
      },
      {
        operation: 'scroll',
        approved: true,
        deltaX: 0,
        deltaY: 500,
      },
      {
        operation: 'navigate',
        approved: true,
        url: 'https://example.com/',
      },
    ];

    expect(unapprovedClick).not.toHaveProperty('approved');
    expect(
      consequential.every(
        (operation) => 'approved' in operation && operation.approved === true,
      ),
    ).toBe(true);
  });
});

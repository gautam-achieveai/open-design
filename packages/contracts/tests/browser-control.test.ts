import { describe, expect, it } from 'vitest';

import {
  BROWSER_OPERATION_NAMES,
  isBrowserOperationName,
  type BrowserOperationRequest,
  type BrowserOperationResult,
} from '../src/index.js';

describe('embedded browser control contracts', () => {
  it('pins the complete operation vocabulary', () => {
    expect(BROWSER_OPERATION_NAMES).toEqual([
      'snapshot',
      'inspect',
      'screenshot',
      'click',
      'type',
      'scroll',
      'navigate',
      'console',
      'network-list',
      'network-get',
      'network-failures',
    ]);
    expect(BROWSER_OPERATION_NAMES.every(isBrowserOperationName)).toBe(true);
    expect(isBrowserOperationName('evaluate')).toBe(false);
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

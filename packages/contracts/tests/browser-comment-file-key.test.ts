import { describe, expect, it } from 'vitest';

import {
  browserCommentFileKey,
  isBrowserCommentFileKey,
} from '../src/api/comments';

describe('browserCommentFileKey', () => {
  it('keys a page by the normalised URL, fragment included', () => {
    expect(browserCommentFileKey('https://app.example.com/inbox?folder=2#msg-9'))
      .toBe('browser:https://app.example.com/inbox?folder=2#msg-9');
    // A hash-routed SPA: each route is its own page (and numbering space).
    expect(browserCommentFileKey(' http://127.0.0.1:5180/#/workbench '))
      .toBe('browser:http://127.0.0.1:5180/#/workbench');
    expect(browserCommentFileKey('HTTP://127.0.0.1:5180')).toBe('browser:http://127.0.0.1:5180/');
  });

  it('separates routes and queries, but not the same page typed two ways', () => {
    expect(browserCommentFileKey('https://a.test/x#/1')).not.toBe(browserCommentFileKey('https://a.test/x#/2'));
    expect(browserCommentFileKey('https://a.test/x?q=1')).not.toBe(browserCommentFileKey('https://a.test/x?q=2'));
    expect(browserCommentFileKey('https://A.test/x')).toBe(browserCommentFileKey('https://a.test/x'));
  });

  it('refuses non-http pages and garbage', () => {
    expect(browserCommentFileKey('about:blank')).toBeNull();
    expect(browserCommentFileKey('chrome-extension://abc/popup.html')).toBeNull();
    expect(browserCommentFileKey('not a url')).toBeNull();
    expect(browserCommentFileKey('')).toBeNull();
  });

  it('recognises browser keys by prefix only', () => {
    expect(isBrowserCommentFileKey('browser:https://a.test/')).toBe(true);
    expect(isBrowserCommentFileKey('index.html')).toBe(false);
    expect(isBrowserCommentFileKey(undefined)).toBe(false);
  });
});

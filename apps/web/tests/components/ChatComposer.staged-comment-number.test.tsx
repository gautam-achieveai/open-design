// @vitest-environment jsdom
/**
 * A staged saved comment shows the same number as its canvas pin (`pinSeq`
 * carried as `order`), so the user can match chip ↔ pin ↔ the model's `N.`.
 * Board-batch notes are not pins and get no number.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import type { ChatCommentAttachment } from '../../src/types';

const base: ChatCommentAttachment = {
  id: 'c3',
  order: 3,
  filePath: 'index.html',
  elementId: 'hero-title',
  selector: '[data-od-id="hero-title"]',
  label: 'h1.hero-title',
  comment: 'Shorten this title',
  currentText: 'A long title',
  pagePosition: { x: 12, y: 44, width: 500, height: 60 },
  htmlHint: '<h1 data-od-id="hero-title">',
  source: 'saved-comment',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  cleanup();
});

describe('ChatComposer staged comment numbering', () => {
  it('labels a saved comment chip with its pin number and leaves board notes unnumbered', () => {
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        commentAttachments={[
          base,
          { ...base, id: 'note', order: 1, elementId: 'chart', source: 'board-batch' },
        ]}
      />,
    );

    const tray = screen.getByTestId('staged-comment-attachments');
    expect(tray.querySelectorAll('.staged-chip')).toHaveLength(2);
    expect(
      Array.from(screen.getAllByTestId('staged-comment-seq')).map((node) => node.textContent),
    ).toEqual(['#3']);
  });
});

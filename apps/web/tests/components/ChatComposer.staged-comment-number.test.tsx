// @vitest-environment jsdom
/**
 * A staged saved comment shows the same number as its canvas pin (`pinSeq`
 * carried as `order`), so the user can match chip ↔ pin ↔ the model's `N.`.
 * Board-batch notes are not pins and get no number.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(tray.querySelectorAll('[data-testid="staged-comment-card"]')).toHaveLength(2);
    expect(
      Array.from(screen.getAllByTestId('staged-comment-seq')).map((node) => node.textContent),
    ).toEqual(['#3']);
  });

  it('shows the element capture as the card picture and opens it whole on click', () => {
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        commentAttachments={[{
          ...base,
          imageAttachments: [
            { path: 'refs/user-sketch.png', name: 'user-sketch.png' },
            { path: 'browser-annotations/browser-annotation-1.png', name: 'browser-annotation-1.png' },
          ],
        }]}
      />,
    );

    const card = screen.getByTestId('staged-comment-card');
    expect(card.querySelector('img')?.getAttribute('src')).toContain('browser-annotations/browser-annotation-1.png');
    expect(within(card).getByRole('button', { name: 'Remove comment attachment for #3 h1.hero-title' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Preview #3 h1.hero-title' }));
    const dialog = screen.getByRole('dialog', { name: '#3 h1.hero-title' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain('browser-annotations/browser-annotation-1.png');
    expect(within(dialog).getByText('Shorten this title')).toBeTruthy();
  });

  it('falls back to the element text, then the target name, when the pin has no picture', () => {
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        commentAttachments={[base, { ...base, id: 'c4', order: 4, currentText: '' }]}
      />,
    );

    const [withText, withoutText] = screen.getAllByTestId('staged-comment-card');
    expect(withText!.querySelector('img')).toBeNull();
    expect(within(withText!).getByText('A long title')).toBeTruthy();
    expect(within(withoutText!).getByText('h1.hero-title')).toBeTruthy();
  });
  it('names the page on cards whose pin number repeats on another page', () => {
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        commentAttachments={[
          { ...base, id: 'a1', order: 1, filePath: 'browser:https://shop.example.test/cart?x=1' },
          { ...base, id: 'b1', order: 1, filePath: 'browser:https://shop.example.test/checkout' },
          { ...base, id: 'a2', order: 2, filePath: 'browser:https://shop.example.test/cart?x=1' },
        ]}
      />,
    );

    const cards = screen.getAllByTestId('staged-comment-card');
    // Pin numbers count per page: both #1 cards say which page they are on,
    // the unique #2 stays a plain card.
    expect(cards.map((card) => card.querySelector('[data-testid="staged-comment-page"]')?.textContent ?? null))
      .toEqual(['shop.example.test/cart', 'shop.example.test/checkout', null]);
    // Screen readers hear the page too, on both the open and the remove button.
    expect(within(cards[1]!).getAllByRole('button', { name: /#1 .*· shop\.example\.test\/checkout/ })).toHaveLength(2);
  });
});

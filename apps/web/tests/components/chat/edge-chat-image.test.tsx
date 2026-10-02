// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UserMessageImpl } from '../../../src/components/ChatPane';

const t = ((key: string) => key) as never;

afterEach(cleanup);

describe('chat-only Edge image', () => {
  it('renders a chat-owned JSON attachment without displaying technical context', () => {
    render(<UserMessageImpl message={{ id: 'message-1', role: 'user', content: 'Change Save',
      createdAt: Date.now(), annotationContexts: [{ id: 'annotation-1',
        name: 'annotation-context.json', mimeType: 'application/json' }] } as never}
      projectId="project-1" conversationId="conversation-1" t={t} />);
    const link = screen.getByRole('link', { name: 'annotation-context.json' });
    expect(link.getAttribute('href')).toBe('/api/projects/project-1/conversations/conversation-1/messages/message-1/annotation-context/annotation-1');
    expect(screen.getByTestId('user-message').textContent).not.toContain('DOM outline');
  });

  it('renders an authorized message-scoped link rather than a project source attachment', () => {
    render(<UserMessageImpl message={{ id: 'message-1', role: 'user', content: 'Change Save',
      createdAt: Date.now(), chatImages: [{ id: 'message-1', mimeType: 'image/png',
        bytes: 80, width: 16, height: 8 }] } as never}
      projectId="project-1" conversationId="conversation-1" t={t} />);
    const image = screen.getByAltText('chat.edge.reviewedScreenshot') as HTMLImageElement;
    const url = '/api/projects/project-1/conversations/conversation-1/messages/message-1/edge-image';
    expect(image.getAttribute('src')).toBe(url);
    const link = screen.getByRole('link', { name: 'chat.edge.openReviewedScreenshot' });
    expect(link.getAttribute('href')).toBe(url);
    expect(screen.getByTestId('chat-only-image-row')).toBeTruthy();
  });
});

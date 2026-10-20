// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { flushMounts } from '../helpers/lexical-composer';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatComposer fixed Design mode', () => {
  it('does not expose a session-mode picker in project chat', async () => {
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    await flushMounts();

    expect(screen.queryByTestId('composer-mode-trigger')).toBeNull();
    expect(screen.queryByTestId('composer-mode-clear')).toBeNull();
  });

  it('shows the picker, with Build, only when the host offers Build mode', async () => {
    const onSessionModeChange = vi.fn();
    render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        sessionMode="build"
        onSessionModeChange={onSessionModeChange}
        buildModeAvailable
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    await flushMounts();

    expect(screen.getByTestId('composer-mode-trigger').getAttribute('aria-label')).toBe('Mode: Build');
  });
});

// @vitest-environment jsdom
/**
 * Red spec: a streaming delta that leaves the "jump to latest" pill unchanged
 * must cost ChatPane exactly one render.
 *
 * Seen live (Next.js dev, fast streaming): the console reports
 * `Maximum update depth exceeded ... calls setState inside useEffect`, blamed
 * on whichever `setMessages` happens to cross React's counter.
 *
 * Cause: the content effects call `syncFollowState()` on every delta, and it
 * used to call `setScrolledFromBottom((prev) => … prev)`. An updater that
 * returns `prev` only skips work when React can bail out eagerly, which needs
 * the fiber to have no pending lanes. During streaming that is often false, so
 * the call still queues an update from inside the passive-effect flush. React
 * counts each flush that schedules work; once deltas keep batching into those
 * follow-up renders the chain passes 50 and the warning fires. Each one is
 * also a wasted ChatPane render.
 *
 * The check counts ChatPane renders through its `useI18n()` call, one per
 * render, and expects one render per delta.
 */
import { act, cleanup, render } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../../src/components/ChatPane';
import type { AppConfig, ChatMessage } from '../../../src/types';

const translate = (key: string, vars?: Record<string, string | number>) =>
  (vars && Object.keys(vars).length > 0 ? `${key} ${Object.values(vars).join(' ')}` : key);

let chatPaneRenders = 0;
/** True when the hook was called from ChatPane's own body, not a child. */
const calledFromChatPane = () =>
  /\n\s*at ChatPane \(/.test(new Error().stack ?? '');

vi.mock('../../../src/i18n', () => ({
  useI18n: () => {
    if (calledFromChatPane()) chatPaneRenders += 1;
    return { locale: 'en', setLocale: () => undefined, t: translate };
  },
  useT: () => translate,
}));

vi.mock('../../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid={`assistant-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('../../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
    trackRunFailedToastSurfaceView: vi.fn(),
    trackRunRecoveryActionClick: vi.fn(),
    trackRunRecoveryActionSurfaceView: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function buildMessages(streamedChars: number): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'question', createdAt: 1 } as ChatMessage,
    {
      id: 'a-stream',
      role: 'assistant',
      content: 'x'.repeat(streamedChars),
      createdAt: 2,
      runId: 'run-1',
      runStatus: 'running',
      agentId: 'amr',
      events: [],
    } as unknown as ChatMessage,
  ];
}

function chatPane(messages: ChatMessage[]) {
  return (
    <ChatPane
      messages={messages}
      streaming
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'amr', agentCliEnv: {} } as unknown as AppConfig}
    />
  );
}

/**
 * Browser-like scroll geometry for the log: content height follows the
 * streamed text, and a `scrollTop` write fires `scroll` on a later task, the
 * way a browser does after the bottom-pin write. Those scroll events run
 * `syncFollowState` outside React, which is what leaves ChatPane's fiber with
 * pending work when the next passive flush calls it again.
 */
function emulateLogGeometry(log: HTMLElement, contentHeight: () => number) {
  let top = 0;
  const clientHeight = 600;
  const max = () => Math.max(0, contentHeight() - clientHeight);
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(log, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(clientHeight, contentHeight()),
  });
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const next = Math.min(max(), Math.max(0, value));
      if (next === top) return;
      top = next;
      setTimeout(() => log.dispatchEvent(new Event('scroll')), 0);
    },
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('ChatPane follow sync during streaming', () => {
  it('renders once per delta when the jump pill does not change', async () => {
    let streamed = 1;
    const { rerender } = render(chatPane(buildMessages(streamed)));
    const log = document.querySelector('[data-testid="chat-log"]') as HTMLElement;
    emulateLogGeometry(log, () => 400 + streamed * 4);
    // Let mount-time effects and frames settle before counting.
    await settle();

    const deltas = 20;
    chatPaneRenders = 0;
    for (let i = 0; i < deltas; i += 1) {
      streamed += 40;
      await act(async () => { rerender(chatPane(buildMessages(streamed))); });
      await settle();
    }

    expect(document.querySelector('.chat-jump-btn-active')).toBeNull();
    expect(chatPaneRenders).toBe(deltas);
  });
});

// @vitest-environment jsdom
//
// 红测(OPEND-2597):**跑到一半余额不足只该有升级卡,不该出第二张白色通用报错卡。**
//
// 用户 2026-09-02 裁决:「额度不足和额度耗尽,升级卡各只有一张,不存在第二张
// 白色通用报错卡」。
//
// 「跑到一半」那条走的是 daemon 的 `AMR_INSUFFICIENT_BALANCE` → `amr-guidance` 的
// 通用 `failureCard` → 白色 `RunErrorCard` + 四颗按钮。同一件事两张卡、两种说法,
// 正是设计稿要避免的。
//
// 这一页断言的是**渲染出来的东西**,不是映射表的字段:从真实的 `<ChatPane>` 出发,
// 给它产品真实会给的 props,然后数 DOM 里有几张卡。
//
// 反向对照同样是这一页的一部分:别的失败(客户端环境类 · S30、超时)**仍然**
// 画白色报错卡。少了这一条,「把整条报错路都改掉」会一路绿着推上去。

import { cleanup, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../../src/components/ChatPane';
import type { AppConfig, ChatMessage } from '../../../src/types';

const translate = (key: string, vars?: Record<string, string | number>) => {
  if (vars && Object.keys(vars).length > 0) {
    return `${key} ${Object.values(vars).join(' ')}`;
  }
  return key;
};

vi.mock('../../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: translate }),
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

/** 一轮已经开始、跑到一半才死掉的 AMR 回合。 */
function failedMidRun(
  event: { code?: string; failureDetail?: string; detail?: string },
): ChatMessage {
  return {
    id: 'msg-failed',
    role: 'assistant',
    content: 'Partial work before the failure.',
    createdAt: 1,
    runId: 'run-failed',
    runStatus: 'failed',
    agentId: 'amr',
    events: [
      {
        kind: 'status',
        label: 'error',
        detail: event.detail ?? 'Something went wrong.',
        ...(event.code ? { code: event.code } : {}),
        ...(event.failureDetail ? { failureDetail: event.failureDetail } : {}),
      },
    ],
  } as ChatMessage;
}

function renderChat(opts: {
  messages?: ChatMessage[];
} = {}) {
  return render(
    <ChatPane
      messages={opts.messages ?? []}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onOpenSettings={vi.fn() as never}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'amr', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
}

/**
 * 「白色通用报错卡在不在」。用精确查询 + `toBeNull()`,不用否定式匹配 ——
 * 后者在选择器写错时会永远为真。
 */
function genericErrorCard(container: HTMLElement): Element | null {
  return container.querySelector('[data-user-action-card="run-recovery"]');
}

describe('反向对照:别的失败照旧画通用报错卡', () => {
  it('客户端环境类失败(证书 · S30)仍然是白色报错卡,且没有升级卡', () => {
    const { container } = renderChat({
      messages: [failedMidRun({ failureDetail: 'certificate_failure' })],
    });

    expect(genericErrorCard(container)).toBeTruthy();
    expect(screen.getByTestId('chat-error-contact-support')).toBeTruthy();
    expect(screen.getByTestId('chat-error-export-logs')).toBeTruthy();
    expect(screen.queryByTestId('chat-upgrade-card')).toBeNull();
  });

  it('超时仍然是白色报错卡', () => {
    const { container } = renderChat({
      messages: [failedMidRun({ failureDetail: 'timeout' })],
    });

    expect(genericErrorCard(container)).toBeTruthy();
    expect(screen.queryByTestId('chat-upgrade-card')).toBeNull();
  });

  it('AMR 的登录失效仍然是白色报错卡 —— 那一档说的不是钱', () => {
    const { container } = renderChat({
      messages: [failedMidRun({ code: 'AMR_AUTH_REQUIRED' })],
    });

    expect(genericErrorCard(container)).toBeTruthy();
    expect(screen.queryByTestId('chat-upgrade-card')).toBeNull();
  });
});

describe('Historical balance failure after Cloud retirement', () => {
  it('keeps diagnostics visible without a wallet lookup, upgrade, or retry action', () => {
    const {container}=renderChat({messages:[failedMidRun({code:'AMR_INSUFFICIENT_BALANCE'})]});
    expect(genericErrorCard(container)).toBeTruthy();
    expect(screen.queryByTestId('chat-upgrade-card')).toBeNull();
    expect(screen.queryByTestId('chat-error-retry')).toBeNull();
  });
});

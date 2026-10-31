// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ChatMessage, PersistedAgentEvent } from '@open-design/contracts';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { I18nProvider } from '../../../src/i18n';
import type { BuildTurnInput } from '../../../src/runtime/chat/contract';

const buildSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/runtime/chat/build-turn-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/chat/build-turn-blocks')>();
  return {
    ...actual,
    buildTurnBlocks: (input: BuildTurnInput) => {
      buildSpy(input);
      return actual.buildTurnBlocks(input);
    },
  };
});

const T0 = 1_800_000_000_000;
const events: PersistedAgentEvent[] = [
  { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' }, startedAt: T0 },
];
const message = {
  id: 'm1', role: 'assistant', content: '', createdAt: T0, runStatus: 'running', events,
} as ChatMessage;

function ui(showRole = false): ReactElement {
  return (
    <I18nProvider initial="zh-CN">
      <AssistantMessage message={message} streaming showRole={showRole} />
    </I18nProvider>
  );
}

function elapsedText(root: HTMLElement): string {
  return Array.from(root.querySelectorAll('[data-testid="chat-foldable-elapsed"]'))
    .map((node) => node.textContent)
    .join('|');
}

describe('stream clock render boundary', () => {
  beforeEach(() => {
    buildSpy.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 3_000);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('advances labels and unrelated renders without rebuilding the turn', () => {
    const { container, rerender } = render(ui());
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(elapsedText(container)).toBe('3.0s|3.0s');

    act(() => { vi.advanceTimersByTime(6_000); });
    expect(elapsedText(container)).toBe('9.0s|9.0s');
    expect(buildSpy).toHaveBeenCalledTimes(1);

    rerender(ui(true));
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(elapsedText(container)).toBe('9.0s|9.0s');

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(elapsedText(container)).toBe('12s|12.0s');
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('starts ticking from a known sub-100 ms baseline without inventing 0.0s', () => {
    vi.setSystemTime(T0 + 50);
    const { container } = render(ui());
    expect(elapsedText(container)).toBe('|');
    expect(container.textContent).not.toContain('0.0s');

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(elapsedText(container)).toBe('1.1s|1.1s');
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});

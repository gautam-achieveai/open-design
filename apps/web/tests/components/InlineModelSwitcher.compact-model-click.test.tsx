// @vitest-environment jsdom
// Local model picker selections must reach the visible chip and persistence.

// @vitest-environment jsdom
// Local model picker selections must reach the visible chip and persistence.
import {
  useRef,
  useState,
} from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentModelChoice } from '../../src/App';

import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

/** The catalog from the bug report: the two DeepSeek tiers are on the caller's
 *  plan, the Claude tiers are not. `enabled: true` is what `vela model list
 *  --json` reports for a model above the caller's plan. */
const localAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: true, default: true },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: true },
    { id: 'claude-fable-5', label: 'claude-fable-5', enabled: true },
    { id: 'claude-opus-4.6', label: 'claude-opus-4.6', enabled: true },
    { id: 'claude-opus-4.7', label: 'claude-opus-4.7', enabled: true },
    { id: 'claude-opus-4.8', label: 'claude-opus-4.8', enabled: true },
  ],
};

/** Same catalog with every model on-plan — the control case. */
const localAgentAllEnabled: AgentInfo = {
  ...localAgent,
  models: (localAgent.models ?? []).map((model) => ({ ...model, enabled: true })),
};

/**
 * Mirrors `App.handleAgentModelChange`: merge into the persisted choice, keep a
 * ref as the write-through truth source, and re-render the switcher with the new
 * config. This is the round-trip the chip label actually depends on, and the
 * same round-trip a page reload replays out of the persisted config.
 */
function StatefulSwitcher({
  agents,
  initialConfig,
  compact = true,
  onPersist,
}: {
  agents: AgentInfo[];
  initialConfig?: Partial<AppConfig>;
  compact?: boolean;
  onPersist?: (agentId: string, model: string | undefined) => void;
}) {
  const [config, setConfig] = useState<AppConfig>({ ...baseConfig, ...initialConfig });
  const persistedRef = useRef(config);
  return (
    <InlineModelSwitcher
      config={config}
      agents={agents}
      providerModelsCache={{}}
      compact={compact}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={(agentId, choice) => {
        const current = persistedRef.current;
        const merged = mergeAgentModelChoice(
          current.agentModels?.[agentId] ?? {},
          choice,
        );
        const next: AppConfig = {
          ...current,
          agentModels: { ...(current.agentModels ?? {}), [agentId]: merged },
        };
        persistedRef.current = next;
        onPersist?.(agentId, merged.model);
        setConfig(next);
      }}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
}

function chipText(): string {
  return screen.getByTestId('inline-model-switcher-chip').textContent ?? '';
}

function openSwitcher(): HTMLElement {
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

/** What the picker shows for a catalog name now that the company token is
 *  dropped: `deepseek-v4-pro` → `v4-pro`. Restated here on purpose — the point
 *  of these assertions is the text a user reads, not the helper that makes it. */
function versionOf(label: string): string {
  return label.replace(/^(?:deepseek|claude)-/, '');
}

function compactRow(modelId: string): HTMLElement {
  return screen.getByTestId(`inline-model-switcher-compact-model-${modelId}`);
}

function isOffered(row: HTMLElement): boolean {
  return (
    !(row as HTMLButtonElement).disabled && row.getAttribute('aria-disabled') !== 'true'
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pins the clock inside/outside the real campaign window — the ONLY lever
 *  left for campaign visibility now that the URL review parameters are gone. */

describe('compact home model list — a clicked model reaches the chip', () => {
  it('never offers a model whose click the chip will not honor', () => {
    // The invariant, stated as the user sees it. Any row the list presents as
    // clickable must move the chip; a row it will not honor must be presented
    // as unavailable with a reason. Today `claude-opus-4.6` (and the other
    // off-plan Claude tiers) are offered as plain rows and clicking them leaves
    // the chip on `deepseek-v4-flash`.
    for (const model of localAgent.models ?? []) {
      render(<StatefulSwitcher agents={[localAgent]} />);
      expect(chipText()).toContain(versionOf('deepseek-v4-flash'));

      openSwitcher();
      const row = compactRow(model.id);
      const offered = isOffered(row);
      fireEvent.click(row);

      if (offered) {
        expect(chipText(), `${model.id} was offered as selectable`).toContain(
          versionOf(model.label),
        );
      } else {
        // Refused is fine — silently refused is not. The row must say why.
        expect(
          screen.getByTestId(`inline-model-switcher-compact-model-lock-${model.id}`)
            .textContent,
          `${model.id} was refused without a reason`,
        ).toBeTruthy();
        expect(chipText()).toContain(versionOf('deepseek-v4-flash'));
      }
      cleanup();
    }
  });

  it('applies an available model the user clicks', () => {
    // Control case: this passes on the unfixed code. It is what rules out the
    // outside-click/`mousedown` close handler as the cause — if that handler
    // were unmounting the list before the option's click fired, this case would
    // fail too.
    render(<StatefulSwitcher agents={[localAgentAllEnabled]} />);
    expect(chipText()).toContain(versionOf('deepseek-v4-flash'));

    openSwitcher();
    fireEvent.click(compactRow('deepseek-v4-pro'));

    expect(chipText()).toContain(versionOf('deepseek-v4-pro'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('names models by version alone — the brand mark carries the company', () => {
    // Every row in this list already shows the company's logo, so printing
    // `deepseek-`/`claude-` in front of each name spends width on the half of
    // the string that is identical within a company. The chip follows the rows.
    render(<StatefulSwitcher agents={[localAgentAllEnabled]} />);
    expect(chipText()).toContain('v4-flash');
    expect(chipText()).not.toContain('deepseek');

    const popover = openSwitcher();
    expect(compactRow('deepseek-v4-pro')).toHaveTextContent('v4-pro');
    expect(compactRow('claude-fable-5')).toHaveTextContent('fable-5');
    expect(within(popover).getAllByRole('radio').map((r) => r.textContent ?? '').join('\n'))
      .not.toMatch(/deepseek-|claude-/);
  });

  it('re-selecting the already active model closes the list without changing the chip', () => {
    render(<StatefulSwitcher agents={[localAgentAllEnabled]} />);
    openSwitcher();
    fireEvent.click(compactRow('deepseek-v4-flash'));

    expect(chipText()).toContain(versionOf('deepseek-v4-flash'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('still closes on a click genuinely outside the switcher', () => {
    render(
      <div>
        <StatefulSwitcher agents={[localAgentAllEnabled]} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    openSwitcher();
    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('keeps the execution-settings picker applying a model', () => {
    // The non-compact surface the existing portal-class exemption protects. It
    // must keep working: its option list is a `document.body` portal, so its
    // clicks land outside the switcher's wrapper.
    render(<StatefulSwitcher agents={[localAgentAllEnabled]} compact={false} />);
    openSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    fireEvent.mouseDown(modelPopover);
    fireEvent.click(
      within(modelPopover).getByRole('option', { name: new RegExp(versionOf('deepseek-v4-pro')) }),
    );

    expect(chipText()).toContain(versionOf('deepseek-v4-pro'));
    expect(screen.getByTestId('inline-model-switcher-agent-model')).toHaveTextContent(
      versionOf('deepseek-v4-pro'),
    );
  });
});

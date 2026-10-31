// @vitest-environment jsdom

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';

import { fetchProviderModels } from '../../src/providers/provider-models';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import type { AgentInfo, AppConfig, ProviderModelOption } from '../../src/types';
import { workspaceDirectoryFixture } from '../helpers/workspace-context';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsMocks.track,
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setConfigureGlobals: vi.fn(),
      setUserId: vi.fn(),
      anonymousId: 'test-anonymous-id',
      sessionId: 'test-session-id',
      newRequestId: () => 'test-request-id',
    }),
  };
});

function optionNames(container: HTMLElement): string[] {
  return within(container).getAllByRole('option').map((option) => {
    const labelledBy = option.getAttribute('aria-labelledby');
    if (!labelledBy) return option.textContent?.trim() ?? '';
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  });
}

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
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
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'default', label: 'Default' },
    { id: 'amr-cloud-latest', label: 'AMR Cloud Latest' },
  ],
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0-alpha.1',
  models: [{ id: 'default', label: 'Default' }],
};

function renderSwitcher(
  config: Partial<AppConfig> = {},
  agents: AgentInfo[] = [amrAgent],
  providerModelsCache: Record<string, ProviderModelOption[]> = {},
  options: { compact?: boolean } = {},
) {
  const onAgentModelChange = vi.fn();
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      providerModelsCache={providerModelsCache}
      compact={options.compact}
      daemonLive={true}
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={onAgentModelChange}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  return { ...view, onAgentModelChange };
}

// recvqfYKutwWlQ: the AMR upgrade entry point must only render for a caller who
// can actually act on it (`permissions.canManageBilling`), never just a
// caller whose plan tier happens to be upgradeable. Personal workspaces
// resolve `canManageBilling` true because the user is always their own owner
// there (`buildWorkspacePermissions`: `canManageBilling: readable && isOwner`),
// so this fixture doubles as the "personal identity keeps the upgrade entry"
// control case.
function personalWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-personal',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'personal_byok',
    seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: false },
    permissions: {
      canManageMembers: true,
      canManageBilling: true,
      canInviteMembers: true,
      canManageAutoRecharge: true,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: true,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

// A team MEMBER (not owner/admin) — `canManageBilling` folds in role, so this
// is the "cannot act on billing" case the upgrade entry must hide for.
function teamMemberWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    ...personalWorkspaceContext(),
    workspaceId: 'ws-team',
    workspaceType: 'team',
    role: 'member',
    teamId: 'team-1',
    teamName: 'OD Feature Team',
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

function workspaceContextResponse(context: WorkspaceCollabContext | null) {
  return new Response(JSON.stringify({ context }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function workspaceDirectoryResponse(context: WorkspaceCollabContext) {
  return new Response(JSON.stringify(workspaceDirectoryFixture([context])), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function expectVelaLoginWithAttribution(
  fetchMock: ReturnType<typeof vi.fn>,
  sourceDetail: string,
) {
  const loginCall = fetchMock.mock.calls.find(([input, init]) => (
    input.toString() === '/api/integrations/vela/login'
    && (init as RequestInit | undefined)?.method === 'POST'
  ));
  expect(loginCall).toBeDefined();
  const init = loginCall?.[1] as RequestInit | undefined;
  expect(init).toEqual(expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: expect.any(String),
  }));
  const body = JSON.parse(String(init?.body)) as {
    attribution?: {
      entryId?: string;
      sourceProduct?: string;
      sourceDetail?: string;
      occurredAt?: string;
    };
  };
  expect(body.attribution).toEqual(expect.objectContaining({
    entryId: expect.stringMatching(/^od-amr-/u),
    sourceProduct: 'open_design',
    sourceDetail,
  }));
  expect(Number.isFinite(Date.parse(body.attribution?.occurredAt ?? ''))).toBe(true);
}

describe('InlineModelSwitcher', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(fetchProviderModels).mockReset();
    analyticsMocks.track.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try {
      window.localStorage.clear();
    } catch {
      // jsdom normally exposes localStorage; keep cleanup tolerant.
    }
    resetWorkspaceContextCache();
  });

  it('keeps an accessible name on the chip when the icon-only treatment hides its text', () => {
    // Regression: in the icon-only topbar treatment `.inline-switcher__chip-text`
    // is `display: none`, so the visible label is removed from the accessibility
    // tree. The button must still expose a real accessible name (CLI/model state)
    // for screen-reader users, not just an icon plus a `data-tooltip` hint.
    renderSwitcher({ agentId: 'codex' }, [amrAgent, codexAgent]);

    const chip = screen.getByRole('button', {
      name: /Codex/i,
    });
    expect(chip).toBe(screen.getByTestId('inline-model-switcher-chip'));
    expect(chip.getAttribute('aria-label')).toMatch(/·/u);
  });

  it('can render the compact home-hero chip variant', () => {
    renderSwitcher({}, [amrAgent, codexAgent], {}, { compact: true });

    expect(screen.getByTestId('inline-model-switcher').className).toContain(
      'inline-switcher--compact',
    );
  });

  // recvqfYKutwWlQ: a team member's plan tier can be upgradeable while the
  // member itself cannot act on billing (owner-only) — the upgrade entry must
  // stay hidden for them even with a fully signed-in, upgrade-eligible AMR
  // account.

  it('filters fetched BYOK provider models in the Home switcher search box', async () => {
    renderSwitcher(
      {
        mode: 'api',
        apiProtocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4.1-mini',
      },
      [amrAgent, codexAgent],
      {
        [providerModelsCacheKey(
          'openai',
          'https://api.openai.com/v1',
          'sk-test',
        )]: [
          { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
          { id: 'gpt-4.1', label: 'gpt-4.1' },
          { id: 'gpt-5.5', label: 'gpt-5.5' },
          { id: 'o4-mini', label: 'o4-mini' },
          { id: 'o3', label: 'o3' },
          { id: 'o1', label: 'o1' },
          { id: 'gpt-4o', label: 'gpt-4o' },
          { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        ],
      },
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const modelPicker = screen.getByTestId('inline-model-switcher-api-model');
    fireEvent.click(modelPicker);

    const searchInput = screen.getByTestId(
      'inline-model-switcher-api-model-search',
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: '5.5' } });

    const modelPopover = screen.getByTestId('inline-model-switcher-api-model-popover');
    expect(optionNames(modelPopover)).toEqual(['gpt-4.1-mini', 'gpt-5.5']);
  });

  it('prefers fetched BYOK provider models over only showing the currently selected custom model', async () => {
    renderSwitcher(
      {
        mode: 'api',
        apiProtocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4.1-mini',
      },
      [amrAgent, codexAgent],
      {
        [providerModelsCacheKey(
          'openai',
          'https://api.openai.com/v1',
          'sk-test',
        )]: [
          { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
          { id: 'gpt-4.1', label: 'gpt-4.1' },
          { id: 'gpt-5.5', label: 'gpt-5.5' },
        ],
      },
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const modelPicker = screen.getByTestId('inline-model-switcher-api-model');
    fireEvent.click(modelPicker);
    const modelPopover = screen.getByTestId('inline-model-switcher-api-model-popover');
    expect(optionNames(modelPopover)).toEqual(
      expect.arrayContaining(['gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5']),
    );
    expect(within(modelPopover).getAllByRole('option').length).toBeGreaterThan(1);
  });

  it('warms the shared provider-models cache from the home picker for keyless AIHubMix', async () => {
    // Regression: the home picker only READ the cache, so on a fresh load (no
    // Settings/onboarding fetch yet) the AIHubMix BYOK list fell back to the
    // small static seed list. It must fetch the live catalogue itself. AIHubMix
    // is keyless, so the fetch fires with an empty apiKey.
    const fetchMock = vi.mocked(fetchProviderModels);
    fetchMock.mockResolvedValue({
      ok: true,
      kind: 'success',
      latencyMs: 1,
      models: [
        { id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
        { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash' },
        { id: 'minimax-m3', label: 'minimax-m3' },
      ],
    });
    const onProviderModelsCacheChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'aihubmix',
          baseUrl: 'https://aihubmix.com/v1',
          apiProviderBaseUrl: 'https://aihubmix.com/v1',
          apiKey: '',
          model: 'claude-opus-4-8',
        }}
        agents={[amrAgent, codexAgent]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        providerModelsCache={{}}
        onProviderModelsCacheChange={onProviderModelsCacheChange}
        onOpenSettings={vi.fn()}
      />,
    );

    // No fetch until the user opens the switcher panel.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith({
        protocol: 'aihubmix',
        baseUrl: 'https://aihubmix.com/v1',
        apiKey: '',
      });
      expect(onProviderModelsCacheChange).toHaveBeenCalled();
    });

    // The updater populates the slot under the Settings-shared cache key, so
    // one fetch serves both surfaces.
    const updater = onProviderModelsCacheChange.mock.calls[0]![0] as (
      current: Record<string, ProviderModelOption[]>,
    ) => Record<string, ProviderModelOption[]>;
    const key = providerModelsCacheKey('aihubmix', 'https://aihubmix.com/v1', '', '');
    const next = updater({});
    expect(next[key]?.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'gemini-3.5-flash',
      'minimax-m3',
    ]);
  });

  it('does not fetch from the home picker for a keyed protocol with no API key', async () => {
    const fetchMock = vi.mocked(fetchProviderModels);
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4.1-mini',
        }}
        agents={[amrAgent, codexAgent]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        providerModelsCache={{}}
        onProviderModelsCacheChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists AIHubMix as a BYOK provider chip and marks it active when selected', () => {
    const onApiProtocolChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'aihubmix',
          baseUrl: 'https://aihubmix.com/v1',
          apiProviderBaseUrl: 'https://aihubmix.com/v1',
          apiKey: '',
          model: 'gemini-3.5-flash',
        }}
        agents={[amrAgent, codexAgent]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={onApiProtocolChange}
        onApiModelChange={vi.fn()}
        providerModelsCache={{}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const chip = screen.getByTestId('inline-model-switcher-provider-aihubmix');
    expect(chip.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the panel open and applies the choice when picking a BYOK model from the portaled list', async () => {
    // Regression: the model list renders in a portal on `document.body`, so a
    // mousedown on an option lands OUTSIDE the switcher's `wrapRef`. The panel's
    // outside-click handler used to close the whole panel on that mousedown,
    // unmounting the picker before its click fired — the model never changed.
    const onApiModelChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4.1-mini',
        }}
        agents={[amrAgent, codexAgent]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={onApiModelChange}
        providerModelsCache={{
          [providerModelsCacheKey('openai', 'https://api.openai.com/v1', 'sk-test', '')]: [
            { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
            { id: 'gpt-4.1', label: 'gpt-4.1' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-api-model'));

    const modelPopover = screen.getByTestId('inline-model-switcher-api-model-popover');
    const option = within(modelPopover).getByRole('option', { name: 'gpt-5.5' });

    // The real browser fires mousedown before the option's click. The panel's
    // document-level mousedown listener must NOT treat this portal click as
    // "outside" and close the switcher.
    fireEvent.mouseDown(option);
    expect(screen.queryByTestId('inline-model-switcher-popover')).not.toBeNull();
    expect(
      screen.queryByTestId('inline-model-switcher-api-model-popover'),
    ).not.toBeNull();

    fireEvent.click(option);
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-5.5');
  });

  it('offers the BYOK provider catalogue, not the CLI agent catalogue, in the compact home popover', () => {
    // Bug: with BYOK active, the compact home-hero chip correctly showed the
    // BYOK model (e.g. gpt-4o), but opening the popover listed the local CLI
    // agent's models (the OpenDesign cloud catalogue) instead of the BYOK
    // provider's catalogue. The popover body must always reflect the active
    // execution mode; `compact` only affects layout density.
    const onApiModelChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o',
        }}
        agents={[amrAgent, codexAgent]}
        compact
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={onApiModelChange}
        providerModelsCache={{
          [providerModelsCacheKey('openai', 'https://api.openai.com/v1', 'sk-test', '')]: [
            { id: 'gpt-4o', label: 'gpt-4o' },
            { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const popover = screen.getByTestId('inline-model-switcher-popover');

    // The CLI agent's catalogue must not leak into a BYOK popover.
    expect(within(popover).queryByText('AMR Cloud Latest')).toBeNull();

    // The BYOK provider's catalogue is on offer and picking a model writes
    // through the BYOK sink.
    fireEvent.click(within(popover).getByTestId('inline-model-switcher-api-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-api-model-popover',
    );
    expect(optionNames(modelPopover)).toEqual(
      expect.arrayContaining(['gpt-4o', 'gpt-4o-mini', 'gpt-5.5']),
    );
    fireEvent.click(within(modelPopover).getByRole('option', { name: 'gpt-5.5' }));
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-5.5');
  });

  it('lists fetched BYOK provider models from the shared cache', () => {
    const cacheKey = providerModelsCacheKey(
      'anthropic',
      baseConfig.baseUrl,
      'sk-test',
      '',
    );
    renderSwitcher(
      {
        mode: 'api',
        apiKey: 'sk-test',
        model: 'claude-3-5-haiku-latest',
      },
      [amrAgent],
      {
        [cacheKey]: [
          { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
        ],
      },
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const select = screen.getByTestId(
      'inline-model-switcher-api-model',
    );
    fireEvent.click(select);
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-api-model-popover',
    );
    expect(
      within(modelPopover).getByRole('option', { name: 'Claude 3.5 Haiku' }),
    ).toBeTruthy();
  });
});

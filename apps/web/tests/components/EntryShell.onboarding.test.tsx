// @vitest-environment jsdom

// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell, ONBOARDING_LOCAL_AUTO_TEST_DELAY_MS } from '../../src/components/EntryShell';

import { I18nProvider } from '../../src/i18n';
import { fetchProjectFiles } from '../../src/providers/registry';
import type { AgentInfo, AppConfig } from '../../src/types';
import { isOpenDesignHostAvailable, pickHostWorkingDir } from '@open-design/host';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

vi.mock('@open-design/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-design/host')>();
  return {
    ...actual,
    isOpenDesignHostAvailable: vi.fn(() => false),
    pickHostWorkingDir: vi.fn(),
  };
});

const mockedIsHostAvailable = vi.mocked(isOpenDesignHostAvailable);
const mockedPickHostWorkingDir = vi.mocked(pickHostWorkingDir);

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: analyticsMocks.track,
    }),
    useAppVersion: () => null,
  };
});

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function amrAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'amr',
    name: 'AMR',
    bin: 'amr',
    available: true,
    models: [{ id: 'amr-model', label: 'AMR Model' }],
    ...overrides,
  };
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

// DeepSeek Harness before its companion is installed: unavailable, yet the
// picker still lists it so the user has somewhere to start setup from.
function dshSetupRequiredAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    bin: 'deepseek-harness',
    available: false,
    path: '/usr/local/bin/deepseek-harness',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    diagnostics: [
      {
        reason: 'runtime-profile-incompatible',
        severity: 'error',
        message: 'Companion setup required.',
      },
    ],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    // These cases cover the Cloud onboarding, so Cloud is turned on.
    cloudFeatures: true,
    mode: 'daemon',
    agentId: null,
    agentModels: {},
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    ...overrides,
  } as AppConfig;
}

function renderOnboarding(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/onboarding');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig(),
    agents: [amrAgent(), cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [amrAgent(), cliAgent()]),
    onCreateProject: vi.fn(),
    onBeginProjectCreation: () => ({ projectId: 'optimistic-project', rollback: () => undefined }),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  function Harness() {
    const [config, setConfig] = useState(props.config);
    return (
      <I18nProvider initial="en">
        <EntryShell
          {...props}
          config={config}
          onConfigPersist={(next) => {
            props.onConfigPersist(next);
            setConfig(next as AppConfig);
          }}
        />
      </I18nProvider>
    );
  }

  render(
    <Harness />,
  );

  return props;
}

function renderHome(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
  path = '/',
) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig({
      agentId: 'claude-code',
      agentModels: { 'claude-code': { model: 'sonnet' } },
    }),
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onCreateProject: vi.fn(),
    onBeginProjectCreation: () => ({ projectId: 'optimistic-project', rollback: () => undefined }),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

function trackedEvents(name: string) {
  return analyticsMocks.track.mock.calls.filter(([eventName]) => eventName === name);
}

function latestTrackedEvent<T extends Record<string, unknown>>(name: string): T {
  const calls = trackedEvents(name);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[1] as T;
}

function findTrackedEvent<T extends Record<string, unknown>>(
  name: string,
  predicate: (payload: T) => boolean,
): T {
  const payload = trackedEvents(name)
    .map(([, eventPayload]) => eventPayload as T)
    .find(predicate);
  expect(payload).toBeTruthy();
  return payload as T;
}

function chooseOnboardingOption(label: string, option: string | RegExp) {
  const chipField = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-chip-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (chipField) {
    const matcher = option instanceof RegExp ? option : new RegExp(option, 'i');
    const chip = Array.from(chipField.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      matcher.test(button.textContent ?? ''),
    );
    if (!(chip instanceof HTMLButtonElement)) {
      throw new Error(`profile chip not found: ${label} / ${String(option)}`);
    }
    fireEvent.click(chip);
    return;
  }

  const dropdownField = screen
    .getAllByText(label)
    .map((node) => node.closest('.onboarding-view__select-field'))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (!dropdownField) throw new Error(`profile field not found: ${label}`);
  const trigger = dropdownField.querySelector('button');
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`profile field trigger not found: ${label}`);
  }
  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole('option', {
      name: option instanceof RegExp ? option : new RegExp(option, 'i'),
    }),
  );
}

async function waitForModelSourceChooser() {
  await screen.findByRole('heading', { name: 'Choose your model source' });
}

async function openLocalRuntimeSetup() {
  await waitForModelSourceChooser();
  fireEvent.click(screen.getByRole('radio', { name: /Local Agent/i }));
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
  expect(await screen.findByText('Local CLI')).toBeTruthy();
}

async function openByokRuntimeSetup() {
  await waitForModelSourceChooser();
  fireEvent.click(screen.getByRole('radio', { name: /Bring Your Own Key/i }));
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
  expect(await screen.findByRole('heading', { name: 'Bring Your Own Key' })).toBeTruthy();
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  vi.useRealTimers();
  analyticsMocks.track.mockReset();
  window.sessionStorage.clear();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  mockedIsHostAvailable.mockReturnValue(false);
  mockedPickHostWorkingDir.mockReset();
  analyticsMocks.track.mockReset();
});

describe('EntryShell settings menu', () => {
  it('opens settings from the signed-out rail without duplicating the footer action', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/community/discord')) {
        return jsonResponse({
          inviteCode: 'mHAjSMV6gz',
          inviteUrl: 'https://discord.gg/mHAjSMV6gz',
          onlineCount: 1234,
          memberCount: 4321,
          fetchedAt: Date.now(),
          stale: false,
        });
      }
      if (url.endsWith('/api/github/open-design')) {
        return jsonResponse({
          repo: 'nexu-io/open-design',
          stargazers_count: 56100,
          fetchedAt: Date.now(),
          stale: false,
        });
      }
      return jsonResponse({});
    }) as typeof fetch;
    const props = renderHome();

    // The signed-out rail's own settings item (below 扩展) is the single
    // settings entry — the #5517 footer carries none.
    fireEvent.click(await screen.findByTestId('entry-settings-button'));

    expect(props.onOpenSettings).toHaveBeenCalledWith();
    expect(screen.getAllByTestId('entry-settings-button')).toHaveLength(1);
  });

});

describe('EntryShell navigation shortcuts', () => {
  afterEach(() => {
    window.localStorage.removeItem('od.entry.railOpen');
  });

  it('leaves the rail unchanged when the composer owns Cmd/Ctrl+B', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'false');
    renderHome();

    const entry = document.querySelector('.entry');
    expect(entry).toBeInstanceOf(HTMLElement);
    expect(entry?.classList.contains('entry--rail-open')).toBe(false);

    const editor = await screen.findByTestId('home-hero-input');
    fireEvent.keyDown(editor, {
      key: 'b',
      ...(/Mac|iPod|iPhone|iPad/.test(navigator.platform)
        ? { metaKey: true }
        : { ctrlKey: true }),
    });

    expect(entry?.classList.contains('entry--rail-open')).toBe(false);
  });
});

describe('EntryShell design systems view', () => {
  it('leaves workspace-scoped design-system activation to the mounted tab', async () => {
    const onDesignSystemsRefresh = vi.fn();
    renderHome({ onDesignSystemsRefresh }, '/design-systems');

    expect(await screen.findByTestId('entry-view-design-systems')).toHaveAttribute(
      'data-active',
      'true',
    );
    // DesignSystemsTab owns its Team SSE activation and fallback snapshot.
    // Calling the App-level catalog refresh here as well creates a duplicate,
    // differently-scoped request every time the route becomes active.
    expect(onDesignSystemsRefresh).not.toHaveBeenCalled();
  });
});

describe('EntryShell route scroll isolation', () => {
  afterEach(() => {
    window.localStorage.removeItem('od.entry.railOpen');
  });

  function entryScrollContainer(): HTMLElement {
    const scrollContainer = document.querySelector('.entry-main--scroll');
    expect(scrollContainer).toBeInstanceOf(HTMLElement);
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error('entry scroll container not found');
    }
    return scrollContainer;
  }

  // #5517 reshaped the rail: the flat `entry-nav-projects` button is gone, and
  // its Drafts / All-projects replacements only mount under a workspace
  // context this render has none of. Design systems is the nearest rail
  // destination that survives in every state, and the reset it exercises is the
  // same shared `.entry-main--scroll` element, so the spec's subject is intact.
  it('resets the shared scroll offset when navigating away from Home', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'true');
    renderHome();

    const scrollContainer = entryScrollContainer();
    scrollContainer.scrollTop = 280;
    fireEvent.click(screen.getByTestId('entry-nav-design-systems'));

    await waitFor(() => {
      expect(
        screen.getByTestId('entry-view-design-systems').getAttribute('data-active'),
      ).toBe('true');
    });
    expect(scrollContainer.scrollTop).toBe(0);
  });

  it('resets the shared scroll offset when navigating from Projects to Home', async () => {
    window.localStorage.setItem('od.entry.railOpen', 'true');
    renderHome({}, '/projects');

    const scrollContainer = entryScrollContainer();
    scrollContainer.scrollTop = 360;
    fireEvent.click(screen.getByTestId('entry-nav-home'));

    await waitFor(() => {
      expect(screen.getByTestId('entry-view-home').getAttribute('data-active')).toBe('true');
    });
    expect(scrollContainer.scrollTop).toBe(0);
  });
});

describe('EntryShell project reopen request priority', () => {
  // The catalogue grid — and its background cover scan — lives on the 项目
  // page now that Home carries no grid on either branch (OPEND-2683 /
  // OPEND-3140); the invariant is unchanged, the surface moved.
  it('aborts the 项目 page cover work, keeps hidden Projects idle, and lets the foreground files read finish', async () => {
    const files = [{
      name: 'index.html',
      path: 'index.html',
      kind: 'html' as const,
      mtime: 1,
      size: 1,
      mime: 'text/html',
    }];
    const fileRequests: Array<RequestInit | undefined> = [];
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
        if (url === '/api/projects/project-reopen/files') {
          // Single-flight (`lib/shared-cancellable-get`) gives every `/files`
          // reader — cancellable or not — one shared request carrying the
          // shared AbortSignal, so "is this the background scan?" is the
          // request ordinal, not the presence of a signal. Request #1 is
          // the 项目 page's cover scan and must hang until it is aborted; the
          // foreground read that follows it must be answered.
          const isBackgroundCoverScan = fileRequests.length === 0;
          fileRequests.push(init);
          if (isBackgroundCoverScan) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return jsonResponse({ files });
        }
        if (url.includes('/api/live-artifacts?projectId=project-reopen')) {
          return jsonResponse({ liveArtifacts: [] });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const onOpenProject = vi.fn((projectId: string) => {
      expect(projectId).toBe('project-reopen');
      // App leaves EntryShell when it opens ProjectView. Model that boundary
      // directly so the mounted strip must cancel its background probe.
      cleanup();
    });

    renderHome({
      projects: [{
        id: 'project-reopen',
        name: 'Reopen project',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 2,
        status: { value: 'not_started' },
      }],
      onOpenProject,
    }, '/drafts');

    await waitFor(() => expect(fileRequests).toHaveLength(1));
    const homeSignal = fileRequests[0]?.signal;
    expect(homeSignal).toBeDefined();
    expect(screen.getByTestId('recent-projects-strip')).toBeTruthy();
    // DesignsTab is mounted under EntryShell's hidden Projects pane, but its
    // own background files/live-artifact scans must remain dormant.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/api/live-artifacts?projectId=project-reopen'),
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Reopen project/ }));

    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(homeSignal?.aborted).toBe(true);
    await expect(fetchProjectFiles('project-reopen')).resolves.toEqual(files);
    expect(fileRequests).toHaveLength(2);
    // The foreground read must own a live request of its own: it neither joins
    // the abandoned scan's dead entry nor inherits its aborted signal.
    const foregroundSignal = fileRequests[1]?.signal;
    expect(foregroundSignal).toBeDefined();
    expect(foregroundSignal).not.toBe(homeSignal);
    expect(foregroundSignal?.aborted).toBe(false);
  });
});

describe('EntryShell new project rail', () => {
  // The rail's "+ New project" button (`entry-nav-new-project`) is gone in
  // #5517's rail: `EntryShell` still passes `onNewProject` — with its
  // `new_project_plus` ui_click — to `EntryNavRail`, but the rail never renders
  // a control that calls it, so the button and that analytics event are both
  // unreachable. The spec that drove it is therefore removed; opening the
  // new-project modal is still covered by the Projects-view CTA below, which is
  // the surviving entry point.

  it('opens the new project modal from the Projects view new-project button', async () => {
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url === '/api/projects' && init?.method === 'POST') {
          return jsonResponse({
            project: {
              id: 'blank-project-from-projects',
              name: 'Untitled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            conversationId: 'conversation-2',
          });
        }
        if (url.endsWith('/api/projects/project-existing/files')) {
          return jsonResponse({ files: [] });
        }
        if (url.endsWith('/api/live-artifacts?projectId=project-existing')) {
          return jsonResponse({ liveArtifacts: [] });
        }
        if (url.endsWith('/api/community/discord')) {
          return jsonResponse({
            inviteCode: 'mHAjSMV6gz',
            inviteUrl: 'https://discord.gg/mHAjSMV6gz',
            onlineCount: 0,
            memberCount: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        if (url.endsWith('/api/github/open-design')) {
          return jsonResponse({
            repo: 'nexu-io/open-design',
            stargazers_count: 0,
            fetchedAt: Date.now(),
            stale: false,
          });
        }
        return jsonResponse({});
      });
    globalThis.fetch = fetchMock as typeof fetch;
    // Start directly on the Projects view (/projects). The nav rail no longer
    // has a single "Projects" button — the projects list is its own route,
    // reachable via /projects or Home's "view all" — so drive the DesignsTab's
    // own new-project CTA rather than a removed rail button.
    const props = renderHome({
      projects: [
        {
          id: 'project-existing',
          name: 'Existing project',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
          status: { value: 'not_started' },
        },
      ],
    }, '/projects');

    fireEvent.click(screen.getByTestId('designs-new-project'));

    await waitFor(() => {
      expect(screen.getByTestId('new-project-modal')).toBeTruthy();
    });
    expect(screen.getByTestId('new-project-panel')).toBeTruthy();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/projects' && init?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
    expect(analyticsMocks.track).toHaveBeenCalledWith(
      'ui_click',
      expect.objectContaining({
        page_name: 'projects',
        area: 'list_controls',
        element: 'create_project',
      }),
      undefined,
    );
  });

  it('does not persist the modal hidden default Skill on an automatic OD Next route', async () => {
    const onCreateProject = vi.fn(() => true);
    renderHome({
      skills: [{
        id: 'agent-browser',
        name: 'agent-browser',
        description: 'Inspect rendered prototypes',
        mode: 'prototype',
        surface: 'web',
        previewType: 'html',
        designSystemRequired: true,
        defaultFor: ['prototype'],
        triggers: [],
        upstream: null,
        hasBody: true,
        examplePrompt: '',
        aggregatesExamples: false,
      }],
      projects: [{
        id: 'project-existing',
        name: 'Existing project',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 2,
        status: { value: 'not_started' },
      }],
      onCreateProject,
    }, '/projects');

    fireEvent.click(screen.getByTestId('designs-new-project'));
    await screen.findByTestId('new-project-panel');
    fireEvent.click(screen.getByTestId('create-project'));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      skillId: null,
      metadata: expect.objectContaining({ kind: 'prototype' }),
    }));
  });
});

describe('EntryShell Home submit handoff', () => {
  it('keeps the Home run button in sending state until project creation resolves', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      if (url.endsWith('/api/community/discord')) return jsonResponse({ stale: true });
      if (url.endsWith('/api/github/open-design')) return jsonResponse({ stale: true });
      return jsonResponse({});
    }) as typeof fetch;
    let resolveCreate: (accepted: boolean) => void = () => undefined;
    const onCreateProject = vi.fn(
      (_input: { pluginId?: string }) => new Promise<boolean>((resolve) => { resolveCreate = resolve; }),
    );
    renderHome({ onCreateProject });

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('Build a landing page');
    const submit = await screen.findByTestId('home-hero-submit') as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      pendingPrompt: 'Build a landing page',
      conversationMode: 'design',
    }));
    // HomeView's hidden default-router identity is provenance, not an
    // explicit user plugin choice on the public create contract.
    expect(onCreateProject.mock.calls[0]?.[0]?.pluginId).toBeUndefined();
    expect(submit.disabled).toBe(true);
    // The arrow stays visually stable while creation is in flight: no spinner,
    // no busy state — the disabled lock above is the whole sending treatment.
    expect(submit.getAttribute('aria-busy')).toBe('false');
    expect(submit.getAttribute('aria-label')).toBe('Run');

    resolveCreate(true);
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it('binds the picked source folder as the project working directory and preserves its host token', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      if (url.endsWith('/api/community/discord')) return jsonResponse({ stale: true });
      if (url.endsWith('/api/github/open-design')) return jsonResponse({ stale: true });
      return jsonResponse({});
    }) as typeof fetch;
    mockedIsHostAvailable.mockReturnValue(true);
    mockedPickHostWorkingDir.mockResolvedValueOnce({
      ok: true,
      baseDir: '/work/source',
      token: 'source-token',
    });
    const onCreateProject = vi.fn(() => true);
    renderHome({ onCreateProject });

    await screen.findByTestId('home-hero-input');
    fireEvent.click(screen.getByTestId('working-dir-trigger'));
    fireEvent.click(screen.getByTestId('working-dir-pick'));
    await waitFor(() => {
      expect(mockedPickHostWorkingDir).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('working-dir-trigger').getAttribute('title')).toBe('/work/source');
    });

    setHomeHeroPrompt('Fix the existing app');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      userWorkingDirToken: 'source-token',
      metadata: expect.objectContaining({
        userWorkingDir: '/work/source',
      }),
    }));
  });
});

describe('EntryShell local and BYOK onboarding', () => {

  it.each([
    ['Local CLI', baseConfig({ mode: 'daemon', agentId: 'claude-code' })],
    ['BYOK', baseConfig({
      mode: 'api',
      agentId: 'amr',
      apiKey: 'persisted-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
    })],
  ])('keeps Home available for signed-out %s execution', async (_label, config) => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;

    renderHome({ config });

    expect(await screen.findByTestId('home-hero-input')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    expect(
      screen.queryByRole('heading', { name: 'Welcome to OpenDesign' }),
    ).toBeNull();
  });

  it('supports arrow-key selection and focus within the model-source radio group', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        loggedIn: true,
        profile: 'prod',
        configPath: '/x',
        user: { id: 'u', email: 'user@example.com' },
      }),
    ) as typeof fetch;
    renderOnboarding();

    const hosted = await screen.findByRole('radio', { name: /Bring Your Own Key/i });
    const local = screen.getByRole('radio', { name: /Local Agent/i });
    hosted.focus();
    fireEvent.keyDown(hosted, { key: 'ArrowDown' });

    expect(local.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(local);
    fireEvent.keyDown(local, { key: 'ArrowUp' });
    expect(hosted.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(hosted);
  });

  it('tests Local Agent on Continue, stays on failure, and retries on the next click', async () => {
    let testCalls = 0;
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return testCalls === 1
          ? jsonResponse({
              ok: false,
              kind: 'agent_spawn_failed',
              latencyMs: 12,
              model: 'sonnet',
              agentName: 'Claude Code',
              detail: 'process exited before responding',
            })
          : jsonResponse({
              ok: true,
              kind: 'success',
              latencyMs: 12,
              model: 'sonnet',
              sample: 'pong',
              agentName: 'Claude Code',
            });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    const continueButton = screen.getByRole('button', { name: /^Continue$/i });
    expect(continueButton.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(continueButton);
    expect(await screen.findByText(/Could not start Claude Code/i)).toBeTruthy();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();

    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(testCalls).toBe(2);
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
    expect(props.onConfigPersist).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'daemon', agentId: 'claude-code' }),
    );
    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      result: 'completed',
      exit_step_name: 'runtime_setup',
      runtime_type: 'local_cli',
    });
  });

  it('drops a Local Agent validation that lands after the user goes Back', async () => {
    // Continue awaits a network round trip before it persists. Back stays
    // enabled through that wait, so a late success must not resurrect the
    // configuration the user just walked away from. Leaving the step also
    // aborts the request; a mock that ignores its signal keeps this spec on
    // the second line of defence, the one that judges a result that still
    // arrives.
    let releaseTest: ((value: Response) => void) | undefined;
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return new Promise<Response>((resolve) => {
          releaseTest = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(await screen.findByRole('radio', { name: /Local Agent/i })).toBeTruthy();

    await act(async () => {
      releaseTest?.(
        jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'sonnet',
          sample: 'pong',
          agentName: 'Claude Code',
        }),
      );
      await Promise.resolve();
    });

    expect(props.onConfigPersist).not.toHaveBeenCalled();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Local Agent/i })).toBeTruthy();
  });

  it('validates the selected Local Agent in the background so Continue does not wait on a spawn', async () => {
    // The runtime smoke test spawns the agent CLI and waits for a real model
    // reply: 7s for Claude Code and 12s for Codex CLI measured against a local
    // daemon, against a 45s budget. Starting it only when Continue is pressed
    // puts that whole cost between the click and the next screen, so it has to
    // already be under way by the time the user clicks.
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'sonnet',
          sample: 'pong',
          agentName: 'Claude Code',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    // Nobody has pressed Continue: the selection validates on its own.
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
    expect(props.onConfigPersist).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'daemon', agentId: 'claude-code' }),
    );
    // The click settled on the finished validation instead of spawning again.
    expect(testCalls).toBe(1);
  });

  it('lets Continue join the in-flight Local Agent validation instead of dropping the click', async () => {
    // Background validation must not turn Continue into a dead button: a click
    // landing mid-flight joins the attempt already validating those inputs and
    // finishes with it, rather than being swallowed or spawning a second agent.
    let releaseTest: ((value: Response) => void) | undefined;
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return new Promise<Response>((resolve) => {
          releaseTest = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });

    const continueButton = screen.getByRole('button', { name: /^Continue$/i });
    expect(continueButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(continueButton);

    await act(async () => {
      releaseTest?.(
        jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'sonnet',
          sample: 'pong',
          agentName: 'Claude Code',
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
    expect(testCalls).toBe(1);
  });

  it('releases the agent child when the user leaves the setup step mid-validation', async () => {
    // The background pass spawns a real agent CLI, so a validation the user
    // walks away from is not free — left alone the daemon holds that child
    // until its own timeout, and a few abandoned visits cost several spawns
    // and model calls for nothing.
    let testSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testSignal = init.signal ?? undefined;
        // Never settles: the abort is the only thing that can end this run.
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    await waitFor(() => {
      expect(testSignal).toBeDefined();
    });
    expect(testSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    await waitFor(() => {
      expect(testSignal?.aborted).toBe(true);
    });
  });

  it('restarts BYOK auto-validation against edited inputs instead of waiting the old one out', async () => {
    // A held request must not decide when the replacement gets to start: the
    // key the user is now looking at has to begin validating immediately, or
    // it stays unproven until the abandoned run times out.
    const signals: AbortSignal[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [{ id: 'gpt-test', label: 'GPT Test' }],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        if (init.signal) signals.push(init.signal);
        // Never settles, so only the abort can free the slot.
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        mode: 'api',
        apiProtocol: 'openai',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
      }),
    });

    await openByokRuntimeSetup();
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'rotated-api-key' },
    });

    await waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('validates again when the user returns to a selection whose check was cut short', async () => {
    // Aborting writes no result by design, so the attempt's bookkeeping has to
    // come back with it. Left behind, it claims these inputs were already
    // validated and the panel stays on a "testing" line no run will ever
    // finish — the automatic path is then dead until Continue is pressed.
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        // Never settles, so leaving is the only thing that ends the first run.
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(await screen.findByRole('radio', { name: /Local Agent/i })).toBeTruthy();

    // Same agent, same model: the cut-short attempt must not count as proof.
    fireEvent.click(screen.getByRole('radio', { name: /Local Agent/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    expect(await screen.findByText('Local CLI')).toBeTruthy();
    await waitFor(() => {
      expect(testCalls).toBe(2);
    });
  });

  it('releases a BYOK request once its key is cleared and nothing can consume it', async () => {
    // Staying on the step does not keep a request useful: an emptied key can
    // no longer be validated, so the run holding the daemon has to go the same
    // way it would if the user had walked out.
    const signals: AbortSignal[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [{ id: 'gpt-test', label: 'GPT Test' }],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        if (init.signal) signals.push(init.signal);
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        mode: 'api',
        apiProtocol: 'openai',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
      }),
    });

    await openByokRuntimeSetup();
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: '' } });

    await waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
    expect(signals).toHaveLength(1);
  });

  it('does not spend a second spawn when the debounce outlives a manual Test', async () => {
    // Pressing Test disturbs none of the auto-validation effect's inputs, so
    // its debounce stays armed. A manual check that answers inside that window
    // must still leave exactly one spawn behind.
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 1,
          model: 'sonnet',
          sample: 'pong',
          agentName: 'Claude Code',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await openLocalRuntimeSetup();
    // Beat the debounce with a manual press that resolves immediately.
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });
    expect(await screen.findByText(/replied in/i)).toBeTruthy();

    // Let the armed debounce fire; it must find the inputs already proven.
    await new Promise((resolve) => setTimeout(resolve, ONBOARDING_LOCAL_AUTO_TEST_DELAY_MS + 250));
    expect(testCalls).toBe(1);
  });

  it('does not validate a saved selection the step is still asking the user to set up', async () => {
    // A setup-required entry is selectable and can be the saved selection, but
    // the daemon resolves its binary and really tries to start the runtime, so
    // validating it unprompted answers with a failure on the same screen that
    // is telling the user to finish installing it. Nothing may be spent until
    // the companion setup actually succeeds.
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return jsonResponse({
          ok: false,
          kind: 'agent_spawn_failed',
          latencyMs: 5,
          model: 'deepseek-chat',
          agentName: 'DeepSeek Harness',
          detail: 'companion missing',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    // Only the setup-required entry is installed, so the scan has no available
    // agent to fall back to and the saved selection stays on it.
    renderOnboarding({
      agents: [amrAgent(), dshSetupRequiredAgent()],
      onRefreshAgents: vi.fn(() => [amrAgent(), dshSetupRequiredAgent()]),
      config: baseConfig({ agentId: 'deepseek-harness' }),
    });

    await openLocalRuntimeSetup();
    expect(await screen.findByText('DeepSeek Harness')).toBeTruthy();

    // Let the whole debounce window pass: nothing may be spawned across it.
    await new Promise((resolve) => setTimeout(resolve, ONBOARDING_LOCAL_AUTO_TEST_DELAY_MS + 250));
    expect(testCalls).toBe(0);

    // And the step is indeed still asking for setup rather than offering to
    // continue — the two states must not contradict each other.
    expect(
      screen.getByRole('button', { name: /^Continue$/i }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('offers only local or BYOK setup and performs no Cloud login requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({}));
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderOnboarding({ agents: [cliAgent(), amrAgent()], onRefreshAgents: vi.fn(() => [cliAgent()]) });
    expect(await screen.findByRole('heading', { name: 'Choose your model source' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull();
    fireEvent.focus(window);
    expect(fetchMock.mock.calls.some(([url]) => /\/api\/(integrations\/vela|amr)/.test(String(url)))).toBe(false);
    expect(props.onAgentChange).not.toHaveBeenCalledWith('amr');
  });

  it.each([false, true])('offers only local sources with legacy cloudFeatures=%s', async (cloudFeatures) => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ loggedIn: false, profile: 'prod', user: null, configPath: '/x' }),
    ) as typeof fetch;
    renderOnboarding({ config: baseConfig({ cloudFeatures }) });

    expect(
      await screen.findByRole('heading', { name: 'Choose your model source' }),
    ).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /OpenDesign Hosted/i })).toBeNull();
    expect(screen.queryByText(/hosted service/i)).toBeNull();
    const local = screen.getByRole('radio', { name: /Local Agent/i });
    expect(local.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Bring Your Own Key/i })).toBeTruthy();
    // Arrow keys cycle between the two local sources only.
    fireEvent.keyDown(local, { key: 'ArrowDown' });
    expect(
      screen.getByRole('radio', { name: /Bring Your Own Key/i }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.keyDown(screen.getByRole('radio', { name: /Bring Your Own Key/i }), { key: 'ArrowDown' });
    expect(local.getAttribute('aria-checked')).toBe('true');
  });

  it('excludes AMR from the Local CLI agent list', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        loggedIn: true,
        profile: 'prod',
        user: { id: 'u', email: 'user@example.com' },
        configPath: '/x',
      }),
    ) as typeof fetch;
    renderOnboarding();

    await openLocalRuntimeSetup();

    const localPanel = screen.getByText('Local CLI').closest('.onboarding-view__setup-panel');
    expect(localPanel?.textContent).toContain('Claude Code');
    expect(localPanel?.textContent).not.toContain('AMR');
  });

  it('tests the selected Local CLI agent from onboarding', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'sonnet',
          sample: 'pong',
          agentName: 'Claude Code',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    renderOnboarding({
      config: baseConfig({
        agentId: 'claude-code',
        agentCliEnv: { 'claude-code': { OPEN_DESIGN_TEST: '1' } },
        agentModels: { 'claude-code': { model: 'sonnet', reasoning: 'high' } },
      }),
      agents: [amrAgent(), cliAgent()],
      onRefreshAgents: vi.fn(() => [amrAgent(), cliAgent()]),
    });

    await openLocalRuntimeSetup();
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Claude Code replied in 12 ms/i)).toBeTruthy();
    });
    const connectionTestCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/test/connection'),
    );
    expect(connectionTestCalls).toHaveLength(1);
    expect(JSON.parse(String(connectionTestCalls[0]?.[1]?.body))).toMatchObject({
      mode: 'agent',
      agentId: 'claude-code',
      model: 'sonnet',
      reasoning: 'high',
      agentCliEnv: { 'claude-code': { OPEN_DESIGN_TEST: '1' } },
    });
  });

  it('renders Local CLI test failures as alerts in onboarding', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          user: { id: 'u', email: 'user@example.com' },
          configPath: '/x',
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        return jsonResponse({
          ok: false,
          kind: 'agent_not_installed',
          latencyMs: 0,
          agentName: 'Claude Code',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    renderOnboarding({
      config: baseConfig({ agentId: 'claude-code' }),
      agents: [amrAgent(), cliAgent()],
      onRefreshAgents: vi.fn(() => [amrAgent(), cliAgent()]),
    });

    await openLocalRuntimeSetup();
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Claude Code is not installed or not in PATH.');
  });

  it('uses provider preferences instead of the first upstream model during BYOK onboarding', async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          user: { id: 'u', email: 'user@example.com' },
          configPath: '/x',
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [
            { id: 'upstream-first', label: 'Upstream First' },
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        apiProtocol: 'anthropic',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.anthropic.com',
        model: '',
        apiProviderBaseUrl: 'https://api.anthropic.com',
      }),
    });

    await openByokRuntimeSetup();
    fireEvent.click(screen.getByRole('button', { name: /Fetch models/i }));

    await waitFor(() => {
      expect(props.onApiModelChange).toHaveBeenCalledWith('claude-sonnet-4-5');
    });
    expect(props.onApiModelChange).not.toHaveBeenCalledWith('upstream-first');
  });

  it('tests BYOK on Continue, stays on rate limit, and retries on the next click', async () => {
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [{ id: 'gpt-test', label: 'GPT Test' }],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return testCalls === 1
          ? jsonResponse({
              ok: false,
              kind: 'rate_limited',
              latencyMs: 12,
              model: 'gpt-test',
              status: 429,
            })
          : jsonResponse({
              ok: true,
              kind: 'success',
              latencyMs: 12,
              model: 'gpt-test',
              sample: 'Connected',
            });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        mode: 'api',
        apiProtocol: 'openai',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
      }),
    });

    await openByokRuntimeSetup();
    const continueButton = screen.getByRole('button', { name: /^Continue$/i });
    expect(continueButton.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(continueButton);
    expect(await screen.findByText(/rate-limited the test/i)).toBeTruthy();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();

    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(testCalls).toBe(2);
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  it('drops a BYOK validation that lands after its inputs changed', async () => {
    // The inputs stay editable while the test is in flight. A success for the
    // key the user has already replaced must not complete onboarding.
    let releaseTest: ((value: Response) => void) | undefined;
    let testCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [{ id: 'gpt-test', label: 'GPT Test' }],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        testCalls += 1;
        return new Promise<Response>((resolve) => {
          releaseTest = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        mode: 'api',
        apiProtocol: 'openai',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
      }),
    });

    await openByokRuntimeSetup();
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() => {
      expect(testCalls).toBe(1);
    });

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'rotated-api-key' },
    });

    await act(async () => {
      releaseTest?.(
        jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'gpt-test',
          sample: 'Connected',
        }),
      );
      await Promise.resolve();
    });

    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Bring Your Own Key' })).toBeTruthy();
  });

  it('persists the BYOK config before finishing onboarding', async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          configPath: '/x',
          user: { id: 'u', email: 'user@example.com' },
        });
      }
      if (url.endsWith('/api/provider/models') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 10,
          models: [
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
            { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
          ],
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          model: 'claude-opus-4-8',
          sample: 'Connected',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding();

    fireEvent.click(await screen.findByRole('radio', { name: /Bring Your Own Key/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    expect(await screen.findByRole('heading', { name: 'Bring Your Own Key' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-api-key' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.anthropic.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Fetch models/i }));
    await waitFor(() => {
      expect(screen.getByText('Fetched 2 models.')).toBeTruthy();
    });
    chooseOnboardingOption('Model', /claude-opus-4-8/i);
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Connected\. Replied in 12 ms/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));

    expect(props.onModeChange).not.toHaveBeenCalled();
    expect(props.onApiModelChange).toHaveBeenCalledWith('claude-opus-4-8');
    expect(props.onConfigPersist).toHaveBeenCalled();
    await waitFor(() => {
      expect(props.onCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
    expect((props.onConfigPersist as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'api',
      apiProtocol: 'anthropic',
      apiKey: 'test-api-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-4-8',
      apiProviderBaseUrl: null,
    });
    expect(latestTrackedEvent('onboarding_complete_result')).toMatchObject({
      result: 'completed',
      exit_step_name: 'runtime_setup',
      runtime_type: 'byok',
    });
  });

  it('lets Azure BYOK onboarding enter a custom deployment directly', async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          loggedIn: true,
          profile: 'prod',
          user: { id: 'u', email: 'user@example.com' },
          configPath: '/x',
        });
      }
      if (url.endsWith('/api/test/connection') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        expect(body).toMatchObject({
          protocol: 'azure',
          apiKey: 'azure-key',
          baseUrl: 'https://example.openai.azure.com',
          model: 'deployment-one',
        });
        return jsonResponse({
          ok: true,
          kind: 'success',
          latencyMs: 11,
          model: 'deployment-one',
          sample: 'Connected',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const props = renderOnboarding({
      config: baseConfig({
        mode: 'api',
        apiProtocol: 'azure',
        apiProviderBaseUrl: '',
      }),
    });

    await openByokRuntimeSetup();

    expect(screen.getByRole('tab', { name: 'Azure OpenAI' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect((screen.getByRole('button', { name: /Fetch models/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getAllByRole('button', { name: 'Azure OpenAI' }).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'azure-key' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://example.openai.azure.com' },
    });
    fireEvent.change(screen.getByLabelText('Deployment name'), {
      target: { value: 'deployment-one' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Connected\. Replied in 11 ms/i)).toBeTruthy();
    });
    expect(props.onApiModelChange).toHaveBeenCalledWith('deployment-one');
    expect((props.onConfigPersist as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'api',
      apiProtocol: 'azure',
      apiKey: 'azure-key',
      apiProviderBaseUrl: '',
      baseUrl: 'https://example.openai.azure.com',
      model: 'deployment-one',
    });
  });

  it('shows no Skip affordance on the Connect step', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ loggedIn: false, profile: 'prod', user: null, configPath: '/x' }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const props = renderOnboarding();
    await act(async () => {});

    // "Skip for now" was removed — Connect is a required step. The Connect
    // step exposes no secondary Skip/Back button, onboarding is not completed
    // from here, and no skip telemetry fires.
    expect(screen.queryByRole('button', { name: /Skip/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Back$/i })).toBeNull();
    expect(props.onCompleteOnboarding).not.toHaveBeenCalled();
    const skipClicks = trackedEvents('ui_click')
      .map(([, payload]) => payload as Record<string, unknown>)
      .filter((payload) => payload.element === 'skip');
    expect(skipClicks).toHaveLength(0);
    expect(trackedEvents('onboarding_complete_result')).toHaveLength(0);
  });
});

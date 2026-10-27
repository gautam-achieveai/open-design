// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

import { HomeView } from '../../src/components/HomeView';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { pickHomeTemplate } from '../helpers/home-template-picker';

const ACTIVE_UI_PLUGIN = {
  id: 'od-active-ui-development',
  title: 'Active UI development',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/od-active-ui-development',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/od-active-ui-development',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'od-active-ui-development',
    title: 'Active UI development',
    version: '0.1.0',
    description: 'Improve an existing app in its original source.',
    od: {
      kind: 'scenario',
      taskKind: 'tune-collab',
      useCase: { query: 'Improve the existing app.' },
      inputs: [],
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('HomeView Active UI development creation', () => {
  it('starts in Build mode and keeps the scenario product-owned', async () => {
    stubFetch();
    const onSubmit = vi.fn();
    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
      />,
    );

    await pickHomeTemplate('active-ui-development');
    setHomeHeroPrompt('Improve the existing settings interaction');
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      conversationMode: 'build',
      pluginSelectionProvenance: 'automatic-default',
      projectMetadata: { kind: 'other', intent: 'active-ui-development' },
    });
  });
});

function stubFetch() {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const href = typeof url === 'string' ? url : String(url);
    if (href === '/api/plugins') return json({ plugins: [ACTIVE_UI_PLUGIN] });
    if (href === '/api/mcp/servers') return json({ servers: [], templates: [] });
    if (href === '/api/workspace/directory') return json({ items: [], activeWorkspaceId: null });
    if (href === '/api/plugins/od-active-ui-development/apply') {
      return json({
        query: 'Improve the existing app.',
        contextItems: [],
        inputs: [],
        assets: [],
        mcpServers: [],
        trust: 'trusted',
        capabilitiesGranted: ['prompt:inject'],
        capabilitiesRequired: ['prompt:inject'],
        projectMetadata: {},
        appliedPlugin: {
          snapshotId: 'snap-active-ui-development',
          pluginId: ACTIVE_UI_PLUGIN.id,
          pluginVersion: ACTIVE_UI_PLUGIN.version,
          manifestSourceDigest: 'a'.repeat(64),
          inputs: {},
          resolvedContext: { items: [] },
          capabilitiesGranted: ['prompt:inject'],
          capabilitiesRequired: ['prompt:inject'],
          assetsStaged: [],
          taskKind: 'tune-collab',
          appliedAt: 0,
          connectorsRequired: [],
          connectorsResolved: [],
          mcpServers: [],
          status: 'fresh',
        },
      });
    }
    return json({});
  }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

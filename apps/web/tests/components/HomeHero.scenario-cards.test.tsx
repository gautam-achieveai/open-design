// @vitest-environment jsdom
import { homeTemplateTrigger } from '../helpers/home-template-picker';
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The rail leads with Website clone, then the slide deck ("Slides"), per the
//     curated create order.
//   - The finer-grained scenarios (wireframe / mobile / document) exist and
//     route to a working scenario plugin.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const placeholderCarouselMock = vi.hoisted(() => ({
  reportScenario: false,
  reportedScenarioId: null as string | null,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: ({
    scenarios,
    active,
    onScenarioChange,
  }: {
    scenarios: Array<{ id: string; chipId?: string | null; text: string }>;
    active: boolean;
    onScenarioChange: (scenario: { id: string; chipId?: string | null; text: string }) => void;
  }) => {
    const scenario = scenarios[0];
    if (
      placeholderCarouselMock.reportScenario &&
      active &&
      scenario &&
      placeholderCarouselMock.reportedScenarioId !== scenario.id
    ) {
      placeholderCarouselMock.reportedScenarioId = scenario.id;
      queueMicrotask(() => onScenarioChange(scenario));
    }
    return null;
  },
}));

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';
import {
  prototypeSceneProjectMetadata,
  prototypeSubChipForSlug,
} from '../../src/components/home-hero/sub-chips';

afterEach(() => {
  placeholderCarouselMock.reportScenario = false;
  placeholderCarouselMock.reportedScenarioId = null;
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activePluginTitle: null,
    activeChipId: null,
    onClearActivePlugin: () => undefined,
    pluginOptions: [],
    pluginsLoading: false,
    pendingPluginId: null,
    pendingChipId: null,
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

// #5517 removed the illustrated scenario-card rail from Home; scenarios are
// picked from the composer footer's radial template picker instead.
// Types are a horizontal pill row under the working-directory row (product,
// 2026-08-21); anything that does not fit folds into its 全部 popover.
function typePill(chipId: string): HTMLElement | null {
  if (!screen.queryByTestId('home-hero-template-menu')) fireEvent.click(homeTemplateTrigger());
  return screen.getByTestId('home-hero-template-menu').querySelector(`[data-chip="${chipId}"]`);
}

describe('HomeHero scenario cards', () => {
  it('labels each create scenario in the composer template picker', () => {
    renderHero();
    expect(typePill('prototype')?.textContent).toContain('Prototype');
    expect(typePill('deck')?.textContent).toContain('Slide deck');
  });

  it('offers active UI development alongside creation types in product order', () => {
    const ordered = orderedCreateChips();
    const ids = ordered.map((chip) => chip.id);
    expect(ids).toEqual([
      'prototype',
      'active-ui-development',
      'deck',
      'document',
      'image',
      'web-clone',
      'hyperframes',
      'webgl',
      'live-artifact',
      'video',
      'audio',
    ]);
    expect(ids).not.toContain('wireframe');
    expect(ids).not.toContain('mobile');
  });

  it('offers existing-site prompts and an improvement headline for active UI development', () => {
    renderHero({ activeChipId: 'active-ui-development' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Let’s improve your UI');
    expect(screen.getByText('Open or import the existing source project, then share a preview URL or annotations.')).toBeTruthy();
    const examples = screen.getAllByTestId('home-hero-prompt-example');
    expect(examples).toHaveLength(4);
    expect(examples.map((example) => example.textContent)).toEqual([
      expect.stringContaining('annotations'),
      expect.stringContaining('feedback'),
      expect.stringContaining('responsive'),
      expect.stringContaining('Research'),
    ]);
    expect(findChip('active-ui-development')?.action).toMatchObject({
      pluginId: 'od-active-ui-development',
      projectKind: 'other',
      projectMetadata: { kind: 'other', intent: 'active-ui-development' },
      automaticDefault: true,
    });
  });

  it('keeps nested prototype scenarios executable without giving them a chip of their own', () => {
    renderHero();
    expect(typePill('wireframe')).toBeNull();
    expect(typePill('mobile')).toBeNull();
    expect(typePill('document')).toBeTruthy();
    // They are scenes, so they have no catalog entry at all — what makes them
    // executable is the Prototype chip's action plus their own refinement.
    expect(findChip('wireframe')).toBeUndefined();
    expect(findChip('mobile')).toBeUndefined();
    const prototypeChip = findChip('prototype')!;
    expect(prototypeChip.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
    });
    // Wireframe reuses the web-prototype seed at lo-fi fidelity.
    expect(
      prototypeSceneProjectMetadata(prototypeChip, prototypeSubChipForSlug('wireframe')),
    ).toEqual({ kind: 'prototype', fidelity: 'wireframe' });
    expect(findChip('document')?.action).toMatchObject({
      pluginId: 'od-new-generation',
      projectKind: 'other',
    });
  });

  it('keeps empty carousel scenario submit disabled while plugins are loading', async () => {
    placeholderCarouselMock.reportScenario = true;
    const onSubmit = vi.fn();
    const onSubmitScenario = vi.fn();
    renderHero({
      pluginsLoading: true,
      onSubmit,
      onSubmitScenario,
    });

    await waitFor(() => expect(placeholderCarouselMock.reportedScenarioId).not.toBeNull());
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitScenario).not.toHaveBeenCalled();
  });

  it('uses the nested Prototype scene to scope empty-composer carousel suggestions', async () => {
    placeholderCarouselMock.reportScenario = true;
    renderHero({
      activeChipId: 'prototype',
      activePrototypeSubtypeId: 'mobile',
    });

    await waitFor(() => {
      expect(placeholderCarouselMock.reportedScenarioId).toBe('app-idea');
    });
  });
});

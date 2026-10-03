// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceholderCarousel } from '../../src/components/home-hero/PlaceholderCarousel';
import { DEFAULT_TYPEWRITER_TIMING } from '../../src/components/home-hero/placeholderScenarios';
import { VISUAL_STABILITY_STORAGE_KEY } from '../../src/utils/visualStability';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('PlaceholderCarousel', () => {
  it('places the decorative caret before the example prompt', () => {
    window.localStorage.setItem(VISUAL_STABILITY_STORAGE_KEY, '1');
    render(
      <PlaceholderCarousel
        active
        scenarios={[{ id: 'first', text: 'Example prompt', chipId: 'prototype' }]}
        onScenarioChange={vi.fn()}
      />,
    );

    const carousel = screen.getByTestId('home-hero-carousel');
    expect(Array.from(carousel.children, (child) => child.textContent))
      .toEqual(['', 'Example prompt']);
  });

  it('pins the first full scenario without scheduling carousel advances in visual stability mode', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    window.localStorage.setItem(VISUAL_STABILITY_STORAGE_KEY, '1');
    const onScenarioChange = vi.fn();

    render(
      <PlaceholderCarousel
        active
        scenarios={[
          { id: 'first', text: 'Pinned first scenario', chipId: 'document' },
          { id: 'second', text: 'Second scenario', chipId: 'deck' },
        ]}
        onScenarioChange={onScenarioChange}
      />,
    );

    expect(screen.getByTestId('home-hero-carousel').textContent).toContain('Pinned first scenario');
    expect(onScenarioChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_TYPEWRITER_TIMING.holdMs * 2);
    });

    expect(screen.getByTestId('home-hero-carousel').textContent).toContain('Pinned first scenario');
    expect(onScenarioChange).toHaveBeenCalledTimes(1);
  });
});

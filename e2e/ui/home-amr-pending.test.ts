import { expect, test } from '@/playwright/suite';
import type { Page } from '@playwright/test';

import { gotoEntryHome } from '@/playwright/amr';
import {
  applyStandardMocks,
  routeSuccessfulRuns,
  suppressWhatsNew,
} from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// Pin the Home-to-project handoff order while real project creation is held.
// The pending frame must paint within one animation frame of the click.

declare global {
  interface Window {
    __odHandoffProbe?: {
      frame: number;
      clickFrame: number | null;
      pendingFrame: number | null;
    };
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Frame-accurate probe installed before the app boots: a rAF counter, the
 * frame the send button was clicked on, and the frame the pending frame's
 * root landed in the DOM. "≤ 1 frame" is then a plain subtraction.
 */
async function installHandoffProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { frame: 0, clickFrame: null as number | null, pendingFrame: null as number | null };
    window.__odHandoffProbe = probe;
    const tick = () => {
      probe.frame += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target as Element | null;
        if (probe.clickFrame == null && target?.closest?.('[data-testid="home-hero-submit"]')) {
          probe.clickFrame = probe.frame;
        }
      },
      true,
    );
    new MutationObserver(() => {
      if (
        probe.pendingFrame == null
        && document.querySelector('[data-testid="project-creation-pending-view"]')
      ) {
        probe.pendingFrame = probe.frame;
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function readHandoffFrames(page: Page): Promise<number> {
  const probe = await page.evaluate(() => window.__odHandoffProbe ?? null);
  expect(probe?.clickFrame, 'send click was observed').not.toBeNull();
  expect(probe?.pendingFrame, 'pending frame was observed').not.toBeNull();
  return (probe!.pendingFrame as number) - (probe!.clickFrame as number);
}

/** Hold POST /api/projects until released; the create must not gate the frame. */
async function holdProjectCreate(page: Page) {
  const release = deferred();
  let requested = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    requested = true;
    await release.promise;
    await route.continue();
  });
  return { release: release.resolve, requested: () => requested };
}

async function sendFromHome(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('home-hero-input');
  await expect(input).toBeVisible({ timeout: T.medium });
  await input.fill(prompt);
  const submit = page.getByTestId('home-hero-submit');
  await expect(submit).toBeEnabled();
  await submit.click();
}

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await suppressWhatsNew(page);
  await installHandoffProbe(page);
});

test('[P0] @critical local send paints the pending frame before project creation finishes', async ({ page }) => {
  await applyStandardMocks(page);
  const create = await holdProjectCreate(page);
  const runRequests = await routeSuccessfulRuns(page, { runId: 'home-local-pending-run' });

  await gotoEntryHome(page);
  await sendFromHome(page, 'Draft a landing page with the local agent.');

  const pending = page.getByTestId('project-creation-pending-view');
  await expect(pending).toBeVisible({ timeout: T.short });
  expect(await readHandoffFrames(page)).toBeLessThanOrEqual(1);
  await expect.poll(() => create.requested(), { timeout: T.medium }).toBe(true);
  await expect(page.getByTestId('project-creation-pending-chat')).toBeVisible();
  create.release();
  await runRequests.expectCount(1);
  await expect(pending).toBeHidden({ timeout: T.medium });
});

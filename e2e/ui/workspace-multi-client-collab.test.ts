import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { createLocalProject, readProjectSnapshot, seedLegacyTeamProject } from '@/vitest/local-workspace';
import { T } from '@/timeouts';

test('[P0] local navigation never starts retired workspace authority streams', async ({ page }) => {
  await applyStandardMocks(page);
  const cloudRequests: string[] = [];
  page.on('request', request => {
    if (/^\/api\/(?:integrations\/vela|amr|workspaces|workspace\/(?:invite|billing|resources|projects|members|events|active)|touchpoints\/(?:test|production)-runtime)(?:\/|$)/.test(new URL(request.url()).pathname)) {
      cloudRequests.push(request.url());
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
  await ensureRailOpen(page);
  await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.reload();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  expect(cloudRequests).toEqual([]);
});

test('[P0] isolated browser contexts see local projects but cannot expose preserved Team projects', async ({ page, browser, toolsDev }) => {
  const local = await createLocalProject(toolsDev.url.web(), 'Local browser project');
  const legacy = await createLocalProject(toolsDev.url.web(), 'Hidden legacy Team project');
  const before = seedLegacyTeamProject(toolsDev.dataDir, legacy.project.id);
  const otherContext = await browser.newContext({ baseURL: toolsDev.url.web() });
  try {
    const other = await otherContext.newPage();
    for (const client of [page, other]) {
      await applyStandardMocks(client);
      await client.goto('/projects');
      const localCard = client.locator('.design-grid .design-card', {
        has: client.getByText(local.project.name, { exact: true }),
      });
      await expect(localCard).toBeVisible({ timeout: T.long });
      await expect(client.getByText(legacy.project.name, { exact: true })).toHaveCount(0);
      const denied = await client.request.get(`/api/projects/${legacy.project.id}`);
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    }
    expect(readProjectSnapshot(toolsDev.dataDir, legacy.project.id)).toEqual(before);
  } finally {
    await otherContext.close();
  }
});

test('[P0] local plugin discovery has no Team sharing entry', async ({ page }) => {
  await applyStandardMocks(page);
  await page.goto('/plugins');
  const plugins = page.getByTestId('entry-view-plugins');
  await expect(plugins.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible({ timeout: T.long });
  await plugins.getByTestId('plugins-tab-installed').click();
  await expect(plugins.getByTestId('plugins-tab-installed')).toBeVisible();
  await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
  await expect(plugins.getByRole('tab', { name: /^Team$/i })).toHaveCount(0);
  await expect(plugins.getByRole('button', { name: /Invite|Share to Team/i })).toHaveCount(0);
});

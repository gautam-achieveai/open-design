import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { createLocalProject, readProjectSnapshot, seedLegacyTeamProject } from '@/vitest/local-workspace';
import { T } from '@/timeouts';

test('[P0] local project menus remain usable without Team invitation or movement controls', async ({ page, toolsDev }) => {
  await applyStandardMocks(page);
  const created = await createLocalProject(toolsDev.url.web(), 'Local menu project');
  await page.goto('/projects');
  await ensureRailOpen(page);
  const card = page.locator('.design-grid .design-card', {
    has: page.getByText(created.project.name, { exact: true }),
  });
  await expect(card).toBeVisible({ timeout: T.long });
  await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Invite members|New team/i })).toHaveCount(0);
  await card.hover();
  await card.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Move .*team|Share to team/i })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const renameModal = page.locator('.modal-rename');
  await expect(renameModal).toBeVisible();
  const name = renameModal.getByRole('textbox');
  await expect(name).toHaveValue(created.project.name);
  await name.fill('Renamed local project');
  await renameModal.locator('button.primary').click();
  await expect(page.locator('.design-grid .design-card', {
    has: page.getByText('Renamed local project', { exact: true }),
  })).toBeVisible();
  const stored = await page.request.get('/api/projects/' + created.project.id);
  expect(stored.ok()).toBe(true);
  expect(await stored.json()).toMatchObject({ project: { name: 'Renamed local project' } });
});

test('[P0] legacy Team project deep links are denied without changing stored project data', async ({ page, toolsDev }) => {
  await applyStandardMocks(page);
  const created = await createLocalProject(toolsDev.url.web(), 'Preserved Team deep link');
  const before = seedLegacyTeamProject(toolsDev.dataDir, created.project.id);
  const denied = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/projects/' + created.project.id + '/workspace-scope' && response.request().method() === 'GET');
  await page.goto('/projects/' + created.project.id);
  const response = await denied;
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
  await expect(page.getByRole('alert').filter({ hasText: 'This project has been deleted or no longer exists.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to projects', exact: true })).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toHaveCount(0);
  expect(readProjectSnapshot(toolsDev.dataDir, created.project.id)).toEqual(before);
});

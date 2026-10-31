import { expect, test } from '@/playwright/suite';
import { routeAgents, suppressWhatsNew } from '@/playwright/mock-factory';
import { T } from '@/timeouts';
import { openSettingsDialog, putAppConfig, seedBrowserConfig } from '@/playwright/amr';

test('[P0] a retired logout request cannot redirect local users to Cloud sign-in or erase their setup', async ({ page }) => {
  await suppressWhatsNew(page);
  await routeAgents(page, [{
    id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: 'test',
    models: [{ id: 'default', label: 'Default' }],
  }]);
  const config = { mode: 'daemon', agentId: 'codex', onboardingCompleted: true, privacyDecisionAt: 1,
    agentModels: { codex: { model: 'default', reasoning: 'default' } } };
  await putAppConfig(page, config);
  await seedBrowserConfig(page, config);
  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
  const settings = await openSettingsDialog(page);
  await settings.getByTestId('settings-nav-execution').click();
  await expect(settings.getByTestId('settings-agent-card-codex')).toBeVisible();
  await expect(settings.getByTestId('settings-agent-card-amr')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /^Sign out$/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const logout = await page.request.post('/api/integrations/vela/logout');
  expect(logout.status()).toBe(410);
  expect(await logout.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
  await page.reload();
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
  await expect(page.getByRole('button', { name: /Sign in \/ Sign up/i })).toHaveCount(0);
  const response = await page.request.get('/api/app-config');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ config: { agentId: 'codex', onboardingCompleted: true } });
});

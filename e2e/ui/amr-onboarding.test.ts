import { expect, test } from '@/playwright/suite';
import type { Locator, Page } from '@playwright/test';

import {
  dismissPrivacyDialog,
  openSettingsDialog,
  STORAGE_KEY,
  waitForLoadingToClear,
} from '@/playwright/amr';
import {
  fulfillAgentsRoute,
  routeSuccessfulRuns,
  successfulRunEventBody,
  suppressWhatsNew,
} from '@/playwright/mock-factory';
import { T } from '@/timeouts';

type OnboardingConfig = {
  mode: 'daemon' | 'api';
  apiKey: string;
  apiProtocol?: string;
  baseUrl: string;
  model: string;
  agentId: string | null;
  skillId: null;
  designSystemId: string | null;
  onboardingCompleted: boolean;
  mediaProviders: Record<string, never>;
  agentModels: Record<string, { model: string; reasoning: string }>;
};

test.describe.configure({ timeout: T.xlong });

const retiredRequestsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const requests: string[] = [];
  retiredRequestsByPage.set(page, requests);
  page.on('request', (request) => {
    if (/^\/api\/(?:integrations\/vela|amr|workspaces|workspace\/(?:invite|billing|resources|projects|members|events|active)|touchpoints\/(?:test|production)-runtime)(?:\/|$)/.test(new URL(request.url()).pathname)) {
      requests.push(request.url());
    }
  });
  await suppressWhatsNew(page);
});

test.afterEach(async ({ page }) => {
  expect(retiredRequestsByPage.get(page)).toEqual([]);
});

test('[P0] @critical onboarding offers only Local Agent and API sources across reload', async ({ page }) => {
  const config = await wireOnboardingMocks(page, { legacyAmrAvailable: true });
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  const localDirectory = await page.request.get('/api/workspace/directory');
  expect(localDirectory.ok()).toBe(true);
  expect(await localDirectory.json()).toMatchObject({ items: [] });
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('radio', { name: /OpenDesign Hosted|Cloud/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Sign in|Sign up|Cancel sign-in/i })).toHaveCount(0);
  await openModelSourceSetup(page, /Local Agent/i);
  await expect(page.getByText('Local CLI', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Back$/i }).click();
  await expectModelSourceChooser(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);
  await expect(onboardingByokPanel(page)).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expectModelSourceChooser(page);
});

test('[P0] @critical onboarding Local CLI card lets the user pick an agent model before continuing', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    codexModels: [
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'o3', label: 'o3' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'glm-5', label: 'GLM 5' },
      { id: 'qwen3-235b', label: 'Qwen3 235B' },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    ],
  });

  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: STORAGE_KEY, value: config },
  );

  await gotoOnboarding(page);

  // Scanning auto-selects
  // the default agent (codex), so its live model picker is available.
  await openModelSourceSetup(page, /Local Agent/i);
  const localPanel = page.locator('.onboarding-view__setup-panel');
  await expect(localPanel).toBeVisible();
  await selectOnboardingOption(localPanel, 'Model', 'GLM 5');

  await expect(expectOnboardingTrigger(localPanel, 'Model')).toContainText('GLM 5');
  await expect(page.getByRole('button', { name: /^Continue$/i })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await page.getByRole('button', { name: /^Back$|返回/i }).click();
  await expectModelSourceChooser(page);
});

test('[P0] onboarding Local CLI path completes setup with the selected agent model', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    codexModels: [
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'glm-5', label: 'GLM 5' },
    ],
  });

  await seedOnboardingConfig(page, config);
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        model: 'glm-5',
        agentName: 'Codex CLI',
        sample: 'Connected',
      },
    });
  });
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Local Agent/i);
  const localPanel = page.locator('.onboarding-view__setup-panel');
  await expect(localPanel).toBeVisible();
  await selectOnboardingOption(localPanel, 'Model', 'GLM 5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await page.getByRole('button', { name: /^Continue$/i }).click();

  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'daemon',
    agentId: 'codex',
    agentModels: {
      codex: { model: 'glm-5' },
    },
    onboardingCompleted: true,
  });
});

test('[P0] onboarding Local CLI path stays gated when no local CLI is available', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    localAgents: [],
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Local Agent/i);
  await expect(page.getByText('Local CLI')).toBeVisible();
  await expect(page.getByText(/No agents detected|No local CLI detected/i)).toBeVisible();

  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  await expect(continueButton).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('heading', { name: /Local Agent|本地 Agent/i })).toBeVisible();
  await expect(page.getByText(/Optional details for better defaults/i)).toHaveCount(0);
});

test('[P0] onboarding Local CLI path stays gated while local agent scan is still running', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    agentsDelayMs: 20_000,
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Local Agent/i);
  await expect(page.getByRole('button', { name: /Scanning|扫描中/i })).toBeVisible();

  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  await expect(continueButton).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('heading', { name: /Local Agent|本地 Agent/i })).toBeVisible();
  await expect(page.getByText(/Optional details for better defaults/i)).toHaveCount(0);
});

test('[P0] onboarding supports Local CLI when the AMR agent is unavailable', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  await seedOnboardingConfig(page, config);

  await gotoOnboarding(page);

  await expect(page.getByRole('button', { name: /AMR Cloud/i })).toHaveCount(0);
  await openModelSourceSetup(page, /Local Agent/i);
  await expect(page.getByText('Local CLI')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue$/i })).toBeVisible();
});

test('[P0] onboarding local selection carries into the first Home run request', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Local Agent/i);
  await expectConnectionSuccess(page);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expectOnboardingFinished(page);
  const runBodies: Array<Record<string, unknown>> = [];
  const runs = await routeSuccessfulRuns(page, {
    bodies: runBodies,
    runId: 'local-onboarding-first-run',
    eventBody: successfulRunEventBody(['event: start', 'data: {"bin":"codex"}', '']),
  });
  await page.getByTestId('home-hero-input').fill('Create a local onboarding carryover artifact.');
  await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
  await page.getByTestId('home-hero-submit').click();
  await runs.expectCount(1);
  expect(runBodies[0]).toMatchObject({ agentId: 'codex' });
});

test('[P0] completed BYOK setup stays usable without Cloud account state', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});
  Object.assign(config, {
    mode: 'api',
    apiKey: 'persisted-byok-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    agentId: null,
    onboardingCompleted: true,
  } satisfies Partial<OnboardingConfig>);
  await seedOnboardingConfig(page, config);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Choose your model source|选择模型来源/i })).toHaveCount(0);
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiKey: 'persisted-byok-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    onboardingCompleted: true,
  });
});

test('[P1] install-local BYOK survives daemon preference reset and cold reload', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});
  Object.assign(config, {
    mode: 'api',
    apiProtocol: 'openai',
    apiKey: 'persisted-private-key',
    baseUrl: 'https://persisted.example/v1',
    model: 'persisted-private-model',
    agentId: null,
    onboardingCompleted: true,
  } satisfies Partial<OnboardingConfig>);
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 11,
        models: [{ id: 'persisted-private-model', label: 'Persisted Private Model' }],
      },
    });
  });
  let connectionBody: Record<string, unknown> | null = null;
  await page.route('**/api/test/connection', async (route) => {
    connectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 13,
        model: 'persisted-private-model',
        sample: 'Connected',
      },
    });
  });

  // Seed only the first document so cold reload proves install-local persistence.
  await page.goto('/api/health');
  await page.evaluate(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: STORAGE_KEY, value: config },
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expect(page.getByTestId('home-view')).toBeVisible();
  // The daemon cannot hand the install-local BYOK secret back to the browser.
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: false,
          agentId: null,
          agentModels: {},
          agentCliEnv: {},
          agentCliEnvIntent: {},
        },
      },
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const settings = await openSettingsDialog(page);
  await settings.getByTestId('settings-nav-execution').click();
  await expect(settings.getByLabel('API key')).toHaveValue('persisted-private-key');
  await expect(settings.getByLabel('Base URL')).toHaveValue('https://persisted.example/v1');
  await settings.getByRole('button', { name: 'Test', exact: true }).click();
  await expect.poll(() => connectionBody).toMatchObject({
    mode: 'provider',
    protocol: 'openai',
    apiKey: 'persisted-private-key',
    baseUrl: 'https://persisted.example/v1',
    model: 'persisted-private-model',
  });
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiProtocol: 'openai',
    apiKey: 'persisted-private-key',
    baseUrl: 'https://persisted.example/v1',
    model: 'persisted-private-model',
    onboardingCompleted: true,
  });
});

for (const destination of [
  { name: 'Home', path: '/' },
  { name: 'Community', path: '/community' },
  { name: 'Projects', path: '/projects' },
  { name: 'Design Systems', path: '/design-systems' },
  { name: 'Plugins', path: '/plugins' },
  { name: 'Integrations', path: '/integrations' },
  { name: 'Settings', path: '/settings' },
] as const) {
  test(`[P0] unconfigured users reach model-source setup from ${destination.name}`, async ({ page }) => {
    const config = await wireOnboardingMocks(page, {});
    await seedOnboardingConfig(page, config);

    await page.goto(destination.path, { waitUntil: 'domcontentloaded' });
    await waitForLoadingToClear(page);
    await dismissPrivacyDialog(page);

    await expect(page).toHaveURL(/\/onboarding$/);
    await expectModelSourceChooser(page);
  });
}

test('[P0] onboarding configuration Back returns to the source chooser with the test gate locked', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await expectModelSourceChooser(page);
  await continueWithModelSource(page, /Bring Your Own Key/i);
  await expect(onboardingByokPanel(page)).toBeVisible();

  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  await expect(continueButton).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('heading', { name: /Bring your own key|自己的模型 Key/i })).toBeVisible();
  await page.getByRole('button', { name: /^Back$/i }).click();
  await expectModelSourceChooser(page);
  await expect(page.getByRole('radio', { name: /Bring Your Own Key/i })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('[P0] @critical onboarding BYOK path can fetch models, test the provider, and complete setup', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 14,
        models: [
          { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        ],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 27,
        model: 'claude-opus-4-8',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  await expect(byokPanel).toBeVisible();

  await fillInlineField(page, 'API key', 'test-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 2 models\./)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'claude-opus-4-8');

  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);

  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiKey: 'test-api-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-8',
    onboardingCompleted: true,
  });
});

test('[P0] onboarding BYOK Continue tests the configuration and retries after failure', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  let connectionOk = false;
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 14,
        models: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: connectionOk
        ? {
            ok: true,
            kind: 'success',
            latencyMs: 18,
            model: 'claude-sonnet-4-5',
            sample: 'Connected',
          }
        : {
            ok: false,
            kind: 'error',
            latencyMs: 18,
            error: 'Invalid API key',
          },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  await expect(byokPanel).toBeVisible();

  const continueButton = page.getByRole('button', { name: /^Continue$/i });
  await expect(continueButton).toHaveAttribute('aria-disabled', 'true');

  await fillInlineField(page, 'API key', 'bad-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 1 model/)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Sonnet 4.5');
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  await continueButton.click();
  await expect(page.getByText(/Invalid API key|Connection failed|failed/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Bring your own key|自己的模型 Key/i })).toBeVisible();
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  connectionOk = true;
  await fillInlineField(page, 'API key', 'good-api-key');
  await continueButton.click();
  await expectOnboardingFinished(page);
});

test('[P0] onboarding BYOK path supports Anthropic model selection and API key visibility before completing', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});
  let connectionBody: Record<string, unknown> | null = null;
  await page.route('**/api/test/connection', async (route) => {
    connectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 19,
        model: 'claude-custom-onboarding',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Bring Your Own Key/i);
  await expect(page.getByRole('tab', { name: /^Anthropic$/i })).toHaveAttribute('aria-selected', 'true');

  const apiKeyField = onboardingField(page, 'API key');
  const apiKeyInput = apiKeyField.locator('input');
  await expect(apiKeyInput).toHaveAttribute('type', 'password');
  await fillInlineField(page, 'API key', 'anthropic-test-key');
  await apiKeyField.getByRole('button', { name: /^Show$/i }).click();
  await expect(apiKeyInput).toHaveAttribute('type', 'text');

  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  const byokPanel = onboardingByokPanel(page);
  await selectOnboardingOption(byokPanel, 'Model', 'claude-sonnet-4-5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);

  await expect.poll(() => connectionBody).toMatchObject({
    mode: 'provider',
    protocol: 'anthropic',
    apiKey: 'anthropic-test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
  });

  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiProtocol: 'anthropic',
    apiKey: 'anthropic-test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    onboardingCompleted: true,
  });
});

test('[P0] onboarding BYOK successful test is invalidated when connection settings change', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 11,
        models: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 16,
        model: 'claude-sonnet-4-5',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  const continueButton = page.getByRole('button', { name: /^Continue$/i });

  await fillInlineField(page, 'API key', 'valid-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 1 model/)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Sonnet 4.5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  await fillInlineField(page, 'API key', 'changed-api-key');

  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Bring your own key|自己的模型 Key/i })).toBeVisible();
  await expect(page.getByText(/Optional details for better defaults/i)).toHaveCount(0);
});

test('[P0] onboarding BYOK successful test is invalidated when Base URL or model changes', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {});

  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        models: [
          { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        ],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 17,
        model: 'claude-sonnet-4-5',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);

  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  const continueButton = page.getByRole('button', { name: /^Continue$/i });

  await fillInlineField(page, 'API key', 'valid-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  // Scope to the models-status text rather than role=status: both the models
  // status and (after the test below) the connection status share role=status,
  // so a bare getByRole('status') would be ambiguous on later assertions.
  await expect(page.getByText(/Fetched 2 models/)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Sonnet 4.5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  await fillInlineField(page, 'Base URL', 'https://api.changed.example');
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);

  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  await selectOnboardingOption(byokPanel, 'Model', 'Claude Opus 4.8');
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Bring your own key|自己的模型 Key/i })).toBeVisible();
  await expect(page.getByText(/Optional details for better defaults/i)).toHaveCount(0);
});

async function wireOnboardingMocks(
  page: Page,
  options: {
    legacyAmrAvailable?: boolean;
    agentsDelayMs?: number;
    codexModels?: Array<{ id: string; label: string }>;
    localAgents?: Array<{
      id: string;
      name: string;
      bin: string;
      available: boolean;
      version: string;
      models: Array<{ id: string; label: string }>;
    }>;
  },
): Promise<OnboardingConfig> {
  const config: OnboardingConfig = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: 'codex',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: false,
    mediaProviders: {},
    agentModels: { codex: { model: 'default', reasoning: 'default' } },
  };

  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { config } });
      return;
    }
    if (route.request().method() === 'PUT') {
      Object.assign(config, route.request().postDataJSON() as Partial<OnboardingConfig>);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });

  const localAgents = options.localAgents ?? [{
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: 'test',
    models: options.codexModels ?? [{ id: 'default', label: 'Default' }],
  }];

  const agents = [
    ...(options.legacyAmrAvailable
      ? [{
          id: 'amr',
          name: 'AMR (vela)',
          bin: 'vela',
          available: true,
          version: '1.0.0',
          models: [{ id: 'default', label: 'Default' }],
        }]
      : []),
    ...localAgents,
  ];

  await page.route('**/api/agents**', async (route) => {
    if (options.agentsDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.agentsDelayMs));
    }
    await fulfillAgentsRoute(route, agents);
  });

  // Onboarding validates a settled runtime selection on its own, before
  // Continue is ever pressed. Without a default handler that background pass
  // reaches the live daemon and spawns whichever agent CLI the box happens to
  // have. Cases that care about the verdict register their own handler after
  // this one, which Playwright matches first.
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        model: 'default',
        agentName: 'Codex CLI',
        sample: 'Connected',
      },
    });
  });

  return config;
}

async function gotoOnboarding(page: Page) {
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expectModelSourceChooser(page);
}

async function expectModelSourceChooser(page: Page) {
  await expect(
    page.getByRole('heading', { name: /Choose your model source|选择模型来源/i }),
  ).toBeVisible({ timeout: T.long });
  await expect(page.getByRole('radiogroup')).toBeVisible();
}

async function continueWithModelSource(page: Page, sourceName: RegExp) {
  const source = page.getByRole('radio', { name: sourceName });
  await expect(source).toBeVisible();
  await source.click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
}

async function openModelSourceSetup(page: Page, sourceName: RegExp) {
  await expectModelSourceChooser(page);
  await continueWithModelSource(page, sourceName);
}

async function seedOnboardingConfig(page: Page, config: OnboardingConfig) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: STORAGE_KEY, value: config },
  );
}

async function expectOnboardingFinished(page: Page) {
  await dismissPrivacyDialog(page);
  const goHome = page.getByRole('button', { name: /Go to home/i });
  if (await goHome.isVisible().catch(() => false)) {
    await goHome.click();
  } else {
    const finishSetup = page.getByRole('button', { name: /Finish setup/i });
    if (await finishSetup.isVisible().catch(() => false)) {
      await finishSetup.click();
    }
  }
  await expect(page).not.toHaveURL(/\/onboarding$/);
  await dismissPrivacyDialog(page);
  await expect(page.getByTestId('home-view')).toBeVisible();
}

function onboardingByokPanel(page: Page) {
  return page.locator('.onboarding-view__setup-panel').filter({
    has: page.getByText('API providers', { exact: true }),
  });
}

async function expectConnectionSuccess(page: Page) {
  await expect(
    page.getByText(/Connected\. Replied in \d+ ms|.+ replied in \d+ ms/),
  ).toBeVisible();
}

function pollStoredConfig(page: Page) {
  return expect.poll(() =>
    page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || '{}'), STORAGE_KEY),
  );
}

type OnboardingLocatorRoot = Page | Locator;

function onboardingField(root: OnboardingLocatorRoot, label: string) {
  return root.locator('.onboarding-view__select-field, .onboarding-view__inline-field').filter({
    hasText: new RegExp(label, 'i'),
  }).first();
}

function expectOnboardingTrigger(root: OnboardingLocatorRoot, label: string) {
  return onboardingField(root, label).getByRole('button');
}

async function selectOnboardingOption(root: OnboardingLocatorRoot, label: string, option: string) {
  const field = onboardingField(root, label);
  const listbox = field.getByRole('listbox', { name: new RegExp(label, 'i') });
  if (!(await listbox.isVisible().catch(() => false))) {
    await field.getByRole('button').click();
  }
  await listbox.getByRole('option').filter({ hasText: new RegExp(option, 'i') }).first().click();
}

async function fillInlineField(page: Page, label: string, value: string) {
  await onboardingField(page, label).locator('input').fill(value);
}

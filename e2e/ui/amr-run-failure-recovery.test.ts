import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@/playwright/suite';
import { ACTIVE_ARTIFACT_PREVIEW_SELECTOR } from '@/playwright/artifact-preview';
import { runErrorCard } from '@/playwright/chat';
import { routeAgents, suppressWhatsNew, trackRunRequests } from '@/playwright/mock-factory';
import { T } from '@/timeouts';
import { createFakeAgentRuntimes } from '@/playwright/fake-agents';
import { createLocalProject } from '@/vitest/local-workspace';
import {
  AMR_PERSONAL_WORKSPACE_HEADERS, createProjectViaApi, gotoProject, openSettingsDialog,
  putAppConfig, seedBrowserConfig, sendPrompt, STORAGE_KEY,
} from '@/playwright/amr';

let codexRuntime: Awaited<ReturnType<typeof createFakeAgentRuntimes>>['codex'];
const CODEX_AGENT = { id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] };
const CLAUDE_AGENT = { id: 'claude', name: 'Claude Code', bin: 'claude', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] };
const ANTIGRAVITY_AGENT = { id: 'antigravity', name: 'Antigravity', bin: 'antigravity', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] };
const RETIRED_AGENT = { id: 'amr', name: 'OpenDesign AMR', bin: 'vela', available: true, version: 'old', models: [{ id: 'glm-5', label: 'glm-5' }] };

test.describe.configure({ timeout: T.xlong });
test.beforeEach(async ({ page }) => { await suppressWhatsNew(page); });
test.beforeAll(async ({ toolsDev }) => {
  const runtimes = await createFakeAgentRuntimes({ root: join(toolsDev.root, 'scratch', 'recovery-agents'), runtimeIds: ['codex', 'claude'] });
  codexRuntime = runtimes.codex;
});
async function stubCatalogsEmpty(page: Page) {
  for (const [path, key] of [['skills', 'skills'], ['design-templates', 'designTemplates'], ['design-systems', 'designSystems']] as const) {
    await page.route(`**/api/${path}`, route => route.fulfill({ json: { [key]: [] } }));
  }
}
async function stubRuntimeAgents(page: Page) {
  await routeAgents(page, [CODEX_AGENT, CLAUDE_AGENT, ANTIGRAVITY_AGENT]);
}

test('[P0] @critical restored Cloud selection offers local recovery without login, wallet, or recharge', async ({ page, toolsDev }) => {
  await stubCatalogsEmpty(page);
  await routeAgents(page, [RETIRED_AGENT, CODEX_AGENT]);
  const config = { mode: 'daemon', agentId: 'amr', cloudFeatures: true, onboardingCompleted: true, privacyDecisionAt: 1,
    agentModels: { amr: { model: 'glm-5', reasoning: 'default' }, codex: { model: 'default', reasoning: 'default' } },
    agentCliEnv: { codex: codexRuntime.env } };
  await putAppConfig(page, config);
  // Seed once so navigating to the project preserves the user's new selection.
  await page.goto('/api/health');
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: STORAGE_KEY, value: config,
  });
  const requests: string[] = [];
  page.on('request', request => {
    if (/\/(integrations\/vela|workspace\/billing)/.test(new URL(request.url()).pathname)) requests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
  const settings = await openSettingsDialog(page);
  await settings.getByTestId('settings-nav-execution').click();
  await expect(settings.getByTestId('settings-agent-card-amr')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /Sign in|Sign out|Recharge|Upgrade/i })).toHaveCount(0);
  await settings.getByTestId('settings-agent-select-codex').click();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').agentId, STORAGE_KEY)).toBe('codex');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  const project = await createLocalProject(toolsDev.url.web(), 'Local recovery after retired Cloud');
  await gotoProject(page, project.project.id);
  await sendPrompt(page, 'Create a deterministic smoke artifact');
  await expect(page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR).getByRole('heading', { name: 'Real Daemon Smoke' })).toBeVisible({ timeout: T.long });
  expect(requests).toEqual([]);
});

test('[P0] CLI upstream outages preserve guidance and offer an explicit local retry', async ({ page, toolsDev }) => {
  await stubCatalogsEmpty(page);
  await stubRuntimeAgents(page);
  const root = join(toolsDev.root, 'scratch', 'upstream-recovery');
  const runtimes = await createFakeAgentRuntimes({ root: join(root, 'agents'), runtimeIds: ['claude'] });
  const config = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: 'claude',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    mediaProviders: {},
    agentModels: {
      claude: { model: 'default', reasoning: 'default' },
    },
    agentCliEnv: {
      claude: runtimes.claude.env,
    },
  };

  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = `upstream-ui-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-');
  const { conversationId } = await createProjectViaApi(page, projectId, 'Upstream outage recovery');

  const userMsgId = `u-${projectId}`;
  const userMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${userMsgId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'user',
        content: 'please build something',
        createdAt: Date.now() - 2_000,
      },
    },
  );
  expect(userMsgRes.ok(), `upsert user msg: ${await userMsgRes.text()}`).toBeTruthy();

  const assistantMsgId = `a-${projectId}`;
  const assistantMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${assistantMsgId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'assistant',
        content: '',
        agentId: 'claude',
        runId: `run-${projectId}`,
        runStatus: 'failed',
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
        preTurnFileNames: [],
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: 'The model provider is temporarily unavailable.',
            code: 'UPSTREAM_UNAVAILABLE',
          },
        ],
      },
    },
  );
  expect(assistantMsgRes.ok(), `upsert assistant msg: ${await assistantMsgRes.text()}`).toBeTruthy();

  await gotoProject(page, projectId);

  const card = runErrorCard(page);
  await expect(card).toContainText('Model service unavailable', { timeout: T.long });
  await expect(card.getByTestId('chat-run-error-description')).toHaveText(
    'The current model is temporarily unavailable. Try again later, or switch models.',
  );
  await expect(card.getByRole('button')).toHaveText([
    'Contact us', 'Export logs', 'Retry',
  ]);
  await expect(card.getByRole('button', { name: /^Retry$/i })).toBeVisible();
  await expect(card.getByRole('button', { name: /Cloud/i })).toHaveCount(0);
  await expect(card).not.toContainText('The model provider is temporarily unavailable.');
  await expect(page.getByText(/Model call failed/i)).toHaveCount(0);
});

test('[P1] zh-CN context-limit guidance keeps diagnostics without Cloud promotion', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('open-design:locale', 'zh-CN');
    window.localStorage.setItem('open-design:locale-source', 'manual');
  });
  await stubCatalogsEmpty(page);
  await stubRuntimeAgents(page);

  const config = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: 'codex',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    mediaProviders: {},
    agentModels: {
      codex: { model: 'default', reasoning: 'default' },
    },
    agentCliEnv: {
      codex: codexRuntime.env,
    },
  };
  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = `prompt-too-large-ui-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-');
  const { conversationId } = await createProjectViaApi(page, projectId, 'Prompt too large guidance');

  const userMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/u-${projectId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'user',
        content: 'please build with a very large attachment set',
        createdAt: Date.now() - 2_000,
      },
    },
  );
  expect(userMsgRes.ok(), `upsert user msg: ${await userMsgRes.text()}`).toBeTruthy();

  const rawDetail = 'context window exceeded: estimated 250000 tokens for this run.';
  const assistantMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/a-${projectId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'assistant',
        content: '',
        agentId: 'codex',
        agentName: 'Codex CLI',
        runId: `run-${projectId}`,
        runStatus: 'failed',
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
        preTurnFileNames: [],
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: rawDetail,
            code: 'AGENT_PROMPT_TOO_LARGE',
          },
        ],
      },
    },
  );
  expect(assistantMsgRes.ok(), `upsert assistant msg: ${await assistantMsgRes.text()}`).toBeTruthy();

  await gotoProject(page, projectId);

  const card = runErrorCard(page);
  await expect(card).toContainText('对话内容过长', { timeout: T.long });
  // L7 revision 96 approved context-limit wording; preserve the original code/detail fixture.
  await expect(card.getByTestId('chat-run-error-description')).toHaveText(
    '当前上下文已超出模型可处理的长度，请新建对话后再试。',
  );
  await expect(card.getByRole('button')).toHaveText([
    '联系我们', '导出日志', '重试',
  ]);
  await expect(card.getByRole('button', { name: '重试', exact: true })).toBeVisible();

  // 卡上不再有「错误详情」折叠(用户 2026-08-27):既没有那颗〔查看详情〕,
  // 上游原文也不出现在卡上的任何地方。
  await expect(card.getByRole('button', { name: /查看详情/ })).toHaveCount(0);
  await expect(card).not.toContainText(rawDetail);
});

// G16 replaces terminal/retry actions on this CLI error card with the single Cloud action.
test('[P0] antigravity rate limits keep classification without Cloud switching', async ({ page }) => {
  await stubCatalogsEmpty(page);
  await stubRuntimeAgents(page);
  // This case owns the signed-in in-project switch. The signed-out gate is
  // covered separately above, without relying on another worker test's login.
  await page.route('**/api/integrations/vela/status*', async (route) => {
    await route.fulfill({ json: {
      loggedIn: true, profile: 'local',
      user: { id: 'antigravity-switch-user', email: 'antigravity-switch@example.com', plan: 'free' },
    } });
  });
  let oauthLaunchCalls = 0;
  await page.route('**/api/agents/antigravity/oauth-launch', async (route) => {
    oauthLaunchCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  const config = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: 'antigravity',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    mediaProviders: {},
    agentModels: {
      antigravity: { model: 'default', reasoning: 'default' },
    },
  };

  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = `antigravity-ui-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-');
  const { conversationId } = await createProjectViaApi(page, projectId, 'Antigravity rate limit recovery');

  const userMsgId = `u-${projectId}`;
  const userMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${userMsgId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'user',
        content: 'please build something',
        createdAt: Date.now() - 2_000,
      },
    },
  );
  expect(userMsgRes.ok(), `upsert user msg: ${await userMsgRes.text()}`).toBeTruthy();

  const assistantMsgId = `a-${projectId}`;
  const assistantMsgRes = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${assistantMsgId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'assistant',
        content: '',
        agentId: 'antigravity',
        runId: `run-${projectId}`,
        runStatus: 'failed',
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
        preTurnFileNames: [],
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: 'Switch to another Antigravity model before retrying this run.',
            code: 'RATE_LIMITED',
          },
        ],
      },
    },
  );
  expect(assistantMsgRes.ok(), `upsert assistant msg: ${await assistantMsgRes.text()}`).toBeTruthy();

  await gotoProject(page, projectId);

  const originalUrl = page.url();
  const runRequests = trackRunRequests(page);
  const card = runErrorCard(page);
  await expect(card).toContainText('Model service is busy', { timeout: T.long });
  await expect(card).not.toContainText('Switch to another Antigravity model before retrying this run.');
  await expect(card.getByRole('button')).toHaveText([
    'Contact us', 'Export logs',
  ]);
  await expect(card.getByRole('button', { name: /Switch model in terminal|^Retry$/i })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Cloud/i })).toHaveCount(0);
  await expect(page).toHaveURL(originalUrl);
  await runRequests.expectNone();
  expect(oauthLaunchCalls).toBe(0);
  runRequests.dispose?.();
});

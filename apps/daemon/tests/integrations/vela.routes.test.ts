// Older Cloud clients receive removal responses without activating saved credentials.
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';
import { readAppConfig, writeAppConfig } from '../../src/app-config.js';
import { parseAmrEntryAnalyticsPayload, parseAmrOnboardingProfileAnalyticsPayload } from '../../src/integrations/vela.js';

describe('retired Cloud HTTP routes', () => {
  let started: { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
  let savedConfig: Awaited<ReturnType<typeof readAppConfig>>;
  const dataDir = process.env.OD_DATA_DIR!;

  beforeAll(async () => {
    const config = await readAppConfig(dataDir);
    await writeAppConfig(dataDir, { ...config, cloudFeatures: true,
      agentCliEnv: { ...config.agentCliEnv, amr: {
        VELA_BIN: 'retired-provider-must-not-launch',
        VELA_RUNTIME_KEY: 'synthetic-retired-runtime-key',
        VELA_CONTROL_KEY: 'synthetic-retired-control-key',
      } },
    });
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    savedConfig = await readAppConfig(dataDir);
  });

  afterAll(async () => {
    await started?.shutdown?.();
    started?.server.closeAllConnections();
    if (started?.server.listening) {
      await new Promise<void>(resolve => started.server.close(() => resolve()));
    }
  });

  it.each([
    ['GET', '/api/integrations/vela/status'],
    ['GET', '/api/integrations/vela/wallet'],
    ['POST', '/api/integrations/vela/login'],
    ['POST', '/api/integrations/vela/logout'],
    ['POST', '/api/integrations/vela/analytics-entry'],
    ['POST', '/api/integrations/vela/analytics-profile'],
    ['GET', '/api/integrations/vela/message-center/messages'],
    ['POST', '/api/integrations/vela/api-proxy/auth/device'],
    ['GET', '/api/amr/models'],
    ['POST', '/api/touchpoints/test-runtime/context'],
    ['POST', '/api/touchpoints/production-runtime/decision'],
  ])('%s %s rejects saved Cloud switches and credentials', async (method, route) => {
    const response = await fetch(started.url + route, { method });
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    expect(body).not.toContain('synthetic-retired');
    expect(await readAppConfig(dataDir)).toEqual(savedConfig);
  });

  it('keeps local health and provider settings available', async () => {
    const health = await fetch(started.url + '/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const agents = await fetch(started.url + '/api/agents');
    expect(agents.status).toBe(200);
    const body = await agents.json() as { agents: Array<{ id: string }> };
    expect(body.agents.some(agent => agent.id === 'amr')).toBe(false);
  });
});

describe('parseAmrEntryAnalyticsPayload — entry sources added in this PR', () => {
  const payloadFor = (source: string, page: string) => ({
    pageName: 'open_design',
    sourcePageName: page,
    area: 'amr_entry',
    element: source,
    action: 'click_amr_entry',
    entryId: 'od-amr-entry-x',
    sourceProduct: 'open_design',
    sourceDetail: source,
    entryOccurredAt: '2026-06-03T12:00:00.000Z',
  });

  it('accepts upgrade / agent-card sources so mirroring is not 400ed', () => {
    const cases: Array<[string, string]> = [
      ['settings_amr_upgrade', 'settings'],
      ['inline_amr_upgrade', 'chat_panel'],
      ['go_plan_sunset_modal', 'home'],
      ['deepseek_unpaid_modal', 'home'],
      ['deepseek_workbench_badge', 'home'],
      ['deepseek_model_switcher_upgrade', 'chat_panel'],
      ['avatar_amr_upgrade', 'chat_panel'],
      ['avatar_amr_agent_card', 'chat_panel'],
      ['artifact_success_upgrade', 'artifact'],
      ['home_artifact_upgrade', 'home'],
    ];
    for (const [source, page] of cases) {
      expect(parseAmrEntryAnalyticsPayload(payloadFor(source, page))).not.toBeNull();
    }
  });

  it('still rejects an unknown source', () => {
    expect(
      parseAmrEntryAnalyticsPayload(payloadFor('made_up_source', 'settings')),
    ).toBeNull();
  });

  it('preserves campaignId and conversionSource on the mirrored payload', () => {
    const parsed = parseAmrEntryAnalyticsPayload({
      ...payloadFor('deepseek_workbench_badge', 'home'),
      campaignId: 'deepseek_v4_flash',
      conversionSource: 'deepseek_workbench_badge',
    });
    expect(parsed).toMatchObject({
      campaignId: 'deepseek_v4_flash',
      conversionSource: 'deepseek_workbench_badge',
    });
  });

  // The ingest allowlist is fail-closed: an unrecognised campaign id voids the
  // WHOLE entry, not just its campaign field. So a live campaign missing from
  // the set loses every attributed entry it produces — and the campaign's own
  // success metrics (活动归因付费人数 / 金额) are defined as payments carrying
  // its `campaign_id`, which means the campaign would report zero while
  // converting normally.
  it('accepts the current campaign id, not only the finished one', () => {
    const parsed = parseAmrEntryAnalyticsPayload({
      ...payloadFor('deepseek_workbench_badge', 'home'),
      campaignId: 'deepseek_v4_pro',
      conversionSource: 'deepseek_workbench_badge',
    });
    expect(parsed).toMatchObject({
      campaignId: 'deepseek_v4_pro',
      conversionSource: 'deepseek_workbench_badge',
    });
  });

  it('accepts the targeted Go Plan sunset campaign dimensions', () => {
    const parsed = parseAmrEntryAnalyticsPayload({
      ...payloadFor('go_plan_sunset_modal', 'home'),
      campaignId: 'go_plan_sunset_202608',
      conversionSource: 'go_plan_sunset_modal',
    });
    expect(parsed).toMatchObject({
      campaignId: 'go_plan_sunset_202608',
      conversionSource: 'go_plan_sunset_modal',
    });
  });

  it('rejects unknown campaign dimensions rather than silently dropping them', () => {
    expect(
      parseAmrEntryAnalyticsPayload({
        ...payloadFor('deepseek_workbench_badge', 'home'),
        campaignId: 'not_a_real_campaign',
      }),
    ).toBeNull();
    expect(
      parseAmrEntryAnalyticsPayload({
        ...payloadFor('deepseek_workbench_badge', 'home'),
        conversionSource: 'not_a_real_source',
      }),
    ).toBeNull();
  });
});

describe('legacy analytics payload validation', () => {
it('drops an over-long profile value rather than mirroring it', () => {
    const base = {
      pageName: 'open_design',
      sourcePageName: 'chat_panel',
      area: 'amr_entry',
      element: 'chat_error_recharge',
      action: 'click_amr_entry',
      entryId: 'od-amr-entry-789',
      sourceProduct: 'open_design',
      sourceDetail: 'chat_error_recharge',
      entryOccurredAt: '2026-06-03T12:00:00.000Z',
    };
    // Valid optional values pass through; an over-long value rejects the event.
    expect(parseAmrEntryAnalyticsPayload({ payload: { ...base, odRole: 'student' } }))
      .toMatchObject({ odRole: 'student' });
    expect(
      parseAmrEntryAnalyticsPayload({
        payload: { ...base, odRole: 'x'.repeat(65) },
      }),
    ).toBeNull();
    // useCase is an array; valid lists pass through, a bad element rejects.
    expect(
      parseAmrEntryAnalyticsPayload({
        payload: { ...base, odUseCase: ['product', 'landing'], odSource: 'github' },
      }),
    ).toMatchObject({ odUseCase: ['product', 'landing'], odSource: 'github' });
    expect(
      parseAmrEntryAnalyticsPayload({
        payload: { ...base, odUseCase: ['product', 'x'.repeat(65)] },
      }),
    ).toBeNull();
    expect(
      parseAmrEntryAnalyticsPayload({
        payload: { ...base, odUseCase: 'not-an-array' },
      }),
    ).toBeNull();
  });
it('rejects malformed AMR onboarding profile analytics payloads', () => {
    const base = {
      pageName: 'open_design',
      sourcePageName: 'onboarding',
      area: 'onboarding',
      element: 'about_you_submit',
      action: 'submit_profile',
      entryId: 'od-amr-entry-profile',
      sourceProduct: 'open_design',
      sourceDetail: 'onboarding_amr_sign_in_continue',
      entryOccurredAt: '2026-06-03T12:00:00.000Z',
      profileOccurredAt: '2026-06-03T12:03:00.000Z',
    };

    expect(
      parseAmrOnboardingProfileAnalyticsPayload({
        payload: { ...base, odRole: 'pm', odDeviceId: 'od-install-abc' },
      }),
    ).toMatchObject({ odRole: 'pm', odDeviceId: 'od-install-abc' });
    expect(parseAmrOnboardingProfileAnalyticsPayload({ payload: base }))
      .toBeNull();
    expect(
      parseAmrOnboardingProfileAnalyticsPayload({
        payload: { ...base, odRole: 'x'.repeat(65) },
      }),
    ).toBeNull();

  });
it('rejects non-onboarding sources for AMR onboarding profile analytics', () => {
    const payload = {
      pageName: 'open_design',
      sourcePageName: 'onboarding',
      area: 'onboarding',
      element: 'about_you_submit',
      action: 'submit_profile',
      entryId: 'od-amr-entry-profile',
      sourceProduct: 'open_design',
      sourceDetail: 'settings_amr_console',
      entryOccurredAt: '2026-06-03T12:00:00.000Z',
      profileOccurredAt: '2026-06-03T12:03:00.000Z',
      odRole: 'pm',
    };

    expect(parseAmrOnboardingProfileAnalyticsPayload({ payload })).toBeNull();

  });
});

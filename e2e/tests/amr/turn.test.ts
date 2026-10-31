// @vitest-environment node
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createFakeAgentRuntimes } from '@/fake-agents';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { createLocalProject } from '@/vitest/local-workspace';
import { startRun, waitForRunTerminal, readRunEvents } from '@/vitest/runs';
import { listMessages } from '@/vitest/messages';

test('[P0] a local agent completes a turn after an obsolete Cloud request is rejected', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('local-turn-after-cloud');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const fake = await createFakeAgentRuntimes({ root: join(suite.scratchDir, 'agents'), runtimeIds: ['codex'] });
    await requestJson(webUrl, '/api/app-config', { method: 'PUT', body: {
      agentId: 'codex', agentCliEnv: { codex: fake.codex.env }, onboardingCompleted: true,
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    } });
    const project = await createLocalProject(webUrl, 'Local continuation');
    const body = { projectId: project.project.id, conversationId: project.conversationId,
      message: 'Create a deterministic smoke artifact', model: 'default' };
    const rejected = await fetch(new URL('/api/runs', webUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, agentId: 'amr' }),
    });
    expect(rejected.status).toBe(400);
    const run = await startRun(webUrl, { ...body, agentId: 'codex',
      assistantMessageId: 'local-assistant', clientRequestId: 'local-after-cloud' });
    const terminal = await waitForRunTerminal(webUrl, run.runId, { timeoutMs: 20_000 });
    expect(terminal.status).toBe('succeeded');
    const assistant = (await listMessages(webUrl, project.project.id, project.conversationId))
      .find(message => message.id === 'local-assistant');
    expect(assistant?.runStatus).toBe('succeeded');
    expect(assistant?.content.trim().length).toBeGreaterThan(0);
    expect(await readRunEvents(webUrl, run.runId)).not.toMatch(/AMR_AUTH_REQUIRED|AMR_INSUFFICIENT_BALANCE/);
  });
});

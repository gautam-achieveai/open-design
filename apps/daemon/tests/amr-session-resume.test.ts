import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Explicit synthetic local ACP capability: real Hermes does not promise session/load.
// The full server still owns persistence, retry, teardown and conversation identity.
vi.mock('../src/runtimes/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/registry.js')>();
  const hermes = actual.getAgentDef('hermes')!;
  const fixture = { ...hermes, resumesSessionViaAcpLoad: true, fetchModels: undefined,
    buildArgs: () => ['agent', 'run'], supportsCustomModel: true };
  return { ...actual, AGENT_DEFS: actual.AGENT_DEFS.map(def => def.id === 'hermes' ? fixture : def),
    getAgentDef: (id: string) => id === 'hermes' ? fixture : actual.getAgentDef(id) };
});

import { startServer } from '../src/server.js';

// Generic ACP continuation coverage, using the local synthetic capability above.
// Retired Cloud catalog choices are separately rejected before process launch.

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

type RunStatus = {
  id: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  eventsLogPath: string;
};
type RunEvent = { event: string; data: unknown };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_VELA = path.join(HERE, 'fixtures', 'fake-vela.mjs');

describe('synthetic local ACP session resume — full server cycle', () => {
  const originalEnv = snapshotEnv();
  let started: StartedServer | null = null;
  let binDir: string | null = null;

  beforeEach(() => {
    // These fixtures exercise session transport with plain replies, not OD Next state.
    process.env.OD_NEXT_STRATEGY_ROLLOUT = 'off';
  });

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    if (binDir) await removeTempDir(binDir);
    binDir = null;
    restoreEnv(originalEnv);
  });

  it.each(['success', 'pending', 'legacy', 'missing', 'mismatch', 'limit'])(
    'stops unsupported compaction continuation without repeating tool writes: %s', async (scenario) => {
      binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-continuation-'));
      const bin = path.join(binDir, process.platform === 'win32' ? 'local-acp.cmd' : 'local-acp');
      const fixture = path.join(HERE, 'fixtures', 'fake-vela-continuation.ts');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(bin, process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" "${scenario}" "${binDir}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(scenario)} ${quote(binDir)} "$@"\n`);
      await chmod(bin, 0o755);
      clearTelemetryEnv();
      started = await startServer({ port: 0, returnServer: true }) as StartedServer;
      await putConfig(started.url, { agentId: 'hermes', agentCliEnv: { hermes: { HERMES_BIN: bin } } });
      const conversation = await createConversation(started.url);
      const run = await sendRunAndWait(started.url, conversation, 'write exactly once');
      expect(run.status, JSON.stringify({ run, events: (await readRunEvents(run.eventsLogPath)).slice(-8) })).toBe('failed');
      const ledger = (await readFile(path.join(binDir, 'ledger.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line));
      expect(ledger.filter((row) => row.method === 'session/new')).toHaveLength(1);
      expect(ledger.filter((row) => row.method === 'session/prompt')).toHaveLength(1);
      expect(await readFile(path.join(binDir, 'tool-executions'), 'utf8')).toBe('write\n');
      expect(ledger.filter((row) => row.method === 'session/load')).toHaveLength(0);
      const attempts = ledger.filter((row) => row.method === '_session/continue');
      expect(attempts).toHaveLength(0);
      const events = await readRunEvents(run.eventsLogPath);
      expect(events.filter((event) => event.event === 'end')).toHaveLength(1);
      expect(events.filter((event) => event.event === 'run_retry_attempted')).toHaveLength(0);
      expect(hasDiagnostic(events, { type: 'agent_resume_auto_reseed' })).toBe(false);
      const final = events.find((event) => event.event === 'run_retry_finished');
      expect(final?.data).toMatchObject({ retry_result: 'suppressed' });
    }, 30_000,
  );

  it('captures the durable handle on turn 1 and resumes it via session/load on turn 2', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-resume-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    const bin = await writeLocalAcpWrapper(binDir, 'vela-resume', { logPath });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    const turn1 = await sendRunAndWait(started.url, conversationId, 'first request');
    expect(turn1.status).toBe('succeeded');

    const turn2 = await sendRunAndWait(started.url, conversationId, 'second request');
    expect(turn2.status).toBe('succeeded');

    // Turn 1 binds a fresh session; turn 2 resumes the captured durable handle.
    expect(await readInvocations(logPath)).toEqual(['new', 'load']);
  });

  it('bounds retry of rejected resumed prompts without opening a fresh session', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-deadresume-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    // session/load succeeds; the fixture rejects the resumed prompt before work.
    const bin = await writeLocalAcpWrapper(binDir, 'vela-deadresume', { logPath, resumeFailed: true, logPrompt: true });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    // Turn 1 creates + persists the durable handle.
    const turn1 = await sendRunAndWait(started.url, conversationId, 'first request');
    expect(turn1.status).toBe('succeeded');

    // The local adapter treats this RPC error as transient before visible work.
    // It may retry the same native session once, without fresh-session reseeding.
    const turn2 = await sendRunAndWait(started.url, conversationId, 'second request');
    expect(turn2.status).toBe('failed');
    expect(turn2.errorCode).toBe('AGENT_EXECUTION_FAILED');
    assertBoundedRejectedPromptRetry(await readRunEvents(turn2.eventsLogPath), await readInvocations(logPath));
  });

  it('keeps two rejected prompt attempts distinct from one terminal failure', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-reseed-noerror-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    const bin = await writeLocalAcpWrapper(binDir, 'vela-deadresume-noerror', { logPath, resumeFailed: true, logPrompt: true });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    expect((await sendRunAndWait(started.url, conversationId, 'first request')).status)
      .toBe('succeeded');

    const turn2 = await sendRunAndWait(started.url, conversationId, 'second request');
    expect(turn2.status).toBe('failed');
    assertBoundedRejectedPromptRetry(await readRunEvents(turn2.eventsLogPath), await readInvocations(logPath));
  });

  it('opens a fresh session next turn when turn 1 yields no durable handle', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-nohandle-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    // vela never reports openCodeSessionId → the daemon captures null and must
    // clear the row, so the next turn cannot attempt a session/load.
    const bin = await writeLocalAcpWrapper(binDir, 'vela-nohandle', { logPath, omitHandle: true });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    expect((await sendRunAndWait(started.url, conversationId, 'first request')).status)
      .toBe('succeeded');
    expect((await sendRunAndWait(started.url, conversationId, 'second request')).status)
      .toBe('succeeded');

    // No handle was ever stored, so BOTH turns open a fresh session — never a
    // session/load against a non-existent upstream session.
    expect(await readInvocations(logPath)).toEqual(['new', 'new']);
  });

  it('clears a resumed local ACP session after request_too_large so the next turn starts fresh', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-largecontext-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    const bin = await writeLocalAcpWrapper(binDir, 'vela-largecontext', {
      logPath,
      promptErrorOnLoad: '[code=request_too_large] request body exceeds configured limit',
    });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    // Turn 1 captures the durable upstream OpenCode handle.
    expect((await sendRunAndWait(started.url, conversationId, 'first request')).status)
      .toBe('succeeded');

    // Turn 2 resumes that handle, but the upstream request is now too large.
    // The run should fail honestly, but the daemon must clear the handle so
    // the next user retry does not load the same overgrown native session.
    const turn2 = await sendRunAndWait(started.url, conversationId, 'second request');
    expect(turn2.status).toBe('failed');
    expect(turn2.error ?? '').toMatch(/request body exceeds configured limit/i);

    const turn2Events = await readRunEvents(turn2.eventsLogPath);
    expect(hasDiagnostic(turn2Events, {
      type: 'agent_session_cleared_after_prompt_too_large',
      reason: 'prompt_too_large',
      stale_session_cleared: true,
    })).toBe(true);

    // Turn 3 proves the stale handle was discarded: it opens session/new and
    // succeeds instead of session/load-ing the same oversized upstream session.
    expect((await sendRunAndWait(started.url, conversationId, 'third request')).status)
      .toBe('succeeded');
    expect(await readInvocations(logPath)).toEqual(['new', 'load', 'new']);
  });

  it.each([undefined, 'default', 'legacy-disabled-model', 'legacy-custom/model'])(
    'rejects retired Cloud model selection before creating a run: %s', async (model) => {
      clearTelemetryEnv();
      started = await startServer({ port: 0, returnServer: true }) as StartedServer;
      const [projectId, conversationId] = (await createConversation(started.url)).split('::');
      const response = await fetch(started.url + '/api/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, conversationId, agentId: 'amr', model, message: 'retired Cloud request' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string }; runId?: string };
      expect(body.error.code).toBe('AGENT_UNAVAILABLE');
      expect(body.runId).toBeUndefined();
    },
  );

  it('reseeds a fresh session (no resume) when the model changes between turns', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-amr-modelchange-bin-'));
    const logPath = path.join(binDir, 'invocations.jsonl');
    const bin = await writeLocalAcpWrapper(binDir, 'vela-modelchange', { logPath });

    clearTelemetryEnv();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'hermes',
      agentCliEnv: { hermes: { HERMES_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });

    const conversationId = await createConversation(started.url);

    // Turn 1 binds a session under one model and captures the durable handle.
    expect((await sendRunAndWait(started.url, conversationId, 'first request', 'deepseek-v3.2')).status)
      .toBe('succeeded');
    // Turn 2 switches model: the resume-identity guard must invalidate (the
    // upstream session was seeded under the old model) and open a FRESH session
    // rather than session/load the mismatched one.
    expect((await sendRunAndWait(started.url, conversationId, 'second request', 'gemini-2.5-flash')).status)
      .toBe('succeeded');

    expect(await readInvocations(logPath)).toEqual(['new', 'new']);
  });
});

// Synthetic ACP fixture launched through HERMES_BIN. Its private behavior flags
// are set in the owned wrapper, keeping the real runtime environment allowlist.
async function writeLocalAcpWrapper(
  dir: string,
  name: string,
  opts: {
    logPath: string;
    resumeFailed?: boolean;
    omitHandle?: boolean;
    promptErrorOnLoad?: string;
    logSetModel?: boolean;
    logPrompt?: boolean;
    requireSetModel?: boolean;
    modelPresetJson?: string;
    modelListJson?: string;
  },
): Promise<string> {
  const bin = path.join(dir, process.platform === 'win32' ? name + '.cmd' : name);
  const lines = [
    '#!/bin/sh',
    `export FAKE_VELA_INVOCATION_LOG=${JSON.stringify(opts.logPath)}`,
  ];
  if (opts.requireSetModel !== true) {
    // Isolate most resume-cycle tests from the set_model gate; individual
    // default-model regressions opt back into the production-shaped strict gate.
    lines.push('export FAKE_VELA_REQUIRE_SET_MODEL=0');
  }
  if (opts.resumeFailed) lines.push('export FAKE_VELA_RESUME_FAILED=1');
  if (opts.omitHandle) lines.push('export FAKE_VELA_OMIT_OPENCODE_SESSION_ID=1');
  if (opts.promptErrorOnLoad) {
    lines.push(`export FAKE_VELA_PROMPT_ERROR_ON_LOAD=${JSON.stringify(opts.promptErrorOnLoad)}`);
  }
  if (opts.logSetModel) lines.push('export FAKE_VELA_LOG_SET_MODEL=1');
  if (opts.logPrompt) lines.push('export FAKE_VELA_LOG_PROMPT=1');
  if (opts.modelPresetJson) {
    lines.push(`export FAKE_VELA_MODEL_PRESET_JSON=${JSON.stringify(opts.modelPresetJson)}`);
  }
  if (opts.modelListJson) {
    lines.push(`export FAKE_VELA_MODEL_LIST_JSON=${JSON.stringify(opts.modelListJson)}`);
  }
  lines.push(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_VELA)} "$@"`, '');
  const script = process.platform === 'win32'
    ? lines.map((line) => line === '#!/bin/sh' ? '@echo off'
      : line.startsWith('export ') ? 'set "' + line.slice(7).replace(/="(.*)"$/, '=$1') + '"'
      : line.startsWith('exec ') ? line.slice(5).replace('"$@"', '%*') : line).join('\r\n')
    : lines.join('\n');
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

function assertBoundedRejectedPromptRetry(events: RunEvent[], invocations: string[]): void {
  expect(invocations).toEqual(['new', 'prompt', 'load', 'prompt', 'load', 'prompt']);
  expect(events.filter(event => event.event === 'error')).toHaveLength(2);
  expect(events.filter(event => event.event === 'run_retry_attempted')).toEqual([
    expect.objectContaining({ data: expect.objectContaining({
      retry_reason: 'transient_failure', retry_strategy: 'same_run_transient',
      retry_attempt_index: 1, retry_max_attempts: 1,
      failure_detail: 'fatal_rpc_error',
    }) }),
  ]);
  expect(events.filter(event => event.event === 'run_retry_finished')).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ retry_result: 'failed', retry_attempt_index: 1 }) }),
  ]);
  expect(events.filter(event => event.event === 'end')).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
  ]);
  expect(hasDiagnostic(events, { type: 'agent_resume_auto_reseed' })).toBe(false);
  expect(events.filter(event => {
    if (event.event !== 'agent' || !event.data || typeof event.data !== 'object') return false;
    const data = event.data as Record<string, unknown>;
    return data.type === 'tool_use' || data.type === 'tool_result'
      || (data.type === 'text_delta' && typeof data.delta === 'string' && data.delta.length > 0);
  })).toEqual([]);
}

async function readInvocations(logPath: string): Promise<string[]> {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

async function readRunEvents(
  eventsLogPath: string,
): Promise<RunEvent[]> {
  let raw = '';
  try {
    raw = await readFile(eventsLogPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

function hasDiagnostic(events: RunEvent[], expected: Record<string, unknown>): boolean {
  return events.some((event) => {
    if (event.event !== 'diagnostic' || !event.data || typeof event.data !== 'object') {
      return false;
    }
    return Object.entries(expected).every(
      ([key, value]) => (event.data as Record<string, unknown>)[key] === value,
    );
  });
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
    OPEN_DESIGN_TELEMETRY_RELAY_URL: process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL,
    POSTHOG_KEY: process.env.POSTHOG_KEY,
    POSTHOG_HOST: process.env.POSTHOG_HOST,
    OD_NEXT_STRATEGY_ROLLOUT: process.env.OD_NEXT_STRATEGY_ROLLOUT,
  };
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearTelemetryEnv(): void {
  delete process.env.POSTHOG_KEY;
  delete process.env.POSTHOG_HOST;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  delete process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL;
}

async function putConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(url + '/api/app-config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  expect(response.status, await response.text()).toBe(200);
}

async function createConversation(url: string): Promise<string> {
  const projectId = `amr_resume_${randomUUID()}`;
  const workspaceId = `amr_resume_personal_${projectId}`;
  const workspaceMemberId = `amr_resume_owner_${projectId}`;
  const workspaceHeaders = {
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-type': 'personal',
    'x-od-workspace-member-id': workspaceMemberId,
    'x-od-workspace-role': 'owner',
  };
  const projectResponse = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...workspaceHeaders,
    },
    body: JSON.stringify({
      id: projectId,
      name: 'AMR resume smoke',
      metadata: { kind: 'prototype' },
      skipDiscoveryBrief: true,
    }),
  });
  expect(projectResponse.status).toBe(200);
  const projectBody = (await projectResponse.json()) as { conversationId: string; id: string };
  return [
    projectId,
    projectBody.conversationId,
    workspaceId,
    workspaceMemberId,
  ].join('::');
}

async function sendRunAndWait(
  url: string,
  encoded: string,
  message: string,
  model?: string,
): Promise<RunStatus> {
  const [projectId, conversationId, workspaceId, workspaceMemberId] =
    encoded.split('::');
  if (!projectId || !conversationId || !workspaceId || !workspaceMemberId) {
    throw new Error(`invalid AMR resume fixture identity: ${encoded}`);
  }
  const assistantMessageId = `assistant_amr_${randomUUID()}`;
  const runResponse = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-od-analytics-device-id': 'amr-resume-test',
      'x-od-analytics-session-id': 'amr-resume-session',
      'x-od-analytics-client-type': 'web',
      'x-od-workspace-id': workspaceId,
      'x-od-workspace-type': 'personal',
      'x-od-workspace-member-id': workspaceMemberId,
      'x-od-workspace-role': 'owner',
    },
    body: JSON.stringify({
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `client_amr_${randomUUID()}`,
      agentId: 'hermes',
      message,
      currentPrompt: message,
      ...(model ? { model } : {}),
    }),
  });
  const body = (await runResponse.json()) as {
    runId?: string;
    error?: { code?: string; message?: string };
  };
  expect(runResponse.status, JSON.stringify(body)).toBe(202);
  expect(body.runId).toBeTypeOf('string');
  return await waitForRun(url, body.runId!, {
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-type': 'personal',
    'x-od-workspace-member-id': workspaceMemberId,
    'x-od-workspace-role': 'owner',
  });
}

async function waitForRun(
  url: string,
  runId: string,
  headers: Record<string, string>,
): Promise<RunStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const response = await fetch(
      `${url}/api/runs/${encodeURIComponent(runId)}`,
      { headers },
    );
    expect(response.status).toBe(200);
    const run = (await response.json()) as RunStatus;
    if (run.status === 'failed' || run.status === 'succeeded' || run.status === 'canceled') {
      return run;
    }
    await delay(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

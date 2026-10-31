// Integration: actual HTTP run startup and filesystem preparation; no provider or agent child.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  prepared: null as ((value: string) => void) | null,
  release: null as Promise<void> | null,
  runSpawns: 0,
  phase: 'idle',
  taskExecutionPresent: false,
}));
vi.mock('../../src/runtimes/mcp.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtimes/mcp.js')>();
  return { ...actual, prepareClaudeRunMcpConfig: async (...args: Parameters<typeof actual.prepareClaudeRunMcpConfig>) => {
    const prepared = await actual.prepareClaudeRunMcpConfig(...args);
    boundary.prepared?.(prepared.path);
    if (boundary.release) await boundary.release;
    return prepared;
  } };
});
vi.mock('../../src/runtimes/agent-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtimes/agent-process.js')>();
  return { ...actual, spawnAgentProcess: (...args: Parameters<typeof actual.spawnAgentProcess>) => {
    boundary.runSpawns++;
    return actual.spawnAgentProcess(...args);
  } };
});

import { startServer } from '../../src/server.js';
import { ToolTokenRegistry, type ToolTokenGrant } from '../../src/tool-tokens.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import { writeFakeCli } from './helpers/test-helpers.js';

describe('Claude MCP startup cancellation', () => {
  let daemon: { url: string; server: Server; shutdown: () => Promise<void> } | undefined;
  let root: string | undefined;
  let release = () => {};
  let preparationWatcher: { controller: AbortController; settled: Promise<never> } | undefined;
  const stopPreparationWatcher = async () => {
    const watcher = preparationWatcher;
    preparationWatcher = undefined;
    watcher?.controller.abort();
    await watcher?.settled.catch(() => undefined);
  };
  const savedEnv = new Map<string, string | undefined>();
  const changeEnv = (key: string, value: string | undefined) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  afterEach(async () => {
    if (boundary.phase !== 'complete') console.info(JSON.stringify({ test: 'claude-mcp-startup', phase: boundary.phase, runSpawns: boundary.runSpawns, taskExecutionPresent: boundary.taskExecutionPresent }));
    release();
    await stopPreparationWatcher();
    boundary.prepared = null;
    boundary.release = null;
    await daemon?.shutdown();
    if (daemon) await new Promise<void>(resolve => daemon!.server.close(() => resolve()));
    daemon = undefined;
    vi.restoreAllMocks();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    savedEnv.clear();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('cancels during real preparation without an inventory warmup, leaving no config, child or grant', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-claude-startup-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    for (const key of Object.keys(process.env)) {
      if (/token|secret|password|credential|api.?key|anthropic|openai|langfuse|_BIN$/iu.test(key)) changeEnv(key, undefined);
    }
    changeEnv('OD_AGENT_HOME', home);
    changeEnv('CODEX_HOME', path.join(home, 'codex'));
    changeEnv('PATH', [path.dirname(process.execPath), ...(process.platform === 'win32'
      ? [path.join(process.env.SystemRoot!, 'System32'), path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0')]
      : ['/usr/bin', '/bin'])].join(path.delimiter));
    const metadata = 'if(process.argv.includes("--version"))console.log("2.1.312");else if(process.argv.includes("--help"))console.log("--mcp-config --include-partial-messages");else if(process.argv[2]==="auth")console.log(JSON.stringify({loggedIn:true}));';
    const entry = path.join(root, 'metadata.cjs');
    fs.writeFileSync(entry, metadata);
    const cli = writeFakeCli(root, 'claude-startup', `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, `@"${process.execPath}" "${entry}" %*\n`);
    agentCapabilities.delete('claude');
    boundary.runSpawns = 0;
    boundary.taskExecutionPresent = false;
    const prepared = new Promise<string>(resolve => { boundary.prepared = resolve; });
    boundary.release = new Promise<void>(resolve => { release = resolve; });
    const grants: Array<{ registry: ToolTokenRegistry; grant: ToolTokenGrant }> = [];
    const mint = ToolTokenRegistry.prototype.mint;
    vi.spyOn(ToolTokenRegistry.prototype, 'mint').mockImplementation(function (this: ToolTokenRegistry, options) {
      const grant = mint.call(this, options);
      grants.push({ registry: this, grant });
      return grant;
    });
    boundary.phase = 'start-server';
    daemon = await startServer({ port: 0, host: '127.0.0.1', returnServer: true }) as typeof daemon;
    const request = async (route: string, body?: unknown, method = 'POST', signal: AbortSignal | null = null) => {
      const response = await fetch(daemon!.url + route, { method, signal,
        headers: { 'content-type': 'application/json', 'x-od-analytics-device-id': 'claude-startup-test', 'x-od-analytics-session-id': 'claude-startup-session', 'x-od-analytics-client-type': 'web' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok).toBe(true);
      return response.json() as Promise<Record<string, unknown>>;
    };
    boundary.phase = 'save-config';
    await request('/api/app-config', { agentId: 'claude', agentCliEnv: { claude: { CLAUDE_BIN: cli, CLAUDE_CONFIG_DIR: home } }, telemetry: { metrics: false, content: false, artifactManifest: false }, privacyDecisionAt: Date.now() }, 'PUT');
    const projectId = `claude-startup-${randomUUID()}`;
    boundary.phase = 'create-project';
    const project = await request('/api/projects', { id: projectId, name: 'Claude startup cancellation', conversationMode: 'chat', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true });
    boundary.phase = 'create-run';
    const run = await request('/api/runs', { projectId, conversationId: project.conversationId, assistantMessageId: `assistant-${randomUUID()}`, clientRequestId: `request-${randomUUID()}`, agentId: 'claude', message: 'Read browser', currentPrompt: 'Read browser' });
    boundary.taskExecutionPresent = typeof run.taskExecutionId === 'string';
    boundary.phase = 'wait-prepared';
    const controller = new AbortController();
    const endedBeforePreparation = fetch(`${daemon!.url}/api/runs/${run.runId}/events`, { signal: controller.signal }).then(response => response.text()).then(async () => {
      const state = await request(`/api/runs/${run.runId}`, undefined, 'GET', controller.signal);
      const code = typeof state.errorCode === 'string' && /^[A-Z_]{1,64}$/u.test(state.errorCode) ? state.errorCode : 'NONE';
      throw new Error(`Run ended before preparation: ${state.status}, ${code}, mcpFlag=${agentCapabilities.get('claude')?.mcpConfig === true}`);
    });
    preparationWatcher = { controller, settled: endedBeforePreparation };
    let configPath: string;
    try {
      configPath = await Promise.race([prepared, endedBeforePreparation]);
    } finally {
      await stopPreparationWatcher();
    }
    expect(fs.existsSync(configPath)).toBe(true);
    boundary.phase = 'cancel';
    await request(`/api/runs/${run.runId}/cancel`, {});
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fs.existsSync(configPath)).toBe(false);
    expect(boundary.runSpawns).toBe(0);
    expect(grants.length).toBeGreaterThan(0);
    for (const { registry, grant } of grants) expect(registry.validate(grant.token, { endpoint: '/mcp' }).ok).toBe(false);
    expect((await request(`/api/runs/${run.runId}`, undefined, 'GET')).status).toBe('canceled');
    boundary.phase = 'complete';
  });
});

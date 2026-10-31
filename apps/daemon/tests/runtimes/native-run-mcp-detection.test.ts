import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../src/runtimes/launch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtimes/launch.js')>();
  return { ...actual, resolveAgentLaunch: vi.fn(() => ({ selectedPath: null, launchPath: null })) };
});

import { codexAgentDef } from '../../src/runtimes/defs/codex.js';
import { detectAgent } from '../../src/runtimes/detection.js';
import { resolveAgentLaunch } from '../../src/runtimes/launch.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('serializes selected Codex MCP metadata without probing or mutating the rollback definition', async () => {
  for (const [transport, expected] of [['app-server', 'codex-thread-config'], ['exec-json', undefined], ['auto', undefined]]) {
    vi.stubEnv('OD_CODEX_TRANSPORT', transport!);
    const detected = await detectAgent(codexAgentDef);
    expect(detected.available).toBe(false);
    expect(detected.externalMcpInjection).toBe(expected);
    expect(codexAgentDef).not.toHaveProperty('externalMcpInjection');
  }
  expect(resolveAgentLaunch).toHaveBeenCalledTimes(3);
});

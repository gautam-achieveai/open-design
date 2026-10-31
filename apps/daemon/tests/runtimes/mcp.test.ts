import { test } from 'vitest';

import { AGENT_DEFS, assert, buildLiveArtifactsMcpServersForAgent, hermes, kimi } from './helpers/test-helpers.js';

test('live artifact MCP discovery is limited to mature ACP agents', () => {
  for (const agent of AGENT_DEFS) {
    const server = buildLiveArtifactsMcpServersForAgent(agent);
    if (agent.mcpDiscovery !== 'mature-acp') {
      assert.deepEqual(server, []);
      continue;
    }
    assert.equal(server.length, 1);
    const s = server[0];
    if (!s) throw new Error('unreachable: server length verified as 1 above');
    assert.equal(s.name, 'open-design-live-artifacts');
    assert.equal(s.command, 'od');
    assert.deepEqual(s.args, ['mcp', 'live-artifacts']);
    const envIsMap =
      typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env);
    const envIsArray = Array.isArray(s.env);
    assert.ok(envIsArray || envIsMap, `env must be array or map, got ${typeof s.env}`);
    if (envIsArray) {
      assert.deepEqual(s.env, [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]);
    }
    if (envIsMap) {
      assert.deepEqual(s.env, { ELECTRON_RUN_AS_NODE: '1' });
    }
  }
});

test('live artifact MCP discovery is disabled when run-scoped tool auth is unavailable', () => {
  assert.deepEqual(buildLiveArtifactsMcpServersForAgent(hermes, { enabled: false }), []);
});

test('Kimi retains ACP live-artifacts and external MCP wiring', () => {
  assert.equal(kimi.mcpDiscovery, 'mature-acp');
  assert.equal(kimi.externalMcpInjection, 'acp-merge');
  assert.deepEqual(buildLiveArtifactsMcpServersForAgent(kimi), [
    {
      name: 'open-design-live-artifacts',
      command: 'od',
      args: ['mcp', 'live-artifacts'],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    },
  ]);
});

test('live artifact MCP discovery can use daemon-resolved CLI command', () => {
  assert.deepEqual(
    buildLiveArtifactsMcpServersForAgent(hermes, {
      command: process.execPath,
      argsPrefix: ['/workspace/apps/daemon/dist/cli.js'],
    } as unknown as Parameters<typeof buildLiveArtifactsMcpServersForAgent>[1]),
    [
      {
        name: 'open-design-live-artifacts',
        command: process.execPath,
        args: ['/workspace/apps/daemon/dist/cli.js', 'mcp', 'live-artifacts'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
      },
    ],
  );
});

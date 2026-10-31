import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  AGENT_SLUGS,
  applyJsonInstall,
  isAgentSlug,
  planAgentInstall,
  planHttpAgentInstall,
  httpMcpUrlFromDaemonOrigin,
  removeJsonInstall,
  type JsonInstallPlan,
  type McpLaunchSpec,
} from '../src/mcp-agent-install.js';

const SPEC: McpLaunchSpec = {
  command: '/usr/local/bin/node',
  args: ['/opt/open-design/cli.js', 'mcp', '--daemon-url', 'http://127.0.0.1:7456'],
  env: { OD_DATA_DIR: '/home/u/.open-design' },
};

const SPEC_NO_ENV: McpLaunchSpec = { ...SPEC, env: {} };

const ctx = (platform: NodeJS.Platform = 'linux') => ({
  home: '/home/u',
  platform,
  serverName: 'open-design',
});

describe('agent slug guard', () => {
  it('accepts every documented slug and rejects others', () => {
    for (const s of AGENT_SLUGS) expect(isAgentSlug(s)).toBe(true);
    expect(isAgentSlug('not-an-agent')).toBe(false);
    expect(AGENT_SLUGS).toHaveLength(17);
    expect(isAgentSlug('kiro')).toBe(true);
    expect(isAgentSlug('reasonix')).toBe(true);
    expect(isAgentSlug('raven')).toBe(true);
  });
});

describe('CLI-driven agents', () => {
  it('plans Codex HTTP with only an environment-variable name and preserves stdio planning', () => {
    const plan = planHttpAgentInstall('codex', { url: 'http://127.0.0.1:7456/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' }, ctx());
    expect(plan).toEqual({
      kind: 'cli', slug: 'codex', bin: 'codex',
      addArgv: ['mcp', 'add', 'open-design', '--url', 'http://127.0.0.1:7456/mcp', '--bearer-token-env-var', 'OD_MCP_TOKEN'],
      getArgv: ['mcp', 'get', 'open-design'], removeArgv: ['mcp', 'remove', 'open-design'],
    });
    expect(planAgentInstall('codex', SPEC_NO_ENV, ctx())).toMatchObject({
      kind: 'cli', addArgv: ['mcp', 'add', 'open-design', '--', SPEC_NO_ENV.command, ...SPEC_NO_ENV.args],
    });
    expect(planHttpAgentInstall('codex', { url: 'http://[::1]:7456/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' }, ctx()).addArgv).toContain('http://[::1]:7456/mcp');
  });

  it('fails closed for unverified agents, nonlocal URLs and credential-like inputs without echoing them', () => {
    const safe = { url: 'http://127.0.0.1:7456/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' };
    expect(planHttpAgentInstall('cursor', safe, ctx())).toMatchObject({ kind: 'manual', snippet: '' });
    for (const url of [
      'http://example.invalid/mcp', 'https://127.0.0.1/mcp', 'http://localhost/mcp',
      'http://127.0.0.1/mcp?token=synthetic-secret', 'http://127.0.0.1/mcp?',
      'http://127.0.0.1/mcp#synthetic-secret', 'http://user:synthetic-secret@127.0.0.1/mcp',
      'http://127.0.0.1/not-mcp',
    ]) {
      expect(() => planHttpAgentInstall('codex', { ...safe, url }, ctx())).toThrow('invalid local HTTP MCP URL');
      try { planHttpAgentInstall('codex', { ...safe, url }, ctx()); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
    }
    for (const bearerTokenEnvVar of ['odmcp_synthetic_secret', 'odtt_synthetic_secret', 'bad-name', 'BAD=VALUE', '']) {
      expect(() => planHttpAgentInstall('codex', { ...safe, bearerTokenEnvVar }, ctx())).toThrow('invalid bearer environment variable name');
    }
    expect(() => planHttpAgentInstall('codex', safe, { ...ctx(), serverName: '--malicious' })).toThrow('invalid MCP server name');
  });

  it('rejects recognized token prefixes embedded in every caller-controlled HTTP plan output field', () => {
    const safe = { url: 'http://127.0.0.1:7456/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' };
    for (const token of ['odtt_synthetic_secret', 'odmcp_synthetic_secret']) {
      const cases = [
        { spec: safe, context: { ...ctx(), serverName: `prefix-${token}` }, message: 'invalid MCP server name' },
        { spec: { ...safe, bearerTokenEnvVar: `PREFIX_${token.toUpperCase()}` }, context: ctx(), message: 'invalid bearer environment variable name' },
        { spec: { ...safe, url: `http://127.0.0.1:7456/mcp?x=${token}` }, context: ctx(), message: 'invalid local HTTP MCP URL' },
        { spec: { ...safe, url: `http://${token}@127.0.0.1:7456/mcp` }, context: ctx(), message: 'invalid local HTTP MCP URL' },
      ];
      for (const test of cases) {
        try {
          planHttpAgentInstall('codex', test.spec, test.context);
          throw new Error('expected token-bearing input to be rejected');
        } catch (error) {
          expect(String(error)).toBe(`Error: ${test.message}`);
          expect(String(error).toLowerCase()).not.toContain(token.toLowerCase());
        }
      }
    }
    // The accepted names appear in every relevant argv list; no input token
    // can reach add, remove, or get, and valid env-var names still work.
    const plan = planHttpAgentInstall('codex', safe, { ...ctx(), serverName: 'test-server' });
    expect(plan.addArgv).toContain('test-server');
    expect(plan.removeArgv).toContain('test-server');
    expect(plan.getArgv).toContain('test-server');
    expect(plan.addArgv).toContain('OD_MCP_TOKEN');
    expect(JSON.stringify(plan)).not.toMatch(/odtt_|odmcp_/i);
  });

  it('claude registers via `claude mcp add --scope user` with env flags', () => {
    const plan = planAgentInstall('claude', SPEC, ctx());
    expect(plan.kind).toBe('cli');
    if (plan.kind !== 'cli') throw new Error('expected cli');
    expect(plan.bin).toBe('claude');
    expect(plan.addArgv).toEqual([
      'mcp', 'add', '--scope', 'user',
      'open-design',
      '-e', 'OD_DATA_DIR=/home/u/.open-design',
      '--',
      SPEC.command, ...SPEC.args,
    ]);
    expect(plan.removeArgv).toEqual(['mcp', 'remove', '--scope', 'user', 'open-design']);
  });

  it('codex uses --env and a -- separator', () => {
    const plan = planAgentInstall('codex', SPEC, ctx());
    if (plan.kind !== 'cli') throw new Error('expected cli');
    expect(plan.addArgv).toContain('--env');
    expect(plan.addArgv).toContain('OD_DATA_DIR=/home/u/.open-design');
    expect(plan.addArgv.slice(-SPEC.args.length - 2)).toEqual(['--', SPEC.command, ...SPEC.args]);
  });

  it('reasonix uses its native mcp add/remove/get commands', () => {
    const plan = planAgentInstall('reasonix', SPEC, ctx());
    if (plan.kind !== 'cli') throw new Error('expected cli');
    expect(plan.bin).toBe('reasonix');
    expect(plan.addArgv).toEqual([
      'mcp', 'add', 'open-design',
      '--env', 'OD_DATA_DIR=/home/u/.open-design',
      SPEC.command, ...SPEC.args,
    ]);
    expect(plan.removeArgv).toEqual(['mcp', 'remove', 'open-design']);
    expect(plan.getArgv).toEqual(['mcp', 'get', 'open-design']);
  });

});

describe('JSON-config agents', () => {
  it('plans documented HTTP auth references without reading their values and preserves conflicts', () => {
    const spec = { url: 'http://127.0.0.1:45678/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' };
    const claude = planHttpAgentInstall('claude', spec, ctx());
    expect(claude.addArgv).toContain('Authorization: Bearer ${OD_MCP_TOKEN}');
    const entries = {
      kimi: { url: spec.url, bearerTokenEnvVar: 'OD_MCP_TOKEN' },
      opencode: { type: 'remote', url: spec.url, enabled: true, oauth: false,
        headers: { Authorization: 'Bearer {env:OD_MCP_TOKEN}' } },
      kiro: { url: spec.url, headers: { Authorization: 'Bearer ${OD_MCP_TOKEN}' } },
    };
    for (const slug of ['kimi', 'opencode', 'kiro'] as const) {
      const plan = planHttpAgentInstall(slug, spec, ctx());
      if (plan.kind !== 'json') throw new Error('expected JSON HTTP plan');
      expect(plan.entry).toEqual(entries[slug]);
      const previous = JSON.stringify({ keep: true, [plan.keyPath[0]!]: { unrelated: { enabled: true } } });
      const merged = applyJsonInstall(previous, plan);
      expect(JSON.parse(merged).keep).toBe(true);
      expect(JSON.parse(merged)[plan.keyPath[0]!].unrelated).toEqual({ enabled: true });
      expect(applyJsonInstall(merged, plan)).toBe(merged);
      const changed = { ...plan, entry: { url: 'http://127.0.0.1:45679/mcp' } };
      expect(() => applyJsonInstall(merged, changed)).toThrow('already configured differently');
      expect(() => applyJsonInstall(JSON.stringify({ [plan.keyPath[0]!]: [] }), plan)).toThrow('not an object');
    }
    const kimi = planHttpAgentInstall('kimi', spec, { ...ctx(), kimiCodeHome: path.join('/selected', 'kimi') });
    expect(kimi).toMatchObject({ configPath: path.join('/selected', 'kimi', 'mcp.json') });
  });

  it('accepts only numeric loopback origins and never echoes credentials from invalid config', () => {
    expect(httpMcpUrlFromDaemonOrigin('http://127.0.0.1:45678')).toBe('http://127.0.0.1:45678/mcp');
    expect(httpMcpUrlFromDaemonOrigin('http://[::1]:45678/')).toBe('http://[::1]:45678/mcp');
    for (const origin of ['https://127.0.0.1:45678', 'http://localhost:45678', 'http://example.invalid',
      'http://127.0.0.1:45678/path', 'http://127.0.0.1:45678/?token=private-value', 'http://user:private-value@127.0.0.1:45678']) {
      expect(() => httpMcpUrlFromDaemonOrigin(origin)).toThrow('invalid local daemon origin');
    }
    const plan = planHttpAgentInstall('opencode', { url: 'http://127.0.0.1:45678/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' }, ctx());
    if (plan.kind !== 'json') throw new Error('expected JSON HTTP plan');
    try {
      applyJsonInstall('private-value', plan);
      throw new Error('expected invalid JSON');
    } catch (error) {
      expect(String(error)).toContain('not valid JSON');
      expect(String(error)).not.toContain('private-value');
    }
  });

  it('cursor merges a stdio entry under mcpServers', () => {
    const plan = planAgentInstall('cursor', SPEC, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.configPath).toBe(path.join('/home/u', '.cursor', 'mcp.json'));
    expect(plan.keyPath).toEqual(['mcpServers']);
    expect(plan.entry).toEqual({
      command: SPEC.command,
      args: SPEC.args,
      type: 'stdio',
      env: SPEC.env,
    });
  });

  it('opencode folds command+args into one array under `mcp` and uses `environment`', () => {
    const plan = planAgentInstall('opencode', SPEC, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.keyPath).toEqual(['mcp']);
    expect(plan.entry).toEqual({
      type: 'local',
      command: [SPEC.command, ...SPEC.args],
      enabled: true,
      environment: SPEC.env,
    });
  });

  it('openclaw nests under mcp.servers', () => {
    const plan = planAgentInstall('openclaw', SPEC_NO_ENV, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.keyPath).toEqual(['mcp', 'servers']);
    expect(plan.entry).toEqual({ command: SPEC.command, args: SPEC.args });
  });

  it('kiro merges a stdio entry into the user MCP settings file', () => {
    const plan = planAgentInstall('kiro', SPEC, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.configPath).toBe(path.join('/home/u', '.kiro', 'settings', 'mcp.json'));
    expect(plan.keyPath).toEqual(['mcpServers']);
    expect(plan.serverKey).toBe('open-design');
    expect(plan.entry).toEqual({
      command: SPEC.command,
      args: SPEC.args,
      env: SPEC.env,
    });
  });

  it('raven plans a stdio entry under tools.mcpServers', () => {
    const plan = planAgentInstall('raven', SPEC, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.configPath).toBe(path.join('/home/u', '.raven', 'config.json'));
    expect(plan.keyPath).toEqual(['tools', 'mcpServers']);
    expect(plan.serverKey).toBe('open-design');
    expect(plan.entry).toEqual({
      command: SPEC.command,
      args: SPEC.args,
      type: 'stdio',
      env: SPEC.env,
    });
  });

  it('raven keeps the env field when no environment variables are needed', () => {
    const plan = planAgentInstall('raven', SPEC_NO_ENV, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.entry).toEqual({
      command: SPEC.command,
      args: SPEC.args,
      type: 'stdio',
      env: {},
    });
  });

  it('raven install and removal preserve existing config and sibling servers', () => {
    const plan = planAgentInstall('raven', SPEC, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    const existing = JSON.stringify({
      theme: 'dark',
      tools: { mcpServers: { existing: { command: 'existing-command' } } },
    });

    const installed = JSON.parse(applyJsonInstall(existing, plan));
    expect(installed.theme).toBe('dark');
    expect(installed.tools.mcpServers.existing).toEqual({ command: 'existing-command' });
    expect(installed.tools.mcpServers['open-design']).toEqual(plan.entry);

    const removed = removeJsonInstall(JSON.stringify(installed), plan);
    expect(removed).not.toBeNull();
    expect(JSON.parse(removed ?? '{}')).toEqual(JSON.parse(existing));
  });

  it('omits env entirely when the launch spec has no env', () => {
    const plan = planAgentInstall('cursor', SPEC_NO_ENV, ctx());
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.entry).not.toHaveProperty('env');
  });

  it('cline path is OS-specific', () => {
    const mac = planAgentInstall('cline', SPEC, ctx('darwin'));
    const linux = planAgentInstall('cline', SPEC, ctx('linux'));
    if (mac.kind !== 'json' || linux.kind !== 'json') throw new Error('expected json');
    expect(mac.configPath).toContain(path.join('Library', 'Application Support', 'Code', 'User'));
    expect(linux.configPath).toContain(path.join('.config', 'Code', 'User'));
    expect(mac.configPath).toContain('saoudrizwan.claude-dev');
  });

  it('claude-desktop on macOS writes to Library/Application Support/Claude', () => {
    const plan = planAgentInstall('claude-desktop', SPEC, ctx('darwin'));
    if (plan.kind !== 'json') throw new Error('expected json');
    expect(plan.configPath).toBe(path.join('/home/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(plan.keyPath).toEqual(['mcpServers']);
    expect(plan.serverKey).toBe('open-design');
    expect(plan.entry).toEqual({
      command: SPEC.command,
      args: SPEC.args,
      type: 'stdio',
      env: SPEC.env,
    });
  });

  it('claude-desktop on Linux returns manual plan (unsupported platform)', () => {
    const plan = planAgentInstall('claude-desktop', SPEC, ctx('linux'));
    expect(plan.kind).toBe('manual');
    if (plan.kind !== 'manual') throw new Error('expected manual');
    expect(plan.configPath).toBeNull();
    expect(plan.reason).toContain('Automatic MCP configuration');
  });
});

describe('manual (unverified) agents', () => {
  it('pi / vibe / hermes never produce a writable plan', () => {
    for (const slug of ['pi', 'vibe', 'hermes'] as const) {
      const plan = planAgentInstall(slug, SPEC, ctx());
      expect(plan.kind).toBe('manual');
      if (plan.kind !== 'manual') throw new Error('expected manual');
      expect(plan.snippet.length).toBeGreaterThan(0);
      expect(plan.reason.length).toBeGreaterThan(0);
    }
  });

  it('vibe snippet is TOML array-of-tables', () => {
    const plan = planAgentInstall('vibe', SPEC, ctx());
    if (plan.kind !== 'manual') throw new Error('expected manual');
    expect(plan.format).toBe('toml');
    expect(plan.snippet).toContain('[[mcp_servers]]');
    expect(plan.snippet).toContain('transport = "stdio"');
  });
});

describe('applyJsonInstall', () => {
  const plan = planAgentInstall('cursor', SPEC, ctx()) as JsonInstallPlan;

  it('creates the file structure from empty input', () => {
    const out = applyJsonInstall(null, plan);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers['open-design'].command).toBe(SPEC.command);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves unrelated keys and sibling servers', () => {
    const existing = JSON.stringify({
      editor: { theme: 'dark' },
      mcpServers: { 'other-server': { command: 'foo' } },
    });
    const out = JSON.parse(applyJsonInstall(existing, plan));
    expect(out.editor).toEqual({ theme: 'dark' });
    expect(out.mcpServers['other-server']).toEqual({ command: 'foo' });
    expect(out.mcpServers['open-design'].type).toBe('stdio');
  });

  it('is idempotent — re-applying yields the same content', () => {
    const once = applyJsonInstall(null, plan);
    const twice = applyJsonInstall(once, plan);
    expect(twice).toBe(once);
  });

  it('throws on an unparseable existing config rather than clobbering it', () => {
    expect(() => applyJsonInstall('{not json', plan)).toThrow(/not valid JSON/);
  });
});

describe('removeJsonInstall', () => {
  const plan = planAgentInstall('cursor', SPEC, ctx()) as JsonInstallPlan;

  it('removes only the open-design entry', () => {
    const existing = applyJsonInstall(
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      plan,
    );
    const out = JSON.parse(removeJsonInstall(existing, plan)!);
    expect(out.mcpServers).not.toHaveProperty('open-design');
    expect(out.mcpServers.other).toEqual({ command: 'x' });
  });

  it('returns null when there is nothing to remove', () => {
    expect(removeJsonInstall(null, plan)).toBeNull();
    expect(removeJsonInstall('{}', plan)).toBeNull();
    expect(removeJsonInstall(JSON.stringify({ mcpServers: {} }), plan)).toBeNull();
  });
});

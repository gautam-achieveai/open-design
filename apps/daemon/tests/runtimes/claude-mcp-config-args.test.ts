import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  importedProjectClaudeMcpConfigPath,
  prepareImportedProjectClaudeMcpConfig,
  type McpServerConfig,
} from '../../src/mcp-config.js';

/**
 * Imported-folder Claude runs cannot get OD's external MCP servers through a
 * cwd `.mcp.json` (the cwd is the user's own repo), so the daemon writes the
 * same JSON under its data root and passes `--mcp-config <file>`. The flag is
 * additive: `--strict-mcp-config` must never ride along, or the user's own
 * Claude MCP config would stop loading.
 */
describe('claude buildArgs --mcp-config', () => {
  afterEach(() => {
    agentCapabilities.delete('claude');
  });

  it('passes the daemon-owned MCP config file when the CLI advertises the flag', () => {
    agentCapabilities.set('claude', { mcpConfig: true });
    const args = claudeAgentDef.buildArgs('p', [], [], {}, { mcpConfigPath: '/data/claude-mcp-config/p1.json' });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/data/claude-mcp-config/p1.json');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('keeps --add-dir values separate from the variadic --mcp-config value', () => {
    agentCapabilities.set('claude', { mcpConfig: true, addDir: true });
    const args = claudeAgentDef.buildArgs('p', [], ['/skills'], {}, { mcpConfigPath: '/m.json' });
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 4))
      .toEqual(['--add-dir', '/skills', '--mcp-config', '/m.json']);
  });

  it('omits the flag without a path, or when the probe did not confirm support', () => {
    agentCapabilities.set('claude', { mcpConfig: true });
    expect(claudeAgentDef.buildArgs('p', [], [], {}, {})).not.toContain('--mcp-config');
    agentCapabilities.set('claude', { mcpConfig: false });
    expect(claudeAgentDef.buildArgs('p', [], [], {}, { mcpConfigPath: '/m.json' })).not.toContain('--mcp-config');
    agentCapabilities.delete('claude');
    expect(claudeAgentDef.buildArgs('p', [], [], {}, { mcpConfigPath: '/m.json' })).not.toContain('--mcp-config');
  });

  it('probes --mcp-config from the help text', () => {
    expect(claudeAgentDef.capabilityFlags?.['--mcp-config']).toBe('mcpConfig');
  });
});

describe('prepareImportedProjectClaudeMcpConfig', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const stdioServer: McpServerConfig = {
    id: 'fs',
    label: 'fs',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', 'server-filesystem'],
  };

  it('writes the Claude MCP JSON under the data root, then removes it once nothing is enabled', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-claude-mcp-'));
    roots.push(dataDir);

    const file = await prepareImportedProjectClaudeMcpConfig({ dataDir, projectId: 'p1', servers: [stdioServer] });

    expect(file).toBe(path.join(dataDir, 'claude-mcp-config', 'p1.json'));
    expect(JSON.parse(await readFile(file!, 'utf8'))).toEqual({
      mcpServers: { fs: { command: 'npx', args: ['-y', 'server-filesystem'] } },
    });

    const none = await prepareImportedProjectClaudeMcpConfig({
      dataDir,
      projectId: 'p1',
      servers: [{ ...stdioServer, enabled: false }],
    });

    expect(none).toBeNull();
    await expect(stat(file!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses project ids that could escape the data root', () => {
    expect(() => importedProjectClaudeMcpConfigPath(path.resolve('/data'), '../x')).toThrow('invalid project id');
    expect(() => importedProjectClaudeMcpConfigPath('relative', 'p1')).toThrow('absolute');
  });
});

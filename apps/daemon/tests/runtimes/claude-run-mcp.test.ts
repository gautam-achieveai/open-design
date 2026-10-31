import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareClaudeRunMcpConfig, reassertClaudeRunEnvironment } from '../../src/runtimes/mcp.js';

describe('Claude run MCP launch contract', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

  it('uses unique daemon files, retains external servers and cleans only its attempt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-claude-mcp-'));
    roots.push(root);
    const projectDir = path.join(root, 'project');
    await fs.mkdir(projectDir);
    const original = JSON.stringify({ mcpServers: { user: { command: 'user-command' } } });
    await fs.writeFile(path.join(projectDir, '.mcp.json'), original);
    const options = { dataDir: path.join(root, 'data'), daemonUrl: 'http://127.0.0.1:1234', projectDir,
      externalConfig: { mcpServers: { stdio: { command: 'external' }, http: { type: 'http', url: 'http://127.0.0.1:5678' } } } };
    const [first, second] = await Promise.all([prepareClaudeRunMcpConfig(options), prepareClaudeRunMcpConfig(options)]);
    expect(first.path).not.toBe(second.path);
    expect(path.relative(options.dataDir, first.path).startsWith('..')).toBe(false);
    const content = JSON.parse(await fs.readFile(first.path, 'utf8'));
    expect(content.mcpServers['open-design-run']).toEqual({ type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer ${OD_TOOL_TOKEN}' } });
    expect(content.mcpServers.stdio.command).toBe('external');
    expect(content.mcpServers.http.url).toBe('http://127.0.0.1:5678');
    first.cleanup();
    await expect(fs.readFile(second.path, 'utf8')).resolves.toBeTruthy();
    expect(await fs.readFile(path.join(projectDir, '.mcp.json'), 'utf8')).toBe(original);
    second.cleanup();
    await fs.writeFile(path.join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'open-design-run': {} } }));
    await expect(prepareClaudeRunMcpConfig(options)).rejects.toThrow('reserved');
  });

  it('reasserts pinned authority after case-insensitive overlays and removes broad API credentials', () => {
    const env = { od_tool_token: 'wrong', OD_TOOL_TOKEN: 'also-wrong', od_daemon_url: 'wrong', Od_Api_Token: 'broad' };
    reassertClaudeRunEnvironment(env, { OD_TOOL_TOKEN: 'synthetic-final', OD_DAEMON_URL: 'http://127.0.0.1:1234', OD_PROJECT_ID: 'pinned' });
    expect(env).toEqual({ OD_TOOL_TOKEN: 'synthetic-final', OD_DAEMON_URL: 'http://127.0.0.1:1234', OD_PROJECT_ID: 'pinned' });
  });
});

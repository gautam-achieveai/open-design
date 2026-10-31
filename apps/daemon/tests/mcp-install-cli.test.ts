import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

async function runCli(args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
}

describe('od mcp install CLI identity probe', () => {
  it('emits a stable identity token without requiring an agent slug', async () => {
    const result = await runCli(['mcp', 'install', '--open-design-cli-probe']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('open-design-cli:mcp-install:v1\n');
  });

  it('includes the resolved launch spec in JSON dry-run output', async () => {
    const launchSpec = {
      command: '/opt/open-design/runtime',
      args: ['/opt/open-design/daemon-cli.mjs', 'mcp'],
      env: { OD_DATA_DIR: '/tmp/open-design-data' },
    };
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(launchSpec));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const result = await runCli([
        'mcp',
        'install',
        'codex',
        '--transport',
        'stdio',
        '--print',
        '--json',
        '--daemon-url',
        `http://127.0.0.1:${address.port}`,
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        agent: 'codex',
        kind: 'cli',
        launchSpec,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  // Integration: the public CLI must preserve a literal client-side reference
  // through parsing and JSON output; no agent or provider is started.
  it('defaults to HTTP and prints literal argv without reading the credential value', async () => {
    const marker = 'odmcp_synthetic_installer_secret';
    const result = await runCli(['mcp', 'install', 'claude', '--print', '--json',
      '--daemon-url', 'http://127.0.0.1:45678'], { OD_MCP_TOKEN: marker });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, transport: 'http', command: 'claude',
      launchSpec: { url: 'http://127.0.0.1:45678/mcp', bearerTokenEnvVar: 'OD_MCP_TOKEN' } });
    expect(payload.args).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'open-design',
      'http://127.0.0.1:45678/mcp', '--header', 'Authorization: Bearer ${OD_MCP_TOKEN}']);
    expect(result.stdout).not.toContain(marker);
    expect(payload.next).toContain('does not set its value');
    expect(payload.next).toContain('port changes');
  });

  // Integration: only the public executable can prove install/conflict/remove
  // reach the user's JSON file without exposing unrelated stored credentials.
  it.each(['install', 'conflict', 'offline removal'])('preserves unrelated JSON settings and secrets during %s', async (phase) => {
    const prefix = pathResolve(tmpdir(), 'od-mcp-install-');
    const home = await mkdtemp(prefix);
    const config = pathResolve(home, '.config/opencode/opencode.json');
    const secret = 'synthetic-unrelated-private-value';
    const overrides = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      OD_AGENT_HOME: home, OD_DATA_DIR: pathResolve(home, 'data'), OD_DAEMON_URL: undefined };
    const baseArgs = ['mcp', 'install', 'opencode', '--json'];
    try {
      await mkdir(dirname(config), { recursive: true });
      const entry = { type: 'remote', url: 'http://127.0.0.1:45678/mcp', enabled: true, oauth: false,
        headers: { Authorization: 'Bearer {env:OD_MCP_TOKEN}' } };
      const previous = JSON.stringify({ keep: { theme: 'dark' }, mcp: { other: { headers: { secret } },
        ...(phase === 'install' ? {} : { 'open-design': entry }) } });
      await writeFile(config, previous);
      const result = await runCli([...baseArgs, ...(phase === 'offline removal' ? ['--uninstall']
        : ['--daemon-url', `http://127.0.0.1:${phase === 'conflict' ? 45679 : 45678}`])], overrides);
      expect(result.code).toBe(phase === 'conflict' ? 1 : 0);
      const registered = await readFile(config, 'utf8');
      expect(JSON.parse(registered).keep).toEqual({ theme: 'dark' });
      expect(JSON.parse(registered).mcp.other).toEqual({ headers: { secret } });
      if (phase === 'install') expect(JSON.parse(registered).mcp['open-design']).toEqual(entry);
      else if (phase === 'conflict') expect(registered).toBe(previous);
      else expect(JSON.parse(registered).mcp).not.toHaveProperty('open-design');
      expect(result.stdout + result.stderr).not.toContain(secret);
    } finally {
      if (!pathResolve(home).startsWith(prefix)) throw new Error('Unexpected test home');
      await rm(home, { recursive: true, force: true });
    }
  });

  // Integration: exercise actual parser and output modes without starting an agent.
  it.each([
    { json: true, input: 'agent' }, { json: false, input: 'agent' },
    { json: true, input: 'flag' }, { json: false, input: 'flag' },
  ])('does not echo invalid $input input (JSON: $json)', async ({ json, input }) => {
    const marker = 'odmcp_SYNTHETIC_REVIEW_ONLY';
    const outputFlags = json ? ['--json'] : [];
    const args = input === 'agent' ? [marker, ...outputFlags] : ['opencode', '--' + marker, ...outputFlags];
    const result = await runCli(['mcp', 'install', ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(marker);
    if (json) {
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
      expect(JSON.parse(result.stdout)).not.toHaveProperty('agent');
    }
  });

  it.each([
    { flag: '--json=true', json: true },
    { flag: '--json=false', json: false },
  ])('honors $flag on an invalid argument', async ({ flag, json }) => {
    const marker = 'odmcp_SYNTHETIC_REVIEW_ONLY';
    const result = await runCli(['mcp', 'install', 'opencode', flag, '--' + marker]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(marker);
    if (json) {
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ ok: false,
        message: 'Invalid MCP install arguments. Run od mcp install --help.' });
    } else {
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Invalid MCP install arguments. Run od mcp install --help.');
    }
  });

  // Integration: filesystem failures must remain machine-readable and preserve data.
  it.each(['malformed removal', 'rejected config write'])('returns JSON errors for %s', async (failure) => {
    const prefix = pathResolve(tmpdir(), 'od-mcp-install-errors-');
    const home = await mkdtemp(prefix);
    const config = pathResolve(home, '.config/opencode/opencode.json');
    const target = pathResolve(home, 'linked-config.json');
    const marker = 'odmcp_SYNTHETIC_REVIEW_ONLY';
    const overrides = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      OD_AGENT_HOME: home, OD_DATA_DIR: pathResolve(home, 'data') };
    const baseArgs = ['mcp', 'install', 'opencode', '--json'];
    try {
      await mkdir(dirname(config), { recursive: true });
      const original = JSON.stringify({ keep: true, mcp: {} });
      if (failure === 'malformed removal') await writeFile(config, marker);
      else {
        await writeFile(target, original);
        await symlink(target, config, 'file');
      }
      const result = await runCli([...baseArgs, ...(failure === 'malformed removal' ? ['--uninstall']
        : ['--daemon-url', 'http://127.0.0.1:45678'])], overrides);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, agent: 'opencode' });
      expect(result.stdout).not.toContain(marker);
      if (failure === 'malformed removal') expect(await readFile(config, 'utf8')).toBe(marker);
      else {
        expect(await readFile(target, 'utf8')).toBe(original);
        expect((await lstat(config)).isSymbolicLink()).toBe(true);
      }
    } finally {
      if (!pathResolve(home).startsWith(prefix)) throw new Error('Unexpected test home');
      await rm(home, { recursive: true, force: true });
    }
  });
});

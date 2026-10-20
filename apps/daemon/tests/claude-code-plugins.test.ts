import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeCodePlugins } from '../src/claude-code-plugins.js';
import { registerClaudeCodePluginRoutes } from '../src/routes/claude-code-plugins.js';

let cfg: string;

beforeEach(() => {
  cfg = mkdtempSync(path.join(os.tmpdir(), 'od-claude-plugins-'));
});

afterEach(() => {
  rmSync(cfg, { recursive: true, force: true });
});

function write(rel: string, content: string | object): void {
  const file = path.join(cfg, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

/** A config dir shaped like a real Claude Code install (v2 registry). */
function seedValidConfig(): void {
  write('plugins/known_marketplaces.json', {
    'gh-market': {
      source: { source: 'github', repo: 'owner/repo' },
      installLocation: path.join(cfg, 'plugins', 'marketplaces', 'gh-market'),
    },
    'git-market': { source: { source: 'git', url: 'https://example.com/skills.git' } },
    'dir-market': { source: { source: 'directory', path: 'B:\\plugins' } },
    'odd-market': { source: { source: 'npm', package: 'x' } },
  });
  const devRoot = path.join(cfg, 'plugins', 'cache', 'gh-market', 'dev', '1.0.0');
  const docsRoot = path.join(cfg, 'plugins', 'cache', 'gh-market', 'shared', 'abc');
  write('plugins/installed_plugins.json', {
    version: 2,
    plugins: {
      'dev@gh-market': [
        { scope: 'project', installPath: path.join(cfg, 'elsewhere'), version: '0.0.1' },
        { scope: 'user', installPath: devRoot, version: '1.0.0' },
      ],
      'docs@gh-market': [{ scope: 'user', installPath: docsRoot, version: 'abc' }],
      'gone@gh-market': [{ scope: 'user', installPath: path.join(cfg, 'missing'), version: '9' }],
    },
  });
  write('settings.json', {
    enabledPlugins: { 'dev@gh-market': true, 'docs@gh-market': false, 'builtin-thing@builtin': true },
  });

  const devRel = path.relative(cfg, devRoot);
  write(`${devRel}/.claude-plugin/plugin.json`, {
    name: 'dev',
    description: 'Dev workflows',
    version: '1.0.1',
  });
  write(`${devRel}/skills/brainstorm/SKILL.md`, '---\nname: brainstorm\ndescription: >\n  Folded description.\n---\n# Body\n');
  write(`${devRel}/skills/plan/SKILL.md`, 'no frontmatter here');
  mkdirSync(path.join(devRoot, 'skills', 'not-a-skill'), { recursive: true });
  write(`${devRel}/commands/ship.md`, '# ship');
  write(`${devRel}/commands/notes.txt`, 'ignored');
  write(`${devRel}/agents/architect.md`, '# architect');

  // A `strict: false` plugin whose skill list comes from the marketplace
  // manifest, sharing a root with sibling skills it does not own.
  const docsRel = path.relative(cfg, docsRoot);
  write(`${docsRel}/skills/pdf/SKILL.md`, '---\nname: pdf\ndescription: PDF tools\n---\n');
  write(`${docsRel}/skills/art/SKILL.md`, '---\nname: art\n---\n');
  write('plugins/marketplaces/gh-market/.claude-plugin/marketplace.json', {
    plugins: [
      { name: 'docs', description: 'Docs from marketplace', skills: ['./skills/pdf', '../../escape'] },
    ],
  });
}

describe('readClaudeCodePlugins', () => {
  it('reads marketplaces, installs, enabled flags, and plugin contents', async () => {
    seedValidConfig();
    const result = await readClaudeCodePlugins(cfg);

    expect(result.available).toBe(true);
    expect(result.configDir).toBe(cfg);
    expect(result.marketplaces).toEqual([
      { name: 'dir-market', sourceKind: 'directory', sourceLabel: 'B:\\plugins' },
      { name: 'gh-market', sourceKind: 'github', sourceLabel: 'owner/repo' },
      { name: 'git-market', sourceKind: 'git', sourceLabel: 'https://example.com/skills.git' },
      { name: 'odd-market', sourceKind: 'unknown', sourceLabel: 'npm' },
    ]);

    const byId = new Map(result.plugins.map((p) => [p.id, p]));
    expect([...byId.keys()]).toEqual([
      'builtin-thing@builtin',
      'dev@gh-market',
      'docs@gh-market',
      'gone@gh-market',
    ]);

    const dev = byId.get('dev@gh-market')!;
    expect(dev).toMatchObject({
      name: 'dev',
      marketplace: 'gh-market',
      version: '1.0.1',
      enabled: true,
      description: 'Dev workflows',
      commands: ['ship'],
      agents: ['architect'],
    });
    expect(dev.installPath).toContain(path.join('dev', '1.0.0'));
    expect(dev.skills).toEqual([
      { name: 'brainstorm', description: 'Folded description.' },
      { name: 'plan' },
    ]);

    const docs = byId.get('docs@gh-market')!;
    expect(docs.enabled).toBe(false);
    expect(docs.description).toBe('Docs from marketplace');
    expect(docs.skills).toEqual([{ name: 'pdf', description: 'PDF tools' }]);

    // Enabled in settings but never installed: listed, with no install path.
    expect(byId.get('builtin-thing@builtin')).toEqual({
      id: 'builtin-thing@builtin',
      name: 'builtin-thing',
      marketplace: 'builtin',
      enabled: true,
      skills: [],
      commands: [],
      agents: [],
    });

    expect(byId.get('gone@gh-market')!.enabled).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('gone@gh-market: install path not found'),
      expect.stringContaining('"../../escape" is outside the plugin'),
    ]));
    expect(result.warnings).toHaveLength(2);
  });

  it('reads a plugin-root SKILL.md as a skill', async () => {
    const root = path.join(cfg, 'plugins', 'cache', 'm', 'solo', '1');
    write('plugins/installed_plugins.json', { version: 2, plugins: { 'solo@m': [{ installPath: root }] } });
    write(`${path.relative(cfg, root)}/SKILL.md`, '---\ndescription: Single skill\n---\n');
    const result = await readClaudeCodePlugins(cfg);
    expect(result.plugins[0]!.skills).toEqual([{ name: 'solo', description: 'Single skill' }]);
  });

  it('accepts the v1 registry shape (one install object per id)', async () => {
    write('plugins/installed_plugins.json', {
      version: 1,
      plugins: { 'one@m': { installPath: path.join(cfg, 'nope'), version: '2.0.0' } },
    });
    const result = await readClaudeCodePlugins(cfg);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({ id: 'one@m', version: '2.0.0', enabled: false });
  });

  it('reports available:false with empty lists when no registry files exist', async () => {
    write('settings.json', { enabledPlugins: { 'x@y': true } });
    const result = await readClaudeCodePlugins(cfg);
    expect(result).toEqual({ available: false, configDir: cfg, marketplaces: [], plugins: [], warnings: [] });
  });

  it('reports available:false for a config dir that does not exist', async () => {
    const result = await readClaudeCodePlugins(path.join(cfg, 'absent'));
    expect(result.available).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('turns malformed JSON into warnings instead of throwing', async () => {
    write('plugins/known_marketplaces.json', '{ not json');
    write('plugins/installed_plugins.json', { version: 2, plugins: { 'bad@m': 'string-entry' } });
    write('settings.json', { enabledPlugins: ['not', 'a', 'map'] });
    const result = await readClaudeCodePlugins(cfg);
    expect(result.available).toBe(true);
    expect(result.marketplaces).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid JSON'),
      expect.stringContaining('entry "bad@m" has no install record'),
      expect.stringContaining('"enabledPlugins" is not an object'),
    ]));
  });

  it('caps plugins and directory entries with a warning', async () => {
    const root = path.join(cfg, 'plugins', 'cache', 'm', 'big', '1');
    const plugins: Record<string, unknown> = { 'big@m': [{ installPath: root }] };
    for (let i = 0; i < 4; i++) plugins[`p${i}@m`] = [{ installPath: path.join(cfg, 'none') }];
    write('plugins/installed_plugins.json', { version: 2, plugins });
    for (let i = 0; i < 5; i++) write(`${path.relative(cfg, root)}/commands/c${i}.md`, '');
    const result = await readClaudeCodePlugins(cfg, {
      maxPlugins: 2,
      maxDirEntries: 3,
      maxSkillFileBytes: 1024,
    });
    expect(result.plugins.map((p) => p.id)).toEqual(['big@m', 'p0@m']);
    expect(result.plugins[0]!.commands).toEqual(['c0', 'c1', 'c2']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('5 Claude Code plugins found; showing the first 2'),
      expect.stringContaining('has 5 entries; showing the first 3'),
    ]));
  });
});

describe('GET /api/claude-code/plugins', () => {
  async function get(resolveConfigDir: () => Promise<string>) {
    const app = express();
    registerClaudeCodePluginRoutes(app, { resolveConfigDir });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const resp = await fetch(`http://127.0.0.1:${port}/api/claude-code/plugins`);
      return {
        status: resp.status,
        body: (await resp.json()) as { available?: boolean; plugins?: unknown[]; error?: unknown },
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('returns the reader result for the resolved config dir', async () => {
    seedValidConfig();
    const { status, body } = await get(async () => cfg);
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.plugins).toHaveLength(4);
  });

  it('returns a structured 500 when the config dir cannot be resolved', async () => {
    const { status, body } = await get(async () => {
      throw new Error('app config unreadable');
    });
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'claude-code-plugins-read-failed', message: 'app config unreadable' },
    });
  });
});

// Read-only inventory of the Claude Code plugins installed in a Claude config
// dir (`CLAUDE_CONFIG_DIR`, else `<home>/.claude`).
//
// Claude Code loads these plugins natively when OpenDesign spawns `claude`, so
// this module exists for visibility only. It never writes, copies, or installs
// anything. The files it reads are Claude Code internals whose shapes may
// change between releases, so every reader here is tolerant: a missing file is
// an empty result, a malformed one becomes a `warnings` entry, and nothing
// throws on bad data.

import { promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ClaudeCodeMarketplaceSourceKind,
  ClaudeCodeMarketplaceSummary,
  ClaudeCodePluginSkillSummary,
  ClaudeCodePluginSummary,
  ClaudeCodePluginsResponse,
} from '@open-design/contracts';
import { parseFrontmatter } from './design-systems/frontmatter.js';
import { agentCliEnvForAgent, readAppConfig } from './app-config.js';
import { spawnEnvForAgent } from './runtimes/env.js';
import { expandHomePrefix } from './home-expansion.js';

export interface ReadClaudeCodePluginsLimits {
  /** Max plugins described. Extra ids are dropped with a warning. */
  maxPlugins: number;
  /** Max entries read from any one skills/commands/agents dir. */
  maxDirEntries: number;
  /** Max bytes read from one SKILL.md (frontmatter sits at the top). */
  maxSkillFileBytes: number;
}

export const DEFAULT_CLAUDE_CODE_PLUGIN_LIMITS: ReadClaudeCodePluginsLimits = {
  maxPlugins: 300,
  maxDirEntries: 200,
  maxSkillFileBytes: 64 * 1024,
};

/**
 * The Claude config dir the daemon's `claude` child would use: the effective
 * `CLAUDE_CONFIG_DIR` of the Claude spawn env (Settings → Local CLI env,
 * inherited env, sandbox mode), else `<home>/.claude`. Mirrors how
 * diagnostics-export resolves the same value so both agree with the spawn.
 */
export async function resolveClaudeCodeConfigDir(dataDir: string): Promise<string> {
  const appConfig = await readAppConfig(dataDir);
  const env = spawnEnvForAgent(
    'claude',
    { ...process.env, OD_DATA_DIR: dataDir },
    agentCliEnvForAgent(appConfig.agentCliEnv, 'claude'),
  );
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? expandHomePrefix(configured) : path.join(os.homedir(), '.claude');
}

type JsonRead =
  | { kind: 'missing' }
  | { kind: 'ok'; value: unknown }
  | { kind: 'error'; message: string };

async function readJsonFile(file: string): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return { kind: 'missing' };
    return { kind: 'error', message: `${file}: ${errorMessage(err)}` };
  }
  try {
    return { kind: 'ok', value: JSON.parse(raw.replace(/^﻿/, '')) };
  } catch (err) {
    return { kind: 'error', message: `${file}: invalid JSON (${errorMessage(err)})` };
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

interface MarketplaceRecord {
  summary: ClaudeCodeMarketplaceSummary;
  installLocation?: string;
}

function parseMarketplaceSource(source: unknown): {
  sourceKind: ClaudeCodeMarketplaceSourceKind;
  sourceLabel: string;
} {
  if (!isRecord(source)) return { sourceKind: 'unknown', sourceLabel: '' };
  const kind = nonEmptyString(source.source) ?? '';
  switch (kind) {
    case 'github':
      return { sourceKind: 'github', sourceLabel: nonEmptyString(source.repo) ?? '' };
    case 'git':
      return { sourceKind: 'git', sourceLabel: nonEmptyString(source.url) ?? '' };
    case 'directory':
      return { sourceKind: 'directory', sourceLabel: nonEmptyString(source.path) ?? '' };
    case 'url':
      return { sourceKind: 'url', sourceLabel: nonEmptyString(source.url) ?? '' };
    default:
      return { sourceKind: 'unknown', sourceLabel: kind };
  }
}

function parseMarketplaces(value: unknown, warnings: string[]): MarketplaceRecord[] {
  if (!isRecord(value)) {
    warnings.push('known_marketplaces.json: expected an object keyed by marketplace name');
    return [];
  }
  const out: MarketplaceRecord[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      warnings.push(`known_marketplaces.json: entry "${name}" is not an object`);
      continue;
    }
    const installLocation = nonEmptyString(entry.installLocation);
    out.push({
      summary: { name, ...parseMarketplaceSource(entry.source) },
      ...(installLocation ? { installLocation } : {}),
    });
  }
  return out.sort((a, b) => a.summary.name.localeCompare(b.summary.name));
}

interface InstalledEntry {
  installPath?: string;
  version?: string;
}

/**
 * installed_plugins.json has been seen as v2 (`plugins[id]` is an array of
 * per-scope installs) and v1 (`plugins[id]` is a single install object).
 * Prefer the `user`-scope install when several exist.
 */
function parseInstalledPlugins(value: unknown, warnings: string[]): Map<string, InstalledEntry> {
  const out = new Map<string, InstalledEntry>();
  const plugins = isRecord(value) ? value.plugins : undefined;
  if (!isRecord(plugins)) {
    warnings.push('installed_plugins.json: missing "plugins" object');
    return out;
  }
  for (const [id, raw] of Object.entries(plugins)) {
    const candidates = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : [];
    const chosen = candidates.find((c) => c.scope === 'user') ?? candidates[0];
    if (!chosen) {
      warnings.push(`installed_plugins.json: entry "${id}" has no install record`);
      continue;
    }
    const installPath = nonEmptyString(chosen.installPath);
    const version = nonEmptyString(chosen.version);
    out.set(id, {
      ...(installPath ? { installPath } : {}),
      ...(version ? { version } : {}),
    });
  }
  return out;
}

function parseEnabledPlugins(value: unknown, warnings: string[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!isRecord(value)) return out;
  const enabled = value.enabledPlugins;
  if (enabled === undefined) return out;
  if (!isRecord(enabled)) {
    warnings.push('settings.json: "enabledPlugins" is not an object');
    return out;
  }
  for (const [id, flag] of Object.entries(enabled)) out.set(id, flag === true);
  return out;
}

function splitPluginId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@');
  if (at <= 0) return { name: id, marketplace: '' };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/** Entries of a dir, capped. A missing dir is an empty list. */
async function listDir(
  dir: string,
  limits: ReadClaudeCodePluginsLimits,
  warnings: string[],
  label: string,
): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    warnings.push(`${label}: cannot read ${dir} (${errorMessage(err)})`);
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > limits.maxDirEntries) {
    warnings.push(`${label}: ${dir} has ${entries.length} entries; showing the first ${limits.maxDirEntries}`);
    return entries.slice(0, limits.maxDirEntries);
  }
  return entries;
}

async function readHead(file: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSkill(
  skillDir: string,
  fallbackName: string,
  limits: ReadClaudeCodePluginsLimits,
): Promise<ClaudeCodePluginSkillSummary | null> {
  const raw = await readHead(path.join(skillDir, 'SKILL.md'), limits.maxSkillFileBytes);
  if (raw === null) return null;
  let data: Record<string, unknown> = {};
  try {
    data = parseFrontmatter(raw).data;
  } catch {
    // Unparseable frontmatter still names a skill Claude can see.
  }
  const description = nonEmptyString(data.description);
  return {
    name: nonEmptyString(data.name) ?? fallbackName,
    ...(description ? { description } : {}),
  };
}

async function listMarkdownNames(
  dir: string,
  limits: ReadClaudeCodePluginsLimits,
  warnings: string[],
  label: string,
): Promise<string[]> {
  const entries = await listDir(dir, limits, warnings, label);
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name.slice(0, -3));
}

interface MarketplacePluginEntry {
  description?: string;
  /** Explicit skill dirs, relative to the plugin root (`strict: false` plugins). */
  skills?: string[];
}

async function readMarketplaceManifest(
  marketplace: MarketplaceRecord,
  warnings: string[],
): Promise<Map<string, MarketplacePluginEntry>> {
  const out = new Map<string, MarketplacePluginEntry>();
  if (!marketplace.installLocation) return out;
  const file = path.join(marketplace.installLocation, '.claude-plugin', 'marketplace.json');
  const read = await readJsonFile(file);
  if (read.kind === 'missing') return out;
  if (read.kind === 'error') {
    warnings.push(read.message);
    return out;
  }
  const plugins = isRecord(read.value) ? read.value.plugins : undefined;
  if (!Array.isArray(plugins)) return out;
  for (const entry of plugins) {
    if (!isRecord(entry)) continue;
    const name = nonEmptyString(entry.name);
    if (!name) continue;
    const description = nonEmptyString(entry.description);
    const skills = Array.isArray(entry.skills)
      ? entry.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : undefined;
    out.set(name, {
      ...(description ? { description } : {}),
      ...(skills ? { skills } : {}),
    });
  }
  return out;
}

async function describePlugin(input: {
  id: string;
  installed: InstalledEntry | undefined;
  enabled: boolean;
  pluginsDir: string;
  marketplaceEntry: MarketplacePluginEntry | undefined;
  limits: ReadClaudeCodePluginsLimits;
  warnings: string[];
}): Promise<ClaudeCodePluginSummary> {
  const { id, installed, enabled, pluginsDir, marketplaceEntry, limits, warnings } = input;
  const { name: idName, marketplace } = splitPluginId(id);
  const summary: ClaudeCodePluginSummary = {
    id,
    name: idName,
    marketplace,
    enabled,
    skills: [],
    commands: [],
    agents: [],
  };
  if (installed?.version) summary.version = installed.version;
  if (marketplaceEntry?.description) summary.description = marketplaceEntry.description;
  if (!installed?.installPath) return summary;

  const root = path.isAbsolute(installed.installPath)
    ? installed.installPath
    : path.join(pluginsDir, installed.installPath);
  summary.installPath = root;
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      warnings.push(`${id}: install path is not a directory (${root})`);
      return summary;
    }
  } catch (err) {
    warnings.push(`${id}: install path ${isMissing(err) ? 'not found' : 'unreadable'} (${root})`);
    return summary;
  }

  const manifest = await readJsonFile(path.join(root, '.claude-plugin', 'plugin.json'));
  if (manifest.kind === 'error') warnings.push(`${id}: ${manifest.message}`);
  if (manifest.kind === 'ok' && isRecord(manifest.value)) {
    const name = nonEmptyString(manifest.value.name);
    const description = nonEmptyString(manifest.value.description);
    const version = nonEmptyString(manifest.value.version);
    if (name) summary.name = name;
    if (description) summary.description = description;
    if (version) summary.version = version;
  }

  const label = id;
  const skillDirs: Array<{ dir: string; fallbackName: string }> = [];
  if (marketplaceEntry?.skills) {
    for (const rel of marketplaceEntry.skills.slice(0, limits.maxDirEntries)) {
      const dir = path.resolve(root, rel);
      const relative = path.relative(root, dir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        warnings.push(`${id}: marketplace skill path "${rel}" is outside the plugin; skipped`);
        continue;
      }
      skillDirs.push({ dir, fallbackName: path.basename(dir) });
    }
  } else {
    const skillsRoot = path.join(root, 'skills');
    for (const entry of await listDir(skillsRoot, limits, warnings, label)) {
      if (entry.isDirectory()) {
        skillDirs.push({ dir: path.join(skillsRoot, entry.name), fallbackName: entry.name });
      }
    }
  }
  // A SKILL.md at the plugin root is itself a skill (e.g. single-skill
  // plugins); readSkill returns null when it is absent.
  skillDirs.push({ dir: root, fallbackName: summary.name });
  const skills = await Promise.all(
    skillDirs.map(({ dir, fallbackName }) => readSkill(dir, fallbackName, limits)),
  );
  summary.skills = skills.filter((s): s is ClaudeCodePluginSkillSummary => s !== null);
  summary.commands = await listMarkdownNames(path.join(root, 'commands'), limits, warnings, label);
  summary.agents = await listMarkdownNames(path.join(root, 'agents'), limits, warnings, label);
  return summary;
}

/**
 * Read the Claude Code plugin inventory under `configDir`. Never throws on
 * missing or malformed Claude files; problems land in `warnings`.
 */
export async function readClaudeCodePlugins(
  configDir: string,
  limits: ReadClaudeCodePluginsLimits = DEFAULT_CLAUDE_CODE_PLUGIN_LIMITS,
): Promise<ClaudeCodePluginsResponse> {
  const warnings: string[] = [];
  const pluginsDir = path.join(configDir, 'plugins');
  const [marketplacesRead, installedRead, settingsRead] = await Promise.all([
    readJsonFile(path.join(pluginsDir, 'known_marketplaces.json')),
    readJsonFile(path.join(pluginsDir, 'installed_plugins.json')),
    readJsonFile(path.join(configDir, 'settings.json')),
  ]);
  for (const read of [marketplacesRead, installedRead, settingsRead]) {
    if (read.kind === 'error') warnings.push(read.message);
  }

  const available = marketplacesRead.kind !== 'missing' || installedRead.kind !== 'missing';
  const marketplaces = marketplacesRead.kind === 'ok'
    ? parseMarketplaces(marketplacesRead.value, warnings)
    : [];
  const installed = installedRead.kind === 'ok'
    ? parseInstalledPlugins(installedRead.value, warnings)
    : new Map<string, InstalledEntry>();
  const enabled = settingsRead.kind === 'ok'
    ? parseEnabledPlugins(settingsRead.value, warnings)
    : new Map<string, boolean>();

  if (!available) {
    return { available: false, configDir, marketplaces: [], plugins: [], warnings };
  }

  // Settings may name plugins with no install record (built-ins, stale
  // entries); list them too so the view matches what Claude Code is told.
  let ids = [...new Set([...installed.keys(), ...enabled.keys()])].sort((a, b) => a.localeCompare(b));
  if (ids.length > limits.maxPlugins) {
    warnings.push(`${ids.length} Claude Code plugins found; showing the first ${limits.maxPlugins}`);
    ids = ids.slice(0, limits.maxPlugins);
  }

  const manifestsByMarketplace = new Map<string, Map<string, MarketplacePluginEntry>>();
  await Promise.all(marketplaces.map(async (m) => {
    manifestsByMarketplace.set(m.summary.name, await readMarketplaceManifest(m, warnings));
  }));

  const plugins = await Promise.all(ids.map((id) => {
    const { name, marketplace } = splitPluginId(id);
    return describePlugin({
      id,
      installed: installed.get(id),
      enabled: enabled.get(id) === true,
      pluginsDir,
      marketplaceEntry: manifestsByMarketplace.get(marketplace)?.get(name),
      limits,
      warnings,
    });
  }));

  return {
    available: true,
    configDir,
    marketplaces: marketplaces.map((m) => m.summary),
    plugins,
    warnings,
  };
}

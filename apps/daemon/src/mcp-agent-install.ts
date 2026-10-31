// Per-agent MCP registration planner.
//
// `od mcp install <agent>` (and the hosted `install.sh | sh -s <agent>`
// bootstrap that calls it) registers the local HTTP endpoint using a credential
// environment-variable name. Explicit stdio compatibility retains its launch
// spec. Each agent stores MCP servers differently, so the pure planners select
// one of three registration strategies:
//
//   - 'cli'    : the agent ships its own `<bin> mcp add/remove/get`. We
//                shell out to it (like codex-cli.ts) so we inherit the
//                agent's merge/validation rules instead of editing its
//                config by hand. Used for claude / codex / kimi / reasonix.
//   - 'json'   : the agent reads a JSON config file with a known schema.
//                We deep-merge one server entry, never clobbering the
//                rest of the file. Used for cursor / copilot / cline /
//                opencode / openclaw / antigravity / kiro / raven / trae /
//                claude-desktop.
//   - 'manual' : we could not verify the agent's config path/format
//                authoritatively (pi / hermes / vibe). We refuse to write
//                a guessed path and instead print a ready-to-paste
//                snippet plus the best-known location. Writing a wrong
//                path risks corrupting a user-owned config, so this stays
//                a print-only path until the format is confirmed.
//
// The planning functions are pure (no fs / spawn) so they unit-test
// against fixed launch specs + a fake home dir; the executor in cli.ts
// performs the IO.

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const AGENT_SLUGS = [
  'claude',
  'codex',
  'reasonix',
  'raven',
  'cursor',
  'copilot',
  'openclaw',
  'antigravity',
  'pi',
  'vibe',
  'hermes',
  'cline',
  'kimi',
  'kiro',
  'trae',
  'opencode',
  'claude-desktop',
] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

export function isAgentSlug(value: string): value is AgentSlug {
  return (AGENT_SLUGS as readonly string[]).includes(value);
}

/** The resolved stdio launch spec — mirrors the relevant fields of
 *  McpInstallPayload (command/args/env). */
export interface McpLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PlanContext {
  /** Absolute home directory (os.homedir()). Injected for testability. */
  home: string;
  /** Node platform — selects per-OS config paths (cline / trae). */
  platform: NodeJS.Platform;
  /** MCP server name as it appears in the agent config. */
  serverName: string;
  /** Current Kimi Code supports a user-selected configuration home. */
  kimiCodeHome?: string;
}

/** Agent owns a `<bin> mcp add/remove/get`; we drive it. */
export interface CliInstallPlan {
  kind: 'cli';
  slug: AgentSlug;
  bin: string;
  addArgv: string[];
  removeArgv: string[];
  /** Argv that exits 0 iff the server is already registered. */
  getArgv: string[];
}

/** Agent reads a JSON config file with a known schema. */
export interface JsonInstallPlan {
  kind: 'json';
  slug: AgentSlug;
  /** Absolute path to the config file we merge into. */
  configPath: string;
  /** Nested object path to the server map, e.g. ['mcpServers'] or
   *  ['mcp', 'servers'] or ['mcp']. */
  keyPath: string[];
  serverKey: string;
  /** Value stored under keyPath → serverKey. */
  entry: unknown;
  /** HTTP setup refuses to replace an unrelated registration or config map. */
  preserveExisting?: boolean;
}

/** Unverified format — print a snippet, never write. */
export interface ManualInstallPlan {
  kind: 'manual';
  slug: AgentSlug;
  format: 'json' | 'yaml' | 'toml';
  /** Best-known config location, or null when even that is unknown. */
  configPath: string | null;
  snippet: string;
  reason: string;
}

export type InstallPlan = CliInstallPlan | JsonInstallPlan | ManualInstallPlan;

/** HTTP registration contains an environment-variable name, never its value. */
export interface McpHttpInstallSpec {
  url: string;
  bearerTokenEnvVar: string;
}

/**
 * Plan a local HTTP registration using a documented credential-name reference.
 * This does not issue credentials, set environment variables, or write config.
 */
export function planHttpAgentInstall(slug: 'codex' | 'claude', spec: McpHttpInstallSpec, ctx: PlanContext): CliInstallPlan;
export function planHttpAgentInstall(slug: AgentSlug, spec: McpHttpInstallSpec, ctx: PlanContext): InstallPlan;
export function planHttpAgentInstall(slug: AgentSlug, spec: McpHttpInstallSpec, ctx: PlanContext): InstallPlan {
  // Planner output can be printed or used as argv. Reject known token prefixes
  // anywhere in caller-controlled fields, without copying them into errors.
  const containsTokenPrefix = (value: string) => /(?:odtt_|odmcp_)/i.test(value);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(ctx.serverName) || containsTokenPrefix(ctx.serverName)) {
    throw new Error('invalid MCP server name');
  }
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(spec.bearerTokenEnvVar) || containsTokenPrefix(spec.bearerTokenEnvVar)) {
    throw new Error('invalid bearer environment variable name');
  }
  if (containsTokenPrefix(spec.url)) throw new Error('invalid local HTTP MCP URL');
  let url: URL;
  try { url = new URL(spec.url); } catch { throw new Error('invalid local HTTP MCP URL'); }
  // Numeric loopback prevents a configured hostname from later resolving to
  // a non-loopback address while the client sends its bearer header.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/mcp' || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('invalid local HTTP MCP URL');
  }
  const { serverName, home } = ctx;
  const envName = spec.bearerTokenEnvVar;
  const header = 'Bearer ${' + envName + '}';
  const json = (configPath: string, keyPath: string[], entry: unknown): JsonInstallPlan => ({
    kind: 'json', slug, configPath, keyPath, serverKey: serverName, entry, preserveExisting: true,
  });
  switch (slug) {
    case 'codex':
      return {
        kind: 'cli', slug, bin: 'codex',
        addArgv: ['mcp', 'add', serverName, '--url', url.href, '--bearer-token-env-var', envName],
        removeArgv: ['mcp', 'remove', serverName], getArgv: ['mcp', 'get', serverName],
      };
    case 'claude':
      return {
        kind: 'cli', slug, bin: 'claude',
        addArgv: ['mcp', 'add', '--scope', 'user', '--transport', 'http', serverName, url.href,
          '--header', 'Authorization: ' + header],
        removeArgv: ['mcp', 'remove', '--scope', 'user', serverName], getArgv: ['mcp', 'get', serverName],
      };
    case 'kimi':
      return json(path.join(ctx.kimiCodeHome ?? path.join(home, '.kimi-code'), 'mcp.json'), ['mcpServers'],
        { url: url.href, bearerTokenEnvVar: envName });
    case 'opencode':
      return json(path.join(home, '.config', 'opencode', 'opencode.json'), ['mcp'],
        { type: 'remote', url: url.href, enabled: true, oauth: false,
          headers: { Authorization: 'Bearer {env:' + envName + '}' } });
    case 'kiro':
      return json(path.join(home, '.kiro', 'settings', 'mcp.json'), ['mcpServers'],
        { url: url.href, headers: { Authorization: header } });
    case 'hermes':
      return {
        kind: 'manual', slug, format: 'yaml', configPath: path.join(home, '.hermes', 'config.yaml'),
        snippet: ['mcp_servers:', `  ${serverName}:`, `    url: ${JSON.stringify(url.href)}`,
          '    headers:', `      Authorization: ${JSON.stringify(header)}`].join('\n'),
        reason: 'Merge this documented HTTP entry into the existing Hermes YAML configuration. Automatic YAML editing is unavailable.',
      };
    case 'vibe':
      return {
        kind: 'manual', slug, format: 'toml', configPath: path.join(home, '.vibe', 'config.toml'), snippet: '',
        reason: `Configure ${url.href} using Vibe's HTTP MCP transport and its api_key_env setting ${envName}. Follow https://docs.mistral.ai/vibe/code/cli/mcp-servers; automatic TOML editing is unavailable.`,
      };
    default:
      return {
        kind: 'manual', slug, format: 'json', configPath: null, snippet: '',
        reason: 'A native HTTP bearer environment-reference format has not been verified for this client. No configuration was changed. Use the client documentation or explicit --transport stdio compatibility.',
      };
  }
}

/** A stored endpoint is the current listener snapshot, not a daemon identity. */
export function httpMcpUrlFromDaemonOrigin(raw: string): string {
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new Error('invalid local daemon origin'); }
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.href.includes('?') || origin.href.includes('#')
    || /(?:odtt_|odmcp_)/i.test(raw)) throw new Error('invalid local daemon origin');
  return `${origin.origin}/mcp`;
}

function envFlags(env: Record<string, string>, flag: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    out.push(flag, `${k}=${v}`);
  }
  return out;
}

/** JSON server entry shared by the `env`-style agents (cursor / copilot /
 *  cline / openclaw / antigravity / trae). `extra` carries per-agent
 *  fields; env is only attached when non-empty so configs stay clean. */
function jsonEntry(
  spec: McpLaunchSpec,
  extra: Record<string, unknown> = {},
  envKey: 'env' | 'environment' = 'env',
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: spec.command,
    args: spec.args,
    ...extra,
  };
  if (Object.keys(spec.env).length > 0) {
    entry[envKey] = spec.env;
  }
  return entry;
}

/**
 * Build the registration plan for one agent. Pure — all IO happens in the
 * executor. Throws on an unknown slug so callers surface a clear error.
 */
export function planAgentInstall(
  slug: AgentSlug,
  spec: McpLaunchSpec,
  ctx: PlanContext,
): InstallPlan {
  const { home, platform, serverName } = ctx;

  switch (slug) {
    // ----- CLI-driven agents (idempotent via the agent's own tool) -----
    case 'claude':
      return {
        kind: 'cli',
        slug,
        bin: 'claude',
        addArgv: [
          'mcp', 'add', '--scope', 'user',
          serverName,
          ...envFlags(spec.env, '-e'),
          '--', spec.command, ...spec.args,
        ],
        removeArgv: ['mcp', 'remove', '--scope', 'user', serverName],
        getArgv: ['mcp', 'get', serverName],
      };
    case 'codex':
      return {
        kind: 'cli',
        slug,
        bin: 'codex',
        addArgv: [
          'mcp', 'add', serverName,
          ...envFlags(spec.env, '--env'),
          '--', spec.command, ...spec.args,
        ],
        removeArgv: ['mcp', 'remove', serverName],
        getArgv: ['mcp', 'get', serverName],
      };
    case 'reasonix':
      return {
        kind: 'cli',
        slug,
        bin: 'reasonix',
        addArgv: [
          'mcp', 'add', serverName,
          ...envFlags(spec.env, '--env'),
          spec.command, ...spec.args,
        ],
        removeArgv: ['mcp', 'remove', serverName],
        getArgv: ['mcp', 'get', serverName],
      };
    case 'kimi':
      return {
        kind: 'cli',
        slug,
        bin: 'kimi',
        addArgv: [
          'mcp', 'add', '--transport', 'stdio',
          ...envFlags(spec.env, '--env'),
          serverName, '--', spec.command, ...spec.args,
        ],
        removeArgv: ['mcp', 'remove', serverName],
        getArgv: ['mcp', 'get', serverName],
      };

    // ----- JSON config-file agents (safe deep-merge) -----
    case 'cursor':
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.cursor', 'mcp.json'),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec, { type: 'stdio' }),
      };
    case 'raven':
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.raven', 'config.json'),
        keyPath: ['tools', 'mcpServers'],
        serverKey: serverName,
        entry: { ...jsonEntry(spec, { type: 'stdio' }), env: spec.env },
      };
    case 'copilot':
      // GitHub Copilot CLI: ~/.copilot/mcp-config.json, type "local".
      // (VS Code Copilot uses a different `servers` key in
      // .vscode/mcp.json; the terminal installer targets the CLI.)
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.copilot', 'mcp-config.json'),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec, { type: 'local', tools: ['*'] }),
      };
    case 'cline':
      return {
        kind: 'json',
        slug,
        configPath: clineConfigPath(home, platform),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec, { disabled: false, autoApprove: [] }),
      };
    case 'opencode':
      // OpenCode nests under `mcp`, folds command+args into one array,
      // and gates the server with `enabled`.
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.config', 'opencode', 'opencode.json'),
        keyPath: ['mcp'],
        serverKey: serverName,
        entry: (() => {
          const e: Record<string, unknown> = {
            type: 'local',
            command: [spec.command, ...spec.args],
            enabled: true,
          };
          if (Object.keys(spec.env).length > 0) e.environment = spec.env;
          return e;
        })(),
      };
    case 'openclaw':
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.openclaw', 'openclaw.json'),
        keyPath: ['mcp', 'servers'],
        serverKey: serverName,
        entry: jsonEntry(spec),
      };
    case 'antigravity':
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec),
      };
    case 'kiro':
      return {
        kind: 'json',
        slug,
        configPath: path.join(home, '.kiro', 'settings', 'mcp.json'),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec),
      };
    case 'trae':
      return {
        kind: 'json',
        slug,
        configPath: traeConfigPath(home, platform),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec),
      };
    case 'claude-desktop':
      if (platform !== 'darwin' && platform !== 'win32') {
        return {
          kind: 'manual',
          slug,
          format: 'json',
          configPath: null,
          snippet: genericMcpServersSnippet(spec, serverName),
          reason:
            'Automatic MCP configuration for Claude Desktop is ' +
            'currently supported only on macOS and Windows.',
        };
      }
      return {
        kind: 'json',
        slug,
        configPath: claudeDesktopConfigPath(home, platform),
        keyPath: ['mcpServers'],
        serverKey: serverName,
        entry: jsonEntry(spec, { type: 'stdio' }),
      };

    // ----- Unverified formats: print-only, never write -----
    case 'vibe':
      return {
        kind: 'manual',
        slug,
        format: 'toml',
        configPath: path.join(home, '.vibe', 'config.toml'),
        snippet: vibeTomlSnippet(spec, serverName),
        reason:
          'Mistral Vibe uses a TOML array-of-tables ([[mcp_servers]]); ' +
          'its exact schema is unverified, so append this block by hand ' +
          'to avoid corrupting an existing config.',
      };
    case 'pi':
      return {
        kind: 'manual',
        slug,
        format: 'json',
        configPath: path.join(home, '.pi', 'agent', 'mcp.json'),
        snippet: genericMcpServersSnippet(spec, serverName),
        reason:
          'The pi coding agent exposes MCP, but its config path/schema is ' +
          'not authoritatively documented. Paste this into pi’s MCP ' +
          'config (check `pi --help` for the exact location).',
      };
    case 'hermes':
      return {
        kind: 'manual',
        slug,
        format: 'yaml',
        configPath: path.join(home, '.hermes', 'config.yaml'),
        snippet: hermesYamlSnippet(spec, serverName),
        reason:
          'Hermes config format is unverified. Add this under your Hermes ' +
          'MCP server configuration by hand.',
      };
    default: {
      const exhaustive: never = slug;
      throw new Error(`unknown agent slug: ${String(exhaustive)}`);
    }
  }
}

function clineConfigPath(home: string, platform: NodeJS.Platform): string {
  const rel = path.join(
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', rel);
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', rel);
  }
  return path.join(home, '.config', 'Code', 'User', rel);
}

function traeConfigPath(home: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Trae', 'User', 'mcp.json');
  }
  return path.join(home, '.config', 'Trae', 'User', 'mcp.json');
}

function claudeDesktopConfigPath(home: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  // platform === 'win32' — the planAgentInstall case already guards
  // against unsupported platforms before calling this helper.
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'Claude', 'claude_desktop_config.json');
}

// --- Pure JSON merge / removal (the heart of the 'json' strategy) -------

/**
 * Merge one server entry into existing config text without disturbing the
 * rest. Missing intermediate objects are created. Returns pretty JSON with
 * a trailing newline. Throws if existing text is non-empty but unparseable
 * (caller decides whether to bail or back up).
 */
export function applyJsonInstall(existingText: string | null, plan: JsonInstallPlan): string {
  const root = parseJsonObject(existingText, plan.configPath);
  let cursor: Record<string, unknown> = root;
  for (const key of plan.keyPath) {
    const next = cursor[key];
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      if (plan.preserveExisting && Object.hasOwn(cursor, key)) throw new Error('Existing MCP configuration map is not an object; no configuration changed.');
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  if (plan.preserveExisting && Object.hasOwn(cursor, plan.serverKey) && !isDeepStrictEqual(cursor[plan.serverKey], plan.entry)) {
    throw new Error('MCP server name is already configured differently; remove it explicitly or choose --name. No configuration changed.');
  }
  cursor[plan.serverKey] = plan.entry;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Remove the server entry. Returns the new text, or null when the file did
 * not exist / had nothing to remove (caller treats null as a no-op).
 */
export function removeJsonInstall(existingText: string | null, plan: JsonInstallPlan): string | null {
  if (existingText == null || existingText.trim() === '') return null;
  const root = parseJsonObject(existingText, plan.configPath);
  let cursor: Record<string, unknown> = root;
  for (const key of plan.keyPath) {
    const next = cursor[key];
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      return null;
    }
    cursor = next as Record<string, unknown>;
  }
  if (!(plan.serverKey in cursor)) return null;
  delete cursor[plan.serverKey];
  return `${JSON.stringify(root, null, 2)}\n`;
}

function parseJsonObject(text: string | null, where: string): Record<string, unknown> {
  if (text == null || text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON parser excerpts can include credentials from an existing config.
    throw new Error(`existing config at ${where} is not valid JSON`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing config at ${where} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// --- Snippets for the manual (print-only) strategy ----------------------

function genericMcpServersSnippet(spec: McpLaunchSpec, name: string): string {
  const server: Record<string, unknown> = {
    command: spec.command,
    args: spec.args,
  };
  if (Object.keys(spec.env).length > 0) server.env = spec.env;
  return JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
}

function hermesYamlSnippet(spec: McpLaunchSpec, name: string): string {
  const lines = [
    'mcp_servers:',
    `  ${name}:`,
    `    command: ${JSON.stringify(spec.command)}`,
    `    args: ${JSON.stringify(spec.args)}`,
  ];
  if (Object.keys(spec.env).length > 0) {
    lines.push('    env:');
    for (const [k, v] of Object.entries(spec.env)) {
      lines.push(`      ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

function vibeTomlSnippet(spec: McpLaunchSpec, name: string): string {
  const argsToml = `[${spec.args.map((a) => JSON.stringify(a)).join(', ')}]`;
  const lines = [
    '[[mcp_servers]]',
    `name = ${JSON.stringify(name)}`,
    'transport = "stdio"',
    `command = ${JSON.stringify(spec.command)}`,
    `args = ${argsToml}`,
  ];
  return lines.join('\n');
}

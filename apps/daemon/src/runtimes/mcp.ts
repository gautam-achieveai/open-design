import type { RuntimeAgentDef } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AcpMcpServerInput } from '../agent-protocol/acp/session-params.js';

export const CLAUDE_RUN_MCP_SERVER = 'open-design-run';

/** Private ACP transport configuration; never serialize into files or prompts. */
export function buildAcpRunHttpMcpServer(daemonUrl: string | null, token: string | undefined): AcpMcpServerInput | null {
  if (!daemonUrl || !token) return null;
  return {
    type: 'http', name: CLAUDE_RUN_MCP_SERVER,
    url: `${daemonUrl.replace(/\/$/u, '')}/mcp`,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

type RunHttpMcpConfigOptions = { daemonUrl: string; externalConfig?: unknown };

function runMcpUrl(daemonUrl: string): string {
  const url = new URL(daemonUrl);
  if (url.protocol !== 'http:' || !(/^(?:127\.)\d+\.\d+\.\d+$/u.test(url.hostname) || url.hostname === '[::1]')
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OpenDesign MCP requires the local daemon listener.');
  }
  return `${url.origin}/mcp`;
}

/** Per-thread overrides are additive; never roundtrip nullable config/read values. */
export function buildCodexRunMcpConfig({ daemonUrl, externalConfig }: RunHttpMcpConfigOptions): Record<string, unknown> {
  const config = externalConfig && typeof externalConfig === 'object' ? externalConfig as Record<string, unknown> : {};
  const external = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers as Record<string, unknown> : {};
  if (Object.hasOwn(external, CLAUDE_RUN_MCP_SERVER)) throw new Error('OpenDesign MCP server name is reserved.');
  const result: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(external)) {
    // app-server splits override paths on dots; quoted segments are not parsed.
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error('External MCP server ids for Codex must use only letters, numbers, _ or -.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('External MCP configuration is invalid.');
    const entry = raw as Record<string, unknown>;
    const remote = entry.type === 'http' || entry.type === 'sse' || typeof entry.url === 'string';
    result[`mcp_servers.${name}`] = remote
      ? { url: entry.url, ...(entry.headers ? { http_headers: entry.headers } : {}), enabled: true }
      : { command: entry.command, args: entry.args ?? [], ...(entry.env ? { env: entry.env } : {}), enabled: true };
  }
  result[`mcp_servers.${CLAUDE_RUN_MCP_SERVER}`] = {
    url: runMcpUrl(daemonUrl), bearer_token_env_var: 'OD_TOOL_TOKEN', enabled: true, required: true,
  };
  return result;
}

type OpenCodeRunMcpScope = { conversationId?: string | null; runId: string };

function openCodeRunMcpServerName({ conversationId, runId }: OpenCodeRunMcpScope): string {
  // Keep native tool names compact and stable across resumes. This digest is
  // public routing metadata; authority still comes only from the run bearer.
  const identity = conversationId ? `conversation:${conversationId}` : `run:${runId}`;
  return `od_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

/** Keep the run bearer in native env interpolation, never in inline JSON itself. */
export function composeOpenCodeRunMcpConfig(content: string | null, daemonUrl: string, scope: OpenCodeRunMcpScope): string {
  let config;
  try { config = content ? JSON.parse(content) : {}; }
  catch { throw new Error('External MCP configuration is invalid.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('External MCP configuration is invalid.');
  const mcp = config.mcp ?? {};
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('External MCP configuration is invalid.');
  const name = openCodeRunMcpServerName(scope);
  if (Object.hasOwn(mcp, name)) throw new Error('OpenDesign MCP server name is reserved.');
  if (/\{env:\s*OD_TOOL_TOKEN\s*\}/iu.test(JSON.stringify(mcp))) throw new Error('Run credentials cannot be forwarded to external MCP servers.');
  return JSON.stringify({ ...config, mcp: { ...mcp, [name]: {
    type: 'remote', url: runMcpUrl(daemonUrl), oauth: false, enabled: true,
    headers: { Authorization: 'Bearer {env:OD_TOOL_TOKEN}' },
  } } });
}

/** A unique daemon-owned file. It contains an env reference, never the run bearer. */
export async function prepareClaudeRunMcpConfig({ dataDir, daemonUrl, externalConfig, projectDir }: {
  dataDir: string; daemonUrl: string; externalConfig?: unknown; projectDir: string;
}): Promise<{ path: string; cleanup: () => void }> {
  const config = externalConfig && typeof externalConfig === 'object' ? externalConfig as Record<string, unknown> : {};
  const external = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers as Record<string, unknown> : {};
  if (Object.hasOwn(external, CLAUDE_RUN_MCP_SERVER)) throw new Error('OpenDesign MCP server name is reserved.');
  const referencesRunToken = (value: unknown) => /\$\{OD_TOOL_TOKEN(?:\}|:-)/iu.test(JSON.stringify(value));
  if (referencesRunToken(external)) throw new Error('Run credentials cannot be forwarded to external MCP servers.');
  try {
    const projectConfig = JSON.parse(await fs.promises.readFile(path.join(projectDir, '.mcp.json'), 'utf8'));
    if (referencesRunToken(projectConfig)) throw new Error('Run credentials cannot be forwarded to external MCP servers.');
    if (projectConfig?.mcpServers && Object.hasOwn(projectConfig.mcpServers, CLAUDE_RUN_MCP_SERVER)) {
      throw new Error('OpenDesign MCP server name is reserved.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const root = path.join(dataDir, 'runtime-mcp');
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.promises.mkdtemp(path.join(root, 'claude-'));
  const target = path.join(directory, 'mcp.json');
  const cleanup = () => {
    try { fs.unlinkSync(target); } catch { /* Only this attempt owns this file. */ }
    try { fs.rmdirSync(directory); } catch { /* Never delete another attempt's files. */ }
  };
  try {
    await fs.promises.writeFile(target, JSON.stringify({ mcpServers: {
      ...external,
      [CLAUDE_RUN_MCP_SERVER]: {
        type: 'http', url: `${daemonUrl.replace(/\/$/u, '')}/mcp`,
        headers: { Authorization: 'Bearer ${OD_TOOL_TOKEN}' },
      },
    } }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { path: target, cleanup };
  } catch { cleanup(); throw new Error('OpenDesign MCP configuration could not be prepared.'); }
}

/** Last spawn overlay; Windows treats differently cased environment keys alike. */
export function reassertClaudeRunEnvironment(env: NodeJS.ProcessEnv, authority: Record<string, string>): void {
  const keys = new Set([...Object.keys(authority), 'OD_API_TOKEN'].map(key => key.toUpperCase()));
  for (const key of Object.keys(env)) if (keys.has(key.toUpperCase())) delete env[key];
  Object.assign(env, authority);
}

type McpOptions = {
  enabled?: boolean;
  command?: string;
  argsPrefix?: string[];
};

export function buildLiveArtifactsMcpServersForAgent(
  def: RuntimeAgentDef,
  { enabled = true, command = 'od', argsPrefix = [] }: McpOptions = {},
) {
  if (!enabled || def?.mcpDiscovery !== 'mature-acp') return [];
  const wantsMapEnv = def?.acpMcpEnvFormat === 'map';
  const env = wantsMapEnv
    ? { ELECTRON_RUN_AS_NODE: '1' }
    : [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }];
  return [
    {
      name: 'open-design-live-artifacts',
      command,
      args: [...argsPrefix, 'mcp', 'live-artifacts'],
      env,
    },
  ];
}

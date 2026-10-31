import { detectAgents } from '../agents.js';
import { readAppConfig, type AppConfigPrefs } from '../app-config.js';
import { offeredAgents } from '../cloud-features.js';

/** Shared by the non-streaming REST catalog and HTTP MCP. */
export async function discoverOfferedAgents(config: AppConfigPrefs) {
  return offeredAgents(await detectAgents(config.agentCliEnv ?? {}), config);
}

export async function readOfferedAgentCatalog(dataDir: string) {
  return discoverOfferedAgents(await readAppConfig(dataDir));
}

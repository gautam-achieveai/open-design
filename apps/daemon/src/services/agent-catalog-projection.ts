/** Shape the daemon agent inventory for the stdio and HTTP MCP tools. */
export function projectAgentCatalog(agents: readonly unknown[], includeUnavailable: boolean): { agents: Array<Record<string, unknown>> } {
  const all = agents as Array<Record<string, unknown>>;
  const filtered = includeUnavailable ? all : all.filter((agent) => agent?.available === true);
  return { agents: filtered.map((agent) => {
    const models = Array.isArray(agent?.models) ? agent.models : [];
    const result: Record<string, unknown> = {
      id: agent?.id, name: agent?.name, models: models.slice(0, 10), modelsCount: models.length,
    };
    if (typeof agent?.version === 'string' && agent.version.length > 0) result.version = agent.version;
    if (includeUnavailable) {
      result.available = Boolean(agent?.available);
      if (typeof agent?.installUrl === 'string') result.installUrl = agent.installUrl;
    }
    return result;
  }) };
}

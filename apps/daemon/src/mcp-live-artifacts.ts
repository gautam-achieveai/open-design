import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getGlobalDispatcher } from 'undici';

const TOOL_NAMES = new Set([
  'live_artifacts_create', 'live_artifacts_list', 'live_artifacts_update', 'live_artifacts_refresh',
  'connectors_list', 'connectors_execute',
]);

/** Compatibility carrier only. Tool schemas, policy and execution belong to the HTTP registry. */
export async function runLiveArtifactsMcpServer(): Promise<{ exitCode: number }> {
  const token = process.env.OD_TOOL_TOKEN;
  let origin: URL;
  try {
    origin = new URL(process.env.OD_DAEMON_URL ?? '');
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !token) throw new Error();
  } catch { throw new Error('A loopback daemon origin and run credential are required.'); }

  const client = new Client({ name: 'open-design-stdio-compatibility', version: '1' });
  const upstream = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  const server = new Server({ name: 'open-design-live-artifacts', version: '1' }, { capabilities: { tools: {} } });
  const transport = new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = () => { void server.close().catch(() => {}).finally(resolveClosed); };
  try {
    await client.connect(upstream);
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      try {
        const result = await client.listTools(undefined, { signal: extra.signal });
        return { tools: result.tools.filter(tool => TOOL_NAMES.has(tool.name)) };
      } catch { throw new McpError(ErrorCode.InternalError, 'Unable to list daemon tools.'); }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!TOOL_NAMES.has(request.params.name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown compatibility tool.');
      try { return await client.callTool(request.params, undefined, { signal: extra.signal }); }
      catch { throw new McpError(ErrorCode.InternalError, 'Daemon tool call failed.'); }
    });
    await server.connect(transport);
    const onClose = transport.onclose;
    transport.onclose = () => { onClose?.(); resolveClosed(); };
    client.onclose = close;
    process.stdin.once('end', close);
    process.stdin.once('close', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stderr.write('OpenDesign live-artifact stdio is compatibility only; prefer the daemon HTTP MCP endpoint.\n');
    await closed;
    return { exitCode: 0 };
  } catch { throw new Error('Unable to connect the live-artifact compatibility carrier.'); }
  finally {
    process.stdin.off('end', close); process.stdin.off('close', close);
    process.off('SIGINT', close); process.off('SIGTERM', close);
    await Promise.allSettled([server.close(), client.close()]);
    await getGlobalDispatcher().close();
  }
}

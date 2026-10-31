import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BROWSER_MCP_TOOLING_DIRECTIVE } from '@open-design/contracts';

const args = process.argv.slice(2);
const token = process.env.OD_TOOL_TOKEN ?? '';
const mode = process.env.OD_FAKE_ACP_MODE ?? 'normal';
const sessionId = 'fixture-acp-session';
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (value: unknown) => emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
let own: { url: string; headers: { name: string; value: string }[] } | null = null;
let ownHTTPCount = 0, ownStdioCount = 0, externalCount = 0;
let sessionMethod = '', headerMatchesEnv = false, privateHeaderOnly = false;
let promptContainsToken = false, snapshotSucceeded = false, inspectSucceeded = false, screenshotSucceeded = false;
let guidanceObserved = false, phase = 'metadata';
let promptId: number | string | null = null;
let promptStarted = false;

if (args.includes('--version') || args.includes('-V')) process.stdout.write('2.3.1\n');
else if (args.includes('--help')) process.stdout.write('fake Kimi ACP fixture\n');
else {
  createInterface({ input: process.stdin, terminal: false }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1,
        agentInfo: { name: 'Kimi Code CLI fixture', version: mode === 'version-token' && token ? `2.3.1-${token}` : '2.3.1' },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.OD_FAKE_ACP_HTTP !== '0', sse: true } } } });
    } else if (message.method === 'session/new' || message.method === 'session/load') {
      phase = 'session'; sessionMethod = message.method;
      const servers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
      const owned = servers.filter((server: { name?: string }) => server.name === 'open-design-run');
      ownHTTPCount = owned.filter((server: { type?: string }) => server.type === 'http').length;
      ownStdioCount = servers.filter((server: { name?: string }) => server.name === 'open-design-live-artifacts').length;
      externalCount = servers.length - owned.length - ownStdioCount;
      own = owned[0] ?? null;
      headerMatchesEnv = Boolean(token && own?.headers.some(header => header.name.toLowerCase() === 'authorization' && header.value === `Bearer ${token}`));
      const withoutHeader = structuredClone(message.params ?? {});
      for (const server of withoutHeader.mcpServers ?? []) if (server.name === 'open-design-run') server.headers = [];
      privateHeaderOnly = Boolean(token && !JSON.stringify(withoutHeader).includes(token));
      const response = { jsonrpc: '2.0', id: message.id, result: { sessionId: mode === 'invalid-session' && token ? token : sessionId,
        openCodeSessionId: 'fixture-durable-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } };
      if (mode === 'invalid-session' && token) {
        phase = 'invalid-session';
        // The guard may terminate us synchronously after this response. Give
        // the private observer its token before sending the unsafe identity.
        void report().catch(() => {}).then(() => emit(response));
      } else emit(response);
    } else if (message.method === 'session/set_model' || message.method === 'session/set_config_option') {
      emit({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'session/prompt' && !promptStarted) {
      promptStarted = true; promptId = message.id;
      promptContainsToken = Boolean(token && JSON.stringify(message.params).includes(token));
      void scenario().catch(async () => {
        try { await report(); } catch { /* Only fixed safe diagnostics. */ }
        emit({ jsonrpc: '2.0', id: promptId, error: { code: -32603, message: 'Fixture ACP scenario failed.' } });
        process.exitCode = 1;
      }).finally(() => { process.stdin.pause(); process.stdin.destroy(); });
    } else if (message.method === 'session/cancel') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: token || 'late' } });
      if (promptId !== null) emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
      process.stdin.pause(); process.stdin.destroy();
    } else if (message.id !== undefined) emit({ jsonrpc: '2.0', id: message.id, result: {} });
  });
}

async function report() {
  process.stderr.write(`Fixture ACP phase=${phase} ownHttp=${ownHTTPCount} ownStdio=${ownStdioCount}\n`);
  if (!process.env.OD_FAKE_ACP_REPORT_URL) return;
  const observer = new URL(process.env.OD_FAKE_ACP_REPORT_URL);
  if (observer.hostname !== '127.0.0.1') throw new Error('observer must be local');
  const response = await fetch(observer, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    token, pid: process.pid, args, phase, sessionMethod, ownHTTPCount, ownStdioCount, externalCount, headerMatchesEnv, privateHeaderOnly,
    promptContainsToken, snapshotSucceeded, inspectSucceeded, screenshotSucceeded, guidanceObserved,
  }) });
  await response.arrayBuffer();
}

async function scenario() {
  if (promptContainsToken || args.some(arg => token && arg.includes(token))) throw new Error('unsafe launch');
  if (process.env.OD_FAKE_ACP_HTTP === '0') {
    phase = 'fallback';
    await report();
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP fallback retained.' } });
    emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (!token || !own || ownHTTPCount !== 1 || ownStdioCount !== 0 || !headerMatchesEnv || !privateHeaderOnly) throw new Error('invalid own transport');
  const url = new URL(own.url);
  if (url.protocol !== 'http:' || !(url.hostname.startsWith('127.') || url.hostname === '[::1]')) throw new Error('transport must be local');
  if (own.url !== `${process.env.OD_DAEMON_URL}/mcp`) throw new Error('daemon authority mismatch');
  const client = new Client({ name: 'acp-product-fixture', version: '1' });
  try {
    phase = 'mcp-connect';
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: Object.fromEntries(own.headers.map(header => [header.name, header.value])) } }));
    const listed = await client.listTools();
    const snapshotTool = listed.tools.find(tool => tool.name === 'browser_snapshot');
    guidanceObserved = snapshotTool?.description?.includes(BROWSER_MCP_TOOLING_DIRECTIVE) === true;
    phase = 'snapshot';
    snapshotSucceeded = !(await client.callTool({ name: 'browser_snapshot', arguments: {} })).isError;
    phase = 'inspect';
    inspectSucceeded = !(await client.callTool({ name: 'browser_inspect', arguments: { target: { selector: 'body' } } })).isError;
    phase = 'screenshot';
    const screenshot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    screenshotSucceeded = !screenshot.isError && Array.isArray(screenshot.content) && screenshot.content.some(content => content.type === 'image' && content.mimeType === 'image/png');
    if (!snapshotSucceeded || !inspectSucceeded || !screenshotSucceeded) throw new Error('browser read failed');
    phase = 'output';
    const split = Math.floor(token.length / 2);
    const text = (value: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
    text('ACP MCP reads succeeded. '); text(token.slice(0, split));
    update({ sessionUpdate: 'current_mode_update', modeId: 'default' });
    text(token.slice(split)); text(' Ordinary ACP response retained.');
    for (const value of [token.slice(0, split), token.slice(split)]) update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } });
    if (mode === 'invalid-tool-id') { phase = 'invalid-tool-id'; await report(); }
    update({ sessionUpdate: 'tool_call', toolCallId: mode === 'invalid-tool-id' ? token : 'fixture-acp-tool', title: 'Read fixture', kind: 'read', status: 'in_progress', rawInput: { note: token, path: 'fixture.txt' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-acp-tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: token } }] });
    process.stderr.write(`fixture stderr ${token.slice(0, split)}`);
    await new Promise<void>(resolve => setImmediate(resolve));
    process.stderr.write(`${token.slice(split)} complete\n`);
    phase = mode === 'cancel-hold' ? 'cancel-hold' : 'complete';
    await report();
    if (mode === 'cancel-hold') await new Promise<void>(() => {});
    if (mode === 'error-frame') emit({ jsonrpc: '2.0', id: promptId, error: { code: -32603, message: token, data: { detail: token } } });
    else emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } finally { await client.close(); }
}

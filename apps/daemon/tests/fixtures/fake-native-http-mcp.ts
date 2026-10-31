import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const kind = process.env.OD_FAKE_NATIVE_KIND ?? 'codex';
const args = process.argv.slice(2);
const token = process.env.OD_TOOL_TOKEN ?? '';
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = 'fixture-turn';
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: unknown) => emit({ jsonrpc: '2.0', method, params });
let own: Record<string, unknown> | undefined;
let ownHTTPCount = 0, privateHeaderOnly = false, promptContainsToken = false, headerMatchesEnv = false;
let snapshotSucceeded = false, inspectSucceeded = false, screenshotSucceeded = false;
let snapshotGuidanceObserved = false, phase = 'metadata';
let promptStarted = false;

if (args.includes('--version') || args.includes('-V')) process.stdout.write(kind === 'codex' ? 'codex-cli 0.164.0\n' : '1.19.5\n');
else if (args.includes('--help')) process.stdout.write('Synthetic native HTTP fixture\n');
else if (kind === 'codex' && !args.includes('app-server')) process.stdout.write(JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture' }] }) + '\n');
else if (kind === 'codex') {
  createInterface({ input: process.stdin, terminal: false }).on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (frame.method === 'initialize') emit({ jsonrpc: '2.0', id: frame.id, result: { userAgent: 'codex_cli_rs/0.164.0' } });
    else if (frame.method === 'config/read') emit({ jsonrpc: '2.0', id: frame.id, result: { config: { mcp_servers: {} } } });
    else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
      const config = frame.params?.config ?? {};
      const entries = Object.entries(config).filter(([key]) => key === 'mcp_servers.open-design-run');
      ownHTTPCount = entries.length;
      own = entries[0]?.[1] as Record<string, unknown> | undefined;
      privateHeaderOnly = Boolean(token && !JSON.stringify(frame.params).includes(token));
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: threadId, historyMode: 'paginated' } } });
    } else if (frame.method === 'turn/start' && !promptStarted) {
      promptStarted = true; promptContainsToken = Boolean(token && JSON.stringify(frame.params?.input).includes(token));
      emit({ jsonrpc: '2.0', id: frame.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      void scenario().catch(async () => {
        try { await report(); } catch { /* Fixed diagnostics only. */ }
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Fixture native MCP scenario failed.' } } });
      });
    } else if (frame.method === 'turn/interrupt') notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } });
    else if (frame.id !== undefined) emit({ jsonrpc: '2.0', id: frame.id, result: {} });
  });
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    promptContainsToken = Boolean(token && prompt.includes(token));
    try {
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? process.env.MIMOCODE_CONFIG_CONTENT ?? '{}');
      const entries = Object.entries(config.mcp ?? {}).filter(([name]) => /^od_[0-9a-f]{32}$/u.test(name));
      ownHTTPCount = entries.length; own = entries[0]?.[1] as Record<string, unknown> | undefined;
      privateHeaderOnly = Boolean(token && !JSON.stringify(config).includes(token));
    } catch { /* Scenario reports the constant configuration failure. */ }
    void scenario().catch(async () => { try { await report(); } catch {} emit({ type: 'error', error: { message: 'Fixture native MCP scenario failed.' } }); process.exitCode = 1; });
  });
}

async function report() {
  process.stderr.write(`Fixture native phase=${phase} ownHttp=${ownHTTPCount}\n`);
  const value = process.env.OD_FAKE_NATIVE_REPORT_URL;
  if (!value) return;
  const url = new URL(value); if (url.hostname !== '127.0.0.1') throw new Error('Observer must be local.');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    token, pid: process.pid, args, phase, ownHTTPCount, ownStdioCount: 0, privateHeaderOnly, headerMatchesEnv,
    snapshotSucceeded, inspectSucceeded, screenshotSucceeded, snapshotGuidanceObserved,
    stdinPromptReceived: true, stdinPromptContainsToken: promptContainsToken,
  }) }); await response.arrayBuffer();
}

async function scenario() {
  if (!token || !own || ownHTTPCount !== 1 || !privateHeaderOnly || promptContainsToken || args.some(arg => arg.includes(token))) throw new Error('Invalid private config.');
  const url = new URL(String(own.url));
  if (url.origin !== process.env.OD_DAEMON_URL || url.pathname !== '/mcp') throw new Error('Invalid authority.');
  headerMatchesEnv = kind === 'codex' ? own.bearer_token_env_var === 'OD_TOOL_TOKEN'
    : (own.headers as Record<string, unknown>)?.Authorization === 'Bearer {env:OD_TOOL_TOKEN}';
  if (!headerMatchesEnv) throw new Error('Invalid native header reference.');
  const client = new Client({ name: 'native-product-fixture', version: '1' });
  try {
    phase = 'mcp-connect';
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    snapshotGuidanceObserved = tools.tools.find(tool => tool.name === 'browser_snapshot')?.description?.includes('For browser interaction required by the task, prefer the available OpenDesign MCP tools') === true;
    phase = 'snapshot'; snapshotSucceeded = !(await client.callTool({ name: 'browser_snapshot', arguments: {} })).isError;
    phase = 'inspect'; inspectSucceeded = !(await client.callTool({ name: 'browser_inspect', arguments: { target: { selector: 'body' } } })).isError;
    phase = 'screenshot'; const screenshot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    screenshotSucceeded = !screenshot.isError && Array.isArray(screenshot.content) && screenshot.content.some(part => part.type === 'image' && part.mimeType === 'image/png');
    if (!snapshotSucceeded || !inspectSucceeded || !screenshotSucceeded) throw new Error('Browser reads failed.');
    const pieces = ['Native MCP reads succeeded. ', token.slice(0, 12), token.slice(12), ' Ordinary native response retained.'];
    if (kind === 'codex') {
      for (const delta of pieces) notify('item/agentMessage/delta', { threadId, turnId, itemId: 'fixture-text', delta });
      for (const delta of [token.slice(0, 12), token.slice(12)]) notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'fixture-reasoning', summaryIndex: 0, delta });
      notify('item/completed', { threadId, turnId, item: { id: 'fixture-reasoning', type: 'reasoning', summary: [] } });
      notify('item/completed', { threadId, turnId, item: { id: 'fixture-native-tool', type: 'mcpToolCall', server: 'open-design-run', tool: 'browser_snapshot', arguments: { note: token }, result: { content: [{ type: 'text', text: token }] }, status: 'completed' } });
    } else {
      emit({ type: 'step_start', sessionID: 'ses_fixture_native', part: { id: 'fixture-step' } });
      for (const text of pieces) emit({ type: 'text', sessionID: 'ses_fixture_native', part: { id: 'fixture-text', type: 'text', text } });
      emit({ type: 'tool_use', sessionID: 'ses_fixture_native', part: { id: 'fixture-tool-part', callID: 'fixture-native-tool', type: 'tool', tool: 'read', state: { status: 'completed', input: { note: token }, output: token } } });
    }
    process.stderr.write(`fixture stderr ${token.slice(0, 12)}`); await new Promise<void>(resolve => setImmediate(resolve)); process.stderr.write(`${token.slice(12)} complete\n`);
    phase = 'complete'; await report();
    if (kind === 'codex') notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    else emit({ type: 'step_finish', sessionID: 'ses_fixture_native', part: { id: 'fixture-step', reason: 'stop', tokens: { input: 1, output: 1 } } });
  } finally { await client.close(); }
}

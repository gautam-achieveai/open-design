import fs from 'node:fs/promises';
import { BROWSER_MCP_TOOLING_DIRECTIVE } from '@open-design/contracts';

const args = process.argv.slice(2);
let stdinPromptReceived = false;
let stdinPromptContainsToken = false;
let stdinTail = '';
if (args.includes('--version')) process.stdout.write('2.1.312 (Claude Code fixture)\n');
else if (args.includes('--help')) process.stdout.write('--mcp-config --include-partial-messages --add-dir\n');
else if (args[0] === 'auth') process.stdout.write('{"loggedIn":true,"authMethod":"fixture"}\n');
else {

// The first actual stdin frame starts the scenario. No provider/account calls.
process.stdin.setEncoding('utf8');
let started = false;
process.stdin.on('data', (chunk: string) => {
  const token = process.env.OD_TOOL_TOKEN ?? '';
  stdinPromptReceived ||= chunk.length > 0;
  const input = stdinTail + chunk;
  stdinPromptContainsToken ||= Boolean(token && input.includes(token));
  stdinTail = token ? input.slice(-(token.length - 1)) : '';
  if (started) return;
  started = true;
  void scenario().catch(() => { process.stderr.write('Fixture MCP scenario failed.\n'); process.exitCode = 1; }).finally(() => {
    process.stdin.pause();
    process.stdin.destroy();
  });
});
}

async function scenario() {
  const token = process.env.OD_TOOL_TOKEN ?? '';
  const configPath = args[args.indexOf('--mcp-config') + 1];
  let phase = 'launch-contract';
  let httpStatus: number | null = null;
  let mcpErrorCode: number | string | null = null;
  let snapshotSucceeded = false;
  let inspectSucceeded = false;
  let screenshotSucceeded = false;
  let snapshotGuidanceObserved = false;
  const report = async () => {
    process.stderr.write(`Fixture phase=${phase} httpStatus=${httpStatus ?? 'none'} mcpErrorCode=${mcpErrorCode ?? 'none'} observerConfigured=${Boolean(process.env.OD_FAKE_CLAUDE_REPORT_URL)}\n`);
    if (!process.env.OD_FAKE_CLAUDE_REPORT_URL) return;
    // Only the explicitly supplied local observer receives private values.
    // The root driver persists an allowlisted boolean/count projection.
    const observer = new URL(process.env.OD_FAKE_CLAUDE_REPORT_URL);
    if (observer.hostname !== '127.0.0.1') throw new Error('observer must be local');
    const response = await fetch(observer, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, configPath, args, pid: process.pid, snapshotSucceeded, inspectSucceeded, screenshotSucceeded, snapshotGuidanceObserved,
        stdinPromptReceived, stdinPromptContainsToken, phase, httpStatus, mcpErrorCode }) });
    await response.arrayBuffer();
  };
  try {
  if (!configPath || !token) throw new Error('missing fixture launch contract');
  phase = 'read-config';
  const configText = await fs.readFile(configPath, 'utf8');
  const server = JSON.parse(configText).mcpServers['open-design-run'];
  if (configText.includes(token) || args.some(arg => arg.includes(token))) throw new Error('unsafe fixture launch');
  if (server.headers.Authorization !== 'Bearer ${OD_TOOL_TOKEN}') throw new Error('missing environment reference');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  let nextId = 0;
  const request = async (method: string, params: unknown) => {
    phase = method;
    const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }) });
    httpStatus = response.status;
    const text = await response.text();
    const frame = text.startsWith('data:') ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5)) : JSON.parse(text);
    const code = frame.error?.code;
    if (typeof code === 'number' || (typeof code === 'string' && /^[A-Z_]{1,64}$/u.test(code))) mcpErrorCode = code;
    if (!response.ok) throw new Error('fixture MCP rejected');
    if (frame.error) throw new Error('fixture MCP request error');
    return frame.result;
  };
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-product-fixture', version: '1' } });
  const listed = await request('tools/list', {});
  const listedSnapshot = listed.tools.find((tool: { name: string }) => tool.name === 'browser_snapshot');
  if (!listedSnapshot) throw new Error('snapshot not listed');
  snapshotGuidanceObserved = typeof listedSnapshot.description === 'string' && listedSnapshot.description.includes(BROWSER_MCP_TOOLING_DIRECTIVE);
  const snapshot = await request('tools/call', { name: 'browser_snapshot', arguments: {} });
  if (snapshot.isError || snapshot.structuredContent?.ok === false) {
    const code = snapshot.structuredContent?.error?.code;
    if (typeof code === 'string' && /^[A-Z_]{1,64}$/u.test(code)) mcpErrorCode = code;
    throw new Error('snapshot failed');
  }
  snapshotSucceeded = true;
  const mode = process.env.OD_FAKE_CLAUDE_MODE ?? 'normal';
  if (mode === 'read-journey') {
    const inspected = await request('tools/call', { name: 'browser_inspect', arguments: { target: { selector: 'body' } } });
    inspectSucceeded = !inspected.isError && inspected.structuredContent?.ok !== false;
    if (!inspectSucceeded) throw new Error('inspect failed');
    const screenshot = await request('tools/call', { name: 'browser_screenshot', arguments: {} });
    screenshotSucceeded = !screenshot.isError && screenshot.content?.some((content: { type: string; mimeType?: string; data?: string }) =>
      content.type === 'image' && content.mimeType === 'image/png' && Boolean(content.data));
    if (!screenshotSucceeded) throw new Error('screenshot failed');
  }
  if (mode === 'cancel-hold') {
    phase = 'cancel-hold';
    await report();
    await new Promise<void>(() => {});
  }
  if (mode === 'retry') {
    const statePath = process.env.OD_FAKE_CLAUDE_RETRY_STATE;
    if (!statePath) throw new Error('retry fixture state missing');
    let first = false;
    try { const file = await fs.open(statePath, 'wx'); await file.close(); first = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (first) {
      phase = 'retry-first-attempt';
      await report();
      process.stderr.write('HTTP 503 Service Unavailable before first token\n');
      process.exitCode = 1;
      return;
    }
  }
  phase = 'output';
  const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
  if (mode === 'invalid-id') {
    phase = 'invalid-id';
    await report();
    emit({ type: 'system', subtype: 'init', session_id: token, model: 'fixture' });
    return;
  }
  if (mode === 'error-frame') {
    phase = 'error-frame';
    await report();
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [token], raw: { detail: token } });
    return;
  }
  const text = (delta: string) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
  const split = Math.floor(token.length / 2);
  emit({ type: 'system', subtype: 'init', session_id: 'fixture-session', model: 'fixture' });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'fixture-message', usage: {} } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  text('MCP snapshot succeeded. ');
  text(token.slice(0, split));
  emit({ type: 'system', subtype: 'status', status: 'working' });
  text(token.slice(split));
  text(' Ordinary response retained.');
  emit({ type: 'assistant', message: { id: 'fixture-tool-message', content: [{ type: 'tool_use', id: 'fixture-tool-id', name: 'Read', input: { note: token, file_path: 'fixture.txt' } }], stop_reason: 'tool_use' } });
  process.stderr.write(`fixture stderr ${token.slice(0, split)}`);
  await new Promise<void>(resolve => setImmediate(resolve));
  process.stderr.write(`${token.slice(split)} complete\n`);
  phase = 'complete';
  await report();
  emit({ type: 'assistant', message: { id: 'fixture-final-message', content: [], stop_reason: 'end_turn' } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 1 } });
  } catch {
    try { await report(); } catch { /* Never include an exception or body in diagnostics. */ }
    throw new Error('fixture scenario failed');
  }
}

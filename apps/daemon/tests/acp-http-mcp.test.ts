import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAcpSession } from '../src/agent-protocol/acp/session.js';
import type { AcpMcpServerInput } from '../src/agent-protocol/acp/session-params.js';
import { buildAcpRunHttpMcpServer } from '../src/runtimes/mcp.js';

const token = 'od-acp-contract-opaque-token';
const ownStdio = { name: 'open-design-live-artifacts', command: 'od', args: ['mcp', 'live-artifacts'] };
const ownHttp = buildAcpRunHttpMcpServer('http://127.0.0.1:43123', token)!;

class AcpChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; return true; }
}

type Frame = { id: number; method: string; params: Record<string, unknown> };
const sessions: ReturnType<typeof attachAcpSession>[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.abort(); vi.restoreAllMocks(); });

function fixture(options: Partial<Parameters<typeof attachAcpSession>[0]> = {}) {
  const child = new AcpChild();
  const writes: Frame[] = [];
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  child.stdin.on('data', chunk => writes.push(JSON.parse(String(chunk))));
  const unsafe = vi.fn();
  const session = attachAcpSession({
    child: child as never, prompt: 'Read the fixture.', cwd: process.cwd(),
    mcpServers: [ownStdio], ownMcpServers: { stdio: ownStdio, http: ownHttp },
    runToolToken: token, onUnsafeOutput: unsafe,
    send: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }),
    ...options,
  });
  sessions.push(session);
  const receive = (frame: unknown) => child.stdout.write(`${JSON.stringify(frame)}\n`);
  const initialize = (http = true, version = '2.3.1') => receive({ id: 1, result: {
    agentInfo: { version }, agentCapabilities: { loadSession: true, mcpCapabilities: { http } },
  } });
  const ready = () => { initialize(); receive({ id: 2, result: { sessionId: 'session', openCodeSessionId: 'durable' } }); };
  return { child, writes, events, unsafe, session, receive, initialize, ready };
}

describe('ACP private run HTTP transport', () => {
  it.each([false, true])('replaces only own stdio and preserves external entries (load=%s)', load => {
    const external: AcpMcpServerInput[] = [
      { name: 'external-stdio', command: 'fixture-external', args: [] },
      { type: 'http', name: 'external-http', url: 'https://external.test/mcp', headers: { 'X-Fixture': 'external-value' } },
    ];
    const f = fixture({ mcpServers: [ownStdio, ...external], ...(load ? { resumeSessionId: 'prior-session' } : {}) });
    f.initialize();
    const request = f.writes.find(frame => frame.method === (load ? 'session/load' : 'session/new'))!;
    const servers = request.params.mcpServers as Record<string, unknown>[];
    expect(servers.map(server => server.name)).toEqual(['open-design-run', 'external-stdio', 'external-http']);
    expect(servers[0]?.type).toBe('http');
    expect(servers[0]?.url).toBe('http://127.0.0.1:43123/mcp');
    expect(JSON.stringify(servers[0]?.headers) === JSON.stringify([{ name: 'Authorization', value: `Bearer ${token}` }])).toBe(true);
    expect(servers[2]?.headers).toEqual([{ name: 'X-Fixture', value: 'external-value' }]);
    expect(JSON.stringify(servers.slice(1)).includes(token)).toBe(false);
    f.receive({ id: 2, result: load ? {} : { sessionId: 'new-session', openCodeSessionId: 'durable-session' } });
    const prompt = f.writes.find(frame => frame.method === 'session/prompt')!;
    expect(prompt.params.sessionId).toBe(load ? 'prior-session' : 'new-session');
    expect(JSON.stringify(prompt).includes(token)).toBe(false);
    expect(f.session.getDurableSessionId()).toBe(load ? null : 'durable-session');
  });

  it.each([['0.36.1', 1], ['2.3.1', 0]] as const)('keeps Kimi fallback policy for %s without HTTP capability', (version, count) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ stdioMcpRemovedInVersion: '0.37.0' });
    f.initialize(false, version);
    const request = f.writes.find(frame => frame.method === 'session/new')!;
    const servers = request.params.mcpServers as Record<string, unknown>[];
    expect(servers).toHaveLength(count);
    if (count) expect(servers[0]?.name).toBe('open-design-live-artifacts');
    expect(JSON.stringify(request).includes(token)).toBe(false);
    expect(JSON.stringify(warning.mock.calls).includes(token)).toBe(false);
  });

  it('rejects an external own-name collision before session dispatch without logging its descriptor', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ mcpServers: [ownStdio, { type: 'http', name: 'open-design-run', url: `https://external.test/${token}` }] });
    f.initialize();
    expect(f.session.hasFatalError()).toBe(true);
    expect(f.writes.some(frame => frame.method === 'session/new')).toBe(false);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
    expect(JSON.stringify(warning.mock.calls).includes(token)).toBe(false);
  });
});

describe('ACP token-bearing identity boundary', () => {
  it.each(['sessionId', 'openCodeSessionId'])('rejects %s before durable identity or prompt dispatch', field => {
    const f = fixture(); f.initialize();
    f.receive({ id: 2, result: { sessionId: 'session', [field]: token } });
    expect(f.unsafe).toHaveBeenCalledOnce();
    expect(f.session.hasFatalError()).toBe(true);
    expect(f.session.getDurableSessionId()).toBeNull();
    expect(f.writes.some(frame => frame.method === 'session/prompt')).toBe(false);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
  });

  it('rejects a tool identity before an observable tool is retained', () => {
    const f = fixture(); f.ready();
    f.receive({ method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate: 'tool_call', toolCallId: token, kind: 'read', title: 'Read fixture', status: 'in_progress',
    } } });
    expect(f.unsafe).toHaveBeenCalledOnce();
    expect(f.session.hasFatalError()).toBe(true);
    expect(f.events.some(event => event.payload.type === 'tool_in_flight' || event.payload.type === 'tool_use')).toBe(false);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
  });

  it('rejects a permission option identity before replying on stdin', () => {
    const f = fixture(); f.ready();
    const writes = f.writes.length;
    f.receive({ id: 40, method: 'session/request_permission', params: {
      sessionId: 'session', options: [{ optionId: token, kind: 'allow_once', name: 'Allow' }],
    } });
    expect(f.unsafe).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(writes);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
  });
});

describe('ACP guard terminal inputs', () => {
  it('flushes ordinary tool IDs before fatal callback, then emits the actual error payload', () => {
    const order: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    const f = fixture({ onTerminal: kind => { order.push(kind); }, send: (event, payload) => {
      const data = payload as Record<string, unknown>; payloads.push(data);
      if (data.type === 'tool_use' || data.type === 'tool_result' || event === 'error') order.push(event === 'error' ? 'error' : String(data.type));
    } });
    f.ready();
    f.receive({ method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'ordinary-tool', kind: 'read', title: 'Read fixture', status: 'in_progress', rawInput: { path: 'fixture.txt' },
    } } });
    f.receive({ id: 3, error: { code: -32603, message: 'fixture failure', data: { kind: 'fixture', retryable: false } } });
    expect(order.slice(-4)).toEqual(['tool_use', 'tool_result', 'fatal', 'error']);
    const displayedId = payloads.find(payload => payload.type === 'tool_use')?.id;
    expect(typeof displayedId).toBe('string');
    expect(payloads.find(payload => payload.type === 'tool_result')?.toolUseId).toBe(displayedId);
    expect(payloads.at(-1)?.error).toMatchObject({ message: 'json-rpc id 3: fixture failure', retryable: false, details: { kind: 'fixture' } });
    const count = payloads.length;
    f.receive({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } } });
    expect(payloads).toHaveLength(count);
  });

  it('guards split stderr before it is retained in an early-close error', () => {
    const f = fixture(); f.ready();
    f.child.stderr.write(`diagnostic ${token.slice(0, 9)}`);
    f.child.stderr.write(`${token.slice(9)} complete`);
    f.child.emit('close', 1, null);
    expect(f.session.hasFatalError()).toBe(true);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
    expect(JSON.stringify(f.events)).toContain('diagnostic');
    expect(JSON.stringify(f.events)).toContain('complete');
  });
});

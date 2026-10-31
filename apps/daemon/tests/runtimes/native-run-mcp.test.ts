import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachCodexAppServerSession } from '../../src/agent-protocol/codex-app-server/session.js';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';
import { buildCodexRunMcpConfig, composeOpenCodeRunMcpConfig } from '../../src/runtimes/mcp.js';

const daemonUrl = 'http://127.0.0.1:1234';
const token = 'synthetic-exact-run-credential';
const ownKey = 'mcp_servers.open-design-run';

function codexSession(resumeSessionId: string | null = null, requireRunMcpConfig = false, provideRunMcpConfig = true) {
  const stdout = new EventEmitter();
  const frames: Record<string, any>[] = [];
  const events: Record<string, unknown>[] = [];
  const unsafe = vi.fn();
  const end = vi.fn();
  const session = attachCodexAppServerSession({
    child: { stdout, stdin: {
      write: (chunk, callback) => { frames.push(JSON.parse(chunk)); callback?.(); }, end,
    } },
    prompt: 'Browser task', cwd: '/workspace', sandboxMode: 'read-only', resumeSessionId,
    ...(provideRunMcpConfig ? { runMcpConfig: buildCodexRunMcpConfig({ daemonUrl,
      externalConfig: { mcpServers: { external: { command: 'synthetic-external' } } } }) } : {}),
    requireRunMcpConfig,
    runToolToken: token, onUnsafeOutput: unsafe, onAgentEvent: event => events.push(event),
  });
  const sent = (method: string) => frames.find(frame => frame.method === method);
  const say = (frame: unknown) => stdout.emit('data', JSON.stringify(frame) + '\n');
  say({ id: sent('initialize')?.id, result: { userAgent: 'codex/0.164.0' } });
  return { session, frames, events, unsafe, end, sent, say };
}

function openCodeConfig(conversationId: string | null, runId: string, content: unknown = {}) {
  return JSON.parse(composeOpenCodeRunMcpConfig(JSON.stringify(content), daemonUrl, { conversationId, runId }));
}

describe('native run HTTP MCP', () => {
  it('uses additive Codex env references and rejects unsupported daemon server names explicitly', () => {
    const config = buildCodexRunMcpConfig({ daemonUrl,
      externalConfig: { mcpServers: { external: { command: 'synthetic', args: ['--stdio'] } } } });
    expect(config[ownKey]).toEqual({ url: daemonUrl + '/mcp', bearer_token_env_var: 'OD_TOOL_TOKEN', enabled: true, required: true });
    expect(config['mcp_servers.external']).toEqual({ command: 'synthetic', args: ['--stdio'], enabled: true });
    expect(config).not.toHaveProperty('mcp_servers');
    expect(JSON.stringify(config)).not.toContain(token);
    expect(() => buildCodexRunMcpConfig({ daemonUrl, externalConfig: {
      mcpServers: { 'unsupported.external': { command: 'synthetic' } },
    } })).toThrow('External MCP server ids for Codex must use only letters, numbers, _ or -.');
  });

  it('rejects every native/daemon Codex name collision before start or resume', () => {
    for (const resume of [null, 'existing-thread']) for (const name of ['open-design-run', 'external']) {
      const f = codexSession(resume);
      f.say({ id: f.sent('config/read')?.id, result: { config: { mcp_servers: {
        [name]: { command: 'native-external', tool_timeout_sec: null },
      } } } });
      expect(f.sent('thread/start')).toBeUndefined();
      expect(f.sent('thread/resume')).toBeUndefined();
      expect(f.end).toHaveBeenCalledOnce();
      expect(f.events).toEqual([{ type: 'error', message: name === 'open-design-run'
        ? 'OpenDesign MCP server name is reserved.'
        : 'External MCP server name already exists in native Codex configuration. Rename it in OpenDesign settings before retrying.' }]);
    }
  });

  it('keeps native Codex entries in place and sends the same additive overrides for start and resume', () => {
    for (const resume of [null, 'existing-thread']) {
      const f = codexSession(resume, true);
      expect(f.sent('config/read')?.params).toEqual({ includeLayers: false });
      f.say({ id: f.sent('config/read')?.id, result: { config: { mcp_servers: {
        'native.with.arbitrary.id': { command: 'native-external', tool_timeout_sec: null },
      } } } });
      const start = f.sent(resume ? 'thread/resume' : 'thread/start');
      expect(start?.params.config[ownKey]).toMatchObject({ bearer_token_env_var: 'OD_TOOL_TOKEN' });
      expect(start?.params.config['mcp_servers.external']).toMatchObject({ command: 'synthetic-external' });
      expect(start?.params.config).not.toHaveProperty('mcp_servers.native.with.arbitrary.id');
      expect(JSON.stringify(start)).not.toContain(token);
      f.session.abort();
    }
  });

  it('keeps the existing Codex fallback when config/read is unavailable', () => {
    const f = codexSession();
    f.say({ id: f.sent('config/read')?.id, error: { code: -32601, message: 'unsupported' } });
    expect(f.sent('thread/start')?.params.config).not.toHaveProperty(ownKey);
    expect(f.events).toEqual([{ type: 'diagnostic', name: 'codex_mcp_config_unavailable',
      message: 'Using native CLI configuration because MCP overrides are unavailable.' }]);
    f.session.abort();
  });

  it('fails an explicitly required Codex bundle before start or resume when its carrier is unavailable', () => {
    for (const resume of [null, 'existing-thread']) for (const carrier of ['unsupported', 'absent']) {
      const f = codexSession(resume, true, carrier !== 'absent');
      if (carrier === 'unsupported') f.say({ id: f.sent('config/read')?.id, error: { code: -32601, message: 'unsupported' } });
      expect(f.sent('thread/start')).toBeUndefined();
      expect(f.sent('thread/resume')).toBeUndefined();
      expect(f.end).toHaveBeenCalledOnce();
      expect(f.events).toEqual([{ type: 'error', message: 'Codex cannot deliver the requested run tool bundle. Update Codex or use a supported local daemon connection before retrying.' }]);
    }
  });

  it('preserves ordinary OpenCode names and uses one compact name stable across conversation resumes', () => {
    const external = { type: 'local', command: ['synthetic-external'] };
    const base = { permission: { bash: 'deny' }, mcp: { 'open-design-run': external } };
    const first = openCodeConfig('conversation-one', 'run-one', base);
    const key = Object.keys(first.mcp).find(name => name !== 'open-design-run')!;
    expect(key).toMatch(/^od_[0-9a-f]{32}$/u);
    expect((key + '_browser_network_failures').length).toBeLessThanOrEqual(64);
    expect(first.mcp['open-design-run']).toEqual(external);
    expect(first.permission).toEqual(base.permission);
    expect(first.mcp[key]).toEqual({ type: 'remote', url: daemonUrl + '/mcp', oauth: false,
      enabled: true, headers: { Authorization: 'Bearer {env:OD_TOOL_TOKEN}' } });
    expect(Object.keys(openCodeConfig('conversation-one', 'run-two').mcp)).toEqual([key]);
    expect(Object.keys(openCodeConfig('conversation-two', 'run-one').mcp)).not.toEqual([key]);
    expect(Object.keys(openCodeConfig(null, 'conversation-one').mcp)).not.toEqual([key]);
    expect(Object.keys(openCodeConfig(null, 'run-one').mcp)).not.toEqual(Object.keys(openCodeConfig(null, 'run-two').mcp));
    expect(JSON.stringify(first)).not.toContain(token);
  });

  it('rejects a generated OpenCode namespace collision and run-token forwarding', () => {
    const key = Object.keys(openCodeConfig('conversation-one', 'run-one').mcp)[0]!;
    expect(() => openCodeConfig('conversation-one', 'run-two', { mcp: { [key]: { enabled: false } } })).toThrow('reserved');
    expect(() => openCodeConfig('conversation-one', 'run-one', { mcp: {
      external: { headers: { Authorization: 'Bearer {env:OD_TOOL_TOKEN}' } },
    } })).toThrow('Run credentials cannot be forwarded');
  });

  it('rejects credential-bearing Codex identities before durable state or normalized events', () => {
    const f = codexSession();
    f.say({ id: f.sent('config/read')?.id, result: { config: {} } });
    f.say({ id: f.sent('thread/start')?.id, result: { thread: { id: 'thread-' + token, path: '/private/path' } } });
    expect(f.unsafe).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.session.getDurableSessionId()).toBeNull();
    expect(f.session.getLastSessionPath()).toBeNull();
    expect(f.sent('turn/start')).toBeUndefined();
    expect(JSON.stringify(f.events)).not.toContain(token);
  });

  it('retains ordinary OpenCode correlation IDs and latches unsafe identities before tool state', () => {
    const events: Record<string, unknown>[] = [];
    const unsafe = vi.fn();
    const stream = createJsonEventStreamHandler('opencode', event => events.push(event), {
      runToolToken: token, onUnsafeOutput: unsafe,
    });
    const tool = (callID: string) => JSON.stringify({ type: 'tool_use', sessionID: 'ses-native', part: {
      id: 'part-native', callID, type: 'tool', tool: 'read', state: { status: 'completed', input: {}, output: 'normal' },
    } }) + '\n';
    stream.feed(tool('ordinary-call'));
    expect(events.filter(event => event.id === 'ordinary-call' || event.toolUseId === 'ordinary-call').map(event => event.type)).toEqual(['tool_use', 'tool_result']);
    stream.feed(tool('unsafe-' + token));
    stream.feed(tool('late-call'));
    stream.flush();
    expect(unsafe).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain('late-call');
    expect(stream.childEvidenceCandidates()).toEqual([]);
  });
});

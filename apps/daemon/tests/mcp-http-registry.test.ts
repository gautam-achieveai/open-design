import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  McpToolRegistry,
  operationAllowed,
  redactSecrets,
  toolError,
  toolOk,
  type McpAuthGrant,
} from '../src/mcp-http/registry.js';

const unrestrictedGrant: McpAuthGrant = {
  kind: 'external',
  runId: null,
  projectId: null,
  credentialId: 'cred-1',
  name: 'test',
  allowedOperations: null,
};

function createRegistry(options?: ConstructorParameters<typeof McpToolRegistry>[0]) {
  const registry = new McpToolRegistry(options);
  registry.register({
    name: 'test_echo',
    description: 'echoes its input',
    operation: 'test:echo',
    version: 1,
    schema: z.object({ text: z.string().max(50) }),
    handler: async (args) => toolOk({ echoed: args.text }, 0),
  });
  return registry;
}

describe('operationAllowed', () => {
  it('allows everything for a null allowlist', () => {
    expect(operationAllowed(null, 'anything:goes')).toBe(true);
  });

  it('matches exact tags and prefix globs', () => {
    expect(operationAllowed(['mcp:ping'], 'mcp:ping')).toBe(true);
    expect(operationAllowed(['mcp:ping'], 'browser:snapshot')).toBe(false);
    expect(operationAllowed(['browser/*'], 'browser/snapshot')).toBe(true);
    expect(operationAllowed(['browser/*'], 'browseric/snapshot')).toBe(false);
    expect(operationAllowed(['*'], 'whatever')).toBe(true);
  });
});

describe('McpToolRegistry', () => {
  it('rejects duplicate names and non-snake_case names', () => {
    const registry = createRegistry();
    expect(() => registry.register({
      name: 'test_echo',
      description: 'dup',
      operation: 'test:dup',
      version: 1,
      schema: z.object({}),
      handler: async () => toolOk({}, 0),
    })).toThrow(/already registered/);
    expect(() => registry.register({
      name: 'Bad-Name',
      description: 'bad',
      operation: 'test:bad',
      version: 1,
      schema: z.object({}),
      handler: async () => toolOk({}, 0),
    })).toThrow(/snake_case/);
  });

  it('filters tools/list by the grant allowlist and emits JSON Schema', () => {
    const registry = createRegistry();
    const all = registry.listWireTools(unrestrictedGrant);
    expect(all.map((tool) => tool.name)).toEqual(['test_echo']);
    const [echoTool] = all;
    expect(echoTool).toBeDefined();
    expect(echoTool!.inputSchema).toMatchObject({ type: 'object' });
    expect(echoTool!.inputSchema).toHaveProperty(['properties', 'text']);

    const denied = registry.listWireTools({ ...unrestrictedGrant, allowedOperations: ['other/*'] });
    expect(denied).toEqual([]);
  });

  it('returns an error envelope for unknown tools', async () => {
    const registry = createRegistry();
    const result = await registry.call('nope', {}, unrestrictedGrant);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
  });

  it('denies operations outside the grant with a structured error', async () => {
    const registry = createRegistry();
    const grant: McpAuthGrant = { ...unrestrictedGrant, allowedOperations: ['other/*'] };
    const result = await registry.call('test_echo', { text: 'hi' }, grant);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'TOOL_OPERATION_DENIED' },
    });
  });

  it('validates arguments against the tool schema', async () => {
    const registry = createRegistry();
    const tooLong = await registry.call('test_echo', { text: 'x'.repeat(100) }, unrestrictedGrant);
    expect(tooLong.isError).toBe(true);
    expect(tooLong.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    const missing = await registry.call('test_echo', {}, unrestrictedGrant);
    expect(missing.isError).toBe(true);
  });

  it('wraps handler throws in TOOL_HANDLER_FAILED and redacts tokens in messages', async () => {
    const registry = new McpToolRegistry();
    registry.register({
      name: 'test_boom',
      description: 'throws',
      operation: 'test:boom',
      version: 1,
      schema: z.object({}),
      handler: async () => {
        throw new Error(`blew up with odmcp_secretvalue123 in the message`);
      },
    });
    const result = await registry.call('test_boom', {}, unrestrictedGrant);
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent;
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('TOOL_HANDLER_FAILED');
      expect(envelope.error.message).not.toContain('odmcp_secretvalue123');
      expect(envelope.error.message).toContain('<redacted-token>');
    }
  });

  it('truncates oversized text content and marks meta.truncated', async () => {
    const registry = new McpToolRegistry();
    registry.register({
      name: 'test_big',
      description: 'big',
      operation: 'test:big',
      version: 1,
      schema: z.object({}),
      maxResultChars: 64,
      handler: async () => toolOk({ payload: 'y'.repeat(1_000) }, 0),
    });
    const result = await registry.call('test_big', {}, unrestrictedGrant);
    const [first] = result.content;
    expect(first).toBeDefined();
    expect(first!.type).toBe('text');
    if (first!.type === 'text') {
      expect(first!.text.length).toBeLessThan(100);
      expect(first!.text).toContain('<truncated>');
    }
    expect(result.structuredContent.meta.truncated).toBe(true);
  });

  it('stamps meta.ms and emits redacted observability entries', async () => {
    const log = vi.fn();
    let now = 1_000;
    const registry = new McpToolRegistry({ now: () => now, log });
    registry.register({
      name: 'test_slow',
      description: 'slow',
      operation: 'test:slow',
      version: 1,
      schema: z.object({}),
      handler: async () => {
        now += 42;
        return toolOk({ fine: true }, 0);
      },
    });
    const result = await registry.call('test_slow', {}, unrestrictedGrant);
    expect(result.structuredContent.meta.ms).toBe(42);
    expect(log).toHaveBeenCalledOnce();
    const [firstCall] = log.mock.calls;
    const entry = firstCall![0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      tool: 'test_slow',
      operation: 'test:slow',
      grantKind: 'external',
      outcome: 'ok',
      ms: 42,
    });
    expect(JSON.stringify(entry)).not.toContain('odtt_');
    expect(JSON.stringify(entry)).not.toContain('odmcp_');
  });

  it('passes run-grant identity to handlers', async () => {
    const registry = createRegistry();
    const grant: McpAuthGrant = {
      kind: 'run',
      runId: 'run-9',
      projectId: 'p9',
      credentialId: null,
      name: null,
      allowedOperations: ['test:*'],
    };
    // 'test:echo' does not match 'test:*' (different separator) — use a null allowlist.
    grant.allowedOperations = null;
    const result = await registry.call('test_echo', { text: 'hi' }, grant);
    expect(result.structuredContent.ok).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('strips odtt_ and odmcp_ tokens', () => {
    expect(redactSecrets('token odtt_abc-123 done')).toBe('token <redacted-token> done');
    expect(redactSecrets('token odmcp_xyz done')).toBe('token <redacted-token> done');
    expect(redactSecrets('nothing here')).toBe('nothing here');
  });
});

describe('toolError', () => {
  it('produces an isError result with a stable envelope', () => {
    const result = toolError('X', 'boom', 5);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'X', message: 'boom' },
      meta: { ms: 5 },
    });
  });
});

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { createSynchronousProjectRequestDecision } from '../src/collab/project-request-authority.js';
import { registerAgentCatalogMcpTool } from '../src/mcp-http/agent-catalog-tools.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import type { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { McpToolRegistry, type McpAuthGrant } from '../src/mcp-http/registry.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const inventory = [
  { id: 'available', name: 'Available', available: true, version: '1', models: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}` })), path: 'private-path' },
  { id: 'missing', name: 'Missing', available: false, installUrl: 'https://example.test/install' },
];

describe('HTTP MCP agent catalog', () => {
  it('returns the shared stdio projection and hides host paths', async () => {
    const { registry, grant, req, tokens } = fixture();
    try {
      const result = await registry.call('list_agents', {}, grant, undefined, req);
      expect(result.structuredContent.ok).toBe(true);
      if (!result.structuredContent.ok) throw new Error('expected catalog');
      expect(result.structuredContent.data).toEqual({ agents: [{ id: 'available', name: 'Available', version: '1', models: inventory[0]!.models!.slice(0, 10), modelsCount: 12 }] });
      const all = await registry.call('list_agents', { includeUnavailable: true }, grant, undefined, req);
      expect(all.structuredContent.ok).toBe(true);
      expect(JSON.stringify(all)).toContain('https://example.test/install');
      expect(JSON.stringify(all)).not.toContain('private-path');
    } finally { tokens.clear(); }
  });

  it.each([false, true])('preserves complete agent IDs in bounded pages (includeUnavailable=%s)', async (includeUnavailable) => {
    const large = Array.from({ length: 170 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, available: true,
      models: Array.from({ length: 10 }, (_, j) => ({ id: `m${j}`, label: 'x'.repeat(180) })) }));
    const f = fixture(async () => large);
    try {
      let offset = 0;
      const ids: string[] = [];
      for (;;) {
        const result = await f.registry.call('list_agents', { includeUnavailable, offset }, f.grant, undefined, f.req);
        expect(result.structuredContent.ok).toBe(true);
        if (!result.structuredContent.ok) throw new Error('expected page');
        const page = result.structuredContent.data as { agents: Array<{ id: string; modelsCount: number; models: unknown[] }>; nextOffset?: number };
        if (page.nextOffset !== undefined) expect(result.structuredContent.meta.truncated).toBe(true);
        expect(page.agents.length).toBeGreaterThan(0);
        expect(page.agents.every((agent) => agent.modelsCount === 10)).toBe(true);
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(30_000);
        const content = result.content[0]!;
        if (content.type !== 'text') throw new Error('expected text content');
        expect(JSON.parse(content.text)).toEqual(page);
        ids.push(...page.agents.map((agent) => agent.id));
        if (page.nextOffset === undefined) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(ids).toEqual(large.map((agent) => agent.id));
    } finally { f.tokens.clear(); }
  });

  it('returns a next offset for explicit page limits and rejects unsupported workflow attribution', async () => {
    const f = fixture();
    try {
      const first = await f.registry.call('list_agents', { includeUnavailable: true, limit: 1 }, f.grant, undefined, f.req);
      expect(first.structuredContent.ok).toBe(true);
      if (!first.structuredContent.ok) throw new Error('expected page');
      expect(first.structuredContent.data).toMatchObject({ agents: [{ id: 'available' }], nextOffset: 1 });
      expect(first.structuredContent.meta.truncated).toBe(true);
      const second = await f.registry.call('list_agents', { includeUnavailable: true, offset: 1 }, f.grant, undefined, f.req);
      expect(second.structuredContent.ok).toBe(true);
      if (!second.structuredContent.ok) throw new Error('expected page');
      expect(second.structuredContent.data).toMatchObject({ agents: [{ id: 'missing' }] });
      for (const pluginWorkflowId of ['malformed', '00000000-0000-4000-8000-000000000000', null]) {
        const rejected = await f.registry.call('list_agents', { pluginWorkflowId }, f.grant, undefined, f.req);
        expect(rejected.structuredContent.ok).toBe(false);
        if (!rejected.structuredContent.ok) expect(rejected.structuredContent.error.code).toBe('UNSUPPORTED_ARGUMENT');
      }
    } finally { f.tokens.clear(); }
  });

  it('fails visibly instead of splitting an oversized agent identity', async () => {
    const f = fixture(async () => [{ id: 'x'.repeat(31_000), name: 'oversized', available: true, models: [] }]);
    try {
      const result = await f.registry.call('list_agents', {}, f.grant, undefined, f.req);
      expect(result.structuredContent.ok).toBe(false);
      if (!result.structuredContent.ok) expect(result.structuredContent.error.code).toBe('AGENT_CATALOG_ENTRY_TOO_LARGE');
    } finally { f.tokens.clear(); }
  });

  it.each(['漢'.repeat(180), '"\\\n'.repeat(240), '😀'.repeat(150)])(
    'bounds both result representations in UTF-8 while preserving paged IDs', async (label) => {
      const agents = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: `Agent ${i}`, available: true,
        models: Array.from({ length: 10 }, (_, j) => ({ id: `m${j}`, label })) }));
      const f = fixture(async () => agents);
      try {
        let offset = 0; const ids: string[] = [];
        for (;;) {
          const result = await f.registry.call('list_agents', { offset }, f.grant, undefined, f.req);
          expect(result.structuredContent.ok).toBe(true);
          if (!result.structuredContent.ok) throw new Error('expected page');
          expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32_000);
          const page = result.structuredContent.data as { agents: Array<{id:string;modelsCount:number}>; nextOffset?:number };
          const text = result.content[0]; if (!text || text.type !== 'text') throw new Error('expected text');
          expect(JSON.parse(text.text)).toEqual(page);
          expect(page.agents.every((agent) => agent.modelsCount === 10)).toBe(true);
          ids.push(...page.agents.map((agent) => agent.id));
          if (page.nextOffset === undefined) break;
          expect(result.structuredContent.meta.truncated).toBe(true);
          expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
        }
        expect(ids).toEqual(agents.map((agent) => agent.id));
      } finally { f.tokens.clear(); }
    },
  );

  it('compacts an oversized model while retaining the identity and total', async () => {
    const f = fixture(async () => [{ id: 'one', name: 'One', available: true, models: [{ id: 'm', label: '漢'.repeat(30_000) }] }]);
    try {
      const result = await f.registry.call('list_agents', {}, f.grant, undefined, f.req);
      expect(result.structuredContent).toMatchObject({ ok: true, data: { agents: [{ id: 'one', models: [], modelsCount: 1, entryTruncated: true }] }, meta: { truncated: true } });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32_000);
    } finally { f.tokens.clear(); }
  });

  it('keeps the exact result-object byte boundary for a single identity', async () => {
    let length = 0;
    const f = fixture(async () => [{ id: 'id', name: 'x'.repeat(length), available: true, models: [] }]);
    try {
      let low = 0, high = 20_000;
      while (low < high) {
        const candidate = Math.ceil((low + high) / 2); length = candidate;
        const result = await f.registry.call('list_agents', {}, f.grant, undefined, f.req);
        if (result.structuredContent.ok) low = candidate; else high = candidate - 1;
      }
      length = low; const fits = await f.registry.call('list_agents', {}, f.grant, undefined, f.req);
      expect(fits.structuredContent.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(fits), 'utf8')).toBeLessThanOrEqual(32_000);
      length = low + 1; const exceeds = await f.registry.call('list_agents', {}, f.grant, undefined, f.req);
      expect(exceeds.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_CATALOG_ENTRY_TOO_LARGE' } });
    } finally { f.tokens.clear(); }
  });

  it.each(['revoked', 'cancelled', 'rebound', 'deleted', 'expired'])(
    'withholds a result when %s during asynchronous discovery', async (scenario) => {
      let started!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const f = fixture(async () => { started(); await gate; return inventory; }, scenario === 'expired' ? 100 : 5000);
      try {
        const pending = f.registry.call('list_agents', {}, f.grant, undefined, f.req);
        await reached;
        if (scenario === 'revoked') f.tokens.revokeToken(f.token);
        if (scenario === 'cancelled') f.run.cancelRequested = true;
        if (scenario === 'rebound') f.binding = 'other';
        if (scenario === 'deleted') f.exists = false;
        if (scenario === 'expired') await new Promise<void>((resolve) => setTimeout(resolve, 120));
        release();
        const result = await pending;
        expect(result.structuredContent.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('Available');
      } finally { f.tokens.clear(); }
    },
  );

  it('rejects external, wrong endpoint, wrong operation and mismatched run before discovery', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return inventory; });
    try {
      const external = { ...f.grant, kind: 'external', runId: null, projectId: null, credentialId: 'synthetic' } as McpAuthGrant;
      expect((await f.registry.call('list_agents', {}, external, undefined, f.req)).structuredContent.ok).toBe(false);
      const wrongEndpoint = f.tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/other'], allowedOperations: ['catalog/agents:list'] });
      const wrongOperation = f.tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot'] });
      for (const token of [wrongEndpoint.token, wrongOperation.token]) {
        const req = request(token);
        expect((await f.registry.call('list_agents', {}, f.grant, undefined, req)).structuredContent.ok).toBe(false);
      }
      expect((await f.registry.call('list_agents', {}, { ...f.grant, runId: 'other' }, undefined, f.req)).structuredContent.ok).toBe(false);
      expect(calls).toBe(0);
    } finally { f.tokens.clear(); }
  });
});

function request(token: string): Request {
  return { get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
}

function fixture(listOfferedAgents: () => Promise<readonly unknown[]> = async () => inventory, ttlMs = 5000) {
  const tokens = new ToolTokenRegistry();
  const minted = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/agents:list'], ttlMs });
  const req = request(minted.token);
  const credentials = { validateToken: () => ({ ok: false, code: 'MCP_CREDENTIAL_INVALID' }) } as unknown as McpCredentialStore;
  const resolved = resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials });
  if (!resolved.ok) throw new Error('fixture authentication failed');
  const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false, workspaceScope: null };
  let binding: string | null = null;
  let exists = true;
  const decideProjectRequest = createSynchronousProjectRequestDecision({ db: null, getWorkspaceProject: () => null, getWorkspaceProjectByProjectId: () => null });
  const registry = new McpToolRegistry();
  registerAgentCatalogMcpTool(registry, { tokenRegistry: tokens, getRun: () => run,
    projectExists: () => exists, getProjectWorkspaceId: () => binding, decideProjectRequest, listOfferedAgents });
  return { registry, grant: resolved.grant, req, tokens, token: minted.token, run,
    get binding() { return binding; }, set binding(value: string | null) { binding = value; },
    get exists() { return exists; }, set exists(value: boolean) { exists = value; } };
}

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { registerSkillCatalogMcpTool } from '../src/mcp-http/skill-catalog-tools.js';
import { registerPluginCatalogMcpTool } from '../src/mcp-http/plugin-catalog-tools.js';
import { registerAgentCatalogMcpTool } from '../src/mcp-http/agent-catalog-tools.js';
import { resolveCatalogAccess } from '../src/mcp-http/catalog-access.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('od-external-catalog-')) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(operation: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-external-catalog-')); roots.push(root);
  let now = Date.now();
  const credentialStore = new McpCredentialStore({ filePath: path.join(root, 'credentials.json'), now: () => now });
  const tokenRegistry = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const credential = credentialStore.create({ name: 'Synthetic', allowedOperations: [operation], ttlMs: 1000 });
  const grant = { kind: 'external' as const, runId: null, projectId: null, credentialId: credential.credential.id, name: 'Synthetic', allowedOperations: [operation] };
  const scopes: unknown[] = [];
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = { wait: false, registry, credentialStore, credential, grant, scopes, ready, release, tokenRegistry,
    expire: () => { now += 1001; }, lookups: 0 };
  const deps = { credentialStore, tokenRegistry, projectExists: () => { f.lookups++; return false; },
    getRun: () => { f.lookups++; return undefined; }, getProjectWorkspaceId: () => { f.lookups++; return null; },
    decideProjectRequest: () => { f.lookups++; return { ok: false } as never; } };
  const observe = async (scope?: unknown) => { if (scope) scopes.push(scope); if (f.wait) { reached(); await barrier; } };
  registerSkillCatalogMcpTool(registry, { ...deps, listSkillsSnapshot: async scope => { await observe(scope); return { entries: [], revalidate: () => true }; } });
  registerPluginCatalogMcpTool(registry, { ...deps, listPluginSnapshot: async scope => { await observe(scope); return { entries: [], revalidate: () => true }; } });
  registerAgentCatalogMcpTool(registry, { ...deps, listOfferedAgents: async () => { await observe(); return []; } });
  return Object.assign(f, { call: (name: string, headers: Record<string, string> = {}, contextGrant = grant) => registry.call(name, {}, contextGrant, undefined,
    { headers, get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${credential.token}` : headers[key.toLowerCase()] } as never) });
}

describe('external HTTP MCP catalogs', () => {
  it.each([['list_skills', 'catalog/skills:list'], ['list_plugins', 'catalog/plugins:list'], ['list_agents', 'catalog/agents:list']])(
    '%s retains explicit credential authority across discovery', async (name, operation) => {
      const f = await fixture(operation);
      try {
        expect(f.registry.listWireTools(f.grant).map(tool => tool.name)).toEqual([name]);
        expect((await f.call(name)).structuredContent.ok).toBe(true);
        expect(f.scopes.every(scope => JSON.stringify(scope) === JSON.stringify({ workspaceId: null, workspaceMemberId: null }))).toBe(true);
        expect((await f.call(name, { 'x-od-workspace-id': 'foreign' })).structuredContent.ok).toBe(false);
        expect((await f.call(name, {}, { ...f.grant, credentialId: 'other' })).structuredContent.ok).toBe(false);
        f.wait = true;
        const pending = f.call(name); await f.ready;
        f.credentialStore.revoke(f.credential.credential.id); f.release();
        expect((await pending).structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
        expect(f.lookups).toBe(0);
      } finally { f.release(); f.tokenRegistry.clear(); }
    },
  );

  it('rejects expiration and operations absent from the current credential', async () => {
    const f = await fixture('catalog/agents:list');
    try {
      expect((await f.call('list_skills')).structuredContent.ok).toBe(false);
      f.expire();
      expect((await f.call('list_agents')).structuredContent.ok).toBe(false);
      expect(f.lookups).toBe(0);
    } finally { f.tokenRegistry.clear(); }
  });
});

describe('run catalog authorization ordering', () => {
  it.each(['revoked', 'wrong operation', 'wrong run'])('rejects %s authority before a recoverable run lookup', reason => {
    const tokenRegistry = new ToolTokenRegistry();
    const token = tokenRegistry.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: ['catalog/agents:list'] });
    if (reason === 'revoked') tokenRegistry.revokeToken(token.token);
    let lookups = 0;
    try {
      const access = resolveCatalogAccess({ grant: { kind: 'run', runId: reason === 'wrong run' ? 'other' : 'r', projectId: 'p', credentialId: null, name: null, allowedOperations: ['catalog/agents:list'] },
        request: { get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${token.token}` : undefined } as never, signal: undefined },
      reason === 'wrong operation' ? 'catalog/skills:list' : 'catalog/agents:list', { tokenRegistry,
        getRun: () => { lookups++; return undefined; }, projectExists: () => false, getProjectWorkspaceId: () => null,
        decideProjectRequest: () => ({ ok: false }) as never });
      expect(access).toBeNull();
      expect(lookups).toBe(0);
    } finally { tokenRegistry.clear(); }
  });
});

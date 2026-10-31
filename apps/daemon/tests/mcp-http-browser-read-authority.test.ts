import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { createProjectRequestDecision, createSynchronousProjectRequestDecision } from '../src/collab/project-request-authority.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { createBrowserReadAuthority } from '../src/mcp-http/browser-read-authority.js';
import { registerBrowserMcpTools } from '../src/mcp-http/browser-tools.js';
import type { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { createBrowserCommandBroker } from '../src/services/browser-command-broker.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

describe('browser read authority at asynchronous boundaries', () => {
  it.each([
    'rebound', 'unbound-then-bound', 'cancelled', 'revoked-during-auth',
    'rebind-during-auth', 'cancel-during-auth', 'revoked-after-claim',
    'external-local-trust', 'external-revoked-during-auth', 'external-revoked-after-claim', 'screenshot-revoked-after-claim',
  ])('handles %s', async (scenario) => {
    const tokens = new ToolTokenRegistry();
    const screenshot = scenario.startsWith('screenshot');
    const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: [screenshot ? 'browser/screenshot' : 'browser/snapshot'] }).token;
    const externalToken = 'synthetic-external';
    let externalValid = true;
    const credentials = { validateToken: (candidate: string) => externalValid && candidate === externalToken
      ? { ok: true, credential: { id: 'ext', name: 'fixture', allowedOperations: ['browser/snapshot'] } }
      : { ok: false, code: 'MCP_CREDENTIAL_INVALID' } } as unknown as McpCredentialStore;
    const external = scenario.startsWith('external');
    const req = { query: {}, get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${external ? externalToken : token}` : undefined } as Request;
    const auth = resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error('fixture authentication failed');
    const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false,
      workspaceScope: { schemaVersion: 1 as const, projectId: 'p', source: 'persisted_project_binding' as const, workspaceId: 'w1', workspaceMemberId: 'alice' } as null | { schemaVersion: 1; projectId: string; source: 'persisted_project_binding'; workspaceId: string; workspaceMemberId: string } };
    let binding = { workspaceId: 'w1', createdByWorkspaceMemberId: 'alice', visibility: 'personal', resourceState: 'active' };
    if (scenario === 'rebound') binding = { ...binding, workspaceId: 'w2' };
    if (scenario === 'unbound-then-bound') run.workspaceScope = null;
    if (scenario === 'cancelled') run.cancelRequested = true;
    const deps = { db: null, getWorkspaceProject: () => binding, getWorkspaceProjectByProjectId: () => binding };
    const decide = createProjectRequestDecision(deps);
    const authorizeCurrentRead = createBrowserReadAuthority({ toolTokenRegistry: tokens, credentialStore: credentials,
      getRun: () => run, projectExists: () => true, getProjectWorkspaceId: () => binding.workspaceId,
      decideProjectRequest: createSynchronousProjectRequestDecision(deps) });
    let started!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delay = scenario.endsWith('during-auth');
    const broker = createBrowserCommandBroker();
    const lease = broker.registerTab({ projectId: 'p', tabId: 't', url: 'http://example.test', title: 'synthetic' }).leaseId;
    const registry = new McpToolRegistry();
    registerBrowserMcpTools(registry, { broker, authorizeCurrentRead, authorizeProject: async (request, projectId) => {
      const allowed = (await decide(request, projectId, { mode: 'read' })).ok;
      if (delay) { started(); await gate; }
      return allowed;
    } });
    try {
      const pending = registry.call(screenshot ? 'browser_screenshot' : 'browser_snapshot', { projectId: 'p', tabId: 't' }, auth.grant, undefined, req);
      if (delay) {
        await reached;
        if (external) externalValid = false;
        else if (scenario === 'rebind-during-auth') binding = { ...binding, workspaceId: 'w2' };
        else if (scenario === 'cancel-during-auth') run.cancelRequested = true;
        else tokens.revokeToken(token);
        release();
      }
      const dispatched = scenario.endsWith('after-claim') || scenario === 'external-local-trust';
      if (dispatched) {
        const command = await broker.nextCommand('p', 't', lease, 1000);
        expect(command).not.toBeNull();
        if (!command) throw new Error('fixture command missing');
        if (scenario === 'revoked-after-claim' || screenshot) tokens.revokeToken(token);
        if (scenario === 'external-revoked-after-claim') externalValid = false;
        broker.submitResult('p', 't', command.commandId, { leaseId: lease, ok: true,
          result: screenshot ? { operation: 'screenshot', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }
            : { operation: 'snapshot', snapshot: { text: 'synthetic page content' } } });
      }
      const result = await pending;
      expect(result.structuredContent.ok).toBe(scenario === 'external-local-trust');
      if (!dispatched) expect(await broker.nextCommand('p', 't', lease, 0)).toBeNull();
      if (scenario !== 'external-local-trust') expect(JSON.stringify(result)).not.toContain('synthetic page content');
      if (screenshot) expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo=');
    } finally { tokens.clear(); broker.shutdown(); }
  });
});

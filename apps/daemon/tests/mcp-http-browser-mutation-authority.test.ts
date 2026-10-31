import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { createProjectRequestDecision, createSynchronousProjectRequestDecision } from '../src/collab/project-request-authority.js';
import { createBrowserCommandBroker } from '../src/services/browser-command-broker.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { registerBrowserMcpTools } from '../src/mcp-http/browser-tools.js';
import { createBrowserReadAuthority } from '../src/mcp-http/browser-read-authority.js';
import { createApprovalPrincipalResolver } from '../src/mcp-http/approval-principal.js';
import { createMcpApprovalStore } from '../src/mcp-http/approval-store.js';
import { McpToolRegistry } from '../src/mcp-http/registry.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

describe('approved browser mutation result authority', () => {
  const cases = (['evaluate', 'devtools'] as const).flatMap((kind) =>
    (['valid', 'revoke', 'cancel', 'rebind', 'repin'] as const).flatMap((mode) =>
      [true, false].map((success) => ({ kind, mode, success }))));

  it.each(cases)('$kind $mode success=$success', async ({ kind, mode, success }) => {
    const file = path.join(os.tmpdir(), `od-browser-mutation-${randomUUID()}.json`);
    const tokens = new ToolTokenRegistry();
    const credentials = new McpCredentialStore({ filePath: file });
    const token = tokens.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: [`browser/${kind}`] }).token;
    const request = { query: {}, get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined } as Request;
    const auth = resolveMcpGrant(request, { toolTokenRegistry: tokens, credentialStore: credentials });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error(auth.code);
    const run = { id: 'r', projectId: 'p', status: 'running', cancelRequested: false,
      workspaceScope: { schemaVersion: 1, projectId: 'p', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' } };
    const binding = { workspaceId: 'w1', createdByWorkspaceMemberId: 'alice', visibility: 'personal', resourceState: 'active' };
    const core = { db: null, getWorkspaceProject: () => binding, getWorkspaceProjectByProjectId: () => binding };
    const decide = createProjectRequestDecision(core);
    const synchronous = createSynchronousProjectRequestDecision(core);
    const authority = { toolTokenRegistry: tokens, credentialStore: credentials, getRun: () => run as never,
      projectExists: () => true, getProjectWorkspaceId: () => binding.workspaceId, decideProjectRequest: synchronous };
    const broker = createBrowserCommandBroker();
    const lease = broker.registerTab({ projectId: 'p', tabId: 't', url: 'http://127.0.0.1/', title: 'synthetic' }).leaseId;
    const store = createMcpApprovalStore();
    const registry = new McpToolRegistry();
    registerBrowserMcpTools(registry, {
      broker, authorizeCurrentRead: createBrowserReadAuthority(authority),
      authorizeProject: async (req, projectId) => (await decide(req, projectId, { mode: 'read' })).ok,
      approval: { store, resolveCurrentPrincipal: createApprovalPrincipalResolver(authority) },
    });
    const name = `browser_${kind}`;
    const args = kind === 'evaluate' ? { tabId: 't', expression: '1' } : { tabId: 't', action: 'cache-disable', params: { disabled: true } };
    try {
      const initial = await registry.call(name, args, auth.grant, undefined, request);
      expect(initial.structuredContent.ok).toBe(true);
      if (!initial.structuredContent.ok) throw new Error('approval not created');
      const id = (initial.structuredContent.data as { approvalRequestId: string }).approvalRequestId;
      expect(store.decide(id, 'approve', () => true).ok).toBe(true);
      const pending = registry.call(name, { ...args, approvalRequestId: id }, auth.grant, undefined, request);
      const command = await broker.nextCommand('p', 't', lease, 5000);
      expect(command).not.toBeNull();
      if (!command) throw new Error('not claimed');
      expect(store.get(id)?.status).toBe('consumed');
      if (mode === 'revoke') tokens.revokeToken(token);
      if (mode === 'cancel') run.cancelRequested = true;
      if (mode === 'rebind' || mode === 'repin') binding.workspaceId = 'w2';
      if (mode === 'repin') run.workspaceScope.workspaceId = 'w2';
      if (success) broker.submitResult('p', 't', command.commandId, { leaseId: lease, ok: true, result: kind === 'evaluate'
        ? { operation: 'evaluate', value: 'synthetic-private-result', type: 'string', truncated: false }
        : { operation: 'devtools', action: 'cache-disable', result: { value: 'synthetic-private-result' } } });
      else broker.submitResult('p', 't', command.commandId, { leaseId: lease, ok: false, error: { code: 'BAD_REQUEST', message: 'synthetic-private-error' } });
      const result = await pending;
      if (mode === 'valid') {
        expect(result.structuredContent.ok).toBe(success);
        expect(JSON.stringify(result)).toContain(success ? 'synthetic-private-result' : 'synthetic-private-error');
        const replay = await registry.call(name, { ...args, approvalRequestId: id }, auth.grant, undefined, request);
        expect(replay.structuredContent).toMatchObject({ ok: false, error: { code: 'APPROVAL_CONSUMED' } });
      } else {
        expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED', message: expect.stringContaining('may have executed') } });
        expect(JSON.stringify(result)).not.toContain('synthetic-private');
      }
      expect(store.get(id)?.status).toBe('consumed');
    } finally {
      tokens.clear(); store.close(); broker.shutdown();
      await rm(file, { force: true });
    }
  });

  it('withholds an already-claimed result after the external credential is revoked', async () => {
    const file = path.join(os.tmpdir(), `od-browser-mutation-${randomUUID()}.json`);
    const tokens = new ToolTokenRegistry();
    const credentials = new McpCredentialStore({ filePath: file });
    const external = credentials.create({ name: 'synthetic', allowedOperations: ['browser/evaluate'] });
    const headers: Record<string, string> = { authorization: `Bearer ${external.token}`, 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'alice' };
    const request = { query: {}, get: (key: string) => headers[key.toLowerCase()] } as Request;
    const auth = resolveMcpGrant(request, { toolTokenRegistry: tokens, credentialStore: credentials });
    if (!auth.ok) throw new Error(auth.code);
    const binding = { workspaceId: 'w1', createdByWorkspaceMemberId: 'alice', visibility: 'personal', resourceState: 'active' };
    const core = { db: null, getWorkspaceProject: () => binding, getWorkspaceProjectByProjectId: () => binding };
    const decide = createProjectRequestDecision(core);
    const authority = { toolTokenRegistry: tokens, credentialStore: credentials, getRun: () => null,
      projectExists: () => true, getProjectWorkspaceId: () => binding.workspaceId, decideProjectRequest: createSynchronousProjectRequestDecision(core) };
    const broker = createBrowserCommandBroker();
    const lease = broker.registerTab({ projectId: 'p', tabId: 't', url: 'http://127.0.0.1/', title: 'synthetic' }).leaseId;
    const store = createMcpApprovalStore();
    const registry = new McpToolRegistry();
    registerBrowserMcpTools(registry, { broker, authorizeCurrentRead: createBrowserReadAuthority(authority),
      authorizeProject: async (req, projectId) => (await decide(req, projectId, { mode: 'read' })).ok,
      approval: { store, resolveCurrentPrincipal: createApprovalPrincipalResolver(authority) } });
    const args = { projectId: 'p', tabId: 't', expression: '1' };
    try {
      const initial = await registry.call('browser_evaluate', args, auth.grant, undefined, request);
      if (!initial.structuredContent.ok) throw new Error('approval not created');
      const id = (initial.structuredContent.data as { approvalRequestId: string }).approvalRequestId;
      expect(store.decide(id, 'approve', () => true).ok).toBe(true);
      const pending = registry.call('browser_evaluate', { ...args, approvalRequestId: id }, auth.grant, undefined, request);
      const command = await broker.nextCommand('p', 't', lease, 5000);
      if (!command) throw new Error('not claimed');
      expect(credentials.revoke(external.credential.id)).toBe(true);
      broker.submitResult('p', 't', command.commandId, { leaseId: lease, ok: true, result: { operation: 'evaluate', value: 'synthetic-private-result', type: 'string', truncated: false } });
      const response = await pending;
      expect(response.structuredContent).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
      expect(JSON.stringify(response)).not.toContain('synthetic-private-result');
      expect(store.get(id)?.status).toBe('consumed');
    } finally {
      tokens.clear(); store.close(); broker.shutdown();
      await rm(file, { force: true });
    }
  });
});

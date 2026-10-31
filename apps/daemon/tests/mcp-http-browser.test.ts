import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BrowserOperationResult } from '@open-design/contracts';
import { createAuthorizeProjectRequest, createSynchronousProjectRequestDecision } from '../src/collab/project-request-authority.js';
import { createBrowserCommandBroker } from '../src/services/browser-command-broker.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';
import { registerBrowserMcpTools } from '../src/mcp-http/browser-tools.js';
import { createBrowserReadAuthority } from '../src/mcp-http/browser-read-authority.js';
import { McpToolRegistry, operationAllowed, toolOk, type McpToolLogEntry } from '../src/mcp-http/registry.js';
import { registerMcpCredentialRoutes, registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { createMcpApprovalStore } from '../src/mcp-http/approval-store.js';
import { registerMcpApprovalRoutes } from '../src/mcp-http/approval-routes.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe('browser MCP HTTP', () => {
  let server: http.Server;
  let base: string;
  let registry: McpToolRegistry;
  let tokens: ToolTokenRegistry;
  let credentials: McpCredentialStore;
  let broker: ReturnType<typeof createBrowserCommandBroker>;
  let lease: string;
  let now: number;
  let logs: McpToolLogEntry[];
  let approvals: ReturnType<typeof createMcpApprovalStore>;
  let allowWrite: boolean;

  beforeEach(async () => {
    now = Date.now();
    tokens = new ToolTokenRegistry();
    credentials = new McpCredentialStore({ filePath: path.join(os.tmpdir(), `od-mcp-browser-${randomUUID()}.json`), now: () => now });
    broker = createBrowserCommandBroker();
    lease = broker.registerTab({ projectId: 'p1', tabId: 't1', url: 'http://example.test', title: 'Test' }).leaseId;
    logs = [];
    allowWrite = true;
    approvals = createMcpApprovalStore({ now: () => now });
    registry = new McpToolRegistry({ log: (entry) => logs.push(entry) });
    const binding = { workspaceId: 'w1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'alice' };
    const authority = createAuthorizeProjectRequest({
      db: null, getWorkspaceProject: () => binding, getWorkspaceProjectByProjectId: () => binding,
      sendApiError: () => undefined,
    });
    const writeDecision = createSynchronousProjectRequestDecision({
      db: null, getWorkspaceProject: () => binding, getWorkspaceProjectByProjectId: () => binding,
    });
    registerBrowserMcpTools(registry, {
      broker,
      authorizeCurrentRead: createBrowserReadAuthority({
        toolTokenRegistry: tokens, credentialStore: credentials,
        getRun: (runId) => ({ id: runId, projectId: 'p1', status: 'running',
          workspaceScope: { schemaVersion: 1, projectId: 'p1', source: 'persisted_project_binding', workspaceId: 'w1', workspaceMemberId: 'alice' } }),
        projectExists: (projectId) => projectId === 'p1', getProjectWorkspaceId: () => binding.workspaceId,
        decideProjectRequest: writeDecision,
      }),
      authorizeProject: async (req, projectId) => projectId === 'p1'
        && await authority(req, {} as import('express').Response, projectId, { mode: 'read' }),
      approval: {
        store: approvals,
        resolveCurrentPrincipal: (req, projectId, operation) => {
          const auth = resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials });
          if (!allowWrite || !auth.ok || projectId !== 'p1' || !operationAllowed(auth.grant.allowedOperations, operation)
            || !writeDecision(req, projectId, { mode: 'write', capability: 'writeFiles' }).ok) {
            return { ok: false, code: 'FORBIDDEN', message: 'current authority denied' };
          }
          const grant = auth.grant;
          const id = grant.kind === 'run' ? grant.runId : grant.credentialId;
          if (!id || (grant.kind === 'run' && grant.projectId !== projectId)) return { ok: false, code: 'FORBIDDEN', message: 'current authority denied' };
          const workspaceId = req.get('x-od-workspace-id');
          const workspaceMemberId = req.get('x-od-workspace-member-id');
          if (!!workspaceId !== !!workspaceMemberId) return { ok: false, code: 'FORBIDDEN', message: 'incomplete workspace scope' };
          const scope = workspaceId && workspaceMemberId ? { workspaceId, workspaceMemberId } : null;
          return { ok: true, principal: { kind: grant.kind, id, projectId, scope } };
        },
      },
    });
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    registerMcpHttpRoutes(app, {
      registry,
      resolveGrant: (req) => resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: credentials }),
      serverInfo: { name: 'open-design', version: 'test' },
    });
    registerMcpCredentialRoutes(app, { credentialStore: credentials });
    registerMcpApprovalRoutes(app, {
      store: approvals, authorize: async () => allowWrite, authorizeCurrent: () => allowWrite,
      targetCurrent: (target) => broker.isApprovalTargetCurrent(target, approvals.captureTarget.bind(approvals)),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    tokens.clear();
    approvals.close();
    broker.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(token: string, body: unknown, options: { signal?: AbortSignal; denied?: boolean; scope?: boolean } = {}) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18',
        ...(options.denied ? { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'bob' } : {}),
        ...(options.scope ? { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'alice' } : {}),
      },
      body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  function call(token: string, name: string, args: object, options: { signal?: AbortSignal; denied?: boolean; scope?: boolean } = {}) {
    return post(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, options);
  }
  async function result(response: Response) {
    expect(response.status).toBe(200);
    return (await response.json() as { result: { isError?: boolean; _meta?: Record<string, unknown>; content: Array<{ type: string; data?: string; text?: string; mimeType?: string }>; structuredContent: { ok: boolean; data?: Record<string, unknown>; error?: { code: string }; meta: { truncated?: boolean } } } }).result;
  }
  async function renderedCall(token: string, name: string, args: object, rendered: BrowserOperationResult) {
    const waiting = broker.nextCommand('p1', 't1', lease);
    const response = call(token, name, { projectId: 'p1', tabId: 't1', ...args });
    const command = await waiting;
    expect(command).not.toBeNull();
    broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: rendered });
    return result(await response);
  }

  it('delivers tool-first guidance through the authorized native tool catalog', async () => {
    const { token } = tokens.mint({ runId: 'browser-guidance', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot'] });
    const response = await post(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(response.status).toBe(200);
    const { result: { tools } } = await response.json() as { result: { tools: Array<{ name: string; description?: string }> } };
    expect(tools.map(tool => tool.name)).toEqual(['browser_snapshot']);
    const description = tools[0]!.description;
    expect(description).not.toMatch(/[\r\n]/);
    expect(description).toContain('prefer the available OpenDesign MCP tools');
    expect(description).toContain('If listed and authorized');
    expect(description).toContain('browser_inspect');
    expect(description).toContain('browser_screenshot');
    expect(description).toContain('plus the returned approvalRequestId');
  });

  it('returns snapshots, inspections and PNG images through the HTTP broker path', async () => {
    const { token } = tokens.mint({ runId: 'browser-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot', 'browser/inspect', 'browser/screenshot'] });
    const snapshot = await renderedCall(token, 'browser_snapshot', {}, { operation: 'snapshot', snapshot: { text: 'hello' } });
    expect(snapshot.structuredContent.data).toEqual({ operation: 'snapshot', snapshot: { text: 'hello' } });
    const inspect = await renderedCall(token, 'browser_inspect', { target: { selector: '#a' } }, { operation: 'inspect', inspection: { role: 'button' } });
    expect(inspect.structuredContent.data).toEqual({ operation: 'inspect', inspection: { role: 'button' } });
    const image = await renderedCall(token, 'browser_screenshot', {}, { operation: 'screenshot', mimeType: 'image/png', data: `data:image/png;base64,${png}` });
    expect(image.content).toEqual([{ type: 'image', mimeType: 'image/png', data: png }]);
    expect(image).not.toHaveProperty('structuredContent');
    expect(image).toMatchObject({ _meta: { 'open-design/result': { ok: true, data: { mimeType: 'image/png' } } } });
    expect(JSON.stringify(image._meta)).not.toContain(png);
    expect(JSON.stringify(logs)).not.toContain(png);
    const large = await renderedCall(token, 'browser_snapshot', {}, { operation: 'snapshot', snapshot: { text: 'x'.repeat(100_000) } });
    expect(large.structuredContent.meta.truncated).toBe(true);
    expect(JSON.stringify(large).length).toBeLessThan(32_000);
    expect(() => JSON.parse(large.content[0]!.text!)).not.toThrow();
    const invalidImage = await renderedCall(token, 'browser_screenshot', {}, { operation: 'screenshot', mimeType: 'image/png', data: 'bm90LXBuZw==' });
    expect(invalidImage.structuredContent.error?.code).toBe('INVALID_SCREENSHOT');
    const missing = await result(await call(token, 'browser_snapshot', { projectId: 'p1', tabId: 'missing' }));
    expect(missing.structuredContent.error?.code).toBe('BROWSER_TAB_NOT_FOUND');
  });

  it('denies cross-project calls, denied workspace access, and expired credentials', async () => {
    const run = tokens.mint({ runId: 'r1', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot'] });
    const cross = await result(await call(run.token, 'browser_snapshot', { projectId: 'p2', tabId: 't1' }));
    expect(cross.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const denied = await result(await call(run.token, 'browser_snapshot', { tabId: 't1' }, { denied: true }));
    expect(denied.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const external = credentials.create({ name: 'short', allowedOperations: ['browser/*'], ttlMs: 100 });
    const externalAccess = await result(await call(external.token, 'browser_snapshot', {}));
    expect(externalAccess.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    now += 101;
    const expired = await call(external.token, 'browser_snapshot', { projectId: 'p1' });
    expect(expired.status).toBe(401);
    tokens.revokeRun('r1');
    expect((await call(run.token, 'browser_snapshot', { tabId: 't1' })).status).toBe(401);
  });

  it('keeps oversized browser read results structured and reports omitted content', async () => {
    const token = tokens.mint({ runId: 'large-read', projectId: 'p1', allowedEndpoints: ['/mcp'],
      allowedOperations: ['browser/snapshot', 'browser/inspect', 'browser/console', 'browser/network-list', 'browser/network-get', 'browser/network-failures'] }).token;
    const entries = Array.from({ length: 500 }, (_, i) => ({ requestId: `req-${i}`, url: 'http://example.test/?code=[redacted]', text: 'x'.repeat(100) }));
    const scenarios: Array<{ name: string; args: object; rendered: BrowserOperationResult; field: string }> = [
      { name: 'browser_snapshot', args: {}, rendered: { operation: 'snapshot', snapshot: { document: { nodeName: 'HTML', children: entries }, truncated: false } }, field: 'snapshot' },
      { name: 'browser_inspect', args: { target: { selector: '#x' } }, rendered: { operation: 'inspect', inspection: { nodeName: 'DIV', text: 'x'.repeat(100_000) } }, field: 'inspection' },
      { name: 'browser_console', args: { limit: 1000 }, rendered: { operation: 'console', entries }, field: 'entries' },
      { name: 'browser_network_list', args: { limit: 1000 }, rendered: { operation: 'network-list', entries }, field: 'entries' },
      { name: 'browser_network_failures', args: { limit: 1000 }, rendered: { operation: 'network-failures', entries }, field: 'entries' },
      { name: 'browser_network_get', args: { requestId: 'req-1' }, rendered: { operation: 'network-get', entry: { requestId: 'req-1', responseBody: 'x'.repeat(100_000) } }, field: 'entry' },
    ];
    for (const scenario of scenarios) {
      const result = await renderedCall(token, scenario.name, scenario.args, scenario.rendered);
      expect(result.structuredContent.ok).toBe(true);
      expect(result.structuredContent.meta.truncated).toBe(true);
      const data = result.structuredContent.data!;
      expect(data.operation).toBe(scenario.rendered.operation);
      expect(data).toHaveProperty(scenario.field);
      expect(JSON.stringify(data).length).toBeLessThan(32_000);
      expect(JSON.stringify(result).length).toBeLessThan(32_000);
      expect(JSON.parse(result.content[0]!.text!)).toEqual(data);
      if (scenario.field === 'entries') {
        expect((data.entries as unknown[]).length).toBeGreaterThan(0);
        expect(data.omittedEntries).toBeGreaterThan(0);
        expect(JSON.stringify(data)).toContain('[redacted]');
        expect(JSON.stringify(data)).toContain('req-499');
      }
      if (scenario.field === 'snapshot') expect(data.snapshot).toMatchObject({ truncated: true, document: { nodeName: 'HTML' } });
      if (scenario.field === 'entry') expect(data.entry).toMatchObject({ requestId: 'req-1' });
    }
  });

  it('bounds a large escaped Unicode result and leaves valid JSON', async () => {
    const token = tokens.mint({ runId: 'unicode-read', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/inspect'] }).token;
    const result = await renderedCall(token, 'browser_inspect', { target: { selector: '#x' } }, {
      operation: 'inspect', inspection: { nodeName: 'DIV', text: '😀\\"'.repeat(100_000) },
    });
    expect(result.structuredContent.meta.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(32_000);
    const data = JSON.parse(result.content[0]!.text!);
    expect(data.operation).toBe('inspect');
    expect(data.inspection.nodeName).toBe('DIV');
    expect(data.inspection.text).toContain('[truncated]');
    expect(JSON.stringify(data)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i);
  });

  it('enforces the renderer PNG data URL and encoded-size boundaries', async () => {
    const { token } = tokens.mint({ runId: 'image-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/screenshot'] });
    const prefix = 'data:image/png;base64,';
    const maxChars = 3 * 1024 * 1024;
    const maxBase64 = Math.floor((maxChars - prefix.length) / 4) * 4;
    const maximumBytes = Buffer.alloc(maxBase64 / 4 * 3);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(maximumBytes);
    const atLimit = prefix + maximumBytes.toString('base64');
    expect(atLimit.length).toBeLessThanOrEqual(maxChars);
    const accepted = await renderedCall(token, 'browser_screenshot', {}, { operation: 'screenshot', mimeType: 'image/png', data: atLimit });
    expect(accepted.content[0]?.data).toBe(atLimit.slice(prefix.length));
    for (const data of [
      atLimit + 'AAAA',
      `data:image/jpeg;base64,${png}`,
      png,
      `${prefix}${png.slice(0, -3)}h==`, // non-canonical padding bits
      `${prefix}not*base64`,
      `${prefix}${Buffer.from('not a PNG').toString('base64')}`,
    ]) {
      const image = await renderedCall(token, 'browser_screenshot', {}, { operation: 'screenshot', mimeType: 'image/png', data });
      expect(image.structuredContent.error?.code).toBe('INVALID_SCREENSHOT');
    }
    const wrongMime = await renderedCall(token, 'browser_screenshot', {}, { operation: 'screenshot', mimeType: 'image/jpeg', data: `${prefix}${png}` });
    expect(wrongMime.structuredContent.error?.code).toBe('INVALID_SCREENSHOT');
  });

  it('allows a newly issued scoped external credential only for the selected authorized project', async () => {
    const issued = await fetch(`${base}/api/mcp/credentials`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'external', allowedOperations: ['browser/snapshot'] }),
    });
    expect(issued.status).toBe(201);
    const { token } = await issued.json() as { token: string };
    const snapshot = await renderedCall(token, 'browser_snapshot', {}, { operation: 'snapshot', snapshot: { text: 'external' } });
    expect(snapshot.structuredContent.data).toEqual({ operation: 'snapshot', snapshot: { text: 'external' } });
    const other = await result(await call(token, 'browser_snapshot', { projectId: 'p2' }));
    expect(other.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const denied = await result(await call(token, 'browser_snapshot', { projectId: 'p1' }, { denied: true }));
    expect(denied.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const unscoped = await result(await call(token, 'browser_inspect', { projectId: 'p1', target: { selector: '#a' } }));
    expect(unscoped.structuredContent.error?.code).toBe('TOOL_OPERATION_DENIED');
  });

  it('forwards console and network reads with their options and redacted renderer results', async () => {
    const operations = ['browser/console', 'browser/network-list', 'browser/network-get', 'browser/network-failures'];
    const { token } = tokens.mint({ runId: 'network-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: operations });
    // The renderer owns network redaction. This tests that its output is
    // preserved in both MCP representations, without re-masking page data.
    const entry = { requestId: 'request-1', url: 'https://example.invalid/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&keep=visible' };
    const scenarios: Array<{ name: string; args: Record<string, unknown>; command: Record<string, unknown>; rendered: BrowserOperationResult }> = [
      { name: 'browser_console', args: { level: 'error', limit: 10 }, command: { operation: 'console', level: 'error', limit: 10 }, rendered: { operation: 'console', entries: [{ message: 'visible' }] } },
      { name: 'browser_network_list', args: { resourceType: 'XHR', limit: 10 }, command: { operation: 'network-list', resourceType: 'XHR', limit: 10 }, rendered: { operation: 'network-list', entries: [entry] } },
      { name: 'browser_network_get', args: { requestId: 'request-1' }, command: { operation: 'network-get', requestId: 'request-1' }, rendered: { operation: 'network-get', entry } },
      { name: 'browser_network_failures', args: { limit: 10 }, command: { operation: 'network-failures', limit: 10 }, rendered: { operation: 'network-failures', entries: [entry] } },
    ];
    for (const scenario of scenarios) {
      const waiting = broker.nextCommand('p1', 't1', lease);
      const response = call(token, scenario.name, { tabId: 't1', ...scenario.args });
      const command = await waiting;
      expect(command?.request).toEqual(scenario.command);
      broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: scenario.rendered });
      const output = await result(await response);
      expect(output.structuredContent.data).toEqual(scenario.rendered);
      expect(JSON.parse(output.content[0]!.text!)).toEqual(scenario.rendered);
      expect(JSON.stringify(output)).toContain('visible');
    }
  });

  it('enforces read-tool argument, project and operation boundaries', async () => {
    const run = tokens.mint({ runId: 'read-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/network-get'] });
    const invalid = await result(await call(run.token, 'browser_network_get', { requestId: '' }));
    expect(invalid.structuredContent.error?.code).toBe('INVALID_ARGS');
    const cross = await result(await call(run.token, 'browser_network_get', { projectId: 'p2', requestId: 'request-1' }));
    expect(cross.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const denied = await result(await call(run.token, 'browser_console', {}));
    expect(denied.structuredContent.error?.code).toBe('TOOL_OPERATION_DENIED');
    const external = credentials.create({ name: 'network', allowedOperations: ['browser/network-list'] });
    const missingProject = await result(await call(external.token, 'browser_network_list', {}));
    expect(missingProject.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const tooLarge = await result(await call(external.token, 'browser_network_list', { projectId: 'p1', limit: 1001 }));
    expect(tooLarge.structuredContent.error?.code).toBe('INVALID_ARGS');
    const workspaceDenied = await result(await call(external.token, 'browser_network_list', { projectId: 'p1' }, { denied: true }));
    expect(workspaceDenied.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
  });

  it('approves and dispatches one exact click; altered requests and replay cannot consume it', async () => {
    const grant = tokens.mint({ runId: 'click-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/click'] });
    const args = { tabId: 't1', target: { selector: '#buy' } };
    const forged = await result(await call(grant.token, 'browser_click', { ...args, approved: true }));
    expect(forged.structuredContent.error?.code).toBe('INVALID_ARGS');
    const pending = await result(await call(grant.token, 'browser_click', args, { scope: true }));
    expect(pending.structuredContent.data?.status).toBe('approval_required');
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect(id).toBeTruthy();
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
    const pendingAgain = await result(await call(grant.token, 'browser_click', { ...args, approvalRequestId: id }, { scope: true }));
    expect(pendingAgain.structuredContent.data?.approvalRequestId).toBe(id);
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const changed = await result(await call(grant.token, 'browser_click', { ...args, target: { selector: '#other' }, approvalRequestId: id }, { scope: true }));
    expect(changed.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
    const changedButton = await result(await call(grant.token, 'browser_click', { ...args, button: 'right', approvalRequestId: id }, { scope: true }));
    expect(changedButton.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
    const changedTab = await result(await call(grant.token, 'browser_click', { ...args, tabId: 'other', approvalRequestId: id }, { scope: true }));
    expect(changedTab.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
    const scopeChanged = await result(await call(grant.token, 'browser_click', { ...args, approvalRequestId: id }));
    expect(scopeChanged.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
    const other = tokens.mint({ runId: 'other', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/click'] });
    const otherRun = await result(await call(other.token, 'browser_click', { ...args, approvalRequestId: id }, { scope: true }));
    expect(otherRun.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
    const waiting = broker.nextCommand('p1', 't1', lease);
    const first = call(grant.token, 'browser_click', { ...args, approvalRequestId: id }, { scope: true });
    const second = call(grant.token, 'browser_click', { ...args, approvalRequestId: id }, { scope: true });
    const command = await waiting;
    expect(command?.request).toEqual({ operation: 'click', approved: true, target: { selector: '#buy' }, button: 'left', clickCount: 1 });
    broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: { operation: 'click', clicked: true } });
    const outcomes = await Promise.all([first.then(result), second.then(result)]);
    expect(outcomes.filter((outcome) => outcome.structuredContent.data?.clicked === true)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.structuredContent.error?.code === 'APPROVAL_CONSUMED')).toHaveLength(1);
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('rechecks project authority and target lease before consuming a click approval', async () => {
    const grant = tokens.mint({ runId: 'click-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/click'] });
    const args = { tabId: 't1', target: { selector: '#a' } };
    const pending = await result(await call(grant.token, 'browser_click', args));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    allowWrite = false;
    const denied = await result(await call(grant.token, 'browser_click', { ...args, approvalRequestId: id }));
    expect(denied.structuredContent.error?.code).toBe('FORBIDDEN');
    expect(approvals.get(id)?.status).toBe('approved');
    allowWrite = true;
    broker.releaseLease('p1', 't1', lease);
    const replacement = broker.registerTab({ projectId: 'p1', tabId: 't1', url: 'http://example.test', title: 'Test' }).leaseId;
    const stale = await result(await call(grant.token, 'browser_click', { ...args, approvalRequestId: id }));
    expect(stale.structuredContent.error?.code).toBe('BROWSER_LEASE_CONFLICT');
    expect(await broker.nextCommand('p1', 't1', replacement, 0)).toBeNull();
    expect(approvals.get(id)?.status).toBe('approved');
  });

  it('denies expired and revoked approvals and accepts scoped external requests', async () => {
    const external = credentials.create({ name: 'external-click', allowedOperations: ['browser/click'] });
    const args = { projectId: 'p1', tabId: 't1', target: { selector: '#a' } };
    const pending = await result(await call(external.token, 'browser_click', args));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect(id).toBeTruthy();
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const waiting = broker.nextCommand('p1', 't1', lease);
    const accepted = call(external.token, 'browser_click', { ...args, approvalRequestId: id });
    const command = await waiting;
    expect(command?.request.operation).toBe('click');
    broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: { operation: 'click', clicked: true } });
    expect((await result(await accepted)).structuredContent.data?.clicked).toBe(true);
    const pendingExpired = await result(await call(external.token, 'browser_click', args));
    const expiredId = pendingExpired.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${expiredId}/approve`, { method: 'POST' })).status).toBe(200);
    now += 120_001;
    const expired = await result(await call(external.token, 'browser_click', { ...args, approvalRequestId: expiredId }));
    expect(expired.structuredContent.error?.code).toBe('APPROVAL_NOT_FOUND');
    const run = tokens.mint({ runId: 'revoked-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/click'] });
    const pendingRun = await result(await call(run.token, 'browser_click', { tabId: 't1', target: { selector: '#b' } }));
    const runId = pendingRun.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${runId}/approve`, { method: 'POST' })).status).toBe(200);
    tokens.revokeRun('revoked-run');
    expect((await call(run.token, 'browser_click', { tabId: 't1', target: { selector: '#b' }, approvalRequestId: runId })).status).toBe(401);
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('does not dispatch a locally denied click approval', async () => {
    const run = tokens.mint({ runId: 'denied-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/click'] });
    const args = { tabId: 't1', target: { selector: '#a' } };
    const pending = await result(await call(run.token, 'browser_click', args));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${id}/deny`, { method: 'POST' })).status).toBe(200);
    const denied = await result(await call(run.token, 'browser_click', { ...args, approvalRequestId: id }));
    expect(denied.structuredContent.error?.code).toBe('APPROVAL_DENIED');
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('approves exact type and navigate requests once without exposing private arguments in previews or logs', async () => {
    const run = tokens.mint({ runId: 'mutation-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/type', 'browser/navigate'] });
    const listResponse = await post(run.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((item) => item.name)).toEqual(expect.arrayContaining(['browser_type', 'browser_navigate']));
    const cases: Array<{ name: string; args: Record<string, unknown>; changed: Record<string, unknown>; command: Record<string, unknown>; rendered: BrowserOperationResult; outcomeKey: string; privateValue: string }> = [
      { name: 'browser_type', args: { tabId: 't1', target: { selector: '#input' }, text: 'synthetic-private-typed-text' }, changed: { tabId: 't1', target: { selector: '#input' }, text: 'changed' }, command: { operation: 'type', approved: true, target: { selector: '#input' }, text: 'synthetic-private-typed-text', clear: false }, rendered: { operation: 'type', typed: true }, outcomeKey: 'typed', privateValue: 'synthetic-private-typed-text' },
      { name: 'browser_navigate', args: { tabId: 't1', url: 'https://example.invalid/destination?code=synthetic-private-code' }, changed: { tabId: 't1', url: 'https://example.invalid/other' }, command: { operation: 'navigate', approved: true, url: 'https://example.invalid/destination?code=synthetic-private-code' }, rendered: { operation: 'navigate', url: 'https://example.invalid/destination' }, outcomeKey: 'url', privateValue: 'synthetic-private-code' },
    ];
    for (const scenario of cases) {
      const forged = await result(await call(run.token, scenario.name, { ...scenario.args, approved: true }));
      expect(forged.structuredContent.error?.code).toBe('INVALID_ARGS');
      const pending = await result(await call(run.token, scenario.name, scenario.args));
      const id = pending.structuredContent.data?.approvalRequestId as string;
      expect(pending.structuredContent.data?.status).toBe('approval_required');
      expect(JSON.stringify(pending)).not.toContain(scenario.privateValue);
      expect((pending.structuredContent.data?.approval as { partial: boolean }).partial).toBe(true);
      expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
      const pendingRetry = await result(await call(run.token, scenario.name, { ...scenario.args, approvalRequestId: id }));
      expect(pendingRetry.structuredContent.data?.approvalRequestId).toBe(id);
      expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
      const changed = await result(await call(run.token, scenario.name, { ...scenario.changed, approvalRequestId: id }));
      expect(changed.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
      const waiting = broker.nextCommand('p1', 't1', lease);
      const response = call(run.token, scenario.name, { ...scenario.args, approvalRequestId: id });
      const command = await waiting;
      expect(command?.request).toEqual(scenario.command);
      broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: scenario.rendered });
      expect((await result(await response)).structuredContent.data?.[scenario.outcomeKey]).toBeTruthy();
      const replay = await result(await call(run.token, scenario.name, { ...scenario.args, approvalRequestId: id }));
      expect(replay.structuredContent.error?.code).toBe('APPROVAL_CONSUMED');
      expect(JSON.stringify(logs)).not.toContain(scenario.privateValue);
    }
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('approves each remaining browser mutation for exactly the specified action', async () => {
    const run = tokens.mint({ runId: 'remaining-mutations', projectId: 'p1', allowedEndpoints: ['/mcp'],
      allowedOperations: ['browser/scroll', 'browser/viewport', 'browser/style', 'browser/evaluate', 'browser/devtools'] });
    const scenarios: Array<{ name: string; args: Record<string, unknown>; changed: Record<string, unknown>; command: Record<string, unknown>; rendered: BrowserOperationResult }> = [
      { name: 'browser_scroll', args: { deltaY: 100, target: { selector: '#a' } }, changed: { deltaY: 101, target: { selector: '#a' } }, command: { operation: 'scroll', approved: true, deltaX: 0, deltaY: 100, target: { selector: '#a' } }, rendered: { operation: 'scroll', scrolled: true } },
      { name: 'browser_viewport', args: { preset: 'mobile' }, changed: { preset: 'desktop' }, command: { operation: 'viewport', preset: 'mobile' }, rendered: { operation: 'viewport', preset: 'mobile', width: 390, height: 844 } },
      { name: 'browser_style', args: { target: { selector: '#a' }, styles: { color: 'red' } }, changed: { target: { selector: '#a' }, styles: { color: 'blue' } }, command: { operation: 'style', approved: true, target: { selector: '#a' }, styles: { color: 'red' } }, rendered: { operation: 'style', applied: true, inspection: {} } },
      { name: 'browser_evaluate', args: { expression: '1+1' }, changed: { expression: '1+2' }, command: { operation: 'evaluate', approved: true, expression: '1+1' }, rendered: { operation: 'evaluate', value: 2, type: 'number', truncated: false } },
      { name: 'browser_devtools', args: { action: 'cache-disable', params: { disabled: true } }, changed: { action: 'cache-disable', params: { disabled: false } }, command: { operation: 'devtools', approved: true, action: 'cache-disable', params: { disabled: true } }, rendered: { operation: 'devtools', action: 'cache-disable', result: {} } },
    ];
    for (const scenario of scenarios) {
      const args = { tabId: 't1', ...scenario.args };
      const forged = await result(await call(run.token, scenario.name, { ...args, approved: true }));
      expect(forged.structuredContent.error?.code).toBe('INVALID_ARGS');
      const pending = await result(await call(run.token, scenario.name, args));
      expect(pending.structuredContent.data?.status).toBe('approval_required');
      const id = pending.structuredContent.data?.approvalRequestId as string;
      expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
      expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
      const changed = await result(await call(run.token, scenario.name, { tabId: 't1', ...scenario.changed, approvalRequestId: id }));
      expect(changed.structuredContent.error?.code).toBe('APPROVAL_MISMATCH');
      const waiting = broker.nextCommand('p1', 't1', lease);
      const response = call(run.token, scenario.name, { ...args, approvalRequestId: id });
      const command = await waiting;
      expect(command?.request).toEqual(scenario.command);
      broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: scenario.rendered });
      expect((await result(await response)).structuredContent.data).toEqual(scenario.rendered);
      const replay = await result(await call(run.token, scenario.name, { ...args, approvalRequestId: id }));
      expect(replay.structuredContent.error?.code).toBe('APPROVAL_CONSUMED');
    }
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('keeps bounded mutation result discriminators and rechecks authority before publishing', async () => {
    const huge = '\u0001"\\😀'.repeat(25_000);
    const cases: Array<{ name: string; operation: string; args: Record<string, unknown>; rendered: BrowserOperationResult; expected: Record<string, unknown>; field: string }> = [
      { name: 'browser_evaluate', operation: 'evaluate', args: { expression: '1' }, rendered: { operation: 'evaluate', value: huge, type: 'string', truncated: false }, expected: { operation: 'evaluate', type: 'string', truncated: true }, field: 'value' },
      { name: 'browser_evaluate', operation: 'evaluate', args: { expression: '1' }, rendered: { operation: 'evaluate', value: '\\'.repeat(5292), type: 'string', truncated: false }, expected: { operation: 'evaluate', type: 'string', truncated: true }, field: 'value' },
      { name: 'browser_style', operation: 'style', args: { target: { selector: '#a' }, styles: { color: 'red' } }, rendered: { operation: 'style', applied: true, inspection: { text: huge } }, expected: { operation: 'style', applied: true }, field: 'inspection' },
      { name: 'browser_devtools', operation: 'devtools', args: { action: 'cache-disable', params: { disabled: true } }, rendered: { operation: 'devtools', action: 'cache-disable', result: { text: huge } }, expected: { operation: 'devtools', action: 'cache-disable' }, field: 'result' },
      { name: 'browser_click', operation: 'click', args: { target: { selector: '#a' } }, rendered: { operation: 'click', clicked: true, details: { text: huge } }, expected: { operation: 'click', clicked: true }, field: 'details' },
      { name: 'browser_type', operation: 'type', args: { target: { selector: '#a' }, text: 'x' }, rendered: { operation: 'type', typed: true, details: { text: huge } }, expected: { operation: 'type', typed: true }, field: 'details' },
      { name: 'browser_scroll', operation: 'scroll', args: { deltaY: 1 }, rendered: { operation: 'scroll', scrolled: true, details: { text: huge } }, expected: { operation: 'scroll', scrolled: true }, field: 'details' },
    ];
    for (const scenario of cases) for (const revoke of [false, true]) {
      const { token } = tokens.mint({ runId: `large-${scenario.operation}-${revoke}`, projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: [`browser/${scenario.operation}`] });
      const args = { tabId: 't1', ...scenario.args };
      const initial = await result(await call(token, scenario.name, args));
      const id = initial.structuredContent.data?.approvalRequestId as string;
      expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
      const waiting = broker.nextCommand('p1', 't1', lease);
      const pending = call(token, scenario.name, { ...args, approvalRequestId: id });
      const command = await waiting;
      expect(command).not.toBeNull();
      if (revoke) tokens.revokeToken(token);
      broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: scenario.rendered });
      const response = await pending;
      expect(response.status).toBe(200);
      const wire = await response.text();
      expect(wire.length).toBeLessThanOrEqual(32_000);
      const output = JSON.parse(wire).result.structuredContent;
      if (revoke) {
        expect(output).toMatchObject({ ok: false, error: { code: 'PROJECT_SCOPE_DENIED' } });
        expect(wire).not.toContain('[truncated]');
      } else {
        expect(output).toMatchObject({ ok: true, meta: { truncated: true }, data: scenario.expected });
        expect(output.data[scenario.field]).toBeDefined();
        expect(output.data.preview).toBeUndefined();
        expect(JSON.stringify(output.data[scenario.field])).toContain('[truncated]');
        expect((await result(await call(token, scenario.name, { ...args, approvalRequestId: id }))).structuredContent.error?.code).toBe('APPROVAL_CONSUMED');
      }
      expect(approvals.get(id)?.status).toBe('consumed');
    }
  });

  it('withholds a mismatched mutating DevTools result without allowing replay', async () => {
    const { token } = tokens.mint({ runId: 'devtools-mismatch', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/devtools'] });
    const args = { tabId: 't1', action: 'cache-disable', params: { disabled: true } };
    const initial = await result(await call(token, 'browser_devtools', args));
    const id = initial.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const waiting = broker.nextCommand('p1', 't1', lease);
    const pending = call(token, 'browser_devtools', { ...args, approvalRequestId: id });
    const command = await waiting;
    broker.submitResult('p1', 't1', command!.commandId, { leaseId: lease, ok: true, result: { operation: 'devtools', action: 'cache-clear', result: { secret: 'synthetic-private' } } });
    const output = await result(await pending);
    expect(output.structuredContent).toMatchObject({ ok: false, error: { code: 'BROWSER_RESULT_MISMATCH' } });
    expect(JSON.stringify(output)).not.toContain('synthetic-private');
    expect((await result(await call(token, 'browser_devtools', { ...args, approvalRequestId: id }))).structuredContent.error?.code).toBe('APPROVAL_CONSUMED');
  });

  it('validates remaining browser actions and permits read-only DevTools without an approval', async () => {
    const run = tokens.mint({ runId: 'browser-bounds', projectId: 'p1', allowedEndpoints: ['/mcp'],
      allowedOperations: ['browser/scroll', 'browser/viewport', 'browser/style', 'browser/evaluate', 'browser/devtools'] });
    const invalid = [
      ['browser_scroll', { target: { selector: 'x'.repeat(4097) } }],
      ['browser_viewport', { preset: 'custom' }],
      ['browser_style', { target: { selector: '#a' }, styles: { unknown: 'red' } }],
      ['browser_evaluate', { expression: ' ' }],
      ['browser_evaluate', { expression: 'x'.repeat(100_001) }],
      ['browser_devtools', { action: 'unknown' }],
      ['browser_devtools', { action: 'cache-disable', params: { data: 'x'.repeat(16_384) } }],
    ] as const;
    for (const [name, args] of invalid) {
      expect((await result(await call(run.token, name, { tabId: 't1', ...args }))).structuredContent.error?.code).toBe('INVALID_ARGS');
    }
    expect(approvals.list()).toHaveLength(0);
    const read = await renderedCall(run.token, 'browser_devtools', { action: 'status' }, { operation: 'devtools', action: 'status', result: { active: [] } });
    expect(read.structuredContent.data).toEqual({ operation: 'devtools', action: 'status', result: { active: [] } });
    const inappropriate = await result(await call(run.token, 'browser_devtools', { tabId: 't1', action: 'status', approvalRequestId: 'anything' }));
    expect(inappropriate.structuredContent.error?.code).toBe('INVALID_ARGS');
    const restricted = tokens.mint({ runId: 'no-devtools', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/scroll'] });
    const denied = await result(await call(restricted.token, 'browser_devtools', { action: 'status' }));
    expect(denied.structuredContent.error?.code).toBe('TOOL_OPERATION_DENIED');
  });

  it('rejects unsupported inputs and a pre-dispatch cancellation without consuming approval', async () => {
    const run = tokens.mint({ runId: 'mutation-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/type', 'browser/navigate'] });
    const oversized = await result(await call(run.token, 'browser_type', { target: { selector: '#a' }, text: 'x'.repeat(100_001) }));
    expect(oversized.structuredContent.error?.code).toBe('INVALID_ARGS');
    const badUrl = await result(await call(run.token, 'browser_navigate', { url: 'file:///secret' }));
    expect(badUrl.structuredContent.error?.code).toBe('INVALID_ARGS');
    const external = credentials.create({ name: 'external-type', allowedOperations: ['browser/type'] });
    const unscoped = await result(await call(external.token, 'browser_type', { target: { selector: '#a' }, text: 'text' }));
    expect(unscoped.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const args = { tabId: 't1', target: { selector: '#a' }, text: 'text' };
    const pending = await result(await call(run.token, 'browser_type', args));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const controller = new AbortController(); controller.abort();
    const req = { query: {}, get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${run.token}` : undefined } as import('express').Request;
    const grant = { kind: 'run' as const, runId: 'mutation-run', projectId: 'p1', credentialId: null, name: null, allowedOperations: ['browser/type', 'browser/navigate'] };
    const cancelled = await registry.call('browser_type', { ...args, approvalRequestId: id }, grant, controller.signal, req);
    expect(cancelled.structuredContent).toMatchObject({ ok: false, error: { code: 'BROWSER_COMMAND_CANCELED' } });
    expect(approvals.get(id)?.status).toBe('approved');
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('requires a current scoped external approval for navigation', async () => {
    const external = credentials.create({ name: 'external-navigate', allowedOperations: ['browser/navigate'] });
    const args = { projectId: 'p1', tabId: 't1', url: 'https://example.invalid/destination', waitUntil: 'load' };
    const noProject = await result(await call(external.token, 'browser_navigate', { tabId: 't1', url: args.url }));
    expect(noProject.structuredContent.error?.code).toBe('PROJECT_SCOPE_DENIED');
    const pending = await result(await call(external.token, 'browser_navigate', args, { scope: true }));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect(id).toBeTruthy();
    expect((await fetch(`${base}/api/mcp/approvals/${id}/deny`, { method: 'POST' })).status).toBe(200);
    const denied = await result(await call(external.token, 'browser_navigate', { ...args, approvalRequestId: id }, { scope: true }));
    expect(denied.structuredContent.error?.code).toBe('APPROVAL_DENIED');
    const next = await result(await call(external.token, 'browser_navigate', args, { scope: true }));
    const nextId = next.structuredContent.data?.approvalRequestId as string;
    expect((await fetch(`${base}/api/mcp/approvals/${nextId}/approve`, { method: 'POST' })).status).toBe(200);
    now += 120_001;
    const expired = await result(await call(external.token, 'browser_navigate', { ...args, approvalRequestId: nextId }, { scope: true }));
    expect(expired.structuredContent.error?.code).toBe('APPROVAL_NOT_FOUND');
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('rejects host-oversized selectors before creating or consuming an approval', async () => {
    const run = tokens.mint({ runId: 'selector-limits', projectId: 'p1', allowedEndpoints: ['/mcp'],
      allowedOperations: ['browser/type', 'browser/click', 'browser/snapshot', 'browser/inspect'] });
    const tooLong = 'x'.repeat(4097);
    for (const [name, extra] of [
      ['browser_type', { text: 'text' }], ['browser_click', {}], ['browser_snapshot', {}], ['browser_inspect', {}],
    ] as const) {
      const denied = await result(await call(run.token, name, { tabId: 't1', target: { selector: tooLong }, ...extra }));
      expect(denied.structuredContent.error?.code).toBe('INVALID_ARGS');
    }
    expect(approvals.list()).toHaveLength(0);
    const good = { tabId: 't1', target: { selector: 'x'.repeat(4096) }, text: 'text' };
    const snapshot = await renderedCall(run.token, 'browser_snapshot', { target: good.target }, { operation: 'snapshot', snapshot: { text: 'boundary' } });
    expect(snapshot.structuredContent.data).toEqual({ operation: 'snapshot', snapshot: { text: 'boundary' } });
    const inspection = await renderedCall(run.token, 'browser_inspect', { target: good.target }, { operation: 'inspect', inspection: { text: 'boundary' } });
    expect(inspection.structuredContent.data).toEqual({ operation: 'inspect', inspection: { text: 'boundary' } });
    const click = await result(await call(run.token, 'browser_click', { tabId: 't1', target: good.target }));
    expect(click.structuredContent.data?.status).toBe('approval_required');
    const pending = await result(await call(run.token, 'browser_type', good));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect(id).toBeTruthy();
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const retry = await result(await call(run.token, 'browser_type', { ...good, target: { selector: tooLong }, approvalRequestId: id }));
    expect(retry.structuredContent.error?.code).toBe('INVALID_ARGS');
    expect(approvals.get(id)?.status).toBe('approved');
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('checks the normalized navigation URL length before approval or dispatch', async () => {
    const run = tokens.mint({ runId: 'url-limits', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/navigate'] });
    const oversized = `https://example.invalid/${'é'.repeat(1400)}`;
    expect(oversized.length).toBeLessThan(8192);
    expect(new URL(oversized).toString().length).toBeGreaterThan(8192);
    const denied = await result(await call(run.token, 'browser_navigate', { tabId: 't1', url: oversized }));
    expect(denied.structuredContent.error?.code).toBe('INVALID_ARGS');
    expect(approvals.list()).toHaveLength(0);
    const prefix = 'https://example.invalid/';
    const validUrl = prefix + 'a'.repeat(8192 - prefix.length);
    expect(new URL(validUrl).toString()).toHaveLength(8192);
    const pending = await result(await call(run.token, 'browser_navigate', { tabId: 't1', url: validUrl }));
    const id = pending.structuredContent.data?.approvalRequestId as string;
    expect(id).toBeTruthy();
    expect((await fetch(`${base}/api/mcp/approvals/${id}/approve`, { method: 'POST' })).status).toBe(200);
    const retry = await result(await call(run.token, 'browser_navigate', { tabId: 't1', url: oversized, approvalRequestId: id }));
    expect(retry.structuredContent.error?.code).toBe('INVALID_ARGS');
    expect(approvals.get(id)?.status).toBe('approved');
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();
  });

  it('cancels before renderer claim but allows an already claimed command to finish', async () => {
    const before = new AbortController();
    const pendingBefore = broker.execute('p1', 't1', { operation: 'snapshot' }, undefined, before.signal);
    before.abort();
    await expect(pendingBefore).rejects.toMatchObject({ code: 'BROWSER_COMMAND_CANCELED' });
    expect(await broker.nextCommand('p1', 't1', lease, 0)).toBeNull();

    const after = new AbortController();
    const pendingAfter = broker.execute('p1', 't1', { operation: 'snapshot' }, undefined, after.signal);
    const command = await broker.nextCommand('p1', 't1', lease, 0);
    expect(command).not.toBeNull();
    after.abort();
    broker.submitResult('p1', 't1', command!.commandId, {
      leaseId: lease, ok: true, result: { operation: 'snapshot', snapshot: { text: 'completed' } },
    });
    await expect(pendingAfter).resolves.toMatchObject({ result: { snapshot: { text: 'completed' } } });
  });

  it('bounds renderer errors and does not log their content', async () => {
    const { token } = tokens.mint({ runId: 'error-run', projectId: 'p1', allowedEndpoints: ['/mcp'], allowedOperations: ['browser/snapshot'] });
    const waiting = broker.nextCommand('p1', 't1', lease);
    const response = call(token, 'browser_snapshot', { projectId: 'p1', tabId: 't1' });
    const command = await waiting;
    broker.submitResult('p1', 't1', command!.commandId, {
      leaseId: lease, ok: false,
      error: { code: 'BROWSER_COMMAND_FAILED', message: `private-renderer-value ${'x'.repeat(100_000)}` },
    });
    const failure = await result(await response);
    expect(failure.structuredContent.error?.code).toBe('BROWSER_COMMAND_FAILED');
    expect(failure.structuredContent.meta.truncated).toBe(true);
    expect(JSON.stringify(failure).length).toBeLessThan(32_000);
    expect(JSON.stringify(logs)).not.toContain('private-renderer-value');
  });

  it('cancels an in-flight tool when the HTTP client disconnects', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    registry.register({
      name: 'test_wait', description: 'wait for disconnect', operation: 'test:wait', version: 1,
      schema: z.object({}),
      handler: async (_args, context) => {
        started();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) { aborted(); resolve(); }
          else context.signal?.addEventListener('abort', () => { aborted(); resolve(); }, { once: true });
        });
        return toolOk({}, 0);
      },
    });
    const { token } = credentials.create({ name: 'cancel', allowedOperations: ['test:wait'] });
    const controller = new AbortController();
    const pending = call(token, 'test_wait', {}, { signal: controller.signal }).catch(() => null);
    await startedPromise;
    controller.abort();
    await abortedPromise;
    await pending;
  });
});

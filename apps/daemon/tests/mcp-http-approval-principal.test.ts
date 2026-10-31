import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import type { McpApprovalView } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalPrincipalResolver, createApprovalViewPrincipalCheck, type ApprovalRun } from '../src/mcp-http/approval-principal.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

function request(token: string, headers: Record<string, string> = {}): Request {
  const values = { ...headers, authorization: `Bearer ${token}` };
  return { get: (name: string) => values[name.toLowerCase() as keyof typeof values] } as unknown as Request;
}

describe('current approval principal', () => {
  let dir: string;
  let tokens: ToolTokenRegistry;
  let credentials: McpCredentialStore;
  let run: ApprovalRun | null;
  let workspace: string | null;
  let projectExists: boolean;
  let writeAllowed: boolean;
  let credentialNow: number;
  let seenScope: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-approval-principal-'));
    tokens = new ToolTokenRegistry();
    credentialNow = 10_000;
    credentials = new McpCredentialStore({ filePath: path.join(dir, 'credentials.json'), now: () => credentialNow });
    run = { id: 'run-a', projectId: 'project-a', status: 'running', workspaceScope: {
      schemaVersion: 1, projectId: 'project-a', workspaceId: 'workspace-a',
      workspaceMemberId: 'member-a', source: 'persisted_project_binding',
    } };
    workspace = 'workspace-a';
    projectExists = true;
    writeAllowed = true;
    seenScope = [];
  });

  afterEach(() => {
    tokens.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function resolver() {
    return createApprovalPrincipalResolver({
      toolTokenRegistry: tokens,
      credentialStore: credentials,
      getRun: () => run,
      projectExists: () => projectExists,
      getProjectWorkspaceId: () => workspace,
      decideProjectRequest: (req, _projectId, options) => {
        seenScope = [req.get('x-od-workspace-id') ?? '', req.get('x-od-workspace-member-id') ?? '', options.mode];
        return writeAllowed ? { ok: true } : { ok: false, status: 403, code: 'DENIED', message: 'denied' };
      },
    });
  }

  function runToken(options: { endpoint?: string; operation?: string; expired?: boolean } = {}) {
    return tokens.mint({
      runId: 'run-a', projectId: 'project-a',
      allowedEndpoints: [options.endpoint ?? '/mcp'],
      allowedOperations: [options.operation ?? 'browser/click'],
      ...(options.expired ? { nowMs: Date.now() - 2_000, ttlMs: 1_000 } : {}),
    }).token;
  }

  it('uses a pinned workspace and rejects altered or partial headers and rebound projects', () => {
    const token = runToken();
    const resolve = resolver();
    expect(resolve(request(token), 'project-a', 'browser/click')).toEqual({
      ok: true, principal: { kind: 'run', id: 'run-a', projectId: 'project-a',
        scope: { workspaceId: 'workspace-a', workspaceMemberId: 'member-a' } },
    });
    expect(seenScope).toEqual(['workspace-a', 'member-a', 'write']);
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-a' }), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-b', 'x-od-workspace-member-id': 'member-a' }), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-a', 'x-od-workspace-member-id': 'member-a' }), 'project-a', 'browser/click').ok).toBe(true);
    workspace = 'workspace-b';
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(token), 'project-b', 'browser/click').ok).toBe(false);
  });

  it('rechecks bearer audience, operation, run lifecycle, project and current write authority', () => {
    const resolve = resolver();
    expect(resolve(request(runToken({ endpoint: '/api/tools' })), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(runToken({ operation: 'browser/snapshot' })), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(runToken({ expired: true })), 'project-a', 'browser/click').ok).toBe(false);
    const token = runToken();
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(true);
    writeAllowed = false;
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    writeAllowed = true;
    projectExists = false;
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    projectExists = true;
    run = { id: 'run-a', projectId: 'project-a', status: 'succeeded' };
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    run = { id: 'run-a', projectId: 'project-a', status: 'running', cancelRequested: true };
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    tokens.revokeToken(token);
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
  });

  it('does not infer a scope for an unbound run or a later project binding', () => {
    const token = runToken();
    const resolve = resolver();
    run = { id: 'run-a', projectId: 'project-a', status: 'running', workspaceScope: null };
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    workspace = null;
    expect(resolve(request(token), 'project-a', 'browser/click')).toMatchObject({ ok: true, principal: { scope: null } });
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-a', 'x-od-workspace-member-id': 'member-a' }), 'project-a', 'browser/click').ok).toBe(false);
  });

  it('uses the current external credential identity and complete workspace scope', () => {
    const { token, credential } = credentials.create({ name: 'external', allowedOperations: ['browser/*'], ttlMs: 1_000 });
    const resolve = resolver();
    const scoped = request(token, { 'x-od-workspace-id': 'workspace-a', 'x-od-workspace-member-id': 'member-a' });
    expect(resolve(scoped, 'project-a', 'browser/click')).toMatchObject({ ok: true, principal: {
      kind: 'external', id: credential.id, projectId: 'project-a', scope: { workspaceId: 'workspace-a', workspaceMemberId: 'member-a' },
    } });
    expect(resolve(request(token), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-a' }), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(request(token, { 'x-od-workspace-id': 'workspace-b', 'x-od-workspace-member-id': 'member-a' }), 'project-a', 'browser/click').ok).toBe(false);
    expect(resolve(scoped, 'project-a', 'file/write').ok).toBe(false);
    credentialNow += 1_000;
    expect(resolve(scoped, 'project-a', 'browser/click').ok).toBe(false);
    const other = credentials.create({ name: 'revoked', allowedOperations: ['browser/click'] });
    credentials.revoke(other.credential.id);
    expect(resolve(request(other.token), 'project-a', 'browser/click').ok).toBe(false);
  });

  it('returns a bounded generic denial if authority throws', () => {
    const token = runToken();
    const resolve = createApprovalPrincipalResolver({
      toolTokenRegistry: tokens, credentialStore: credentials, getRun: () => run,
      projectExists: () => { throw new Error(`private ${token}`); },
      getProjectWorkspaceId: () => workspace,
      decideProjectRequest: () => ({ ok: true }),
    });
    const result = resolve(request(token), 'project-a', 'browser/click');
    expect(result).toEqual({ ok: false, code: 'PROJECT_SCOPE_DENIED', message: 'current project authority denied' });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('hides external approval records after credential expiry, revocation or operation denial', () => {
    const { credential } = credentials.create({ name: 'external', allowedOperations: ['browser/click'], ttlMs: 1_000 });
    const view: McpApprovalView = {
      id: 'approval', principal: { kind: 'external', id: credential.id }, projectId: 'project-a',
      scope: { workspaceId: 'workspace-a', workspaceMemberId: 'member-a' }, tabId: 'tab-a',
      operation: 'browser_click', location: 'https://example.invalid/', preview: 'Click', partial: false,
      createdAt: new Date(10_000).toISOString(), expiresAt: new Date(20_000).toISOString(), status: 'pending',
    };
    const check = createApprovalViewPrincipalCheck({ credentialStore: credentials, getRun: () => run, now: () => credentialNow });
    expect(check(view)).toBe(true);
    expect(check({ ...view, operation: 'browser_type' })).toBe(false);
    credentialNow += 1_000;
    expect(check(view)).toBe(false);
    const another = credentials.create({ name: 'revoked', allowedOperations: ['browser/*'] });
    credentials.revoke(another.credential.id);
    expect(check({ ...view, principal: { kind: 'external', id: another.credential.id } })).toBe(false);
  });

  it('hides run approval records when a run terminates, cancels, changes project or pinned scope', () => {
    const view: McpApprovalView = {
      id: 'approval', principal: { kind: 'run', id: 'run-a' }, projectId: 'project-a',
      scope: { workspaceId: 'workspace-a', workspaceMemberId: 'member-a' }, tabId: 'tab-a',
      operation: 'browser_click', location: 'https://example.invalid/', preview: 'Click', partial: false,
      createdAt: new Date(10_000).toISOString(), expiresAt: new Date(20_000).toISOString(), status: 'pending',
    };
    const check = createApprovalViewPrincipalCheck({ credentialStore: credentials, getRun: () => run });
    expect(check(view)).toBe(true);
    run = { id: 'run-a', projectId: 'project-a', status: 'succeeded' };
    expect(check(view)).toBe(false);
    run = { id: 'run-a', projectId: 'project-a', status: 'running', cancelRequested: true };
    expect(check(view)).toBe(false);
    run = { id: 'run-a', projectId: 'other-project', status: 'running' };
    expect(check(view)).toBe(false);
    run = { id: 'run-a', projectId: 'project-a', status: 'running', workspaceScope: {
      schemaVersion: 1, projectId: 'project-a', workspaceId: 'workspace-b',
      workspaceMemberId: 'member-a', source: 'persisted_project_binding',
    } };
    expect(check(view)).toBe(false);
  });
});

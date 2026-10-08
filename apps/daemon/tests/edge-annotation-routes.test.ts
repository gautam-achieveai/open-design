import type http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, deletePreviewComment, ensureWorkspaceProject, getMessage, getPreviewComment, getWorkspaceProject, getWorkspaceProjectByProjectId, insertConversation, insertProject, listMessages, listPreviewComments, openDatabase, updatePreviewCommentStatus, upsertMessage, upsertPreviewComment } from '../src/db.js';
import { registerEdgeAnnotationRoutes } from '../src/routes/edge-annotations.js';
import { createAuthorizeProjectRequest } from '../src/collab/project-request-authority.js';
import { createEdgeAnnotationBroker } from '../src/services/edge-annotation-broker.js';
import { appendReviewedCliChatMessage, appendReviewedEdgeChatMessage, claimPendingEdgeAnnotations, claimedEdgeAnnotationContext, claimedEdgeAnnotationContexts, claimedEdgeAnnotationImages, discardPendingEdgeAnnotation, edgeChatImageForMessage, listPendingEdgeAnnotations, pendingEdgeAnnotationContext, pendingEdgeAnnotationImage, storePendingEdgeAnnotation, storePendingNativeAnnotation } from '../src/services/edge-chat-message.js';
import { sendApiError } from '../src/http/api-errors.js';
import type { PreviewComment } from '@open-design/contracts';

const require = createRequire(import.meta.url);
const SqliteDatabase = require('better-sqlite3') as typeof import('better-sqlite3');

const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAAFUlEQVR4nGM4ceLEf0oww6gBw8EAACA2q5Dak2CeAAAAAElFTkSuQmCC';
const png = Buffer.from(screenshotDataUrl.split(',')[1]!, 'base64');
const extension = `chrome-extension://${'a'.repeat(32)}`;
const otherExtension = `chrome-extension://${'b'.repeat(32)}`;
const target = {
  selector: 'main button', elementId: 'save', label: 'Save', text: 'Save changes',
  domOutline: 'button\n  span Save changes',
  position: { x: 10, y: 20, width: 80, height: 30 }, htmlHint: 'button',
};

async function fixture(options: { bound?: boolean; daemonUrl?: string; pins?: boolean; verifiedMember?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'od-edge-chat-'));
  const db = openDatabase(dir, { dataDir: dir });
  const now = Date.now();
  insertProject(db, { id: 'p1', name: 'Project', createdAt: now, updatedAt: now });
  insertConversation(db, { id: 'c1', projectId: 'p1', title: 'Chat', createdAt: now, updatedAt: now });
  if (options.bound) ensureWorkspaceProject(db, { projectId: 'p1', workspaceId: 'w1',
    visibility: 'personal', createdByWorkspaceMemberId: 'm1' });
  const broker = createEdgeAnnotationBroker();
  const events: string[] = [];
  const screenshots: Buffer[] = [];
  const discarded: string[] = [];
  const failures: { upsert: boolean | 'throw' } = { upsert: false };
  // The paired member each pin write hands the host store (the host relays by it).
  const writers: Array<{ op: 'upsert' | 'remove'; workspace: { workspaceId: string; workspaceMemberId: string } | undefined }> = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Typed so the absent branch is a missing key, not `comments: undefined`.
  const pinDeps: Pick<Parameters<typeof registerEdgeAnnotationRoutes>[1], 'comments'> = {};
  if (options.pins) pinDeps.comments = {
    list: (projectId, conversationId) => listPreviewComments(db, projectId, conversationId) as PreviewComment[],
    get: (projectId, conversationId, id) => getPreviewComment(db, projectId, conversationId, id) as PreviewComment | null,
    upsert: (projectId, conversationId, input, workspace) => {
      writers.push({ op: 'upsert', workspace });
      if (failures.upsert === 'throw') throw new Error('label required');
      return failures.upsert ? null : upsertPreviewComment(db, projectId, conversationId, input) as PreviewComment | null;
    },
    remove: (projectId, conversationId, id, workspace) => {
      writers.push({ op: 'remove', workspace });
      return deletePreviewComment(db, projectId, conversationId, id);
    },
    storeScreenshot: async (_projectId, data) => {
      screenshots.push(data);
      return `browser-annotations/clipper-${screenshots.length}.png`;
    },
    discardScreenshot: async (_projectId, path) => { discarded.push(path); },
    emitChanged: () => { events.push('comment-changed'); },
  };
  registerEdgeAnnotationRoutes(app, {
    db,
    broker,
    ...pinDeps,
    getDaemonUrl: () => options.daemonUrl ?? 'http://127.0.0.1:61546',
    appendChatMessage: (input) => appendReviewedEdgeChatMessage(db, input),
    storePendingAnnotation: (input) => storePendingEdgeAnnotation(db, input),
    storePendingNativeAnnotation: (input) => storePendingNativeAnnotation(db, input),
    listPendingAnnotations: (projectId, conversationId) => listPendingEdgeAnnotations(db, projectId, conversationId),
    discardPendingAnnotation: (projectId, conversationId, id) => discardPendingEdgeAnnotation(db, projectId, conversationId, id),
    readPendingImage: (projectId, conversationId, id) => pendingEdgeAnnotationImage(db, projectId, conversationId, id),
    readPendingContext: (projectId, conversationId, id) => pendingEdgeAnnotationContext(db, projectId, conversationId, id),
    readClaimedContext: (projectId, conversationId, messageId, id) =>
      claimedEdgeAnnotationContext(db, projectId, conversationId, messageId, id),
    emitPendingAnnotation: (_projectId, _conversationId) => { events.push('draft-available'); },
    postChatMessage: (input) => appendReviewedCliChatMessage(db, input),
    readChatImage: (project, conversation, message) => edgeChatImageForMessage(db, project, conversation, message),
    emitChatMessage: (_project, _conversation, message) => { events.push(message); },
    authorizeProjectRequest: createAuthorizeProjectRequest({ db,
      getWorkspaceProject: (database, workspaceId, projectId) =>
        getWorkspaceProject(database as typeof db, workspaceId, projectId),
      getWorkspaceProjectByProjectId: (database, projectId) =>
        getWorkspaceProjectByProjectId(database as typeof db, projectId),
      sendApiError: (res, status, code, message) => sendApiError(res, status, code as 'BAD_REQUEST', message),
    }),
    verifyWorkspaceContext: async () => ({ ok: true, context: { workspaceId: 'w1', workspaceMemberId: 'm1' } }),
    ...(options.verifiedMember ? { verifyPairedWorkspace: async () => true } : {}),
    sendApiError: (res, status, code, message) => sendApiError(res, status, code as 'BAD_REQUEST', message),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    db, dir, broker, events, screenshots, discarded, failures, writers, server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

/** Pair conversation c1 and redeem the code from the trusted extension. */
async function pairedGrant(f: Awaited<ReturnType<typeof fixture>>, tabId = 2, documentId = 'doc-1') {
  const paired = await post(f.base, '/api/projects/p1/edge-annotations/pair', { conversationId: 'c1' });
  const { code } = await paired.json() as { code: string };
  const approved = await post(f.base, '/api/edge-annotations/redeem',
    { code, tabId, documentId, origin: 'https://app.example.test' }, extension);
  const { grant, token } = await approved.json() as { grant: { grantId: string }; token: string };
  return { grantId: grant.grantId, token, tabId, documentId };
}

async function post(base: string, route: string, body: unknown, origin?: string, token?: string,
  extraHeaders: Record<string, string> = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe('Edge annotation pairing routes', () => {
  it('echoes bounded diagnostic correlation and loaded protocol version without page data', async () => {
    const f = await fixture();
    fixtures.push(f);
    const response = await fetch(`${f.base}/api/projects/p1/edge-annotations?conversationId=c1`, {
      headers: { 'x-od-annotation-correlation': 'acceptance-correlation-1' },
    });
    expect(response.headers.get('x-od-annotation-correlation')).toBe('acceptance-correlation-1');
    expect(response.headers.get('x-od-annotation-build')).toBe('annotation-evidence-20260930');
  });

  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  afterEach(async () => {
    for (const { server, db, dir } of fixtures.splice(0)) {
      await new Promise<void>((resolve) => (server as http.Server).close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports only a safe live daemon URL in the authorized conversation status', async () => {
    const f = await fixture();
    fixtures.push(f);
    const response = await fetch(`${f.base}/api/projects/p1/edge-annotations?conversationId=c1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ grants: [], daemonUrl: 'http://127.0.0.1:61546' });
    expect((await fetch(`${f.base}/api/projects/p1/edge-annotations?conversationId=other`)).status).toBe(400);
    expect((await fetch(`${f.base}/api/projects/unknown/edge-annotations?conversationId=c1`)).status).toBe(404);
  });

  it.each([
    'https://127.0.0.1:61546', 'http://remote.example.test:61546',
    'http://127.0.0.1:61546/path', 'http://127.0.0.1:61546/?token=private',
    'http://user:pass@127.0.0.1:61546', 'http://127.0.0.1:0',
  ])('does not recommend an unusable extension URL: %s', async (daemonUrl) => {
    const f = await fixture({ daemonUrl });
    fixtures.push(f);
    const response = await fetch(`${f.base}/api/projects/p1/edge-annotations?conversationId=c1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ grants: [], daemonUrl: null });
  });

  it('awaits one exact paired read and denies worker impersonation or cross-conversation access', async () => {
    const f = await fixture();
    fixtures.push(f);
    const pair = await post(f.base, '/api/projects/p1/edge-annotations/pair', { conversationId: 'c1' });
    const { code } = await pair.json() as { code: string };
    const redeemed = await post(f.base, '/api/edge-annotations/redeem', {
      code, tabId: 2, documentId: 'doc-1', origin: 'https://app.example.test',
    }, extension);
    const { grant, token } = await redeemed.json() as { grant: { grantId: string }; token: string };
    const url = 'https://app.example.test/page';
    const identity = { projectId: 'p1', grantId: grant.grantId, tabId: 2, documentId: 'doc-1', url };
    const pollPath = '/api/edge-annotations/inspect/poll';
    const requestPath = '/api/projects/p1/edge-annotations/inspect';
    const resultPath = '/api/edge-annotations/inspect/result';
    expect((await post(f.base, pollPath, identity)).status).toBe(403);
    expect((await post(f.base, pollPath, identity, extension)).status).toBe(404);
    expect((await post(f.base, pollPath, identity, otherExtension, token)).status).not.toBe(200);
    expect((await post(f.base, pollPath, { ...identity, projectId: 'other' }, extension, token)).status).not.toBe(200);
    expect(await (await post(f.base, pollPath, identity, extension, token)).json())
      .toEqual({ ok: true, request: null });
    expect((await post(f.base, requestPath, { conversationId: 'other', grantId: grant.grantId,
      operation: 'snapshot' })).status).not.toBe(200);

    const inspecting = post(f.base, requestPath, { conversationId: 'c1', grantId: grant.grantId,
      operation: 'snapshot' });
    let task: { requestId: string; operation: string } | null = null;
    for (let i = 0; i < 20 && !task; i += 1) {
      const poll = await post(f.base, pollPath, identity, extension, token);
      task = (await poll.json() as { request: typeof task }).request;
      if (!task) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(task).toEqual({ requestId: expect.any(String), operation: 'snapshot' });
    expect(await (await post(f.base, pollPath, identity, extension, token)).json())
      .toEqual({ ok: true, request: null });
    expect((await post(f.base, resultPath, { ...identity, requestId: task!.requestId, ok: true,
      result: { html: '<main>Wrong</main>', title: 'No', url, truncated: false },
    }, otherExtension, token)).status).not.toBe(200);
    expect((await post(f.base, resultPath, { ...identity, documentId: 'other', requestId: task!.requestId,
      ok: true, result: { html: '<main>Wrong</main>', title: 'No', url, truncated: false },
    }, extension, token)).status).not.toBe(200);
    expect((await post(f.base, resultPath, { ...identity, requestId: task!.requestId, ok: true,
      result: { html: '<main>Ready</main>', title: 'Editor', url, truncated: false },
    }, extension, token)).status).toBe(200);
    const response = await inspecting;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, requestId: task!.requestId,
      result: { html: '<main>Ready</main>', title: 'Editor', url, truncated: false } });
    expect((await post(f.base, resultPath, { ...identity, requestId: task!.requestId, ok: false },
      extension, token)).status).not.toBe(200);
  });

  it('discards one pending annotation and its screenshot only in its authorized conversation', async () => {
    const f = await fixture();
    fixtures.push(f);
    const posted = await post(f.base, '/api/projects/p1/edge-annotations/draft', {
      conversationId: 'c1', eventId: 'discard-1', url: 'https://example.test/',
      note: 'Discard this note', screenshotDataUrl,
    });
    expect(posted.status).toBe(200);
    const draft = await posted.json() as { id: string };
    const base = `/api/projects/p1/edge-annotations/pending/${draft.id}`;
    const remove = (conversationId: string) => fetch(`${f.base}${base}?conversationId=${conversationId}`, {
      method: 'DELETE',
    });
    expect((await remove('other')).status).toBe(404);
    const removed = await remove('c1');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ discarded: true });
    expect(listPendingEdgeAnnotations(f.db, 'p1', 'c1')).toEqual([]);
    expect(pendingEdgeAnnotationImage(f.db, 'p1', 'c1', draft.id)).toBeNull();
    expect(await (await remove('c1')).json()).toEqual({ discarded: false });
    expect(f.events).toEqual(['draft-available', 'draft-available']);
  });

  it('collects a paired annotation without posting a chat turn', async () => {
    const f = await fixture();
    fixtures.push(f);
    const paired = await post(f.base, '/api/projects/p1/edge-annotations/pair', { conversationId: 'c1' });
    expect(paired.status).toBe(200);
    const pair = await paired.json() as { code: string; connectionUrl: string };
    expect(pair.connectionUrl).toBe(`http://127.0.0.1:61546/#od-annotation=${encodeURIComponent(pair.code)}`);
    const { code } = pair;
    const redeem = { code, tabId: 2, documentId: 'doc-1', origin: 'https://app.example.test' };
    expect((await post(f.base, '/api/edge-annotations/redeem', redeem)).status).toBe(403);
    expect((await post(f.base, '/api/edge-annotations/redeem', redeem, 'https://example.test')).status).toBe(403);
    const approved = await post(f.base, '/api/edge-annotations/redeem', redeem, extension);
    expect(approved.status).toBe(200);
    expect(approved.headers.get('access-control-allow-origin')).toBe(extension);
    const { grant, token } = await approved.json() as { grant: { grantId: string }; token: string };
    expect((await post(f.base, '/api/edge-annotations/redeem', redeem, extension)).status).not.toBe(200);

    const submission = {
      projectId: 'p1', grantId: grant.grantId, tabId: 2, documentId: 'doc-1',
      url: 'https://app.example.test/page?view=designer#button', title: 'Page', target,
      note: 'Make the Save button clearer', eventId: 'event-1', screenshotDataUrl,
    };
    expect((await post(f.base, '/api/edge-annotations/submit', submission, otherExtension, token)).status).not.toBe(200);
    expect((await post(f.base, '/api/edge-annotations/submit', { ...submission, tabId: 3 }, extension, token)).status).not.toBe(200);
    const sent = await post(f.base, '/api/edge-annotations/submit', submission, extension, token);
    expect(sent.status).toBe(200);
    const result = await sent.json() as { id: string; projectId: string; conversationId: string; replayed: boolean };
    expect(result).toMatchObject({ projectId: 'p1', conversationId: 'c1', replayed: false });
    expect(JSON.stringify(result)).not.toContain('iVBORw');
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    const pendingPath = '/api/projects/p1/edge-annotations/pending?conversationId=c1';
    const pending = await fetch(`${f.base}${pendingPath}`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ annotations: [{ id: result.id, hasScreenshot: true,
      note: submission.note, evidence: { url: submission.url, title: submission.title,
        target: { selector: target.selector, text: target.text } } }] });
    const contextPath = `/api/projects/p1/edge-annotations/pending/${result.id}/context?conversationId=c1`;
    const contextResponse = await fetch(`${f.base}${contextPath}`);
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.headers.get('content-type')).toContain('application/json');
    expect(await contextResponse.json()).toMatchObject({ url: submission.url, title: submission.title,
      screenshot: 'captured', target: { selector: target.selector, domOutline: target.domOutline } });
    const imagePath = `/api/projects/p1/edge-annotations/pending/${result.id}/image?conversationId=c1`;
    const image = await fetch(`${f.base}${imagePath}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await fetch(`${f.base}${imagePath.replace('conversationId=c1', 'conversationId=c2')}`)).status).not.toBe(200);
    expect((await fetch(`${f.base}${imagePath.replace('/p1/', '/p2/')}`)).status).not.toBe(200);

    const replay = await post(f.base, '/api/edge-annotations/submit', submission, extension, token);
    expect(await replay.json()).toEqual({ ...result, replayed: true });
    expect(f.events).toEqual(['draft-available']);
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    expect((await post(f.base, '/api/edge-annotations/submit', { ...submission, note: 'Different note' }, extension, token)).status).toBe(409);
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    const revoked = await post(f.base, '/api/edge-annotations/revoke', {
      grantId: grant.grantId, tabId: 2, documentId: 'doc-1', url: 'https://app.example.test/page',
    }, extension, token);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(f.broker.listGrants('p1')).toEqual([]);
    expect((await fetch(`${f.base}${imagePath}`)).status).toBe(200);
  });

  it('keeps numbered page pins for the paired extension on the reviewed page only', async () => {
    const f = await fixture({ pins: true });
    fixtures.push(f);
    const { grantId, token, tabId, documentId } = await pairedGrant(f);
    const url = 'https://app.example.test/page?view=designer#button';
    const scope = { grantId, tabId, documentId, url };
    const pin = { ...scope, target, note: 'Make the Save button clearer', screenshotDataUrl };

    // Proof is checked before anything is written.
    expect((await post(f.base, '/api/edge-annotations/comment-upsert', pin, otherExtension, token)).status).not.toBe(200);
    expect((await post(f.base, '/api/edge-annotations/comment-upsert', { ...pin, tabId: 9 }, extension, token)).status).not.toBe(200);
    expect(listPreviewComments(f.db, 'p1', 'c1')).toEqual([]);

    const first = await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token);
    expect(first.status).toBe(200);
    expect(first.headers.get('access-control-allow-origin')).toBe(extension);
    const firstBody = await first.text();
    expect(firstBody).not.toContain('iVBORw');
    const { comment } = JSON.parse(firstBody) as { comment: { id: string; pinSeq: number; filePath: string;
      note: string; attachments: { path: string }[]; metadata?: { source?: string } } };
    // Key is the shared browser page key (fragment kept: hash routes are pages); source marks the surface.
    expect(comment).toMatchObject({ pinSeq: 1, filePath: 'browser:https://app.example.test/page?view=designer#button',
      note: pin.note, attachments: [{ path: 'browser-annotations/clipper-1.png' }], metadata: { source: 'clipper' } });
    expect(f.screenshots).toEqual([png]);

    const childScope = { frame: 'child', url: 'https://child.example.test/frame', selectorRoot: 'document',
      shadowHosts: [], screenshot: 'not-supported' };
    const second = await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, note: 'Second pin', screenshotDataUrl: undefined, target: { ...target, scope: childScope } }, extension, token);
    // A child-frame pin keeps where its selector resolves, so a badge can be placed later.
    expect(((await second.json()) as { comment: { pinSeq: number; metadata?: { scope?: unknown } } }).comment)
      .toMatchObject({ pinSeq: 2, metadata: { source: 'clipper', scope: childScope } });

    const listed = await post(f.base, '/api/edge-annotations/comment-list', scope, extension, token);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ filePath: comment.filePath,
      comments: [{ id: comment.id, pinSeq: 1 }, { pinSeq: 2 }] });
    // A different page on the same grant origin sees none of them.
    const elsewhere = await post(f.base, '/api/edge-annotations/comment-list',
      { ...scope, url: 'https://app.example.test/other' }, extension, token);
    expect(await elsewhere.json()).toMatchObject({ comments: [] });

    // Edit keeps the number and the screenshot; a pin from another page cannot be reached through this grant.
    const edited = await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, id: comment.id, note: 'Clearer still', screenshotDataUrl: undefined }, extension, token);
    expect(await edited.json()).toMatchObject({ comment: { id: comment.id, pinSeq: 1, note: 'Clearer still',
      attachments: [{ path: 'browser-annotations/clipper-1.png' }] } });
    const foreign = upsertPreviewComment(f.db, 'p1', 'c1', { target: { ...target, filePath: 'index.html' }, note: 'preview pin' })!;
    expect((await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, id: foreign.id, note: 'hijack' }, extension, token)).status).toBe(404);
    expect((await post(f.base, '/api/edge-annotations/comment-delete',
      { ...scope, id: foreign.id }, extension, token)).status).toBe(404);
    expect(getPreviewComment(f.db, 'p1', 'c1', foreign.id)?.note).toBe('preview pin');

    const removed = await post(f.base, '/api/edge-annotations/comment-delete', { ...scope, id: comment.id }, extension, token);
    expect(await removed.json()).toEqual({ deleted: true });
    // Deleting the pin removes its crop from disk too.
    expect(f.discarded).toEqual(['browser-annotations/clipper-1.png']);
    // Numbers are per page: the preview pin on index.html kept its own `1`.
    expect(listPreviewComments(f.db, 'p1', 'c1').map((row) => [row.filePath, row.pinSeq]))
      .toEqual([[comment.filePath, 2], ['index.html', 1]]);
    expect(f.events).toEqual(['comment-changed', 'comment-changed', 'comment-changed', 'comment-changed']);

    // Without the pin store wired, the paired extension gets a clean 503 (not a crash, not a draft).
    const bare = await fixture();
    fixtures.push(bare);
    const bareGrant = await pairedGrant(bare);
    const unavailable = await post(bare.base, '/api/edge-annotations/comment-upsert',
      { ...pin, grantId: bareGrant.grantId }, extension, bareGrant.token);
    expect(unavailable.status).toBe(503);
  });

  it('hands the paired member to the host store on every pin write, so the host can relay it', async () => {
    const f = await fixture({ bound: true, pins: true, verifiedMember: true });
    fixtures.push(f);
    const member = { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' };
    const paired = await post(f.base, '/api/projects/p1/edge-annotations/pair', { conversationId: 'c1' },
      undefined, undefined, member);
    expect(paired.status).toBe(200);
    const { code } = await paired.json() as { code: string };
    const approved = await post(f.base, '/api/edge-annotations/redeem',
      { code, tabId: 2, documentId: 'doc-1', origin: 'https://app.example.test' }, extension);
    const { grant, token } = await approved.json() as { grant: { grantId: string }; token: string };
    const scope = { grantId: grant.grantId, tabId: 2, documentId: 'doc-1', url: 'https://app.example.test/page' };

    const saved = await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...scope, target, note: 'Relay me' }, extension, token);
    expect(saved.status).toBe(200);
    const { comment } = await saved.json() as { comment: { id: string } };
    const removed = await post(f.base, '/api/edge-annotations/comment-delete',
      { ...scope, id: comment.id }, extension, token);
    expect(removed.status).toBe(200);
    const paired1 = { workspaceId: 'w1', workspaceMemberId: 'm1' };
    expect(f.writers).toEqual([
      { op: 'upsert', workspace: paired1 },
      { op: 'remove', workspace: paired1 },
    ]);

    // An unbound project pairs with no member: the host gets none and keeps the pin local.
    const local = await fixture({ pins: true });
    fixtures.push(local);
    const localGrant = await pairedGrant(local);
    expect((await post(local.base, '/api/edge-annotations/comment-upsert', {
      grantId: localGrant.grantId, tabId: localGrant.tabId, documentId: localGrant.documentId,
      url: 'https://app.example.test/page', target, note: 'Local only',
    }, extension, localGrant.token)).status).toBe(200);
    expect(local.writers).toEqual([{ op: 'upsert', workspace: undefined }]);
  });

  it('answers the CORS preflight for the pin routes and for nothing unlisted', async () => {
    const f = await fixture({ pins: true });
    fixtures.push(f);
    const preflight = (operation: string) => fetch(`${f.base}/api/edge-annotations/${operation}`, { method: 'OPTIONS',
      headers: { origin: extension, 'access-control-request-method': 'POST' } });
    for (const operation of ['comment-list', 'comment-upsert', 'comment-delete']) {
      const answer = await preflight(operation);
      expect([operation, answer.status]).toEqual([operation, 204]);
      expect(answer.headers.get('access-control-allow-origin')).toBe(extension);
    }
    // Not an extension operation: no promise of a POST the origin guard would block.
    expect((await preflight('comment-stage')).status).toBe(404);
  });

  it('shows the paired extension only open pins, like the in-app browser and the canvas', async () => {
    const f = await fixture({ pins: true });
    fixtures.push(f);
    const { grantId, token, tabId, documentId } = await pairedGrant(f);
    const scope = { grantId, tabId, documentId, url: 'https://app.example.test/page' };
    const pin = { ...scope, target, note: 'Open pin' };
    const { comment } = await (await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token))
      .json() as { comment: { id: string } };
    expect(await (await post(f.base, '/api/edge-annotations/comment-list', scope, extension, token)).json())
      .toMatchObject({ comments: [{ id: comment.id }] });

    // Staged and sent: the pin keeps its number but leaves the page everywhere.
    updatePreviewCommentStatus(f.db, 'p1', 'c1', comment.id, 'applying');
    expect(await (await post(f.base, '/api/edge-annotations/comment-list', scope, extension, token)).json())
      .toMatchObject({ comments: [] });
    expect((await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, id: comment.id, note: 'late edit' }, extension, token)).status).toBe(404);
    expect((await post(f.base, '/api/edge-annotations/comment-delete', { ...scope, id: comment.id }, extension, token)).status).toBe(404);
    expect(getPreviewComment(f.db, 'p1', 'c1', comment.id)).toMatchObject({ note: 'Open pin', status: 'applying', pinSeq: 1 });
  });

  it('returns the pin already written when a Save is retried with the same eventId', async () => {
    const f = await fixture({ pins: true });
    fixtures.push(f);
    const { grantId, token, tabId, documentId } = await pairedGrant(f);
    const scope = { grantId, tabId, documentId, url: 'https://app.example.test/page' };
    const pin = { ...scope, target, note: 'Once', screenshotDataUrl, eventId: 'evt-1' };
    type Upsert = { comment: { id: string; pinSeq: number }; replayed?: boolean };
    const first = await (await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).json() as Upsert;
    expect(first).toEqual({ comment: expect.objectContaining({ pinSeq: 1 }) });

    // The response was lost; the extension sends the same Save again.
    const again = await (await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).json() as Upsert;
    expect(again).toEqual({ comment: expect.objectContaining({ id: first.comment.id, pinSeq: 1 }), replayed: true });
    expect(f.screenshots).toHaveLength(1);
    expect(listPreviewComments(f.db, 'p1', 'c1')).toHaveLength(1);

    // A new Save is a new pin; an invalid eventId is ignored rather than refused.
    const second = await (await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, eventId: 'evt-2' }, extension, token)).json() as Upsert;
    expect(second).toEqual({ comment: expect.objectContaining({ pinSeq: 2 }) });
    const unkeyed = await (await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, eventId: 'not valid!' }, extension, token)).json() as Upsert;
    expect(unkeyed).toEqual({ comment: expect.objectContaining({ pinSeq: 3 }) });

    // Once the pin is gone, the key no longer names a row to replay.
    await post(f.base, '/api/edge-annotations/comment-delete', { ...scope, id: first.comment.id }, extension, token);
    const afterDelete = await (await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).json() as Upsert;
    expect(afterDelete).toEqual({ comment: expect.objectContaining({ pinSeq: 4 }) });
  });

  it('replaces the stored crop on an edit that carries a fresh one and never leaves an orphan PNG', async () => {
    const f = await fixture({ pins: true });
    fixtures.push(f);
    const { grantId, token, tabId, documentId } = await pairedGrant(f);
    const scope = { grantId, tabId, documentId, url: 'https://app.example.test/page' };
    const pin = { ...scope, target, note: 'Crop me', screenshotDataUrl };
    type Upsert = { comment: { id: string; attachments: { path: string }[] } };
    const { comment } = await (await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).json() as Upsert;
    expect(comment.attachments).toEqual([{ path: 'browser-annotations/clipper-1.png', name: 'clipper-1.png' }]);

    const recropped = await (await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, id: comment.id }, extension, token)).json() as Upsert;
    expect(recropped.comment.attachments).toEqual([{ path: 'browser-annotations/clipper-2.png', name: 'clipper-2.png' }]);
    expect(f.discarded).toEqual(['browser-annotations/clipper-1.png']);

    // Without a fresh crop the stored one stays.
    const kept = await (await post(f.base, '/api/edge-annotations/comment-upsert',
      { ...pin, id: comment.id, note: 'Edited', screenshotDataUrl: undefined }, extension, token)).json() as Upsert;
    expect(kept.comment.attachments).toEqual([{ path: 'browser-annotations/clipper-2.png', name: 'clipper-2.png' }]);
    expect(f.discarded).toEqual(['browser-annotations/clipper-1.png']);

    // A write the store refuses leaves no PNG behind.
    f.failures.upsert = true;
    expect((await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).status).toBe(400);
    expect(f.screenshots).toHaveLength(3);
    expect(f.discarded).toEqual(['browser-annotations/clipper-1.png', 'browser-annotations/clipper-3.png']);
    // The same when the store throws (db validation such as a blank label).
    f.failures.upsert = 'throw';
    expect((await post(f.base, '/api/edge-annotations/comment-upsert', pin, extension, token)).status).toBeGreaterThanOrEqual(400);
    expect(f.screenshots).toHaveLength(4);
    expect(f.discarded.at(-1)).toBe('browser-annotations/clipper-4.png');
  });

  it('collects native element feedback without a screenshot or an agent run', async () => {
    const f = await fixture();
    fixtures.push(f);
    const input = { conversationId: 'c1', url: 'http://dev.example.test/page?view=wide#hero',
      note: 'Change the heading', eventId: 'native-no-image', title: 'Example',
      target: { ...target, text: 'Marketplaces', domOutline: 'div\n  h1 Marketplaces',
        htmlHint: 'div', style: { fontFamily: '"Inter", sans-serif' } } };
    const posted = await post(f.base, '/api/projects/p1/edge-annotations/draft', input);
    expect(posted.status).toBe(200);
    const result = await posted.json() as { id: string };
    const scope = { frame: 'child', selectorRoot: 'document', shadowHosts: [], screenshot: 'not-supported' };
    for (const url of ['https://accounts.google.com/', 'https://child.example.test/%2563allback',
      'https://child.example.test/frame?access_token=private']) {
      expect((await post(f.base, '/api/projects/p1/edge-annotations/draft', {
        ...input, eventId: 'unsafe-scope-' + url.length,
        target: { ...input.target, scope: { ...scope, url } },
      })).status).toBe(400);
    }
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    const pending = await fetch(`${f.base}/api/projects/p1/edge-annotations/pending?conversationId=c1`);
    expect(await pending.json()).toMatchObject({ annotations: [{ id: result.id, hasScreenshot: false,
      note: input.note, evidence: { url: input.url, title: input.title,
        target: { selector: input.target.selector, text: input.target.text } } }] });
    const context = await fetch(`${f.base}/api/projects/p1/edge-annotations/pending/${result.id}/context?conversationId=c1`);
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ url: input.url, title: input.title,
      screenshot: 'not-provided', target: { selector: input.target.selector, domOutline: input.target.domOutline } });
    const message = { content: listPendingEdgeAnnotations(f.db, 'p1', 'c1')[0]?.text };
    expect(message?.content).toContain(input.url);
    expect(message?.content).toContain(input.target.domOutline);
    expect(message?.content).not.toContain('screenshot attached');
    expect(pendingEdgeAnnotationImage(f.db, 'p1', 'c1', result.id)).toBeNull();
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    expect(await (await post(f.base, '/api/projects/p1/edge-annotations/draft', input)).json())
      .toMatchObject({ id: result.id, replayed: true });
    expect(f.events).toEqual(['draft-available']);
    expect((await post(f.base, '/api/projects/p1/edge-annotations/draft', {
      ...input, eventId: 'malformed', target: { ...input.target, position: {} },
    })).status).toBe(400);
    const optionalEvidence = await post(f.base, '/api/projects/p1/edge-annotations/draft', {
      ...input, eventId: 'optional-evidence', target: { ...input.target,
        ancestors: [null, { tag: 'main', selector: 'main' }],
        style: { color: 123, fontFamily: '"Segoe UI", sans-serif', unknown: 'ignored' },
      },
    });
    expect(optionalEvidence.status).toBe(200);
    const optionalDraft = await optionalEvidence.json() as { id: string };
    expect(pendingEdgeAnnotationContext(f.db, 'p1', 'c1', optionalDraft.id)?.target)
      .toMatchObject({ ancestors: [{ tag: 'main', selector: 'main' }],
        style: { fontFamily: '"Segoe UI", sans-serif' } });
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
  });

  it('claims multiple crops only for one conversation and one user turn', async () => {
    const f = await fixture();
    fixtures.push(f);
    const ids: string[] = [];
    for (const [index, note] of ['Review Save', 'Review heading'].entries()) {
      const response = await post(f.base, '/api/projects/p1/edge-annotations/draft', {
        conversationId: 'c1', url: 'https://app.example.test/page',
        eventId: `claim-${index}`, note, screenshotDataUrl,
      });
      expect(response.status).toBe(200);
      ids.push((await response.json() as { id: string }).id);
    }
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    upsertMessage(f.db, 'c1', { id: 'user-1', role: 'user', content: 'Review both' });
    expect(() => f.db.transaction(() => {
      claimPendingEdgeAnnotations(f.db, 'p1', 'c1', 'user-1', ids, ids);
      throw new Error('run claim rolled back');
    })()).toThrow('run claim rolled back');
    expect(listPendingEdgeAnnotations(f.db, 'p1', 'c1')).toHaveLength(2);
    f.db.transaction(() => claimPendingEdgeAnnotations(f.db, 'p1', 'c1', 'user-1', ids, ids))();
    expect(claimedEdgeAnnotationImages(f.db, 'p1', 'c1', 'user-1', ids)).toEqual([png, png]);
    expect(claimedEdgeAnnotationContexts(f.db, 'p1', 'c1', 'user-1', ids)).toEqual([
      { url: 'https://app.example.test/page', screenshot: 'captured' },
      { url: 'https://app.example.test/page', screenshot: 'captured' },
    ]);
    const contextPath = `/api/projects/p1/conversations/c1/messages/user-1/annotation-context/${ids[0]}`;
    const boundContext = await fetch(`${f.base}${contextPath}`);
    expect(boundContext.status).toBe(200);
    expect(boundContext.headers.get('cache-control')).toBe('private, no-store');
    expect(await boundContext.json()).toEqual({ url: 'https://app.example.test/page', screenshot: 'captured' });
    expect((await fetch(`${f.base}${contextPath.replace('user-1', 'user-2')}`)).status).toBe(404);
    expect((await fetch(`${f.base}${contextPath.replace('/c1/', '/c2/')}`)).status).not.toBe(200);
    expect((await fetch(`${f.base}${contextPath.replace('/p1/', '/p2/')}`)).status).not.toBe(200);
    expect(listMessages(f.db, 'c1')[0]).toMatchObject({ id: 'user-1', content: 'Review both',
      annotationContexts: ids.map((id) => ({ id, name: 'annotation-context.json', mimeType: 'application/json' })) });
    expect(listPendingEdgeAnnotations(f.db, 'p1', 'c1')).toHaveLength(0);
    expect(() => claimPendingEdgeAnnotations(f.db, 'p1', 'c1', 'user-2', ids, ids)).toThrow();
    expect(() => claimedEdgeAnnotationImages(f.db, 'p1', 'c1', 'user-2', ids)).toThrow();
    expect(() => claimedEdgeAnnotationContexts(f.db, 'p1', 'c1', 'user-2', ids)).toThrow();
  });

  it('keeps pre-migration combined-text drafts sendable without inventing JSON evidence', async () => {
    const f = await fixture();
    fixtures.push(f);
    const draft = storePendingNativeAnnotation(f.db, { projectId: 'p1', conversationId: 'c1',
      eventId: 'legacy-draft', url: 'https://example.test/', note: 'Legacy note' });
    f.db.prepare('UPDATE edge_annotation_drafts SET note = NULL, evidence_json = NULL WHERE id = ?').run(draft.id);
    expect(listPendingEdgeAnnotations(f.db, 'p1', 'c1')[0]).toMatchObject({ id: draft.id,
      text: expect.stringContaining('Browser page: https://example.test/') });
    upsertMessage(f.db, 'c1', { id: 'legacy-user', role: 'user', content: draft.text });
    claimPendingEdgeAnnotations(f.db, 'p1', 'c1', 'legacy-user', [draft.id], []);
    expect(claimedEdgeAnnotationContexts(f.db, 'p1', 'c1', 'legacy-user', [draft.id])).toEqual([]);
    expect(listMessages(f.db, 'c1')[0]?.annotationContexts).toEqual([]);
    const path = `/api/projects/p1/conversations/c1/messages/legacy-user/annotation-context/${draft.id}`;
    expect((await fetch(`${f.base}${path}`)).status).toBe(404);
  });

  it('migrates physical pre-column drafts and backfills message-bound JSON ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-edge-old-schema-'));
    try {
      const migrated = openDatabase(dir, { dataDir: dir });
      insertProject(migrated, { id: 'legacy-project', name: 'Legacy', createdAt: 1, updatedAt: 1 });
      insertConversation(migrated, { id: 'legacy-conversation', projectId: 'legacy-project', createdAt: 1, updatedAt: 1 });
      upsertMessage(migrated, 'legacy-conversation', { id: 'legacy-message', role: 'user', content: 'Legacy note' });
      closeDatabase();
      const raw = new SqliteDatabase(join(dir, 'app.sqlite'));
      try {
        raw.exec(`DROP TABLE edge_annotation_message_contexts;
          DROP TABLE edge_annotation_drafts;
          CREATE TABLE edge_annotation_drafts (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
            grant_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
            text TEXT NOT NULL, png BLOB, created_at INTEGER NOT NULL,
            consumed_message_id TEXT, discarded_at INTEGER, UNIQUE(grant_id, event_id)
          );`);
        raw.prepare(`INSERT INTO edge_annotation_drafts
          (id, project_id, conversation_id, grant_id, event_id, payload_digest, text,
            created_at, consumed_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('legacy-annotation', 'legacy-project', 'legacy-conversation', 'native:legacy',
            'legacy-event', 'digest', 'Legacy note', 1, 'legacy-message');
      } finally { raw.close(); }

      const reopened = openDatabase(dir, { dataDir: dir });
      const columns = reopened.pragma('table_info(edge_annotation_drafts)') as { name: string }[];
      expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining(['note', 'evidence_json']));
      expect(listMessages(reopened, 'legacy-conversation')[0]?.annotationContexts).toEqual([]);
      expect(claimedEdgeAnnotationContexts(reopened, 'legacy-project', 'legacy-conversation',
        'legacy-message', ['legacy-annotation'])).toEqual([]);
      reopened.prepare('UPDATE edge_annotation_drafts SET evidence_json = ? WHERE id = ?')
        .run('{"url":"https://example.test/"}', 'legacy-annotation');
      closeDatabase();
      const backfilled = openDatabase(dir, { dataDir: dir });
      expect(listMessages(backfilled, 'legacy-conversation')[0]?.annotationContexts)
        .toMatchObject([{ id: 'legacy-annotation', name: 'annotation-context.json' }]);
      expect(claimedEdgeAnnotationContext(backfilled, 'legacy-project', 'legacy-conversation',
        'legacy-message', 'legacy-annotation')).toEqual({ url: 'https://example.test/' });
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the idempotent native draft across a daemon database restart', async () => {
    const f = await fixture();
    fixtures.push(f);
    const input = { conversationId: 'c1', url: 'https://app.example.test/page',
      note: 'Review Save', eventId: 'restart-event', screenshotDataUrl };
    const original = await post(f.base, '/api/projects/p1/edge-annotations/draft', input);
    expect(original.status).toBe(200);
    const { id } = await original.json() as { id: string };
    const reopened = openDatabase(f.dir, { dataDir: f.dir });
    try {
      const repeated = storePendingNativeAnnotation(reopened, { projectId: 'p1', ...input });
      expect(repeated).toMatchObject({ id, replayed: true });
      expect(listMessages(reopened, 'c1')).toHaveLength(0);
      expect(pendingEdgeAnnotationImage(reopened, 'p1', 'c1', id)).toEqual(png);
    } finally { reopened.close(); }
  });

  it('rolls back a native draft and idempotency claim when storing its PNG fails', async () => {
    const f = await fixture();
    fixtures.push(f);
    f.db.exec(`CREATE TRIGGER block_edge_draft BEFORE INSERT ON edge_annotation_drafts
      BEGIN SELECT RAISE(ABORT, 'image unavailable'); END;`);
    const input = { conversationId: 'c1', url: 'https://app.example.test/page',
      note: 'Review Save', eventId: 'rollback-event', screenshotDataUrl };
    const failed = await post(f.base, '/api/projects/p1/edge-annotations/draft', input);
    expect(failed.status).toBe(400);
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
    expect(listPendingEdgeAnnotations(f.db, 'p1', 'c1')).toHaveLength(0);
    f.db.exec('DROP TRIGGER block_edge_draft');
    const retried = await post(f.base, '/api/projects/p1/edge-annotations/draft', input);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ replayed: false });
    expect(listMessages(f.db, 'c1')).toHaveLength(0);
  });

  it.each(['draft', 'post'] as const)('retains exact written about:blank annotation metadata through %s', async (surface) => {
    const f = await fixture({ bound: true });
    fixtures.push(f);
    const route = `/api/projects/p1/edge-annotations/${surface}`;
    const headers = { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' };
    const input = { conversationId: 'c1', url: 'about:blank', title: 'Written pop-up',
      note: 'Adjust this written heading', eventId: `blank-${surface}`, screenshotDataUrl,
      target: { ...target, selector: 'h1', label: 'Heading', text: 'Written heading' } };
    expect((await post(f.base, route, input, undefined, undefined, {
      ...headers, 'x-od-workspace-id': 'foreign',
    })).status).toBe(403);
    expect((await post(f.base, route, { ...input, conversationId: 'foreign' }, undefined, undefined, headers)).status).toBe(404);
    const posted = await post(f.base, route, input, undefined, undefined, headers);
    expect(posted.status).toBe(200);
    const result = await posted.json() as { id?: string; messageId?: string; replayed: boolean };
    expect(result.replayed).toBe(false);
    if (surface === 'draft') {
      expect(pendingEdgeAnnotationContext(f.db, 'p1', 'c1', result.id!)).toMatchObject({
        url: 'about:blank', title: input.title, target: { selector: 'h1', text: input.target.text }, screenshot: 'captured',
      });
      expect(pendingEdgeAnnotationImage(f.db, 'p1', 'c1', result.id!)).toEqual(png);
      expect(listMessages(f.db, 'c1')).toHaveLength(0);
    } else {
      const message = getMessage(f.db, result.messageId!, 'c1');
      expect(message?.content).toContain('Browser page: about:blank');
      expect(message?.content).toContain('Selector: h1');
      expect(message?.content).toContain('the URL does not identify an editable project file');
      expect(edgeChatImageForMessage(f.db, 'p1', 'c1', result.messageId!)?.data).toEqual(png);
      expect(listMessages(f.db, 'c1')).toHaveLength(1);
    }
    const repeated = await post(f.base, route, input, undefined, undefined, headers);
    expect(await repeated.json()).toMatchObject({ ...result, replayed: true });
    expect(f.events).toHaveLength(1);
    expect((await post(f.base, route, { ...input, note: 'Changed note' }, undefined, undefined, headers)).status).toBe(409);
    for (const [index, url] of ['about:config', 'about:blank#fragment', 'about:blank?query=1', 'about:blank/extra',
      'about:Blank', 'about:%62lank', 'data:text/html,example', 'javascript:alert(1)'].entries()) {
      expect((await post(f.base, route, { ...input, url, eventId: `blank-rejected-${index}` }, undefined, undefined, headers)).status).toBe(400);
    }
    expect(f.events).toHaveLength(1);
  });

  it('CLI post keeps its direct message and message-owned image contract', async () => {
    const f = await fixture();
    fixtures.push(f);
    const posted = await post(f.base, '/api/projects/p1/edge-annotations/post', {
      conversationId: 'c1', url: 'https://app.example.test/page?view=designer',
      note: 'Make Save clearer', eventId: 'cli-event-1', screenshotDataUrl,
    });
    expect(posted.status).toBe(200);
    const result = await posted.json() as { messageId: string; replayed: boolean };
    expect(result.replayed).toBe(false);
    expect(getMessage(f.db, result.messageId, 'c1')?.content).toContain('Cropped screenshot attached to this chat message.');
    expect(edgeChatImageForMessage(f.db, 'p1', 'c1', result.messageId)?.data).toEqual(png);
    const again = await post(f.base, '/api/projects/p1/edge-annotations/post', {
      conversationId: 'c1', url: 'https://app.example.test/page?view=designer',
      note: 'Make Save clearer', eventId: 'cli-event-1', screenshotDataUrl,
    });
    expect(await again.json()).toMatchObject({ messageId: result.messageId, replayed: true });
    expect(listMessages(f.db, 'c1')).toHaveLength(1);
    expect((await post(f.base, '/api/projects/p1/edge-annotations/post', {
      conversationId: 'c1', url: 'javascript:alert(1)',
      note: 'Bad URL', eventId: 'cli-event-2', screenshotDataUrl,
    })).status).toBe(400);
  });

  it('scopes bound image navigation to the persisted workspace identity', async () => {
    const f = await fixture({ bound: true });
    fixtures.push(f);
    const posted = await post(f.base, '/api/projects/p1/edge-annotations/draft', {
      conversationId: 'c1', url: 'https://app.example.test/page', note: 'Review Save',
      eventId: 'bound-image', screenshotDataUrl,
    }, undefined, undefined, { 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' });
    expect(posted.status).toBe(200);
    const { id } = await posted.json() as { id: string };
    const imagePath = `/api/projects/p1/edge-annotations/pending/${id}/image?conversationId=c1`;
    const scoped = await fetch(`${f.base}${imagePath}&workspaceId=w1&workspaceMemberId=m1`);
    expect(scoped.status).toBe(200);
    expect(Buffer.from(await scoped.arrayBuffer())).toEqual(png);
    expect((await fetch(`${f.base}${imagePath}&workspaceId=w2&workspaceMemberId=m1`)).status).toBe(403);
    expect((await fetch(`${f.base}${imagePath}&workspaceId=w1&workspaceMemberId=m2`)).status).toBe(403);
    expect((await fetch(`${f.base}${imagePath}&workspaceId=w1`)).status).toBe(400);
    const conflict = await fetch(`${f.base}${imagePath}&workspaceId=w1&workspaceMemberId=m1`, {
      headers: { 'x-od-workspace-id': 'w2', 'x-od-workspace-member-id': 'm1' },
    });
    expect(conflict.status).toBe(400);
  });

  it('rejects authentication pages and credential-bearing URLs', async () => {
    const f = await fixture();
    fixtures.push(f);
    const { code } = f.broker.createPendingPair({ projectId: 'p1', conversationId: 'c1', extensionId: 'a'.repeat(32) });
    const response = await post(f.base, '/api/edge-annotations/redeem', {
      code, tabId: 2, documentId: 'doc-1', origin: 'https://login.microsoftonline.com',
    }, extension);
    expect(response.status).not.toBe(200);
    expect(f.broker.listGrants('p1')).toEqual([]);
  });
});

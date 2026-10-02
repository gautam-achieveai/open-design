import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { normalizeEdgeAnnotationScope, normalizeEdgeAnnotationAncestors, normalizeEdgeAnnotationStyle, normalizeEdgeAnnotationText } from '@open-design/contracts';
import type { BrowserAnnotationEvidence, BrowserAnnotationPostRequest, ChatImageAttachment, EdgeAnnotationGrant, EdgeAnnotationScreenshot, EdgeAnnotationTarget, PendingBrowserAnnotation } from '@open-design/contracts';
import { upsertMessage, updateProject } from '../db.js';
import { validateEdgeAnnotationScreenshot } from './edge-annotation-broker.js';
import { eligibleEdgeOrigin, reviewedEdgePageUrl } from './edge-annotation-url.js';

function normalizedBrowserScope(value: unknown) {
  const scope = normalizeEdgeAnnotationScope(value);
  if (value !== undefined && (!scope
    || reviewedEdgePageUrl(scope.url, eligibleEdgeOrigin(scope.url) ?? '') !== scope.url)) {
    throw new Error('annotation scope is malformed or unsafe');
  }
  return scope ? { scope } : {};
}

export interface ReviewedEdgeChatMessage {
  grant: EdgeAnnotationGrant;
  eventId: string;
  url: string;
  title: string;
  target: EdgeAnnotationTarget;
  note: string;
  screenshot?: { data: Buffer; metadata: EdgeAnnotationScreenshot };
}

export interface EdgeChatMessageResult {
  projectId: string;
  conversationId: string;
  messageId: string;
  replayed: boolean;
}

/** Native browser and CLI use the same direct, post-only chat path. */
export function appendReviewedCliChatMessage(db: Database.Database, input: BrowserAnnotationPostRequest & {
  projectId: string;
}): EdgeChatMessageResult {
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 4096
    || typeof input.eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.eventId)) {
    throw new Error('a bounded note and event ID are required');
  }
  const screenshot = input.screenshotDataUrl ? validateEdgeAnnotationScreenshot(input.screenshotDataUrl) : undefined;
  const image = screenshot?.data;
  const target = input.target === undefined ? undefined : {
    ...input.target,
    ...normalizedBrowserScope(input.target?.scope),
    text: normalizeEdgeAnnotationText(input.target?.text, 300),
    label: normalizeEdgeAnnotationText(input.target?.label, 160),
    ...(input.target?.domOutline === undefined ? {} : {
      domOutline: normalizeEdgeAnnotationText(input.target.domOutline, 1200, true),
    }),
    ...(input.target?.ancestors === undefined ? {} : {
      ancestors: normalizeEdgeAnnotationAncestors(input.target.ancestors),
    }),
    ...(input.target?.style === undefined ? {} : {
      style: normalizeEdgeAnnotationStyle(input.target.style),
    }),
  };
  if (target !== undefined && (!target || typeof target !== 'object'
    || typeof target.selector !== 'string' || target.selector.length > 4096
    || typeof target.text !== 'string' || target.text.length > 4000
    || typeof target.label !== 'string' || target.label.length > 512
    || typeof target.htmlHint !== 'string' || target.htmlHint.length > 4000
    || (target.domOutline !== undefined && (typeof target.domOutline !== 'string' || target.domOutline.length > 8000))
    || !target.position || ![target.position.x, target.position.y, target.position.width, target.position.height]
      .every((value) => typeof value === 'number' && Number.isFinite(value))
    || target.position.width < 0 || target.position.height < 0
    || (target.ancestors !== undefined && (!Array.isArray(target.ancestors) || target.ancestors.length > 8
      || target.ancestors.some((item) => !item || typeof item.tag !== 'string' || typeof item.selector !== 'string')))
    || (target.style !== undefined && (!target.style || typeof target.style !== 'object' || Array.isArray(target.style)
      || Object.values(target.style).some((value) => typeof value !== 'string')))
    || JSON.stringify(target).length > 24000)) throw new Error('annotation context is malformed or too large');
  const note = input.note.trim();
  const digest = createHash('sha256').update(JSON.stringify({
    projectId: input.projectId, conversationId: input.conversationId,
    url: input.url, note, eventId: input.eventId, target, title: input.title,
  })).update(image ?? '').digest('hex');
  return db.transaction(() => {
    const existing = db.prepare(`SELECT message_id AS messageId, payload_digest AS digest
      FROM edge_chat_events WHERE grant_id = ? AND event_id = ?`)
      .get(`cli:${input.projectId}:${input.conversationId}`, input.eventId) as {
        messageId: string; digest: string;
      } | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Error('annotation event was already used with different content');
      return { projectId: input.projectId, conversationId: input.conversationId,
        messageId: existing.messageId, replayed: true };
    }
    const conversation = db.prepare('SELECT project_id AS projectId FROM conversations WHERE id = ?')
      .get(input.conversationId) as { projectId: string } | undefined;
    if (conversation?.projectId !== input.projectId) throw new Error('conversation no longer belongs to project');
    const messageId = randomUUID();
    const now = Date.now();
    upsertMessage(db, input.conversationId, {
      id: messageId, role: 'user', createdAt: now, startedAt: now, endedAt: now,
      content: [note, '', `Browser page: ${input.url}`,
        'Browser reference; the URL does not identify an editable project file.',
        ...(target ? [
          `Element: ${target.label}`,
          `Selector: ${target.selector}`,
          `Position: ${target.position.x},${target.position.y} ${target.position.width}x${target.position.height}`,
          `Visible text: ${target.text}`,
          ...(target.domOutline ? [`DOM outline: ${target.domOutline}`] : []),
          ...(target.htmlHint ? [`Element markup: ${target.htmlHint}`] : []),
          ...(target.ancestors?.length ? [`Ancestors: ${target.ancestors.map((item) => item.selector).join(' > ')}`] : []),
          ...(target.style ? [`Computed styles: ${Object.entries(target.style).map(([key, value]) => `${key}: ${value}`).join('; ')}`] : []),
        ] : []),
        ...(image ? ['Cropped screenshot attached to this chat message.'] : []),
      ].join('\n'),
    });
    if (screenshot) db.prepare(`INSERT INTO edge_chat_images (message_id, mime_type, bytes, width, height, png)
      VALUES (?, 'image/png', ?, ?, ?, ?)`)
      .run(messageId, screenshot.data.length, screenshot.metadata.width, screenshot.metadata.height, screenshot.data);
    db.prepare(`INSERT INTO edge_chat_events (grant_id, event_id, project_id, conversation_id, message_id, payload_digest)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`cli:${input.projectId}:${input.conversationId}`, input.eventId,
        input.projectId, input.conversationId, messageId, digest);
    updateProject(db, input.projectId, {});
    return { projectId: input.projectId, conversationId: input.conversationId,
      messageId, replayed: false };
  })();
}

/** Message-owned evidence is never uploaded into the project's editable source tree. */
export function migrateEdgeChatMessages(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge_chat_images (
      message_id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
      bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      png BLOB NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS edge_annotation_drafts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      text TEXT NOT NULL,
      note TEXT,
      evidence_json TEXT,
      png BLOB,
      created_at INTEGER NOT NULL,
      consumed_message_id TEXT,
      discarded_at INTEGER,
      UNIQUE(grant_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS edge_annotation_drafts_conversation
      ON edge_annotation_drafts(project_id, conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS edge_annotation_message_images (
      message_id TEXT NOT NULL,
      annotation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(message_id, annotation_id),
      UNIQUE(message_id, ordinal),
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY(annotation_id) REFERENCES edge_annotation_drafts(id)
    );
    CREATE TABLE IF NOT EXISTS edge_annotation_message_contexts (
      message_id TEXT NOT NULL,
      annotation_id TEXT NOT NULL,
      PRIMARY KEY(message_id, annotation_id),
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY(annotation_id) REFERENCES edge_annotation_drafts(id)
    );
    CREATE TABLE IF NOT EXISTS edge_chat_events (
      grant_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      PRIMARY KEY(grant_id, event_id),
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
  const columns = db.pragma('table_info(edge_annotation_drafts)') as { name: string }[];
  if (!columns.some(({ name }) => name === 'note')) db.exec('ALTER TABLE edge_annotation_drafts ADD COLUMN note TEXT');
  if (!columns.some(({ name }) => name === 'evidence_json')) db.exec('ALTER TABLE edge_annotation_drafts ADD COLUMN evidence_json TEXT');
  db.exec(`INSERT OR IGNORE INTO edge_annotation_message_contexts (message_id, annotation_id)
    SELECT message.id, draft.id FROM edge_annotation_drafts draft
    JOIN messages message ON message.id = draft.consumed_message_id
    WHERE draft.discarded_at IS NULL`);
}

export function edgeChatImageForMessage(
  db: Database.Database,
  projectId: string,
  conversationId: string,
  messageId: string,
  imageId: string = messageId,
): { metadata: ChatImageAttachment; data: Buffer } | null {
  const row = imageId === messageId
    ? db.prepare(`SELECT image.message_id AS id, image.mime_type AS mimeType,
        image.bytes AS bytes, image.width AS width, image.height AS height, image.png AS png
        FROM edge_chat_images image
        JOIN messages message ON message.id = image.message_id
        JOIN conversations conversation ON conversation.id = message.conversation_id
        WHERE image.message_id = ? AND message.conversation_id = ? AND conversation.project_id = ?`)
      .get(messageId, conversationId, projectId)
    : db.prepare(`SELECT draft.id, draft.png, 'image/png' AS mimeType
        FROM edge_annotation_message_images image
        JOIN edge_annotation_drafts draft ON draft.id = image.annotation_id
        JOIN messages message ON message.id = image.message_id
        JOIN conversations conversation ON conversation.id = message.conversation_id
        WHERE image.message_id = ? AND image.annotation_id = ? AND message.conversation_id = ?
          AND conversation.project_id = ? AND draft.png IS NOT NULL`)
      .get(messageId, imageId, conversationId, projectId);
  if (!row) return null;
  const image = row as { id: string; mimeType: 'image/png'; bytes?: number; width?: number; height?: number; png: Buffer };
  const metadata = image.bytes && image.width && image.height
    ? { id: image.id, mimeType: image.mimeType, bytes: image.bytes, width: image.width, height: image.height }
    : { id: image.id, mimeType: image.mimeType, bytes: image.png.length,
        width: image.png.readUInt32BE(16), height: image.png.readUInt32BE(20) };
  return { metadata, data: Buffer.from(image.png) };
}

export function edgeChatImageMetadata(db: Database.Database, messageId: string): ChatImageAttachment[] {
  const row = db.prepare('SELECT mime_type AS mimeType, bytes, width, height FROM edge_chat_images WHERE message_id = ?')
    .get(messageId) as Omit<ChatImageAttachment, 'id'> | undefined;
  const pendingRows = db.prepare(`SELECT draft.id, length(draft.png) AS bytes,
    substr(draft.png, 17, 4) AS widthBytes, substr(draft.png, 21, 4) AS heightBytes
    FROM edge_annotation_message_images image
    JOIN edge_annotation_drafts draft ON draft.id = image.annotation_id
    WHERE image.message_id = ? ORDER BY image.ordinal`)
    .all(messageId) as { id: string; bytes: number; widthBytes: Buffer; heightBytes: Buffer }[];
  return [
    ...(row ? [{ id: messageId, ...row }] : []),
    ...pendingRows.map((image) => ({ id: image.id, mimeType: 'image/png' as const,
      bytes: image.bytes, width: image.widthBytes.readUInt32BE(0), height: image.heightBytes.readUInt32BE(0) })),
  ];
}

export function conversationEdgeChatImageMetadata(db: Database.Database, conversationId: string): Map<string, ChatImageAttachment[]> {
  const rows = db.prepare(`
    SELECT image.message_id AS messageId, image.mime_type AS mimeType,
      image.bytes, image.width, image.height
    FROM edge_chat_images image
    JOIN messages message ON message.id = image.message_id
    WHERE message.conversation_id = ?
  `).all(conversationId) as (ChatImageAttachment & { messageId: string })[];
  const images = new Map(rows.map(({ messageId, mimeType, bytes, width, height }) => [
    messageId, [{ id: messageId, mimeType, bytes, width, height }],
  ]));
  const annotations = db.prepare(`SELECT image.message_id AS messageId, draft.id,
    length(draft.png) AS bytes, substr(draft.png, 17, 4) AS widthBytes,
    substr(draft.png, 21, 4) AS heightBytes
    FROM edge_annotation_message_images image
    JOIN edge_annotation_drafts draft ON draft.id = image.annotation_id
    JOIN messages message ON message.id = image.message_id
    WHERE message.conversation_id = ? ORDER BY image.ordinal`)
    .all(conversationId) as { messageId: string; id: string; bytes: number; widthBytes: Buffer; heightBytes: Buffer }[];
  for (const row of annotations) {
    const existing = images.get(row.messageId) ?? [];
    existing.push({ id: row.id, mimeType: 'image/png', bytes: row.bytes,
      width: row.widthBytes.readUInt32BE(0), height: row.heightBytes.readUInt32BE(0) });
    images.set(row.messageId, existing);
  }
  return images;
}

export function hasEdgeChatEvidence(db: Database.Database, messageId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM edge_chat_images WHERE message_id = ?').get(messageId)
    || db.prepare('SELECT 1 FROM edge_annotation_message_images WHERE message_id = ?').get(messageId)
    || db.prepare('SELECT 1 FROM edge_annotation_message_contexts WHERE message_id = ?').get(messageId));
}

export function copyEdgeChatEvidence(db: Database.Database, fromMessageId: string, toMessageId: string): void {
  db.prepare(`
    INSERT INTO edge_chat_images (message_id, mime_type, bytes, width, height, png)
    SELECT ?, mime_type, bytes, width, height, png FROM edge_chat_images WHERE message_id = ?
  `).run(toMessageId, fromMessageId);
  db.prepare(`INSERT INTO edge_annotation_message_images (message_id, annotation_id, ordinal)
    SELECT ?, annotation_id, ordinal FROM edge_annotation_message_images WHERE message_id = ?`)
    .run(toMessageId, fromMessageId);
  db.prepare(`INSERT INTO edge_annotation_message_contexts (message_id, annotation_id)
    SELECT ?, annotation_id FROM edge_annotation_message_contexts WHERE message_id = ?`)
    .run(toMessageId, fromMessageId);
}

export class PendingAnnotationClaimError extends Error {}

const MAX_PENDING_ANNOTATIONS_PER_CONVERSATION = 100;

/** Validated before the Run claim; the claim itself must occur inside its transaction. */
export function selectPendingEdgeAnnotations(db: Database.Database, projectId: string, conversationId: string,
  annotationIds: string[], imageIds: string[], userMessageId: string) {
  if (annotationIds.length > 20 || imageIds.length > annotationIds.length
    || new Set(annotationIds).size !== annotationIds.length || new Set(imageIds).size !== imageIds.length
    || annotationIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))
    || imageIds.some((id) => !annotationIds.includes(id))) {
    throw new PendingAnnotationClaimError('invalid browser annotation selection');
  }
  const items = annotationIds.map((id) => db.prepare(`SELECT id, project_id AS projectId,
    conversation_id AS conversationId, consumed_message_id AS consumedMessageId,
    discarded_at AS discardedAt, png FROM edge_annotation_drafts WHERE id = ?`).get(id) as {
    id: string; projectId: string; conversationId: string; consumedMessageId: string | null;
    discardedAt: number | null; png: Buffer | null;
  } | undefined);
  if (items.some((item) => !item || item.projectId !== projectId || item.conversationId !== conversationId
    || item.discardedAt !== null || (item.consumedMessageId && item.consumedMessageId !== userMessageId))
    || imageIds.some((id) => !items.find((item) => item?.id === id)?.png)) {
    throw new PendingAnnotationClaimError('browser annotation is unavailable for this conversation');
  }
  return items as NonNullable<(typeof items)[number]>[];
}

/** Called only from the existing assistant/user message claim transaction. */
export function claimPendingEdgeAnnotations(db: Database.Database, projectId: string, conversationId: string,
  userMessageId: string, annotationIds: string[], imageIds: string[]): void {
  selectPendingEdgeAnnotations(db, projectId, conversationId, annotationIds, imageIds, userMessageId);
  for (const id of annotationIds) {
    const updated = db.prepare(`UPDATE edge_annotation_drafts SET consumed_message_id = ?
      WHERE id = ? AND project_id = ? AND conversation_id = ? AND discarded_at IS NULL
        AND (consumed_message_id IS NULL OR consumed_message_id = ?)`)
      .run(userMessageId, id, projectId, conversationId, userMessageId);
    if (updated.changes !== 1) throw new PendingAnnotationClaimError('browser annotation was already claimed');
    db.prepare(`INSERT INTO edge_annotation_message_contexts (message_id, annotation_id)
      VALUES (?, ?) ON CONFLICT(message_id, annotation_id) DO NOTHING`).run(userMessageId, id);
  }
  for (let index = 0; index < imageIds.length; index++) {
    db.prepare(`INSERT INTO edge_annotation_message_images (message_id, annotation_id, ordinal)
      VALUES (?, ?, ?) ON CONFLICT(message_id, annotation_id) DO NOTHING`)
      .run(userMessageId, imageIds[index], index);
  }
}

function browserEvidence(url: string, title: string | undefined, target: EdgeAnnotationTarget | undefined,
  hasScreenshot: boolean): BrowserAnnotationEvidence {
  return { url, ...(title ? { title } : {}), ...(target ? { target } : {}),
    screenshot: hasScreenshot ? 'captured' : 'not-provided' };
}

function pendingDraft(row: Record<string, unknown>): PendingBrowserAnnotation {
  const { note, evidenceJson, ...rest } = row;
  return { ...rest, hasScreenshot: Boolean(row.hasScreenshot),
    ...(typeof note === 'string' ? { note } : {}),
    ...(typeof evidenceJson === 'string' ? { evidence: JSON.parse(evidenceJson) as BrowserAnnotationEvidence } : {}),
  } as PendingBrowserAnnotation;
}

export function storePendingEdgeAnnotation(db: Database.Database, input: ReviewedEdgeChatMessage): PendingBrowserAnnotation & { replayed: boolean } {
  const digest = createHash('sha256')
    .update(JSON.stringify({ projectId: input.grant.projectId, conversationId: input.grant.conversationId,
      eventId: input.eventId, url: input.url, title: input.title, target: input.target, note: input.note }))
    .update(input.screenshot?.data ?? '').digest('hex');
  return db.transaction(() => {
    const existing = db.prepare(`SELECT id, project_id AS projectId, conversation_id AS conversationId,
      event_id AS eventId, text, note, evidence_json AS evidenceJson,
      png IS NOT NULL AS hasScreenshot, created_at AS createdAt,
      payload_digest AS digest FROM edge_annotation_drafts WHERE grant_id = ? AND event_id = ?`)
      .get(input.grant.grantId, input.eventId) as (Omit<PendingBrowserAnnotation, 'hasScreenshot'> & { digest: string; hasScreenshot: number }) | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Error('annotation event was already used with different content');
      const { digest: _digest, ...draft } = existing;
      return { ...pendingDraft(draft as unknown as Record<string, unknown>), replayed: true };
    }
    const outstanding = db.prepare(`SELECT count(*) AS count FROM edge_annotation_drafts
      WHERE project_id = ? AND conversation_id = ? AND consumed_message_id IS NULL AND discarded_at IS NULL`)
      .get(input.grant.projectId, input.grant.conversationId) as { count: number };
    if (outstanding.count >= MAX_PENDING_ANNOTATIONS_PER_CONVERSATION) {
      throw new Error('too many pending browser annotations; send or discard some first');
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const note = input.note.trim();
    const evidence = browserEvidence(input.url, input.title, input.target, Boolean(input.screenshot));
    const text = textForChat(input);
    db.prepare(`INSERT INTO edge_annotation_drafts
      (id, project_id, conversation_id, grant_id, event_id, payload_digest, text, note, evidence_json, png, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.grant.projectId, input.grant.conversationId, input.grant.grantId,
        input.eventId, digest, text, note, JSON.stringify(evidence), input.screenshot?.data ?? null, createdAt);
    return { id, projectId: input.grant.projectId, conversationId: input.grant.conversationId,
      eventId: input.eventId, text, note, evidence, hasScreenshot: Boolean(input.screenshot), createdAt, replayed: false };
  })();
}

export function storePendingNativeAnnotation(db: Database.Database, input: BrowserAnnotationPostRequest & { projectId: string }): PendingBrowserAnnotation & { replayed: boolean } {
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 4096
    || typeof input.eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.eventId)) {
    throw new Error('a bounded note and event ID are required');
  }
  const screenshot = input.screenshotDataUrl ? validateEdgeAnnotationScreenshot(input.screenshotDataUrl) : undefined;
  const target = input.target === undefined ? undefined : {
    ...input.target,
    ...normalizedBrowserScope(input.target?.scope),
    text: normalizeEdgeAnnotationText(input.target?.text, 300),
    label: normalizeEdgeAnnotationText(input.target?.label, 160),
    ...(input.target?.domOutline === undefined ? {} : {
      domOutline: normalizeEdgeAnnotationText(input.target.domOutline, 1200, true),
    }),
    ...(input.target?.ancestors === undefined ? {} : {
      ancestors: normalizeEdgeAnnotationAncestors(input.target.ancestors),
    }),
    ...(input.target?.style === undefined ? {} : {
      style: normalizeEdgeAnnotationStyle(input.target.style),
    }),
  };
  if (target !== undefined && (!target || typeof target !== 'object'
    || typeof target.selector !== 'string' || target.selector.length > 4096
    || typeof target.text !== 'string' || target.text.length > 4000
    || typeof target.label !== 'string' || target.label.length > 512
    || typeof target.htmlHint !== 'string' || target.htmlHint.length > 4000
    || (target.domOutline !== undefined && (typeof target.domOutline !== 'string' || target.domOutline.length > 8000))
    || !target.position || ![target.position.x, target.position.y, target.position.width, target.position.height]
      .every((value) => typeof value === 'number' && Number.isFinite(value))
    || target.position.width < 0 || target.position.height < 0
    || (target.ancestors !== undefined && (!Array.isArray(target.ancestors) || target.ancestors.length > 8
      || target.ancestors.some((item) => !item || typeof item.tag !== 'string' || typeof item.selector !== 'string')))
    || (target.style !== undefined && (!target.style || typeof target.style !== 'object' || Array.isArray(target.style)
      || Object.values(target.style).some((value) => typeof value !== 'string')))
    || JSON.stringify(target).length > 24000)) throw new Error('annotation context is malformed or too large');
  const { projectId, conversationId, eventId, note, title, url } = input;
  const digest = createHash('sha256').update(JSON.stringify({ projectId, conversationId,
    eventId, note: note.trim(), target, title, url })).update(screenshot?.data ?? '').digest('hex');
  return db.transaction(() => {
    const grantId = `native:${projectId}:${conversationId}`;
    const existing = db.prepare(`SELECT id, project_id AS projectId, conversation_id AS conversationId,
      event_id AS eventId, text, note, evidence_json AS evidenceJson,
      png IS NOT NULL AS hasScreenshot, created_at AS createdAt,
      payload_digest AS digest FROM edge_annotation_drafts WHERE grant_id = ? AND event_id = ?`)
      .get(grantId, eventId) as (Omit<PendingBrowserAnnotation, 'hasScreenshot'> & { digest: string; hasScreenshot: number }) | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Error('annotation event was already used with different content');
      const { digest: _digest, ...draft } = existing;
      return { ...pendingDraft(draft as unknown as Record<string, unknown>), replayed: true };
    }
    const outstanding = db.prepare(`SELECT count(*) AS count FROM edge_annotation_drafts
      WHERE project_id = ? AND conversation_id = ? AND consumed_message_id IS NULL AND discarded_at IS NULL`)
      .get(projectId, conversationId) as { count: number };
    if (outstanding.count >= MAX_PENDING_ANNOTATIONS_PER_CONVERSATION) {
      throw new Error('too many pending browser annotations; send or discard some first');
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const text = [note.trim(), '', `Browser page: ${url}`,
      'Browser reference; the URL does not identify an editable project file.',
      ...(target ? [`Element: ${target.label}`, `Selector: ${target.selector}`,
        `Position: ${target.position.x},${target.position.y} ${target.position.width}x${target.position.height}`,
        `Visible text: ${target.text}`, ...(target.domOutline ? [`DOM outline: ${target.domOutline}`] : []),
        ...(target.htmlHint ? [`Element markup: ${target.htmlHint}`] : []),
        ...(target.ancestors?.length ? [`Ancestors: ${target.ancestors.map((item) => item.selector).join(' > ')}`] : []),
        ...(target.style ? [`Computed styles: ${Object.entries(target.style).map(([key, value]) => `${key}: ${value}`).join('; ')}`] : []),
      ] : []),
    ].join('\n');
    const evidence = browserEvidence(url, title, target, Boolean(screenshot));
    db.prepare(`INSERT INTO edge_annotation_drafts
      (id, project_id, conversation_id, grant_id, event_id, payload_digest, text, note, evidence_json, png, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, conversationId, grantId, eventId, digest, text, note.trim(),
        JSON.stringify(evidence), screenshot?.data ?? null, createdAt);
    return { id, projectId, conversationId, eventId, text, note: note.trim(), evidence,
      hasScreenshot: Boolean(screenshot), createdAt, replayed: false };
  })();
}

export function discardPendingEdgeAnnotation(db: Database.Database, projectId: string,
  conversationId: string, id: string): boolean {
  return db.prepare(`UPDATE edge_annotation_drafts SET discarded_at = ?, png = NULL
    WHERE id = ? AND project_id = ? AND conversation_id = ?
      AND consumed_message_id IS NULL AND discarded_at IS NULL`)
    .run(Date.now(), id, projectId, conversationId).changes === 1;
}

export function listPendingEdgeAnnotations(db: Database.Database, projectId: string, conversationId: string): PendingBrowserAnnotation[] {
  return db.prepare(`SELECT id, project_id AS projectId, conversation_id AS conversationId,
    event_id AS eventId, text, note, evidence_json AS evidenceJson,
    png IS NOT NULL AS hasScreenshot, created_at AS createdAt
    FROM edge_annotation_drafts WHERE project_id = ? AND conversation_id = ?
      AND consumed_message_id IS NULL AND discarded_at IS NULL ORDER BY created_at, rowid`)
    .all(projectId, conversationId).map((row) => pendingDraft(row as Record<string, unknown>));
}

export function pendingEdgeAnnotationContext(db: Database.Database, projectId: string, conversationId: string,
  id: string): BrowserAnnotationEvidence | null {
  const row = db.prepare(`SELECT evidence_json AS evidenceJson FROM edge_annotation_drafts
    WHERE id = ? AND project_id = ? AND conversation_id = ?
      AND consumed_message_id IS NULL AND discarded_at IS NULL`)
    .get(id, projectId, conversationId) as { evidenceJson: string | null } | undefined;
  return row?.evidenceJson ? JSON.parse(row.evidenceJson) as BrowserAnnotationEvidence : null;
}

export function claimedEdgeAnnotationContext(db: Database.Database, projectId: string, conversationId: string,
  userMessageId: string, id: string): BrowserAnnotationEvidence | null {
  const row = db.prepare(`SELECT draft.evidence_json AS evidenceJson FROM edge_annotation_message_contexts context
    JOIN edge_annotation_drafts draft ON draft.id = context.annotation_id
    JOIN messages message ON message.id = context.message_id
    JOIN conversations conversation ON conversation.id = message.conversation_id
    WHERE context.annotation_id = ? AND context.message_id = ? AND message.conversation_id = ?
      AND conversation.project_id = ? AND draft.project_id = ? AND draft.discarded_at IS NULL`)
    .get(id, userMessageId, conversationId, projectId, projectId) as { evidenceJson: string | null } | undefined;
  return row?.evidenceJson ? JSON.parse(row.evidenceJson) as BrowserAnnotationEvidence : null;
}

export function claimedEdgeAnnotationContexts(db: Database.Database, projectId: string, conversationId: string,
  userMessageId: string, ids: string[]): BrowserAnnotationEvidence[] {
  const read = db.prepare(`SELECT draft.evidence_json AS evidenceJson FROM edge_annotation_message_contexts context
    JOIN edge_annotation_drafts draft ON draft.id = context.annotation_id
    JOIN messages message ON message.id = context.message_id
    JOIN conversations conversation ON conversation.id = message.conversation_id
    WHERE context.annotation_id = ? AND context.message_id = ? AND message.conversation_id = ?
      AND conversation.project_id = ? AND draft.project_id = ? AND draft.discarded_at IS NULL`);
  return ids.flatMap((id) => {
    const row = read.get(id, userMessageId, conversationId, projectId, projectId) as {
      evidenceJson: string | null;
    } | undefined;
    if (!row) throw new PendingAnnotationClaimError('claimed annotation context is unavailable');
    // Drafts collected before the structured evidence migration carried their
    // context in the original message text and have no JSON attachment.
    return row.evidenceJson ? [JSON.parse(row.evidenceJson) as BrowserAnnotationEvidence] : [];
  });
}

export function conversationEdgeAnnotationContexts(db: Database.Database, conversationId: string): Map<string, string[]> {
  const rows = db.prepare(`SELECT draft.id, context.message_id AS messageId
    FROM edge_annotation_message_contexts context
    JOIN edge_annotation_drafts draft ON draft.id = context.annotation_id
    JOIN messages message ON message.id = context.message_id
    WHERE message.conversation_id = ? AND draft.discarded_at IS NULL
      AND draft.evidence_json IS NOT NULL ORDER BY draft.created_at, draft.rowid`)
    .all(conversationId) as { id: string; messageId: string }[];
  const contexts = new Map<string, string[]>();
  for (const { id, messageId } of rows) contexts.set(messageId, [...(contexts.get(messageId) ?? []), id]);
  return contexts;
}

export function edgeAnnotationContextIds(db: Database.Database, messageId: string): string[] {
  const rows = db.prepare(`SELECT draft.id FROM edge_annotation_message_contexts context
    JOIN edge_annotation_drafts draft ON draft.id = context.annotation_id
    WHERE context.message_id = ? AND draft.discarded_at IS NULL AND draft.evidence_json IS NOT NULL
    ORDER BY draft.created_at, draft.rowid`).all(messageId) as { id: string }[];
  return rows.map(({ id }) => id);
}

export function claimedEdgeAnnotationImages(db: Database.Database, projectId: string, conversationId: string,
  userMessageId: string, imageIds: string[]): Buffer[] {
  const rows = imageIds.map((id) => db.prepare(`SELECT draft.png FROM edge_annotation_message_images image
    JOIN edge_annotation_drafts draft ON draft.id = image.annotation_id
    JOIN messages message ON message.id = image.message_id
    JOIN conversations conversation ON conversation.id = message.conversation_id
    WHERE image.message_id = ? AND image.annotation_id = ? AND message.conversation_id = ?
      AND conversation.project_id = ? AND draft.consumed_message_id = ? AND draft.png IS NOT NULL`)
    .get(userMessageId, id, conversationId, projectId, userMessageId) as { png: Buffer } | undefined);
  if (rows.some((row) => !row)) throw new PendingAnnotationClaimError('claimed screenshot is unavailable');
  return rows.map((row) => Buffer.from(row!.png));
}

export function pendingEdgeAnnotationImage(db: Database.Database, projectId: string, conversationId: string, id: string): Buffer | null {
  const row = db.prepare(`SELECT png FROM edge_annotation_drafts WHERE id = ? AND project_id = ?
    AND conversation_id = ? AND consumed_message_id IS NULL AND discarded_at IS NULL`)
    .get(id, projectId, conversationId) as { png: Buffer | null } | undefined;
  return row?.png ? Buffer.from(row.png) : null;
}

export function textForChat(input: ReviewedEdgeChatMessage): string {
  const { target } = input;
  const ancestors = (target.ancestors ?? []).map((ancestor) =>
    `${ancestor.tag}${ancestor.role ? `[role=${ancestor.role}]` : ''} ${ancestor.selector}`).join(' > ');
  const styles = Object.entries(target.style ?? {}).map(([key, value]) => `${key}: ${value}`).join('; ');
  return [
    input.note,
    '',
    `Browser page: ${input.url}`,
    'External browser reference, not a writable project file. Locate authorized source before editing; Microsoft-owned pages can only be reviewed as feedback.',
    `Element: ${target.label || target.htmlHint}`,
    `Selector: ${target.selector}`,
    `Viewport position: ${target.position.x},${target.position.y} ${target.position.width}x${target.position.height}`,
    `Ancestor structure: ${ancestors || '(none)'}`,
    `Visible text: ${target.text || '(none)'}`,
    `DOM outline: ${target.domOutline || '(none)'}`,
    `Computed styles: ${styles || '(none)'}`,
  ].join('\n');
}

/** An idempotent, transactional user-message append. No agent Run is started. */
export function appendReviewedEdgeChatMessage(db: Database.Database, input: ReviewedEdgeChatMessage): EdgeChatMessageResult {
  const payloadDigest = createHash('sha256')
    .update(JSON.stringify({ projectId: input.grant.projectId, conversationId: input.grant.conversationId,
      eventId: input.eventId, url: input.url, title: input.title, target: input.target, note: input.note }))
    .update(input.screenshot?.data ?? '')
    .digest('hex');
  const commit = db.transaction(() => {
    const existing = db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId,
        message_id AS messageId, payload_digest AS payloadDigest
      FROM edge_chat_events WHERE grant_id = ? AND event_id = ?
    `).get(input.grant.grantId, input.eventId) as {
      projectId: string; conversationId: string; messageId: string; payloadDigest: string;
    } | undefined;
    if (existing) {
      if (existing.payloadDigest !== payloadDigest || existing.projectId !== input.grant.projectId
        || existing.conversationId !== input.grant.conversationId) {
        throw new Error('annotation event was already used with different content');
      }
      return { projectId: existing.projectId, conversationId: existing.conversationId,
        messageId: existing.messageId, replayed: true };
    }
    const conversation = db.prepare('SELECT project_id AS projectId FROM conversations WHERE id = ?')
      .get(input.grant.conversationId) as { projectId: string } | undefined;
    if (conversation?.projectId !== input.grant.projectId) throw new Error('paired conversation no longer belongs to this project');
    const messageId = randomUUID();
    const now = Date.now();
    upsertMessage(db, input.grant.conversationId, {
      id: messageId, role: 'user', content: textForChat(input), createdAt: now,
      startedAt: now, endedAt: now,
    });
    if (input.screenshot) db.prepare(`INSERT INTO edge_chat_images (message_id, mime_type, bytes, width, height, png)
      VALUES (?, 'image/png', ?, ?, ?, ?)`)
      .run(messageId, input.screenshot.data.length, input.screenshot.metadata.width,
        input.screenshot.metadata.height, input.screenshot.data);
    db.prepare(`INSERT INTO edge_chat_events
      (grant_id, event_id, project_id, conversation_id, message_id, payload_digest)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.grant.grantId, input.eventId, input.grant.projectId,
        input.grant.conversationId, messageId, payloadDigest);
    updateProject(db, input.grant.projectId, {});
    return { projectId: input.grant.projectId, conversationId: input.grant.conversationId,
      messageId, replayed: false };
  });
  return commit();
}

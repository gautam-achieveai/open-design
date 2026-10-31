import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpToolRegistry, type McpToolContext } from '../src/mcp-http/registry.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { registerBriefMcpTools } from '../src/mcp-http/brief-tools.js';
import { createMcpHttpResources } from '../src/mcp-http/resources.js';
import { OPEN_DESIGN_BRIEF_APP_RESOURCE } from '../src/mcp-apps/brief-resource.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('od-brief-resources-')) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-brief-resources-')); roots.push(root);
  let now = Date.now();
  const tokenRegistry = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const credentialStore = new McpCredentialStore({ filePath: path.join(root, 'credentials.json'), now: () => now });
  const create = () => credentialStore.create({ name: 'Synthetic', allowedOperations: ['brief/*', 'catalog/skills:read', 'catalog/design-systems:read'] });
  const credential = create();
  const context = (value = credential): McpToolContext => ({
    grant: { kind: 'external', runId: null, projectId: null, credentialId: value.credential.id, name: 'Synthetic', allowedOperations: value.credential.allowedOperations },
    request: { get: (key: string) => key.toLowerCase() === 'authorization' ? `Bearer ${value.token}` : undefined } as never,
    signal: undefined, metadata: { 'openai/locale': 'ja' },
  });
  const deps = { tokenRegistry, credentialStore, projectExists: () => false, getRun: () => undefined,
    getProjectWorkspaceId: () => null, decideProjectRequest: () => ({ ok: false }) as never };
  registerBriefMcpTools(registry, { ...deps, now: () => now });
  const f = { registry, tokenRegistry, credentialStore, credential, create, context, now: (advance: number) => { now += advance; }, valid: true,
    skills: [{ id: 'synthetic', name: 'Synthetic', description: 'Synthetic', body: 'Synthetic body' }], wait: undefined as Promise<void> | undefined,
    reached: undefined as (() => void) | undefined };
  const resources = createMcpHttpResources(registry, { ...deps,
    listSkillsSnapshot: async () => { f.reached?.(); await f.wait; return { entries: f.skills, revalidate: () => f.valid }; },
    listDesignSystemsSnapshot: async () => ({ entries: [], revalidate: () => f.valid }), readDesignSystem: async () => null });
  return Object.assign(f, { resources, call: (name: string, args: unknown, ctx = context()) => registry.call(name, args, ctx.grant, ctx.signal, ctx.request, ctx.metadata) });
}

it('keeps HTTP brief collect/resource/confirmation state inside one current credential', async () => {
  const f = await fixture();
  try {
    const collected = await f.call('collect_brief', { artifactType: 'website', skip: true });
    if (!collected.structuredContent.ok) throw new Error('fixture collection failed');
    const draft = collected.structuredContent.data as { briefDraftId: string; nonce: string; locale: string };
    expect(draft.locale).toBe('ja');
    expect(f.registry.listWireTools(f.context().grant).find(tool => tool.name === 'collect_brief')?._meta).toMatchObject({ ui: { resourceUri: OPEN_DESIGN_BRIEF_APP_RESOURCE } });
    expect((await f.resources.read(OPEN_DESIGN_BRIEF_APP_RESOURCE, f.context())).contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', _meta: { version: 'v9' } });
    const args = { briefDraftId: draft.briefDraftId, nonce: draft.nonce, answers: {} };
    expect((await f.call('confirm_brief', args, f.context(f.create()))).structuredContent.ok).toBe(false);
    const confirmed = await f.call('confirm_brief', args);
    expect(confirmed.structuredContent).toMatchObject({ ok: true, data: { view: 'brief-confirmed', locale: 'ja' } });
    if (!confirmed.structuredContent.ok) throw new Error('fixture confirmation failed');
    expect((await f.call('confirm_brief', args)).structuredContent).toMatchObject({ ok: true, data: confirmed.structuredContent.data });
    f.now(16 * 60 * 1000);
    expect((await f.call('confirm_brief', args)).structuredContent.ok).toBe(false);
    f.credentialStore.revoke(f.credential.credential.id);
    await expect(f.resources.read(OPEN_DESIGN_BRIEF_APP_RESOURCE, f.context())).rejects.toThrow('Resource unavailable');
  } finally { f.tokenRegistry.clear(); }
});

it('keeps resource cursors scoped, bodies bounded and authority current after discovery', async () => {
  const f = await fixture();
  try {
    f.skills = Array.from({ length: 75 }, (_, index) => ({ id: `skill-${index}`, name: 'Synthetic', description: 'Synthetic', body: 'x'.repeat(40_000) }));
    const first = await f.resources.list(f.context());
    expect(first.resources).toHaveLength(50); expect(first.nextCursor).toBeTruthy();
    await expect(f.resources.list(f.context(f.create()), first.nextCursor)).rejects.toThrow('Resource unavailable');
    const second = await f.resources.list(f.context(), first.nextCursor);
    expect(second.resources).toHaveLength(26); // 75 skills plus the brief resource.
    const read = await f.resources.read('od://skills/skill-0/SKILL.md', f.context());
    expect(read.contents[0]?._meta).toMatchObject({ truncated: true });
    const content = read.contents[0];
    expect(content).toHaveProperty('text');
    if (!content || !('text' in content)) throw new Error('Expected a text resource');
    expect(content.text.length).toBeLessThan(32_200);
    let release!: () => void;
    const reached = new Promise<void>(resolve => { f.reached = resolve; });
    f.wait = new Promise<void>(resolve => { release = resolve; });
    const pending = f.resources.read('od://skills/skill-0/SKILL.md', f.context());
    await reached; f.valid = false; release();
    await expect(pending).rejects.toThrow('Resource unavailable');
  } finally { f.tokenRegistry.clear(); }
});

it('does not persist or return a brief containing its credential', async () => {
  const f = await fixture();
  try {
    const result = await f.call('collect_brief', { artifactType: 'website', projectTitle: f.credential.token });
    expect(result.structuredContent.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(f.credential.token);
  } finally { f.tokenRegistry.clear(); }
});

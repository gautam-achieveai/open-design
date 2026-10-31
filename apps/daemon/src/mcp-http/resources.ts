import { ErrorCode, McpError, type ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { OPEN_DESIGN_BRIEF_APP_HTML, OPEN_DESIGN_BRIEF_APP_RESOURCE, OPEN_DESIGN_BRIEF_APP_VERSION,
  briefAppResourceDefinition } from '../mcp-apps/brief-resource.js';
import { resolveCatalogAccess, type CatalogAccessDeps, type CatalogScope } from './catalog-access.js';
import { collectionPage } from './collection-pages.js';
import { operationAllowed, type McpToolContext, type McpToolRegistry } from './registry.js';
import type { McpHttpResources } from './routes.js';

type SkillEntry = { id: string; name?: string; description?: string; body?: string };
type DesignEntry = { id: string; title?: string; name?: string; summary?: string; teamSynced?: boolean };
type Snapshot<T> = { entries: T[]; revalidate: (ids: readonly string[]) => boolean };
type Resource = ListResourcesResult['resources'][number];
const SKILLS = 'catalog/skills:read', DESIGNS = 'catalog/design-systems:read', BRIEF = 'brief/resource:read';
const unavailable = () => new McpError(ErrorCode.InvalidParams, 'Resource unavailable for this credential');

export function createMcpHttpResources(registry: McpToolRegistry, deps: CatalogAccessDeps & {
  listSkillsSnapshot: (scope: CatalogScope) => Promise<Snapshot<SkillEntry>>;
  listDesignSystemsSnapshot: (scope: CatalogScope) => Promise<Snapshot<DesignEntry>>;
  readDesignSystem: (id: string, scope: CatalogScope, exactTeam: boolean) => Promise<string | null>;
}): McpHttpResources {
  const safe = (text: string, context: McpToolContext) => {
    const bearer = context.request && bearerTokenFromRequest(context.request);
    return !/(?:odtt_|odmcp_)[A-Za-z0-9_-]+/.test(text) && !(bearer && text.includes(bearer));
  };
  return {
    async list(context, cursor) {
      try {
        const entries: Resource[] = [], checks: Array<() => boolean> = [];
        for (const [operation, kind, load] of [[SKILLS, 'skills', deps.listSkillsSnapshot], [DESIGNS, 'design-systems', deps.listDesignSystemsSnapshot]] as const) {
          if (!operationAllowed(context.grant.allowedOperations, operation)) continue;
          const access = resolveCatalogAccess(context, operation, deps); if (!access) throw unavailable();
          const snapshot = await load(access.scope);
          const ids = snapshot.entries.map(entry => entry.id);
          checks.push(() => access.current() && snapshot.revalidate(ids));
          for (const entry of snapshot.entries) {
            const value = entry as SkillEntry & DesignEntry;
            entries.push({ uri: `od://${kind}/${encodeURIComponent(value.id)}/${kind === 'skills' ? 'SKILL.md' : 'DESIGN.md'}`,
              name: `${kind === 'skills' ? 'Skill' : 'Design system'}: ${value.title || value.name || value.id}`,
              description: (value.description || value.summary || '').replace(/\s+/g, ' ').slice(0, 512), mimeType: 'text/markdown' });
          }
        }
        if (operationAllowed(context.grant.allowedOperations, BRIEF)) {
          const access = resolveCatalogAccess(context, BRIEF, deps); if (!access) throw unavailable();
          entries.unshift(briefAppResourceDefinition()); checks.push(access.current);
        }
        if (operationAllowed(context.grant.allowedOperations, 'context/active:read')) {
          const active = await registry.call('get_active_context', {}, context.grant, context.signal, context.request);
          if (!active.structuredContent.ok) throw unavailable();
          entries.push({ uri: 'od://focus/active', name: 'Active OpenDesign context', mimeType: 'application/json' });
        }
        if (checks.some(check => !check())) throw unavailable();
        const page = collectionPage({ entries, domain: 'resources_list', scope: context.grant, cursor,
          token: context.request && bearerTokenFromRequest(context.request), render: resources => ({ resources }), compact: () => null });
        if (!page.ok) throw unavailable();
        const nextCursor = (page.data.page as { nextCursor?: string } | undefined)?.nextCursor;
        return { resources: page.data.resources as Resource[], ...(nextCursor ? { nextCursor } : {}) };
      } catch { throw unavailable(); }
    },
    async read(uri, context) {
      try {
        if (!safe(uri, context)) throw unavailable();
        if (uri === OPEN_DESIGN_BRIEF_APP_RESOURCE) {
          if (!resolveCatalogAccess(context, BRIEF, deps)) throw unavailable();
          return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: OPEN_DESIGN_BRIEF_APP_HTML, _meta: { version: OPEN_DESIGN_BRIEF_APP_VERSION } }] };
        }
        if (uri === 'od://focus/active') {
          const result = await registry.call('get_active_context', {}, context.grant, context.signal, context.request);
          if (!result.structuredContent.ok) throw unavailable();
          return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.structuredContent.data) }] };
        }
        const parsed = /^od:\/\/(skills|design-systems)\/([^/]+)\/(SKILL\.md|DESIGN\.md)$/.exec(uri);
        if (!parsed || (parsed[1] === 'skills') !== (parsed[3] === 'SKILL.md')) throw unavailable();
        const id = decodeURIComponent(parsed[2]!); if (!id || id.length > 512) throw unavailable();
        const skill = parsed[1] === 'skills', access = resolveCatalogAccess(context, skill ? SKILLS : DESIGNS, deps);
        if (!access) throw unavailable();
        const snapshot = skill ? await deps.listSkillsSnapshot(access.scope) : await deps.listDesignSystemsSnapshot(access.scope);
        const entry = snapshot.entries.find(entry => entry.id === id);
        if (!entry || !access.current() || !snapshot.revalidate([id])) throw unavailable();
        const text = skill ? (entry as SkillEntry).body : await deps.readDesignSystem(id, access.scope, (entry as DesignEntry).teamSynced === true);
        if (typeof text !== 'string' || !safe(text, context) || !access.current() || !snapshot.revalidate([id])) throw unavailable();
        const truncated = text.length > 32_000;
        return { contents: [{ uri, mimeType: 'text/markdown', text: truncated ? text.slice(0, 32_000) + '\n[Resource truncated; use the local UI or CLI for the complete document.]' : text,
          ...(truncated ? { _meta: { truncated: true } } : {}) }] };
      } catch { throw unavailable(); }
    },
  };
}

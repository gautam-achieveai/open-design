import { z } from 'zod';
import { createLocalMcpBriefStore, localeFromMcpToolMetadata, type LocalMcpBriefStore } from '../mcp-brief.js';
import { OPEN_DESIGN_BRIEF_APP_RESOURCE } from '../mcp-apps/brief-resource.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { resolveCatalogAccess, type CatalogAccessDeps } from './catalog-access.js';
import { McpToolRegistry, toolError, toolOk, type McpToolContext } from './registry.js';

const TTL = 15 * 60 * 1000, MAX_PRINCIPALS = 128, MAX_DRAFTS = 128;
const answer = z.union([z.string().max(256), z.array(z.string().max(256)).max(32)]);
const answers = z.record(z.string().max(128), answer).refine(value => Object.keys(value).length <= 40, 'Too many answers');
const unsupported = { pluginWorkflowId: z.unknown().optional(), externalPluginContext: z.unknown().optional() };

/** Draft state is local to one current credential/run, not an HTTP connection. */
export function registerBriefMcpTools(registry: McpToolRegistry, deps: CatalogAccessDeps & { now?: () => number }): void {
  const now = deps.now ?? Date.now;
  const stores = new Map<string, { store: LocalMcpBriefStore; drafts: Map<string, number> }>();
  const principal = (context: McpToolContext) => context.grant.kind === 'run'
    ? `run:${context.grant.runId}` : `external:${context.grant.credentialId}`;
  const prune = () => {
    const at = now();
    for (const [key, state] of stores) {
      for (const [id, expiresAt] of state.drafts) if (expiresAt <= at) state.drafts.delete(id);
      if (!state.drafts.size) stores.delete(key);
    }
  };
  const denied = () => toolError('BRIEF_UNAVAILABLE', 'Brief unavailable for this credential', 0);
  const safe = (value: unknown, context: McpToolContext) => {
    const serialized = JSON.stringify(value), token = context.request && bearerTokenFromRequest(context.request);
    return serialized.length <= 24_000 && !/(?:odtt_|odmcp_)[A-Za-z0-9_-]+/.test(serialized) && !(token && serialized.includes(token));
  };
  registry.register({ name: 'collect_brief', operation: 'brief/collect', version: 1,
    description: 'Open the interactive OpenDesign brief card. Confirmation returns a readable brief. Draft IDs and nonces are internal widget data.',
    wireMeta: { ui: { resourceUri: OPEN_DESIGN_BRIEF_APP_RESOURCE }, 'ui/resourceUri': OPEN_DESIGN_BRIEF_APP_RESOURCE, 'openai/outputTemplate': OPEN_DESIGN_BRIEF_APP_RESOURCE },
    schema: z.object({ artifactType: z.enum(['website', 'product-prototype', 'presentation', 'document', 'image', 'video', 'audio', 'design-system']),
      projectTitle: z.string().min(1).max(256).optional(), locale: z.string().max(64).optional(), knownAnswers: answers.optional(), skip: z.boolean().optional(), ...unsupported }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined || args.externalPluginContext !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'Plugin attribution is not supported by HTTP MCP', 0);
      const access = resolveCatalogAccess(context, 'brief/collect', deps); if (!access) return denied();
      if (!safe(args, context)) return toolError('BRIEF_INVALID', 'Brief input cannot be returned safely', 0);
      prune(); const key = principal(context);
      let state = stores.get(key);
      if (!state && stores.size >= MAX_PRINCIPALS) return toolError('BRIEF_CAPACITY', 'Brief capacity reached; retry after older drafts expire', 0);
      state ??= { store: createLocalMcpBriefStore({ now, ttlMs: TTL }), drafts: new Map() };
      if (state.drafts.size >= MAX_DRAFTS) return toolError('BRIEF_CAPACITY', 'Too many active briefs for this credential', 0);
      try {
        const data = state.store.collect({ ...args, locale: args.locale ?? localeFromMcpToolMetadata(context.metadata) });
        if (!safe(data, context) || !access.current()) return denied();
        state.drafts.set(data.briefDraftId, data.expiresAt); stores.set(key, state);
        return toolOk(data, 0);
      } catch { return toolError('BRIEF_INVALID', 'Unable to collect this brief', 0); }
    },
  });
  registry.register({ name: 'confirm_brief', operation: 'brief/confirm', version: 1,
    description: 'Confirm choices from this credential’s OpenDesign brief card. Returns its readable summary; keep internal correlation values out of user-facing replies.',
    schema: z.object({ briefDraftId: z.string().uuid(), nonce: z.string().min(1).max(128), answers,
      locale: z.string().max(64).optional(), pluginWorkflowId: z.unknown().optional() }).strict(),
    handler: async (args, context) => {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'Plugin attribution is not supported by HTTP MCP', 0);
      const access = resolveCatalogAccess(context, 'brief/confirm', deps); if (!access) return denied();
      prune(); const state = stores.get(principal(context));
      if (!state?.drafts.has(args.briefDraftId)) return denied();
      try {
        const data = state.store.confirm({ ...args, locale: args.locale ?? localeFromMcpToolMetadata(context.metadata) });
        return safe(data, context) && access.current() ? toolOk(data, 0) : denied();
      } catch { return toolError('BRIEF_INVALID', 'Brief is expired, invalid, incomplete or already confirmed differently', 0); }
    },
  });
}

import { z } from 'zod';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { LiveArtifactSummary, ListLiveArtifactsOptions } from '../live-artifacts/store.js';
import { listLiveArtifactsForTool } from '../services/live-artifact-tool-list.js';
import { createLiveArtifactForTool, updateLiveArtifactForTool, refreshLiveArtifactForTool, LiveArtifactToolCancelledError, type LiveArtifactToolWriteDeps } from '../services/live-artifact-tool-write.js';
import { LiveArtifactStoreValidationError, LiveArtifactRefreshLockError } from '../live-artifacts/store.js';
import { LiveArtifactRefreshUnavailableError } from '../live-artifacts/refresh-service.js';
import { LiveArtifactRefreshAbortError } from '../live-artifacts/refresh.js';
import { ConnectorServiceError } from '../connectors/service.js';
import type { LiveArtifactProvenance } from '../live-artifacts/schema.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { authorizeCurrentRunProject } from './run-project-authority.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';
import { collectionPage, collectionPageSchema } from './collection-pages.js';

const LIST_ENDPOINT = '/api/tools/live-artifacts/list';
const LIST_OPERATION = 'live-artifacts:list';

export function registerLiveArtifactMcpTools(
  registry: McpToolRegistry,
  deps: LiveArtifactToolWriteDeps & Parameters<typeof authorizeCurrentRunProject>[1] & {
    projectExists: (projectId: string) => boolean;
    tokenRegistry: ToolTokenRegistry;
    projectsRoot: string;
    authorizeProjectTool: (projectId: string) => Promise<boolean>;
    listLiveArtifacts: (options: ListLiveArtifactsOptions) => Promise<LiveArtifactSummary[]>;
  },
): void {
  const current = (context: import('./registry.js').McpToolContext, runId: string, projectId: string, operation: string, mode: 'read' | 'write') => {
    if (!context.request || !deps.projectExists(projectId)) return false;
    const checked = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), {
      endpoint: `/api/tools/live-artifacts/${operation}`, operation: `live-artifacts:${operation}`,
    });
    return checked.ok && checked.grant.runId === runId && checked.grant.projectId === projectId
      && authorizeCurrentRunProject({ request: context.request, runId, projectId,
        options: mode === 'read' ? { mode: 'read' } : { mode: 'write', capability: 'writeFiles' } }, deps);
  };
  registry.register({
    name: 'live_artifacts_list',
    description: 'List live artifacts for the current project. Follow page.nextCursor; if inventory changes, restart the listing.',
    operation: LIST_OPERATION,
    version: 1,
    annotations: { readOnlyHint: true },
    schema: z.object({ cursor: z.string().min(1).max(collectionPageSchema.cursor.maxLength).optional(), limit: z.number().int().min(1).max(collectionPageSchema.maxItems).optional() }).strict(),
    handler: async (args, context) => {
      if (context.grant.kind !== 'run') {
        return toolError('EXTERNAL_APPROVAL_REQUIRED', 'external artifact access requires trusted credential issuance', 0);
      }
      if (!context.request) return toolError('TOOL_TOKEN_MISSING', 'run token is required', 0);
      const validated = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), {
        endpoint: LIST_ENDPOINT,
        operation: LIST_OPERATION,
      });
      if (!validated.ok) return toolError(validated.code, validated.message, 0);
      if (validated.grant.runId !== context.grant.runId || validated.grant.projectId !== context.grant.projectId) {
        return toolError('PROJECT_SCOPE_DENIED', 'run or project is outside the caller scope', 0);
      }
      const { runId, projectId } = validated.grant;
      if (!current(context, runId, projectId, 'list', 'read')) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      const result = await listLiveArtifactsForTool(validated.grant, { ...deps,
        authorizeProjectToolCurrent: () => current(context, runId, projectId, 'list', 'read'),
      });
      if (!result.ok || !current(context, runId, projectId, 'list', 'read')) return toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      const page = collectionPage({ entries: result.artifacts, domain: 'live_artifacts_list', scope: { projectId, runId },
        cursor: args.cursor, limit: args.limit, token: bearerTokenFromRequest(context.request),
        render: (artifacts) => ({ artifacts }),
        compact: (artifact) => ({ id: artifact.id, projectId: artifact.projectId, title: artifact.title,
          status: artifact.status, refreshStatus: artifact.refreshStatus, entryTruncated: true } as unknown as LiveArtifactSummary),
      });
      if (!page.ok) return toolError(page.code, page.code === 'INVENTORY_CHANGED' ? 'Artifact inventory changed; restart listing' : 'Unable to return this artifact page', 0);
      return toolOk(page.data, 0, page.truncated ? { truncated: true } : undefined);
    },
  });

  const input = z.record(z.string(), z.unknown());
  const validate = (context: import('./registry.js').McpToolContext, operation: string) => {
    if (context.grant.kind !== 'run') return { error: toolError('EXTERNAL_APPROVAL_REQUIRED', 'external artifact access requires trusted credential issuance', 0) };
    if (!context.request) return { error: toolError('TOOL_TOKEN_MISSING', 'run token is required', 0) };
    const checked = deps.tokenRegistry.validate(bearerTokenFromRequest(context.request), {
      endpoint: `/api/tools/live-artifacts/${operation}`, operation: `live-artifacts:${operation}`,
    });
    if (!checked.ok) return { error: toolError(checked.code, checked.message, 0) };
    if (checked.grant.runId !== context.grant.runId || checked.grant.projectId !== context.grant.projectId) {
      return { error: toolError('PROJECT_SCOPE_DENIED', 'run or project is outside the caller scope', 0) };
    }
    if (!current(context, checked.grant.runId, checked.grant.projectId, operation, 'write')) {
      return { error: toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0) };
    }
    return { grant: checked.grant };
  };
  const writeDeps = (context: import('./registry.js').McpToolContext, grant: import('../tool-tokens.js').ToolTokenGrant, operation: string): LiveArtifactToolWriteDeps => ({
    ...deps,
    authorizeProjectToolWriteCurrent: () => current(context, grant.runId, grant.projectId, operation, 'write'),
  });
  const failed = (error: unknown) => {
    if (error instanceof LiveArtifactToolCancelledError) return toolError('TOOL_CALL_CANCELLED', error.message, 0);
    if (error instanceof LiveArtifactStoreValidationError) return toolError('LIVE_ARTIFACT_INVALID', error.message, 0);
    if (error instanceof LiveArtifactRefreshLockError) return toolError('REFRESH_LOCKED', error.message, 0);
    if (error instanceof LiveArtifactRefreshUnavailableError) return toolError('LIVE_ARTIFACT_REFRESH_UNAVAILABLE', error.message, 0);
    if (error instanceof LiveArtifactRefreshAbortError) return toolError(error.kind === 'cancelled' ? 'TOOL_CALL_CANCELLED' : 'LIVE_ARTIFACT_REFRESH_TIMEOUT', error.message, 0);
    if (error instanceof ConnectorServiceError) return toolError(error.code, error.message, 0);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return toolError('LIVE_ARTIFACT_NOT_FOUND', 'live artifact not found', 0);
    return toolError('LIVE_ARTIFACT_STORAGE_FAILED', 'live artifact operation failed', 0);
  };
  const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
  // Keep the identity and local API reference usable when the registry's
  // 32,000-character output budget cannot carry the artifact document.
  const artifactResult = (result: { artifact: Awaited<ReturnType<typeof deps.createLiveArtifact>>['artifact']; refresh?: Awaited<ReturnType<typeof deps.refreshLiveArtifact>>['refresh'] }) => {
    if (JSON.stringify(result).length <= 32_000) return toolOk(result, 0);
    const { id, projectId, title, status, refreshStatus } = result.artifact;
    return toolOk({
      artifact: { id, projectId, title, status, refreshStatus },
      artifactUrl: `/api/live-artifacts/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`,
      ...(result.refresh === undefined ? {} : { refresh: result.refresh }),
    }, 0, { truncated: true });
  };
  const fields = { input, templateHtml: z.string().optional(), provenanceJson: input.optional() };
  registry.register({
    name: 'live_artifacts_create', description: 'Create a live artifact in the current project.', operation: 'live-artifacts:create', version: 1,
    schema: z.object(fields).strict(),
    handler: async (args, context) => {
      const checked = validate(context, 'create');
      if (!checked.grant) return checked.error!;
      try {
        const result = await createLiveArtifactForTool(checked.grant, {
          input: args.input,
          ...(args.templateHtml === undefined ? {} : { templateHtml: args.templateHtml }),
          ...(args.provenanceJson === undefined ? {} : { provenanceJson: args.provenanceJson as unknown as LiveArtifactProvenance }),
        }, writeDeps(context, checked.grant, 'create'), context.signal);
        return result.ok ? artifactResult({ artifact: result.artifact }) : denied();
      } catch (error) { return failed(error); }
    },
  });
  registry.register({
    name: 'live_artifacts_update', description: 'Update a live artifact in the current project.', operation: 'live-artifacts:update', version: 1,
    schema: z.object({ artifactId: z.string().min(1), ...fields }).strict(),
    handler: async (args, context) => {
      const checked = validate(context, 'update');
      if (!checked.grant) return checked.error!;
      try {
        const result = await updateLiveArtifactForTool(checked.grant, {
          artifactId: args.artifactId, input: args.input,
          ...(args.templateHtml === undefined ? {} : { templateHtml: args.templateHtml }),
          ...(args.provenanceJson === undefined ? {} : { provenanceJson: args.provenanceJson as unknown as LiveArtifactProvenance }),
        }, writeDeps(context, checked.grant, 'update'), context.signal);
        return result.ok ? artifactResult({ artifact: result.artifact }) : denied();
      } catch (error) { return failed(error); }
    },
  });
  registry.register({
    name: 'live_artifacts_refresh', description: 'Refresh a live artifact in the current project.', operation: 'live-artifacts:refresh', version: 1,
    schema: z.object({ artifactId: z.string().min(1) }).strict(),
    handler: async (args, context) => {
      const checked = validate(context, 'refresh');
      if (!checked.grant) return checked.error!;
      try {
        const result = await refreshLiveArtifactForTool(checked.grant, args.artifactId, writeDeps(context, checked.grant, 'refresh'), context.signal);
        return result.ok ? artifactResult(result.result) : denied();
      } catch (error) { return failed(error); }
    },
  });
}

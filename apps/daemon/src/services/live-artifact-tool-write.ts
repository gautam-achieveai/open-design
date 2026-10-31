import type { LiveArtifactProvenance } from '../live-artifacts/schema.js';
import type { createLiveArtifact, updateLiveArtifact } from '../live-artifacts/store.js';
import type { refreshLiveArtifact } from '../live-artifacts/refresh-service.js';
import type { ToolTokenGrant } from '../tool-tokens.js';

export interface LiveArtifactToolWriteDeps {
  projectsRoot: string;
  authorizeProjectToolWrite: (projectId: string) => Promise<boolean>;
  /** Optional synchronous check immediately before dispatch, after async authorization. */
  authorizeProjectToolWriteCurrent?: (projectId: string) => boolean;
  createLiveArtifact: typeof createLiveArtifact;
  updateLiveArtifact: typeof updateLiveArtifact;
  refreshLiveArtifact: typeof refreshLiveArtifact;
  emitLiveArtifactEvent: (grant: ToolTokenGrant, action: 'created' | 'updated', artifact: Awaited<ReturnType<typeof createLiveArtifact>>['artifact']) => unknown;
  emitLiveArtifactRefreshEvent: (grant: ToolTokenGrant, payload: { phase: 'started' | 'succeeded' | 'failed'; artifactId: string; refreshId?: string; title?: string; refreshedSourceCount?: number; error?: string }) => unknown;
}

type WriteInput = { input: unknown; templateHtml?: string; provenanceJson?: LiveArtifactProvenance };

export class LiveArtifactToolCancelledError extends Error {
  constructor() { super('live artifact tool call cancelled before dispatch'); }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LiveArtifactToolCancelledError();
}

export async function createLiveArtifactForTool(grant: ToolTokenGrant, args: WriteInput, deps: LiveArtifactToolWriteDeps, signal?: AbortSignal) {
  checkCancelled(signal);
  if (!await deps.authorizeProjectToolWrite(grant.projectId)) return { ok: false as const };
  checkCancelled(signal);
  if (deps.authorizeProjectToolWriteCurrent && deps.authorizeProjectToolWriteCurrent(grant.projectId) !== true) return { ok: false as const };
  const record = await deps.createLiveArtifact({ projectsRoot: deps.projectsRoot, projectId: grant.projectId, ...args, createdByRunId: grant.runId });
  deps.emitLiveArtifactEvent(grant, 'created', record.artifact);
  return { ok: true as const, artifact: record.artifact };
}

export async function updateLiveArtifactForTool(grant: ToolTokenGrant, args: WriteInput & { artifactId: string }, deps: LiveArtifactToolWriteDeps, signal?: AbortSignal) {
  checkCancelled(signal);
  if (!await deps.authorizeProjectToolWrite(grant.projectId)) return { ok: false as const };
  checkCancelled(signal);
  if (deps.authorizeProjectToolWriteCurrent && deps.authorizeProjectToolWriteCurrent(grant.projectId) !== true) return { ok: false as const };
  const record = await deps.updateLiveArtifact({ projectsRoot: deps.projectsRoot, projectId: grant.projectId, ...args });
  deps.emitLiveArtifactEvent(grant, 'updated', record.artifact);
  return { ok: true as const, artifact: record.artifact };
}

export async function refreshLiveArtifactForTool(grant: ToolTokenGrant, artifactId: string, deps: LiveArtifactToolWriteDeps, signal?: AbortSignal) {
  checkCancelled(signal);
  if (!await deps.authorizeProjectToolWrite(grant.projectId)) return { ok: false as const };
  checkCancelled(signal);
  if (deps.authorizeProjectToolWriteCurrent && deps.authorizeProjectToolWriteCurrent(grant.projectId) !== true) return { ok: false as const };
  let result: Awaited<ReturnType<typeof refreshLiveArtifact>>;
  try {
    result = await deps.refreshLiveArtifact({ projectsRoot: deps.projectsRoot, projectId: grant.projectId, artifactId, ...(signal ? { signal } : {}),
      onStarted: ({ refreshId }) => { deps.emitLiveArtifactRefreshEvent(grant, { phase: 'started', artifactId, refreshId }); },
    });
  } catch (error) {
    deps.emitLiveArtifactRefreshEvent(grant, { phase: 'failed', artifactId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  deps.emitLiveArtifactRefreshEvent(grant, { phase: 'succeeded', artifactId, refreshId: result.refresh.id, title: result.artifact.title, refreshedSourceCount: result.refresh.refreshedSourceCount });
  return { ok: true as const, result };
}

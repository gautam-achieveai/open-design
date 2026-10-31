import type { LiveArtifactSummary, ListLiveArtifactsOptions } from '../live-artifacts/store.js';
import type { ToolTokenGrant } from '../tool-tokens.js';

/** The project is always derived from the authenticated run grant. */
export async function listLiveArtifactsForTool(
  grant: ToolTokenGrant,
  deps: {
    projectsRoot: string;
    authorizeProjectTool: (projectId: string) => Promise<boolean>;
    authorizeProjectToolCurrent?: (projectId: string) => boolean;
    listLiveArtifacts: (options: ListLiveArtifactsOptions) => Promise<LiveArtifactSummary[]>;
  },
): Promise<{ ok: true; artifacts: LiveArtifactSummary[] } | { ok: false }> {
  if (!await deps.authorizeProjectTool(grant.projectId)) return { ok: false };
  if (deps.authorizeProjectToolCurrent && deps.authorizeProjectToolCurrent(grant.projectId) !== true) return { ok: false };
  const artifacts = await deps.listLiveArtifacts({
    projectsRoot: deps.projectsRoot,
    projectId: grant.projectId,
  });
  if (deps.authorizeProjectToolCurrent && deps.authorizeProjectToolCurrent(grant.projectId) !== true) return { ok: false };
  return { ok: true, artifacts };
}

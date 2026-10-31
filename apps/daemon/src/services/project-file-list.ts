import type { ProjectFile, ProjectMetadata } from '@open-design/contracts';

/** Shared file-list operation after the caller has passed project read authority. */
export async function listAuthorizedProjectFiles(
  project: { id: string; metadata?: ProjectMetadata | null },
  projectsRoot: string,
  since: number | undefined,
  listFiles: (root: string, projectId: string, options: { since: number | undefined; metadata: ProjectMetadata | null | undefined }) => Promise<ProjectFile[]>,
): Promise<{ ok: true; files: ProjectFile[] } | { ok: false }> {
  const metadata = project.metadata as (ProjectMetadata & { teamMirrorRevokedAt?: unknown }) | null | undefined;
  if (metadata?.teamMirrorRevokedAt) return { ok: false };
  const files = await listFiles(projectsRoot, project.id, { since, metadata: project.metadata });
  return { ok: true, files };
}

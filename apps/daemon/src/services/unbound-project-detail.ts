/** The REST detail projection, shared without adding a filesystem read. */
export function projectDetailPayload<T extends { id: string }>(project: T, binding: { workspaceId?: unknown } | null | undefined, resolvedDir: string) {
  const workspaceId = typeof binding?.workspaceId === 'string' && binding.workspaceId.trim() ? binding.workspaceId.trim() : null;
  return { project: { ...project, workspaceId }, resolvedDir };
}

/** Exact-ID, no-scope detail: no materialization, file listing or adoption. */
export function createUnboundProjectDetail<T extends { id: string }, Location>(deps: {
  isSafeId: (id: string) => boolean;
  getProject: (id: string) => T | null | undefined;
  getBinding: (id: string) => unknown;
  loadLocations: () => Promise<Location[]>;
  currentLocations: () => Location[];
  visibleAtLocations: (project: T, locations: Location[]) => boolean;
  resolveDir: (project: T) => string;
}) {
  return async (id: string) => {
    if (!deps.isSafeId(id)) return null;
    const locations = await deps.loadLocations();
    const project = deps.getProject(id);
    if (!project || deps.getBinding(id) || !deps.visibleAtLocations(project, locations)) return null;
    const payload = projectDetailPayload(project, null, deps.resolveDir(project));
    return {
      payload,
      revalidate: () => {
        const currentLocations = deps.currentLocations();
        const current = deps.getProject(id);
        return Boolean(current && !deps.getBinding(id) && deps.visibleAtLocations(current, currentLocations)
          && JSON.stringify(current) === JSON.stringify(project));
      },
    };
  };
}

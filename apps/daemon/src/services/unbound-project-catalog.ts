/** Shared headerless catalog. The location inventory is an observed filesystem view. */
export function createUnboundProjectCatalog<T extends { id: string }, Location, Output>(deps: {
  loadLocations: () => Promise<Location[]>;
  currentLocations: () => Location[];
  listUnbound: () => T[];
  visibleAtLocations: (project: T, locations: Location[]) => boolean;
  decorate: (projects: T[]) => Output[];
}) {
  return async (publish?: (entries: Output[]) => void) => {
    const locations = await deps.loadLocations();
    const source = deps.listUnbound().filter((project) => deps.visibleAtLocations(project, locations));
    const entries = deps.decorate(source);
    if (entries.length !== source.length) throw new Error('project catalog projection changed item count');
    // REST publishes inside this continuation, before another async gap.
    publish?.(entries);
    return {
      entries,
      revalidate: (indices: readonly number[]) => {
        const currentLocations = deps.currentLocations();
        const current = new Map(deps.listUnbound().map((project) => [project.id, project]));
        return indices.every((index) => {
          const prior = source[index];
          if (!prior) return false;
          const next = current.get(prior.id);
          return Boolean(next && deps.visibleAtLocations(next, currentLocations) && JSON.stringify(prior) === JSON.stringify(next));
        });
      },
    };
  };
}

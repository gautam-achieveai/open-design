import { ACTIVE_CONTEXT_TTL_MS } from '../constants.js';

export interface ActiveContext {
  projectId: string;
  fileName: string | null;
  ts: number;
}

export interface ActiveContextStore { current: ActiveContext | null }

export type ActiveContextView =
  | { active: false }
  | { active: true; projectId: string; projectName: string | null; fileName: string | null; ts: number; ageMs: number };

/** Shared by REST and MCP; the daemon owns the one in-memory store. */
export function readActiveContext(
  store: ActiveContextStore,
  getProject: (projectId: string) => { name?: string | null } | null | undefined,
  now: () => number,
): ActiveContextView {
  const current = store.current;
  if (!current || now() - current.ts > ACTIVE_CONTEXT_TTL_MS) {
    store.current = null;
    return { active: false };
  }
  const project = getProject(current.projectId);
  return { active: true, projectId: current.projectId, projectName: project?.name ?? null,
    fileName: current.fileName, ts: current.ts, ageMs: now() - current.ts };
}

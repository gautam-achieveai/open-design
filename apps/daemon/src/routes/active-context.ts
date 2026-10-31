import type { Express } from 'express';
import { createApiError } from '@open-design/contracts';
import { readActiveContext, type ActiveContext, type ActiveContextStore } from '../services/active-context.js';
import type { RouteDeps } from '../server-context.js';
import { defineJsonRoute, err, mountJsonRoute, ok, type Result } from '../http/index.js';

export interface RegisterActiveContextRoutesDeps extends RouteDeps<'db' | 'http' | 'projectStore'> {
  activeContextStore: ActiveContextStore;
}

// Soft "what is the user looking at right now in OpenDesign?" channel. The
// web UI POSTs the current project + file on every route change; the MCP
// surface reads it so a coding agent in another repo can resolve "the design
// I have open" without the user typing the project id. In-memory only —
// daemon restart clears it.
type PostActiveInput =
  | { kind: 'clear' }
  | { kind: 'set'; projectId: string; fileName: string | null };

type PostActiveOutput =
  | { active: false }
  | { active: true; projectId: string; fileName: string | null; ts: number };

type GetActiveOutput =
  | { active: false }
  | {
      active: true;
      projectId: string;
      projectName: string | null;
      fileName: string | null;
      ts: number;
      ageMs: number;
    };

interface ActiveContextDomainDeps {
  store: ActiveContextStore;
  db: unknown;
  getProject: (db: unknown, projectId: string) => { name?: string | null } | null | undefined;
  now: () => number;
}

function parsePostActive(raw: { body: unknown }): Result<PostActiveInput> {
  const body = (raw.body ?? {}) as Record<string, unknown>;
  if (body.active === false) {
    return ok({ kind: 'clear' });
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!projectId) {
    return err(createApiError('BAD_REQUEST', 'projectId is required'));
  }
  const fileName =
    typeof body.fileName === 'string' && body.fileName.length > 0 ? body.fileName : null;
  return ok({ kind: 'set', projectId, fileName });
}

function handlePostActive(
  input: PostActiveInput,
  deps: ActiveContextDomainDeps,
): Result<PostActiveOutput> {
  if (input.kind === 'clear') {
    deps.store.current = null;
    return ok({ active: false });
  }
  const next: ActiveContext = {
    projectId: input.projectId,
    fileName: input.fileName,
    ts: deps.now(),
  };
  deps.store.current = next;
  return ok({ active: true, ...next });
}

function handleGetActive(
  _input: void,
  deps: ActiveContextDomainDeps,
): Result<GetActiveOutput> {
  return ok(readActiveContext(deps.store, (projectId) => deps.getProject(deps.db, projectId), deps.now));
}

export const postActiveRoute = defineJsonRoute<PostActiveInput, PostActiveOutput, ActiveContextDomainDeps>({
  method: 'post',
  path: '/api/active',
  requireSameOrigin: true,
  parse: parsePostActive,
  handle: handlePostActive,
});

export const getActiveRoute = defineJsonRoute<void, GetActiveOutput, ActiveContextDomainDeps>({
  method: 'get',
  path: '/api/active',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetActive,
});

export function registerActiveContextRoutes(app: Express, ctx: RegisterActiveContextRoutesDeps): void {
  const domainDeps: ActiveContextDomainDeps = {
    store: ctx.activeContextStore,
    db: ctx.db,
    getProject: ctx.projectStore.getProject,
    now: () => Date.now(),
  };
  const adapter = { resolvedPortRef: ctx.http.resolvedPortRef };
  mountJsonRoute(app, postActiveRoute, domainDeps, adapter);
  mountJsonRoute(app, getActiveRoute, domainDeps, adapter);
}

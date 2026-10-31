import express from 'express';
import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../../src/server.js';
import { registerProjectRoutes } from '../../src/routes/project/index.js';
import { projectResourceIdFor } from '../../src/integrations/vela-team-projects.js';
import { verifyWorkspaceRequestContext } from '../../src/collab/request-workspace-context.js';
import {
  createWorkspaceDirectoryAuthorityBroker,
  type WorkspaceDirectoryFetchResult,
} from '../../src/collab/vela-workspace-context.js';
import { recoverPersistedTeamShareOwnership } from '../../src/collab/persisted-team-share.js';

describe('workspace project routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const workspaceId = `ws-${Date.now()}`;

  function headers(memberId: string, extra: Record<string, string> = {}) {
    return workspaceHeaders(workspaceId, memberId, extra);
  }

  function workspaceHeaders(targetWorkspaceId: string, memberId: string, extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      'x-od-workspace-id': targetWorkspaceId,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-role': 'member',
      ...extra,
    };
  }
  function workspacePrincipal(memberId: string, targetWorkspaceId = workspaceId, role: 'owner' | 'admin' | 'member' = 'member') {
    return {
      memberId,
      teamId: targetWorkspaceId,
      role,
      lifecycleState: 'active' as const,
    };
  }

  async function createProject(id: string, name: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name, skillId: null, designSystemId: null }),
    });
    expect(resp.status).toBe(200);
  }

  async function createProjectInWorkspace(
    id: string,
    name: string,
    memberId: string,
    extra: Record<string, string> = {},
  ) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(memberId, extra),
      body: JSON.stringify({ id, name, skillId: null, designSystemId: null }),
    });
    expect(resp.status).toBe(200);
  }

  async function list(memberId: string, query = '', extra: Record<string, string> = {}) {
    return listInWorkspace(workspaceId, memberId, query, extra);
  }

  async function listInWorkspace(
    targetWorkspaceId: string,
    memberId: string,
    query = '',
    extra: Record<string, string> = {},
  ) {
    const resp = await fetch(`${baseUrl}/api/workspaces/${targetWorkspaceId}/projects${query}`, {
      headers: workspaceHeaders(targetWorkspaceId, memberId, extra),
    });
    if (resp.status !== 200) {
      throw new Error(`GET workspace projects failed ${resp.status}: ${await resp.text()}`);
    }
    return resp.json() as Promise<{ projects: Array<any> }>;
  }

  async function waitForWorkspaceProjectSyncState(
    memberId: string,
    projectId: string,
    syncState: string,
    extra: Record<string, string> = {},
  ) {
    let project: any;
    for (let i = 0; i < 40; i += 1) {
      const body = await list(memberId, '?view=all', extra);
      project = body.projects.find((item) => item.id === projectId);
      if (project?.syncState === syncState) return project;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return project;
  }

  it.each([
    ['GET', ''], ['GET', '?view=all'], ['GET', '?view=drafts'],
    ['POST', '/batch-delete'], ['POST', '/batch-move'], ['POST', '/project-id/move'],
  ])('retired Workspace operation %s %s cannot read or mutate local projects', async (method, suffix) => {
    const projectId = `retired-operation-${Date.now()}`;
    await createProject(projectId, 'Preserved local project');
    const beforeResponse = await fetch(`${baseUrl}/api/projects/${projectId}`);
    const before = await beforeResponse.json();
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects${suffix.replace('project-id', projectId)}`, {
      method, headers: headers('legacy-owner', { 'x-od-workspace-type': 'team', 'x-od-workspace-role': 'owner' }),
      ...(method === 'POST' ? { body: JSON.stringify({ projectIds: [projectId], visibility: 'team' }) } : {}),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_FEATURES_DISABLED' } });
    const afterResponse = await fetch(`${baseUrl}/api/projects/${projectId}`);
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual(before);
  });

  it('preserves Personal owner writes and rejects a foreign member without changing the binding', async () => {
    const projectId = `local-authority-${Date.now()}`;
    const owner = headers('local-owner', { 'x-od-workspace-type': 'personal' });
    const foreign = headers('foreign-member', { 'x-od-workspace-type': 'personal', 'x-od-workspace-role': 'owner' });
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: owner,
      body: JSON.stringify({ id: projectId, name: 'Local owner project' }) });
    expect(created.status).toBe(200);
    const write = await fetch(`${baseUrl}/api/projects/${projectId}/files`, { method: 'POST', headers: owner,
      body: JSON.stringify({ name: 'index.html', content: '<h1>local sentinel</h1>' }) });
    expect(write.status).toBe(200);
    for (const [method, suffix, body] of [
      ['PATCH', '', { name: 'Foreign rename' }],
      ['POST', '/files', { name: 'index.html', content: 'foreign bytes' }],
      ['POST', '/duplicate', { name: 'Foreign copy' }],
      ['DELETE', '', {}],
    ] as const) {
      const denied = await fetch(`${baseUrl}/api/projects/${projectId}${suffix}`, {
        method, headers: foreign, body: JSON.stringify(body),
      });
      expect(denied.status).toBe(403);
    }
    const { openDatabase, getWorkspaceProjectByProjectId } = await import('../../src/db.js');
    const dataDir = process.env.OD_DATA_DIR!;
    const db = openDatabase(path.join(dataDir, 'projects'), { dataDir });
    expect(getWorkspaceProjectByProjectId(db, projectId)).toMatchObject({
      workspaceId, visibility: 'personal', createdByWorkspaceMemberId: 'local-owner',
    });
    const detail = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: owner });
    expect(await detail.json()).toMatchObject({ project: { name: 'Local owner project' } });
    const file = await fetch(`${baseUrl}/api/projects/${projectId}/raw/index.html`, { headers: owner });
    expect(await file.text()).toBe('<h1>local sentinel</h1>');
    const renamed = await fetch(`${baseUrl}/api/projects/${projectId}`, { method: 'PATCH', headers: owner,
      body: JSON.stringify({ name: 'Owner rename' }) });
    expect(renamed.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/projects/${projectId}`, { method: 'DELETE', headers: owner })).status).toBe(200);
  });

  it.each([false, true])('duplicates a copy and preserves exact Personal ownership (initially bound=%s)', async (bound) => {
    const projectId = `local-duplicate-${bound}-${Date.now()}`;
    const owner = headers('duplicate-owner', { 'x-od-workspace-type': 'personal' });
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST',
      headers: bound ? owner : { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Duplicate source' }) });
    expect(created.status).toBe(200);
    const duplicate = async (id: string, requestHeaders: Record<string, string>) => {
      const response = await fetch(`${baseUrl}/api/projects/${id}/duplicate`, { method: 'POST', headers: requestHeaders,
        body: JSON.stringify({ name: 'Local copy' }) });
      expect(response.status).toBe(200);
      return ((await response.json()) as { project: { id: string } }).project.id;
    };
    const first = await duplicate(projectId, bound ? owner : { 'content-type': 'application/json' });
    const second = await duplicate(first, owner);
    const { openDatabase, getWorkspaceProjectByProjectId } = await import('../../src/db.js');
    const dataDir = process.env.OD_DATA_DIR!;
    const db = openDatabase(path.join(dataDir, 'projects'), { dataDir });
    for (const id of [first, second]) {
      expect(getWorkspaceProjectByProjectId(db, id)).toMatchObject({
        workspaceId, visibility: 'personal', createdByWorkspaceMemberId: 'duplicate-owner',
      });
    }
  });



  // RED LINE — losing a user's pre-workspace ("legacy") projects across the
  // upgrade is data loss. The adoption model must be: every legacy project is
  // lazily projected into the personal workspace on first read (regardless of
  // how long after the upgrade that read happens), projection is idempotent,
  // and a team view SUPPRESSING an ownerless personal row must never translate
  // into that row disappearing from the personal workspace.


  // Product ruling (2026-07-21): 「草稿和分享的方案都是和 workspace 绑定的」. A
  // project belongs to exactly ONE workspace. This test used to assert the
  // opposite — that the same legacy project is projected independently into
  // every workspace that reads it — which is precisely the back-fill bug: with
  // a row everywhere, every workspace rendered the same 草稿 grid and switching
  // workspaces changed nothing.


  // THE BUG, at the draft grid. A draft created inside workspace A must not
  // appear in workspace B's 草稿 — that is the whole product ruling.


  it('keeps ordinary local creates independent from partial or stale Workspace identity', async () => {
    const suffix = Date.now();
    const partialId = `workspace-create-partial-${suffix}`;
    const partial = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-od-workspace-id': `${workspaceId}-partial`,
      },
      body: JSON.stringify({
        id: partialId,
        name: 'Must not become unbound',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(partial.status).toBe(200);
    await expect(partial.json()).resolves.toMatchObject({
      project: { id: partialId },
    });
    const partialDetail = await fetch(`${baseUrl}/api/projects/${partialId}`);
    expect(partialDetail.status).toBe(200);
    await expect(partialDetail.json()).resolves.toMatchObject({
      project: { id: partialId, workspaceId: null },
    });

    const revokedId = `workspace-create-revoked-${suffix}`;
    const revoked = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: workspaceHeaders(`${workspaceId}-revoked`, 'member-revoked', {
        'x-od-workspace-member-status': 'removed',
      }),
      body: JSON.stringify({
        id: revokedId,
        name: 'Must fail closed',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      project: {
        id: revokedId,
        workspaceId: `${workspaceId}-revoked`,
      },
    });

    // PRODUCT INVARIANT: identity headers are optional local attribution on
    // ordinary creates, never a live Team authorization check. A complete but
    // stale snapshot remains attributable locally; fresh authority belongs to
    // the later share/sync/move-to-Team boundary.
    const revokedDetail = await fetch(`${baseUrl}/api/projects/${revokedId}`, {
      headers: workspaceHeaders(`${workspaceId}-revoked`, 'member-revoked'),
    });
    expect(revokedDetail.status).toBe(200);
    await expect(revokedDetail.json()).resolves.toMatchObject({
      project: {
        id: revokedId,
        workspaceId: `${workspaceId}-revoked`,
      },
    });
  });

  it('keeps the persisted workspace binding on the project detail read model', async () => {
    const suffix = Date.now();
    const projectId = `workspace-detail-scope-${suffix}`;
    const workspaceA = `${workspaceId}-detail-a-${suffix}`;
    const createResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: workspaceHeaders(workspaceA, 'member-detail-a'),
      body: JSON.stringify({
        id: projectId,
        name: 'Project detail scope fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createResp.status).toBe(200);

    const detailResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: workspaceHeaders(workspaceA, 'member-detail-a'),
    });
    expect(detailResp.status).toBe(200);
    const detail = (await detailResp.json()) as {
      project: { id: string; workspaceId?: string | null };
    };
    expect(detail.project).toMatchObject({
      id: projectId,
      workspaceId: workspaceA,
    });
  });

  // Adoption must never mint a second row for a project that already has one.
  // The narrowed primary key would reject it, so a regression here surfaces as a
  // 500 rather than a silent duplicate — but the read path must not get there.










  // A team share recorded against a PERSONAL workspace is self-contradictory:
  // B has no standalone team id, so the workspace id IS the team identity and a
  // personal workspace has no team plane to act on. Every project-scoped collab
  // call the resulting row pins (presence, comments, publish) is answered
  // `403 missing_principal` — forever, and silently. The share must fail loudly
  // at the moment it is requested instead of persisting an impossible row.












  // recvqbklNGDqYY — a fully logged-out request (no x-od-workspace-* headers
  // at all, exactly what the frontend sends once workspaceContext goes null)
  // used to hit the ctx===null branch of enforceWorkspaceProjectMutation and
  // be granted the mutation unconditionally, regardless of whether the
  // project was actually team-shared. A team-shared project must require
  // real workspace identity; an untouched personal/local project must still
  // work headerless (the legacy pre-workspace callers this branch exists for).


  // recvqbjbudBS9r — a duplicated project used to leave the daemon with NO
  // `workspace_projects` row at all for the copy: `POST /api/projects/:id/duplicate`
  // inserted the new project row but never bound it anywhere. It stayed an
  // unbound orphan until whichever workspace's project list was read NEXT
  // (`bindUnboundProjectsToPersonalWorkspace` sweeps every orphan into the
  // workspace it is reading for), which could be a workspace the user never
  // touched. The fix binds the copy into the duplicating request's own
  // workspace immediately, so no later read — for ANY workspace — can steal it.


  // recvqbhor3pai2 — duplicating an already-duplicated project (a "copy of a
  // copy") 403'd with WORKSPACE_PROJECT_PERMISSION_DENIED / "workspace project
  // mutation is not allowed". Before recvqbjbudBS9r's fix (the test above),
  // the first duplicate left NO `workspace_projects` row for the copy, so
  // `workspaceProjectMutationAllowed` hit its `if (!row) return false;` guard
  // the moment anyone tried to duplicate THAT copy. This test exercises the
  // exact reported shape (two duplicates back to back, real owner headers
  // matching the bug report's curl repro) end to end to confirm
  // `bindDuplicateIntoRequestWorkspace` closes this specific case too — the
  // copy's own binding row now exists by the time it is duplicated again.


  // recvqbhor3pai2 (remaining gap) — `bindDuplicateIntoRequestWorkspace`'s own
  // doc comment admits a headerless duplicate (no `x-od-workspace-*` headers —
  // a legitimate legacy/pre-context caller, e.g. the web client's
  // `workspaceContext` has not resolved yet on the very first click) leaves
  // the copy permanently UNBOUND, "same as before" its fix. Before
  // `reconcileUnboundProjectBeforeMutation`, the first LATER mutation that DID
  // carry real headers — duplicating that same still-unbound copy again once
  // the client's workspace context settled — hit
  // `workspaceResourceMutationAllowed`'s `if (!row) return false;` guard and
  // 403'd with "workspace project mutation is not allowed", even though no
  // other workspace had ever claimed the project. This reproduces the exact
  // reported shape end to end and confirms the copy gets claimed into the
  // duplicating member's own workspace instead of staying stuck.






  // A project has ONE workspace, so deleting it from that workspace deletes it
  // outright — there is no second projection left holding it alive. This used to
  // assert the opposite (that workspace B still listed it), which only held
  // because the back-fill had put a copy of every project in every workspace.




  it('fails batch-delete when project directory cleanup fails', async () => {
    const projectId = `workspace-delete-cleanup-fails-${Date.now()}`;
    const dbDeleteProject = vi.fn();
    const removeProjectDir = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const stageProjectDirsForDelete = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject,
      removeProjectDir,
      stageProjectDirsForDelete,
      countWorkspaceProjectRefs: vi.fn(() => 1),
    }));
    const routeServer = await listen(app);
    try {
      const deleteResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/batch-delete`, {
        method: 'POST',
        headers: headers('member-cleanup-fail'),
        body: JSON.stringify({ projectIds: [projectId] }),
      });
      expect(deleteResp.status).toBe(400);
      expect(stageProjectDirsForDelete).toHaveBeenCalledWith('projects', [projectId], 'id');
      expect(removeProjectDir).not.toHaveBeenCalled();
      expect(dbDeleteProject).not.toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

  it('merges Vela team-project catalog entries as read-only member-discovery projects', async () => {
    const localProjectId = `workspace-local-${Date.now()}`;
    const remoteProjectId = `workspace-remote-${Date.now()}`;
    const remoteResourceId = `project-remote-${remoteProjectId}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-${remoteProjectId}`,
          workspaceId,
          projectId: remoteProjectId,
          resourceId: remoteResourceId,
          ownerMemberId: 'member-owner',
          displayName: 'Remote shared project',
          syncState: 'synced',
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: true,
            frozen: false,
          },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId: localProjectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=team`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(teamProjectCatalog.list).toHaveBeenCalledWith({
        memberId: 'member-viewer',
        teamId: workspaceId,
        role: 'member',
        lifecycleState: 'active',
      });
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]).toMatchObject({
        id: remoteResourceId,
        name: 'Remote shared project',
        visibility: 'team',
        resourceState: 'active',
        createdByWorkspaceMemberId: 'member-owner',
        resourceHubResourceId: remoteResourceId,
        syncState: 'synced',
        currentUserAccess: {
          canOpen: true,
          canRename: false,
          canDelete: false,
          canMoveToPersonal: false,
          canRestoreVersion: false,
          canExport: true,
        },
      });
      expect(body.projects[0].project.id).toBe(remoteProjectId);
      expect(body.projects[0].project.workspaceId).toBe(workspaceId);
      expect(body.projects[0].project.metadata).toEqual({
        sharedProjectPlaceholderAt: 20,
      });
    } finally {
      await close(routeServer.server);
    }
  });

  it.each([
    ['syncing', 'pending_upload'],
    ['failed', 'sync_failed'],
  ] as const)(
    'uses the catalog title without persisting a foreign mirror as locally owned (%s)',
    async (remoteSyncState, expectedSyncState) => {
    const projectId = `workspace-materialized-placeholder-${Date.now()}`;
    const adminMemberId = 'member-admin-viewer';
    const ownerMemberId = 'member-project-owner';
    const resourceId = `project-resource-${projectId}`;
    const rebindWorkspaceProject = vi.fn();
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-wrong-workspace-${projectId}`,
          workspaceId: 'ws-other',
          projectId,
          resourceId,
          ownerMemberId,
          displayName: 'Wrong workspace title',
          syncState: 'synced',
          lastSyncedVersionId: 'version-wrong-workspace',
          createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: false,
            frozen: false,
          },
        },
        {
          id: `catalog-${projectId}`,
          workspaceId,
          projectId,
          resourceId,
          ownerMemberId,
          displayName: 'Owner project title',
          syncState: remoteSyncState,
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: false,
            frozen: false,
          },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
      rebindWorkspaceProject,
      workspaceRowOverrides: {
        name: '共享项目',
        visibility: 'team',
        workspaceVisibility: 'team',
        resourceHubResourceId: resourceId,
        createdByWorkspaceMemberId: null,
        updatedByWorkspaceMemberId: adminMemberId,
        syncState: 'synced',
      },
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=team`, {
        headers: headers(adminMemberId, {
          'x-od-workspace-type': 'team',
          'x-od-workspace-role': 'admin',
        }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]).toMatchObject({
        id: projectId,
        name: 'Owner project title',
        createdByWorkspaceMemberId: ownerMemberId,
        updatedByWorkspaceMemberId: adminMemberId,
        resourceHubResourceId: resourceId,
        currentUserAccess: {
          canRename: false,
          canDelete: false,
          canMoveToPersonal: false,
        },
        project: {
          id: projectId,
          name: 'Owner project title',
        },
        syncState: expectedSyncState,
      });
      expect(rebindWorkspaceProject).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        expect.objectContaining({
          workspaceId,
          visibility: 'team',
          createdByWorkspaceMemberId: null,
          updatedByWorkspaceMemberId: adminMemberId,
          resourceHubResourceId: resourceId,
          syncState: expectedSyncState,
        }),
      );
      const persistedPatch = rebindWorkspaceProject.mock.calls[0]?.[2] as {
        createdByWorkspaceMemberId?: string | null;
      };
      expect(recoverPersistedTeamShareOwnership({
        projectId,
        workspaceId,
        createdByWorkspaceMemberId: persistedPatch.createdByWorkspaceMemberId ?? null,
        updatedByWorkspaceMemberId: adminMemberId,
      })).toBeNull();
      expect(teamProjectCatalog.list).toHaveBeenCalledTimes(1);
      expect(teamProjectCatalog.list).toHaveBeenCalledWith({
        memberId: adminMemberId,
        teamId: workspaceId,
        role: 'admin',
        lifecycleState: 'active',
      });
    } finally {
      await close(routeServer.server);
    }
    },
  );

  it('does not merge remote team projects into a personal workspace list (isolation)', async () => {
    const remoteProjectId = `workspace-personal-leak-${Date.now()}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-${remoteProjectId}`,
          workspaceId,
          projectId: remoteProjectId,
          resourceId: `project-remote-${remoteProjectId}`,
          ownerMemberId: 'member-owner',
          displayName: 'Team project that must not leak',
          syncState: 'synced',
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: { canView: true, canComment: true, canEdit: true, frozen: false },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId: `workspace-personal-local-${Date.now()}`,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
    }));
    const routeServer = await listen(app);
    try {
      // Personal workspace context (no team type header). The Vela team catalog
      // lister is scoped to the active team, so without the workspace-type guard
      // the team project would leak into — and duplicate within — the personal
      // list. A personal workspace must never fetch or merge team projects.
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=all`, {
        headers: headers('member-personal'),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(body.projects.some((item) => item.id === remoteProjectId)).toBe(false);
      expect(teamProjectCatalog.list).not.toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

  it('keeps remote team-project discovery entries distinct from local-id collisions', async () => {
    const collidingProjectId = `workspace-collide-${Date.now()}`;
    const remoteA = `resource-a-${collidingProjectId}`;
    const remoteB = `resource-b-${collidingProjectId}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-a-${collidingProjectId}`,
          workspaceId,
          projectId: collidingProjectId,
          resourceId: remoteA,
          ownerMemberId: 'member-owner-a',
          displayName: 'Remote A',
          syncState: 'synced',
          lastSyncedVersionId: 'version-a',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: true,
            frozen: false,
          },
        },
        {
          id: `catalog-b-${collidingProjectId}`,
          workspaceId,
          projectId: collidingProjectId,
          resourceId: remoteB,
          ownerMemberId: 'member-owner-b',
          displayName: 'Remote B',
          syncState: 'synced',
          lastSyncedVersionId: 'version-b',
          createdAt: new Date(11).toISOString(),
          updatedAt: new Date(21).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: true,
            frozen: false,
          },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId: collidingProjectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=team`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(body.projects.map((project: any) => project.id)).toEqual(
        expect.arrayContaining([remoteA, remoteB]),
      );
      expect(new Set(body.projects.map((project: any) => project.id)).size).toBe(body.projects.length);
      expect(body.projects.every((project: any) => project.project.id === collidingProjectId)).toBe(true);
    } finally {
      await close(routeServer.server);
    }
  });

  // RED LINE — "move back to 仅自己" must stick. The move route deletes the hub
  // catalog row in the same request, but the team catalog is read through a
  // stale-while-revalidate cache, so the next list can still carry the row that
  // was just removed. The move also nulls `resourceHubResourceId` — the key the
  // remote merge dedupes on — so before the fix that stale row came back as a
  // `visibility: 'team'` card and the project re-shared itself a moment after
  // the user unshared it, with no way to undo (a remote summary is never
  // `canMoveToPersonal`). The local `cloudTombstonedAt` is the truth here.
  it('does not resurrect a project the member just unshared from a stale team catalog', async () => {
    const projectId = `workspace-unshare-tombstone-${Date.now()}`;
    const memberId = 'member-unshare-tombstone';
    const staleResourceId = projectResourceIdFor(projectId, workspacePrincipal(memberId, workspaceId, 'admin'));
    // The catalog still reports the project as shared — exactly what the SWR
    // cache serves for a few seconds after the hub row has been deleted.
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-${projectId}`,
          workspaceId,
          projectId,
          resourceId: staleResourceId,
          ownerMemberId: memberId,
          displayName: 'Just unshared',
          syncState: 'synced',
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: { canView: true, canComment: true, canEdit: true, frozen: false },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
      // The state the move route leaves behind after a successful unshare.
      workspaceRowOverrides: {
        workspaceVisibility: 'personal',
        resourceHubResourceId: null,
        cloudTombstonedAt: 1_700_000_000_000,
        createdByWorkspaceMemberId: memberId,
        updatedByWorkspaceMemberId: memberId,
      },
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=all`, {
        headers: headers(memberId, { 'x-od-workspace-type': 'team', 'x-od-workspace-role': 'admin' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      const entries = body.projects.filter((item: any) => item.project?.id === projectId);
      expect(entries).toHaveLength(1);
      expect(entries[0].visibility).toBe('personal');
      // The stale catalog row must not come back as a second, team-visible card.
      expect(body.projects.some((item: any) => item.id === staleResourceId)).toBe(false);
    } finally {
      await close(routeServer.server);
    }
  });

  // The tombstone gate must stay owner-scoped: unsharing my own copy cannot
  // hide a teammate's share of the same project id.
  it('still shows a teammate share of a project id the reader has tombstoned', async () => {
    const projectId = `workspace-unshare-teammate-${Date.now()}`;
    const memberId = 'member-unshare-teammate';
    const teammateResourceId = `resource-teammate-${projectId}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-${projectId}`,
          workspaceId,
          projectId,
          resourceId: teammateResourceId,
          ownerMemberId: 'member-someone-else',
          displayName: 'Teammate share',
          syncState: 'synced',
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: { canView: true, canComment: true, canEdit: true, frozen: false },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
      workspaceRowOverrides: {
        workspaceVisibility: 'personal',
        resourceHubResourceId: null,
        cloudTombstonedAt: 1_700_000_000_000,
        createdByWorkspaceMemberId: memberId,
        updatedByWorkspaceMemberId: memberId,
      },
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=all`, {
        headers: headers(memberId, { 'x-od-workspace-type': 'team', 'x-od-workspace-role': 'admin' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(body.projects.some((item: any) => item.id === teammateResourceId)).toBe(true);
    } finally {
      await close(routeServer.server);
    }
  });

  it('includes remote team-project catalog entries in owner-scoped lists', async () => {
    const localProjectId = `workspace-local-owner-${Date.now()}`;
    const remoteProjectId = `workspace-remote-owner-${Date.now()}`;
    const remoteResourceId = `project-remote-${remoteProjectId}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => [
        {
          id: `catalog-${remoteProjectId}`,
          workspaceId,
          projectId: remoteProjectId,
          resourceId: remoteResourceId,
          ownerMemberId: 'member-owner',
          displayName: 'Remote owned project',
          syncState: 'synced',
          lastSyncedVersionId: 'version-1',
          createdAt: new Date(10).toISOString(),
          updatedAt: new Date(20).toISOString(),
          access: {
            canView: true,
            canComment: true,
            canEdit: true,
            frozen: false,
          },
        },
      ]),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId: localProjectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?owner=others`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { projects: Array<any> };
      expect(teamProjectCatalog.list).toHaveBeenCalled();
      expect(body.projects.some((item: any) => item.id === remoteResourceId)).toBe(true);
    } finally {
      await close(routeServer.server);
    }
  });

  it('fails workspace project listing when the remote team catalog is unavailable', async () => {
    const projectId = `workspace-catalog-fails-${Date.now()}`;
    const teamProjectCatalog = {
      list: vi.fn(async () => {
        throw new Error('catalog unavailable');
      }),
      upsert: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      teamProjectCatalog,
      workspaceRowOverrides: {
        createdByWorkspaceMemberId: 'member-viewer',
        updatedByWorkspaceMemberId: 'member-viewer',
      },
    }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?view=team`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(resp.status).toBe(502);
      await expect(resp.json()).resolves.toMatchObject({
        error: {
          code: 'TEAM_PROJECT_CATALOG_UNAVAILABLE',
        },
      });

      teamProjectCatalog.list.mockClear();
      const personalResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?visibility=personal`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(personalResp.status).toBe(200);
      await expect(personalResp.json()).resolves.toMatchObject({
        projects: [
          {
            id: projectId,
            visibility: 'personal',
          },
        ],
      });
      expect(teamProjectCatalog.list).not.toHaveBeenCalled();

      const personalOwnerResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects?owner=mine&visibility=personal`, {
        headers: headers('member-viewer', { 'x-od-workspace-type': 'team' }),
      });
      expect(personalOwnerResp.status).toBe(200);
      expect(teamProjectCatalog.list).not.toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

  // Acceptance #53: a project the user had just shared did not show up in
  // 全部项目 for ~17s. The client refetches as soon as the move responds, but
  // that read was served the pre-move list out of the daemon's SWR cache, so
  // the new row waited for a later poll — up to 60s once SSE lowers the
  // client's cadence. The move has to drop the cache it just invalidated.
  it('drops the cached team-project catalog after a visibility change', async () => {
    const projectId = `workspace-share-invalidate-${Date.now()}`;
    const invalidateTeamProjectCatalog = vi.fn();
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: {
        requestTeamShare: vi.fn(async () => ({ version: 1 })),
        requestTeamUnshare: vi.fn(async () => {}),
        invalidateTeamProjectCatalog,
      },
    }));
    const routeServer = await listen(app);
    try {
      const moveResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers('member-share-principal', {
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });
      expect(moveResp.status).toBe(200);
      expect(invalidateTeamProjectCatalog).toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

  // The invalidation is an optimization layered on top of a write that already
  // landed. A seam that throws must not turn a successful share into a failure.
  it('still reports the move as succeeded when catalog invalidation throws', async () => {
    const projectId = `workspace-share-invalidate-throws-${Date.now()}`;
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: {
        requestTeamShare: vi.fn(async () => ({ version: 1 })),
        requestTeamUnshare: vi.fn(async () => {}),
        invalidateTeamProjectCatalog: vi.fn(() => {
          throw new Error('cache seam exploded');
        }),
      },
    }));
    const routeServer = await listen(app);
    try {
      const moveResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers('member-share-principal', {
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });
      expect(moveResp.status).toBe(200);
    } finally {
      await close(routeServer.server);
    }
  });

  it('passes the authorized workspace principal into the team-share sync seam', async () => {
    const projectId = `workspace-share-principal-${Date.now()}`;
    const requestTeamShare = vi.fn(async () => ({ version: 1 }));
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: { requestTeamShare },
    }));
    const routeServer = await listen(app);
    try {
      const moveResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers('member-share-principal', {
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });
      expect(moveResp.status).toBe(200);
      expect(requestTeamShare).toHaveBeenCalledWith(projectId, {
        memberId: 'member-share-principal',
        teamId: workspaceId,
        role: 'admin',
        lifecycleState: 'active',
      });
    } finally {
      await close(routeServer.server);
    }
  });

  it('does not mark workspace projects as team-visible when durable team share publishing fails', async () => {
    const projectId = `workspace-share-rejected-${Date.now()}`;
    const requestTeamShare = vi.fn(async () => {
      throw new Error('resource hub unavailable');
    });
    const updateWorkspaceProject = vi.fn();
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: { requestTeamShare },
      updateWorkspaceProject,
    }));
    const routeServer = await listen(app);
    try {
      const moveResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers('member-share-rejected', {
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });
      expect(moveResp.status).toBe(503);
      expect(requestTeamShare).toHaveBeenCalledWith(projectId, {
        memberId: 'member-share-rejected',
        teamId: workspaceId,
        role: 'admin',
        lifecycleState: 'active',
      });
      expect(updateWorkspaceProject).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceProject.mock.calls[0]?.[3]).toMatchObject({
        visibility: 'team',
        syncState: 'pending_upload',
      });
      expect(updateWorkspaceProject.mock.calls[1]?.[3]).toMatchObject({
        visibility: 'personal',
        syncState: 'local_only',
        resourceHubResourceId: null,
      });
      updateWorkspaceProject.mockClear();
      requestTeamShare.mockClear();

      const batchResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/batch-move`, {
        method: 'POST',
        headers: headers('member-share-rejected', {
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ projectIds: [projectId], visibility: 'team' }),
      });
      expect(batchResp.status).toBe(503);
      expect(updateWorkspaceProject).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceProject.mock.calls[0]?.[3]).toMatchObject({
        visibility: 'team',
        syncState: 'pending_upload',
      });
      expect(updateWorkspaceProject.mock.calls[1]?.[3]).toMatchObject({
        visibility: 'personal',
        syncState: 'local_only',
        resourceHubResourceId: null,
      });
    } finally {
      await close(routeServer.server);
    }
  });

  it('retries a failed Team publish only for the exact recorded owner and Workspace', async () => {
    const projectId = `workspace-share-retry-${Date.now()}`;
    const memberId = 'member-share-retry';
    const requestTeamShare = vi.fn(async () => ({ version: 7 }));
    const updateWorkspaceProject = vi.fn();
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: { requestTeamShare },
      updateWorkspaceProject,
      workspaceRowOverrides: {
        workspaceVisibility: 'team',
        createdByWorkspaceMemberId: memberId,
        updatedByWorkspaceMemberId: memberId,
        resourceHubResourceId: `resource-${projectId}`,
        syncState: 'sync_failed',
      },
    }));
    const routeServer = await listen(app);
    try {
      const retry = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers(memberId, {
          'x-od-workspace-type': 'team',
          'x-od-workspace-role': 'member',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });

      expect(retry.status).toBe(200);
      expect(requestTeamShare).toHaveBeenCalledTimes(1);
      expect(requestTeamShare).toHaveBeenCalledWith(projectId, {
        memberId,
        teamId: workspaceId,
        role: 'member',
        lifecycleState: 'active',
      });
      expect(updateWorkspaceProject).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        projectId,
        expect.objectContaining({
          visibility: 'team',
          createdByWorkspaceMemberId: memberId,
          resourceHubResourceId: expect.any(String),
          syncState: 'pending_upload',
        }),
      );
    } finally {
      await close(routeServer.server);
    }
  });

  it('does not let another member retry a failed Team publish', async () => {
    const projectId = `workspace-share-retry-foreign-${Date.now()}`;
    const requestTeamShare = vi.fn(async () => ({ version: 7 }));
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: { requestTeamShare },
      workspaceRowOverrides: {
        workspaceVisibility: 'team',
        createdByWorkspaceMemberId: 'member-recorded-owner',
        updatedByWorkspaceMemberId: 'member-recorded-owner',
        resourceHubResourceId: `resource-${projectId}`,
        syncState: 'sync_failed',
      },
    }));
    const routeServer = await listen(app);
    try {
      const retry = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers('member-other', {
          'x-od-workspace-type': 'team',
          'x-od-workspace-role': 'admin',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });

      expect(retry.status).toBe(403);
      expect(requestTeamShare).not.toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

  it('preserves the failed Team binding when an exact-owner retry is still unavailable', async () => {
    const projectId = `workspace-share-retry-unavailable-${Date.now()}`;
    const memberId = 'member-share-retry-unavailable';
    const requestTeamShare = vi.fn(async () => {
      throw new Error('TLS handshake timeout');
    });
    const updateWorkspaceProject = vi.fn();
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      collabSync: { requestTeamShare },
      updateWorkspaceProject,
      workspaceRowOverrides: {
        workspaceVisibility: 'team',
        createdByWorkspaceMemberId: memberId,
        updatedByWorkspaceMemberId: memberId,
        resourceHubResourceId: `resource-${projectId}`,
        syncState: 'sync_failed',
      },
    }));
    const routeServer = await listen(app);
    try {
      const retry = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
        method: 'POST',
        headers: headers(memberId, {
          'x-od-workspace-type': 'team',
          'x-od-workspace-role': 'member',
          'x-od-workspace-lifecycle-state': 'active',
        }),
        body: JSON.stringify({ visibility: 'team' }),
      });

      expect(retry.status).toBe(503);
      await expect(retry.json()).resolves.toMatchObject({
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          retryable: true,
        },
      });
      expect(updateWorkspaceProject).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceProject.mock.calls[1]?.[3]).toMatchObject({
        visibility: 'team',
        createdByWorkspaceMemberId: memberId,
        resourceHubResourceId: `resource-${projectId}`,
        syncState: 'sync_failed',
      });
    } finally {
      await close(routeServer.server);
    }
  });




});

function workspaceProjectRouteDeps({
  workspaceId,
  projectId,
  dbDeleteProject,
  removeProjectDir,
  stageProjectDirsForDelete,
  deleteWorkspaceProject,
  countWorkspaceProjectRefs,
  teamProjectCatalog,
  collabSync,
  updateWorkspaceProject,
  rebindWorkspaceProject,
  workspaceRowOverrides,
}: {
  workspaceId: string;
  projectId: string;
  dbDeleteProject: ReturnType<typeof vi.fn>;
  removeProjectDir: ReturnType<typeof vi.fn>;
  stageProjectDirsForDelete?: ReturnType<typeof vi.fn>;
  deleteWorkspaceProject?: ReturnType<typeof vi.fn>;
  countWorkspaceProjectRefs?: ReturnType<typeof vi.fn>;
  teamProjectCatalog?: unknown;
  collabSync?: unknown;
  updateWorkspaceProject?: ReturnType<typeof vi.fn>;
  rebindWorkspaceProject?: ReturnType<typeof vi.fn>;
  workspaceRowOverrides?: Record<string, unknown>;
}) {
  const now = 1;
  const project = {
    id: projectId,
    name: 'Cleanup failure project',
    skillId: null,
    designSystemId: null,
    pendingPrompt: null,
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
  };
  const workspaceRow = {
    ...project,
    workspaceProjectId: projectId,
    workspaceId,
    workspaceVisibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: 'member-cleanup-fail',
    updatedByWorkspaceMemberId: 'member-cleanup-fail',
    resourceHubResourceId: null,
    cloudTombstonedAt: null,
    syncState: 'local_only',
    workspaceVersion: 1,
    workspaceCreatedAt: now,
    workspaceUpdatedAt: now,
    ...workspaceRowOverrides,
  };
  const noop = vi.fn();
  return {
    db: {
      transaction: (fn: (ids: string[]) => void) => fn,
      // Successful Team shares now preserve the comment foreign-key invariant
      // by ensuring one local conversation after the visibility write. These
      // route tests isolate share/catalog behavior behind a synthetic project
      // store rather than a real SQLite database, so model the pre-existing
      // anchor that is unrelated to their assertions. Keep the SQL surface
      // deliberately narrow: an unexpected direct database query must still
      // fail instead of being silently accepted by an all-purpose stub.
      prepare: (sql: string) => {
        if (/FROM conversations\b/.test(sql)) {
          return {
            get: () => ({ id: `comment-anchor-${projectId}` }),
          };
        }
        throw new Error(`unexpected direct SQLite query in workspace route fixture: ${sql}`);
      },
    },
    design: {},
    http: {
      createSseResponse: noop,
      sendApiError: (res: any, status: number, code: string, message: string, init: Record<string, unknown> = {}) =>
        res.status(status).json({ error: { code, message, ...init } }),
    },
    paths: {
      DESIGN_SYSTEMS_DIR: '',
      PROJECTS_DIR: 'projects',
      SKILLS_DIR: '',
      BRANDS_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
    },
    projectStore: {
      insertProject: noop,
      validateLinkedDirs: () => ({ dirs: [] }),
      getProject: (_db: unknown, requestedProjectId: string) =>
        requestedProjectId === projectId ? project : null,
      updateProject: noop,
      dbDeleteProject,
      removeProjectDir,
      stageProjectDirsForDelete: stageProjectDirsForDelete ?? vi.fn(async () => ({
        rollback: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
      })),
      deleteWorkspaceProject: deleteWorkspaceProject ?? noop,
      countWorkspaceProjectRefs: countWorkspaceProjectRefs ?? vi.fn(() => 1),
      ensureWorkspaceProject: () => workspaceRow,
      getWorkspaceProject: () => workspaceRow,
      // A project belongs to one workspace, so the routes look its binding up by
      // project id alone (see collab/workspace-project-home.ts).
      getWorkspaceProjectByProjectId: () => workspaceRow,
      listWorkspaceProjectBindings: () => new Map([[projectId, workspaceId]]),
      listWorkspaceProjects: () => [workspaceRow],
      updateWorkspaceProject: updateWorkspaceProject ?? noop,
      rebindWorkspaceProject: rebindWorkspaceProject ?? noop,
    },
    projectFiles: {
      writeProjectFile: noop,
      readProjectFile: noop,
      ensureProject: noop,
      listFiles: () => [],
      listTabs: () => [],
      setTabs: noop,
      resolveProjectDir: () => '',
    },
    conversations: { insertConversation: noop },
    templates: {
      getTemplate: noop,
      listTemplates: () => [],
      deleteTemplate: noop,
      insertTemplate: noop,
      findTemplateByNameAndProject: noop,
      updateTemplate: noop,
    },
    status: {
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      normalizeProjectDisplayStatus: (status: string) => status,
      composeProjectDisplayStatus: (status: unknown) => status,
      listProjects: () => [],
    },
    events: {
      subscribeFileEvents: noop,
      activeProjectEventSinks: new Map(),
    },
    ids: { randomId: () => 'id' },
    telemetry: { reportFinalizedMessage: noop },
    appConfig: { readAppConfig: vi.fn(async () => ({})), writeAppConfig: noop },
    agents: {},
    validation: {
      validateProjectDesignSystemId: async () => ({ ok: true, id: null }),
      validateProjectSkillId: async () => ({ ok: true, id: null }),
    },
    collabSync: collabSync ?? { requestTeamShare: noop },
    teamProjectCatalog,
  } as unknown as Parameters<typeof registerProjectRoutes>[1];
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('workspace project list authority cache boundary', () => {
  it('reuses the bounded read witness while mutations still require fresh authority', async () => {
    const workspaceId = 'project-list-read-workspace';
    const projectId = 'project-list-read-project';
    const memberId = 'project-list-read-member';
    const fetchDirectory = vi.fn(async (): Promise<WorkspaceDirectoryFetchResult> => ({
      ok: true,
      items: [{
        workspaceId,
        workspaceName: 'Project list read workspace',
        workspaceType: 'team',
        workspaceMemberId: memberId,
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      }],
    }));
    const authority = createWorkspaceDirectoryAuthorityBroker({
      fetchDirectory,
      identityKey: () => 'project-list-read-session',
      ttlMs: 15_000,
    });
    const verifyWith = (
      fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>,
    ) => (req: express.Request) => verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory,
    });
    const deps = workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
    }) as any;
    deps.verifyWorkspaceReadAuthority = verifyWith(authority.read);
    deps.verifyWorkspaceRequestAuthority = verifyWith(authority.fresh);

    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, deps);
    const routeServer = await listen(app);
    const headers = {
      'content-type': 'application/json',
      'x-od-workspace-id': workspaceId,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    };

    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(
          `${routeServer.url}/api/workspaces/${workspaceId}/projects?view=drafts`,
          { headers },
        );
        expect(response.status, await response.text()).toBe(200);
      }
      expect(fetchDirectory).toHaveBeenCalledTimes(1);

      const mutation = await fetch(
        `${routeServer.url}/api/workspaces/${workspaceId}/projects/${projectId}/move`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        },
      );
      expect(mutation.status).toBe(400);
      expect(fetchDirectory).toHaveBeenCalledTimes(2);
    } finally {
      await close(routeServer.server);
    }
  });
});

describe('GET /api/projects/:id/workspace-scope route bootstrap', () => {
  const projectId = 'route-bootstrap-project-a';
  const workspaceId = 'route-bootstrap-workspace-a';
  const memberId = 'route-bootstrap-member-a';
  const activeMembership = {
    workspaceId,
    workspaceName: 'Workspace A',
    workspaceType: 'team' as const,
    workspaceMemberId: memberId,
    role: 'member' as const,
    memberStatus: 'active' as const,
    lifecycleState: 'active' as const,
  };

  async function startBootstrapRoute(options: {
    directory?: () => Promise<WorkspaceDirectoryFetchResult>;
    resourceState?: string;
    unbound?: boolean;
  } = {}) {
    const deps = workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      workspaceRowOverrides: {
        workspaceVisibility: 'team',
        ...(options.resourceState ? { resourceState: options.resourceState } : {}),
      },
    }) as any;
    if (options.unbound) {
      deps.projectStore.getWorkspaceProject = () => null;
      deps.projectStore.getWorkspaceProjectByProjectId = () => null;
    }
    deps.fetchWorkspaceDirectory =
      options.directory
      ?? (async () => ({ ok: true, items: [activeMembership] }));
    deps.authorizeProjectRequest = vi.fn(async (
      req: express.Request,
      res: express.Response,
    ) => {
      if (options.unbound) return true;
      if (options.resourceState === 'deleted') {
        res.status(403).json({
          error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED' },
        });
        return false;
      }
      const claimedWorkspaceId = req.get('x-od-workspace-id');
      const claimedMemberId = req.get('x-od-workspace-member-id');
      if (!claimedWorkspaceId && !claimedMemberId) return true;
      if (!claimedWorkspaceId || !claimedMemberId) {
        res.status(400).json({
          error: { code: 'WORKSPACE_CONTEXT_INCOMPLETE' },
        });
        return false;
      }
      if (claimedWorkspaceId !== workspaceId) {
        res.status(403).json({
          error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED' },
        });
        return false;
      }
      return true;
    });
    deps.http.sendApiError = (
      res: express.Response,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => res.status(status).json({ error: { code, message, ...details } });
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, deps);
    return listen(app);
  }

  it('returns exact local scope and project content headerlessly', async () => {
    const routeServer = await startBootstrapRoute();
    try {
      const scope = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(scope.status).toBe(200);
      await expect(scope.json()).resolves.toMatchObject({
        scope: {
          kind: 'team',
          projectId,
          workspaceId,
          context: {
            workspaceId,
            workspaceMemberId: 'member-cleanup-fail',
          },
        },
      });

      const headerlessDetail = await fetch(
        `${routeServer.url}/api/projects/${projectId}`,
      );
      expect(headerlessDetail.status).toBe(200);
      const scopedDetail = await fetch(
        `${routeServer.url}/api/projects/${projectId}`,
        {
          headers: {
            'x-od-workspace-id': workspaceId,
            'x-od-workspace-member-id': memberId,
          },
        },
      );
      expect(scopedDetail.status).toBe(200);
    } finally {
      await close(routeServer.server);
    }
  });

  it('keeps partial and wrong explicit claims on the ordinary fail-closed gate', async () => {
    const routeServer = await startBootstrapRoute();
    try {
      const partial = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        { headers: { 'x-od-workspace-id': workspaceId } },
      );
      expect(partial.status).toBe(400);
      const wrong = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        {
          headers: {
            'x-od-workspace-id': 'wrong-workspace',
            'x-od-workspace-member-id': 'wrong-member',
          },
        },
      );
      expect(wrong.status).toBe(403);
    } finally {
      await close(routeServer.server);
    }
  });

  it('ignores stale directory membership but still hides a deleted local resource', async () => {
    const staleDirectoryCases = [
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, workspaceId: 'workspace-b' }],
        }),
      },
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, memberStatus: 'removed' as const }],
        }),
      },
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, lifecycleState: 'deleted' as const }],
        }),
      },
    ];
    for (const stale of staleDirectoryCases) {
      const routeServer = await startBootstrapRoute(stale);
      try {
        const response = await fetch(
          `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        );
        expect(response.status).toBe(200);
      } finally {
        await close(routeServer.server);
      }
    }
    const deletedServer = await startBootstrapRoute({ resourceState: 'deleted' });
    try {
      const deleted = await fetch(
        `${deletedServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(deleted.status).toBe(403);
    } finally {
      await close(deletedServer.server);
    }
  });

  it('stays available on directory outage and returns 404 for a missing project', async () => {
    const directory = vi.fn(async () => {
      throw new Error('directory down');
    });
    const routeServer = await startBootstrapRoute({
      directory,
    });
    try {
      const outage = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(outage.status).toBe(200);
      await expect(outage.json()).resolves.toMatchObject({
        scope: { kind: 'team', workspaceId },
      });
      expect(directory).not.toHaveBeenCalled();
      const missing = await fetch(
        `${routeServer.url}/api/projects/missing-project/workspace-scope`,
      );
      expect(missing.status).toBe(404);
    } finally {
      await close(routeServer.server);
    }
  });

  it('keeps locked/frozen project reads available but read-only', async () => {
    const routeServer = await startBootstrapRoute({
      resourceState: 'frozen',
      directory: async () => ({
        ok: true,
        items: [{ ...activeMembership, lifecycleState: 'locked' as const }],
      }),
    });
    try {
      const response = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        scope: {
          kind: 'team',
          workspaceId,
          context: {
            lifecycleState: 'locked',
            permissions: {
              canShareProjects: false,
              canWriteSyncedFiles: false,
            },
          },
        },
      });
    } finally {
      await close(routeServer.server);
    }
  });

  it('preserves signed-out headerless scope and detail for an unbound local project', async () => {
    const routeServer = await startBootstrapRoute({
      unbound: true,
      directory: async () => {
        throw new Error('signed out');
      },
    });
    try {
      const scope = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(scope.status).toBe(200);
      await expect(scope.json()).resolves.toEqual({
        scope: {
          kind: 'unbound',
          projectId,
          workspaceId: null,
          context: null,
        },
      });
      expect(
        (await fetch(`${routeServer.url}/api/projects/${projectId}`)).status,
      ).toBe(200);
    } finally {
      await close(routeServer.server);
    }
  });
});

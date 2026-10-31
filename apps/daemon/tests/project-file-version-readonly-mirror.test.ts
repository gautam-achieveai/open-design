// Retired Team mirrors must remain untouched by history reads. Personal owners
// still receive a real baseline; denied callers must never fabricate one.

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { openDatabase, updateProject, updateWorkspaceProject } from '../src/db.js';
import { SHARED_PROJECT_PLACEHOLDER_METADATA_KEY } from '../src/collab/shared-project-placeholder.js';

const WORKSPACE_ID = 'ws-readonly-mirror';
const OWNER_MEMBER_ID = 'member-owner-readonly-mirror';
const READER_MEMBER_ID = 'member-reader-readonly-mirror';

describe('version history on a readonly shared mirror', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${id}`, {
        method: 'DELETE',
        headers: memberHeaders(OWNER_MEMBER_ID, 'member'),
      }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function projectsRoot(): string {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    return path.join(dataDir, 'projects');
  }

  async function versionRootExists(projectId: string): Promise<boolean> {
    try {
      await fs.stat(path.join(projectsRoot(), projectId, '.file-versions'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A team-bound project owned by `OWNER_MEMBER_ID`. The production create
   * endpoint establishes the exact owner binding first; the fixture then marks
   * that same row as a pulled Team mirror without invoking the remote hub.
   *
   * Content is then written straight to the project directory instead of
   * through the file-write API, because that API bootstraps a version of its
   * own. The result is the shape a freshly pulled member mirror has: real
   * content on disk, no version manifest — `.file-versions` is in
   * `MEMBER_MIRROR_EXCLUDED_ENTRIES`, so a mirror never receives the owner's.
   */
  async function seedTeamProject(visibility: 'team' | 'personal' = 'team'): Promise<string> {
    const id = `readonly-mirror-${randomUUID()}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders(OWNER_MEMBER_ID, 'member', visibility) },
      body: JSON.stringify({ id, name: 'Readonly mirror project' }),
    });
    expect(created.status).toBe(200);
    projectsToClean.push(id);

    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(projectsRoot(), { dataDir });
    expect(updateWorkspaceProject(db, visibility === 'personal' ? `${WORKSPACE_ID}-personal` : WORKSPACE_ID, id, {
      visibility,
      syncState: 'synced',
      resourceHubResourceId: `hub-${id}`,
    })).not.toBeNull();

    const dir = path.join(projectsRoot(), id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><body><h1>owner content</h1></body></html>',
      'utf8',
    );
    await fs.rm(path.join(dir, '.file-versions'), { recursive: true, force: true });
    return id;
  }

  async function stampAsUnmaterializedPlaceholder(projectId: string): Promise<void> {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(projectsRoot(), { dataDir });
    expect(updateProject(db, projectId, {
      metadata: { [SHARED_PROJECT_PLACEHOLDER_METADATA_KEY]: Date.now() },
    })).not.toBeNull();
  }

  function memberHeaders(memberId: string, role: 'owner' | 'member', visibility: 'team' | 'personal' = 'team') {
    return {
      'x-od-workspace-id': visibility === 'personal' ? `${WORKSPACE_ID}-personal` : WORKSPACE_ID,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-type': visibility,
      'x-od-workspace-role': role,
      'x-od-workspace-lifecycle-state': 'active',
      'x-od-workspace-member-status': 'active',
      'x-od-workspace-can-share-projects': 'true',
      'x-od-workspace-can-write-synced-files': 'true',
    };
  }

  async function getVersions(projectId: string, headers?: Record<string, string>, status = 403) {
    const resp = await fetch(
      `${baseUrl}/api/projects/${projectId}/files/index.html/versions`,
      headers ? { headers } : undefined,
    );
    expect(resp.status).toBe(status);
    return (await resp.json()) as { versions: { id: string; label?: string | null }[] };
  }

  it('does not fabricate a version, or write one, for a member who cannot write the project', async () => {
    const projectId = await seedTeamProject();
    expect(await versionRootExists(projectId)).toBe(false);

    const body = await getVersions(projectId, memberHeaders(READER_MEMBER_ID, 'member'));

    expect(body).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    // And it left nothing behind in a project the member cannot write.
    expect(await versionRootExists(projectId)).toBe(false);
  });

  it('still bootstraps a baseline version for the member who owns the project', async () => {
    const projectId = await seedTeamProject('personal');

    const body = await getVersions(projectId, memberHeaders(OWNER_MEMBER_ID, 'member', 'personal'), 200);

    expect(body.versions.length).toBe(1);
    expect(await versionRootExists(projectId)).toBe(true);
  });

  it('denies headerless retired Team history without writing', async () => {
    const projectId = await seedTeamProject();
    expect(await versionRootExists(projectId)).toBe(false);

    const body = await getVersions(projectId);

    expect(body).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    expect(await versionRootExists(projectId)).toBe(false);
  });

  it('keeps the placeholder stamp fail-closed even if its creator was accidentally promoted', async () => {
    const projectId = await seedTeamProject();
    await stampAsUnmaterializedPlaceholder(projectId);

    const rename = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...memberHeaders(OWNER_MEMBER_ID, 'owner'),
      },
      body: JSON.stringify({ name: 'Must not land before materialization' }),
    });
    expect(rename.status).toBe(403);
    expect(await rename.json()).toMatchObject({
      error: { code: 'WORKSPACE_UNAVAILABLE' },
    });

    const versions = await getVersions(
      projectId,
      memberHeaders(OWNER_MEMBER_ID, 'owner'),
    );
    expect(versions).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    expect(await versionRootExists(projectId)).toBe(false);
  });
});

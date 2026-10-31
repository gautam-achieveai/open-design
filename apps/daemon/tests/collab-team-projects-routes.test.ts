import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type TeamProject,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import type { WorkspaceContextProvider } from '../src/collab/workspace-context.js';
import {
  registerCollabContextRoutes,
  type RegisterCollabContextRoutesDeps,
} from '../src/routes/collab-context.js';

const PROJECTS: TeamProject[] = [
  {
    projectId: 'p1',
    ownerMemberId: 'wm-owner',
    sharedAt: '2026-07-01T00:00:00.000Z',
    name: 'Launch Deck',
  },
];

function teamContextProvider(): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({
      role: 'member',
      lifecycleState: 'active',
    }),
    teamId: 't1',
  };
  return { current: async () => context };
}

function personalContextProvider(): WorkspaceContextProvider {
  return { current: async () => null };
}

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  const toClose = server;
  server = null;
  await new Promise<void>((resolve) => toClose.close(() => resolve()));
});

async function startServer(deps: {
  workspaceContext: WorkspaceContextProvider;
  listTeamProjects: (context: WorkspaceCollabContext) => Promise<TeamProject[]>;
  fetchWorkspaceDirectory?: () => Promise<{
    ok: boolean;
    items: Array<{
      workspaceId: string;
      workspaceName: string;
      workspaceType: 'personal' | 'team';
      workspaceMemberId: string;
      role: 'owner' | 'admin' | 'member';
      memberStatus: 'active' | 'removed';
      lifecycleState: 'active' | 'billing_past_due' | 'locked' | 'deleting' | 'deleted';
    }>;
  }>;
  verifyWorkspaceReadAuthority?: RegisterCollabContextRoutesDeps['verifyWorkspaceReadAuthority'];
}) {
  const app = express();
  app.use(express.json());
  registerCollabContextRoutes(app, {
    workspaceContext: deps.workspaceContext,
    listTeamProjects: deps.listTeamProjects,
    ...(deps.fetchWorkspaceDirectory
      ? { fetchWorkspaceDirectory: deps.fetchWorkspaceDirectory }
      : {}),
    ...(deps.verifyWorkspaceReadAuthority
      ? { verifyWorkspaceReadAuthority: deps.verifyWorkspaceReadAuthority }
      : {}),
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  return async (headers?: Record<string, string>) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workspace/projects/team`,
      headers ? { headers } : undefined,
    );
    return {
      status: response.status,
      body: await response.text(),
    };
  };
}

describe('retired Team project discovery', () => {
  it.each(['team', 'personal', 'headerless'] as const)('does not register discovery or call Cloud for %s requests', async (scope) => {
    const listTeamProjects = vi.fn(async () => PROJECTS);
    const fetchWorkspaceDirectory = vi.fn(async () => ({ ok: true, items: [] }));
    const get = await startServer({ workspaceContext: scope === 'team' ? teamContextProvider() : personalContextProvider(), listTeamProjects, fetchWorkspaceDirectory });
    const response = await get(scope === 'headerless' ? undefined : {
      'x-od-workspace-id': 'ws-1', 'x-od-workspace-member-id': 'wm-1', 'x-od-workspace-type': scope,
    });
    expect(response.status).toBe(404);
    expect(listTeamProjects).not.toHaveBeenCalled();
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });
});

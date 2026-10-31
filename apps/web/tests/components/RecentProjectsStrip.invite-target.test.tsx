// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
  context: null as WorkspaceCollabContext | null,
}));

vi.mock('../../src/collab/useTeamMembers', () => ({
  useTeamMembers: () => ({ resolve: () => null }),
}));

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  notifyTeamProjectsChanged: vi.fn(),
  useWorkspaceBilling: () => null,
  useWorkspaceContext: () => ({ context: workspaceState.context }),
}));

vi.mock('../../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: vi.fn(),
}));

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFiles: vi.fn(async () => []),
  fetchProjectFileText: vi.fn(async () => null),
  projectFileUrl: (projectId: string, fileName: string) =>
    `/api/projects/${projectId}/files/${fileName}`,
}));

import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';

function teamContext(availableSeats: number): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-owner',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    seatSummary: {
      seatLimit: 5,
      usedSeats: 5 - availableSeats,
      availableSeats,
      isSeatFull: availableSeats <= 0,
    },
    permissions: {
      canInviteMembers: true,
      canManageBilling: true,
      canShareProjects: true,
      canManageSharedResources: true,
    },
    teamId: 'team-1',
    workspaceSettingsUrl: 'https://web.example.com/console/settings?workspaceId=ws-team',
  } as unknown as WorkspaceCollabContext;
}

function renderTeamProjects() {
  return render(
    <RecentProjectsStrip
      projects={[]}
      heading="All projects"
      onOpen={() => {}}
      space="team"
    />,
  );
}

afterEach(() => {
  cleanup();
  workspaceState.context = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RecentProjectsStrip retired invite entry', () => {
  it.each([
    ['owner', 0], ['owner', 3], ['admin', 0], ['admin', 3], ['member', 0], ['member', 3],
  ] as const)('does not expose Cloud invites for %s with %i spare seats', (role, availableSeats) => {
    workspaceState.context = {...teamContext(availableSeats),role};
    const openSpy=vi.spyOn(window,'open').mockReturnValue(null);
    const fetchSpy=vi.fn(async()=>Response.json({}));
    vi.stubGlobal('fetch',fetchSpy);
    renderTeamProjects();
    expect(screen.queryByRole('button',{name:/Invite teammates|邀请同事/})).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
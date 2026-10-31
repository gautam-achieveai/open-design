// @vitest-environment jsdom
//
// Placement contract for the update-ready rocket.
//
// #5517 removed the entry topbar and parked the updater host in the rail
// footer — bottom-left, detached from the identity it belongs to. A follow-up
// moved it to a strip above the account row; product then placed it inline
// inside the account capsule. OPEND-2154 separated it again as its own
// control after the capsule. With the account module now at the foot of the
// rail (OPEND-2553 阶段二), the rocket rides that identity row: trigger →
// message-centre bell → updater slot (per product: 升级提醒按钮跟在头像后边).
// Signed-out shells, and the project route, keep it in the top-right cluster.
//
// These specs pin the DOM relationship rather than any pixel value: the rocket
// lives in a slot that is the last child of the account row, never inside the
// trigger. The row layout and the slot's zero-width-when-empty behaviour are
// CSS facts (see `.entry-nav-rail__account-updater` in
// styles/home/entry-layout.css) and are verified in a real browser, not here —
// jsdom applies no stylesheets.
//
// Being a sibling rather than a descendant of the trigger is load-bearing: a
// button nested inside the account button would be invalid markup and would
// make every rocket click also toggle the account menu.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EntryNavRail,
  WorkspaceTopRightAccountCluster,
} from '../../src/components/EntryNavRail';
import { UpdaterPopup } from '../../src/components/UpdaterPopup';
import { I18nProvider } from '../../src/i18n';

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    displayName: 'XINYU SHANG',
    seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
  } as unknown as WorkspaceCollabContext;
}

function freeContext(): WorkspaceCollabContext {
  return {
    ...teamContext(),
    workspaceId: 'ws-free',
    workspaceType: 'personal',
    billingState: 'free',
    planId: null,
  } as unknown as WorkspaceCollabContext;
}

function idleStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '0.16.2-beta.145',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
  };
}

function downloadedStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    ...idleStatus(),
    availableVersion: '0.16.2-beta.146',
    downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
    state: 'downloaded',
  };
}

function renderRail(context: WorkspaceCollabContext | null) {
  return render(
    <I18nProvider initial="zh-CN">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        context={context}        updaterSlot={<UpdaterPopup />}
      />
    </I18nProvider>,
  );
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?')) {
        return Response.json({ messages: [], nextCursor: null, unreadCount: 0 });
      }
      if (url.includes('/status')) return Response.json({ loggedIn: false });
      return Response.json({ items: [] });
    }),
  );
}

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderWithDownloadedUpdate(context: WorkspaceCollabContext | null = teamContext()) {
  restoreHost = installMockOpenDesignHost({
    host: { updater: { status: vi.fn(async () => downloadedStatus()) } },
  });
  const view = renderRail(context);
  await screen.findByTestId('entry-nav-updater');
  return view;
}

describe('updater rocket placement after the account avatar', () => {

  it('keeps the project-detail updater slot outside the shared account capsule', () => {
    render(
      <I18nProvider initial="zh-CN">
        <WorkspaceTopRightAccountCluster          updaterSlot={<span data-testid="project-updater-slot-content" />}
        />
      </I18nProvider>,
    );

    const slot = screen.getByTestId('entry-nav-account-updater');
    expect(screen.getByTestId('project-updater-slot-content')).toBeTruthy();
    // No rail on the project route → no account row to ride; the slot keeps
    // its top-right home, outside any capsule, with no account module beside
    // it (the menu has no second home).
    expect(slot.closest('.entry-top-right-cluster')).not.toBeNull();
    expect(slot.closest('.entry-top-right-account-pill')).toBeNull();
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
  });

  it('keeps the signed-out rocket in the top-right cluster without an account capsule', async () => {
    await renderWithDownloadedUpdate(null);

    const rocket = screen.getByTestId('entry-nav-updater');
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
    await waitFor(() => expect(rocket.closest('.entry-top-right-cluster')).not.toBeNull());
    expect(rocket.closest('.entry-nav-rail__footer')).toBeNull();
  });

  it('keeps the signed-out top-right cluster absent while the updater is idle', async () => {
    restoreHost = installMockOpenDesignHost({
      host: { updater: { status: vi.fn(async () => idleStatus()) } },
    });

    renderRail(null);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('entry-nav-updater')).toBeNull();
    expect(screen.queryByTestId('entry-nav-account-updater')).toBeNull();
    expect(screen.queryByTestId('entry-top-right-github')).toBeNull();
    expect(document.querySelector('.entry-top-right-cluster')).toBeNull();
  });
});

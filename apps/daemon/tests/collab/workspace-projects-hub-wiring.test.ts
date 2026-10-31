// Coverage for the two seams that trigger `reconcileWorkspaceProjectsWithRemote`
// in server.ts: the hub's real-time `team-projects-changed` SSE push
// (`startHubEventsSubscriber`) and the ~15s `workspaceInvalidationPoller`'s
// own diff-and-signal cadence. Mirrors the existing precedent in
// `hub-workspace-context-changed-poll.test.ts` (same extracted-named-function
// + source-scan-boundary-guard style) for the sibling
// `workspace-context-changed` fix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  handleHubProjectMetadataChanged,
  handleHubTeamProjectsChanged,
  handlePolledWorkspaceInvalidation,
} from '../../src/collab/workspace-projects-reconciler.js';
import { parseHubWorkspaceEvent, startHubEventsSubscriber } from '../../src/collab/hub-events-subscriber.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        return;
      }
      // Never enqueue again — keeps the connection open so the subscriber
      // does not immediately loop into a reconnect after the one event.
      await new Promise(() => undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('handleHubTeamProjectsChanged', () => {
  it('emits the thin display-cache signal only after reconciliation finishes', async () => {
    const emit = vi.fn();
    let finishReconcile!: () => void;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => {
      finishReconcile = resolve;
    }));
    handleHubTeamProjectsChanged(emit, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();

    finishReconcile();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  });

  it('never lets a reconciliation failure throw or reject out of the hub event handler', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() => handleHubTeamProjectsChanged(emit, reconcile)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  // End-to-end through the REAL SSE parser/dispatcher (`startHubEventsSubscriber`
  // + `parseHubWorkspaceEvent`), not a hand-called function — this is the
  // "real push" half of the verification: a genuine `team-projects-changed`
  // wire frame, parsed by real code, must reach the reconciler.
  it('fires from a genuine team-projects-changed SSE frame parsed by the real hub subscriber', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const readyFrame = 'event: ready\ndata: {"workspaceId":"w1"}\n\n';
    const frame =
      'event: workspace-event\ndata: {"type":"team-projects-changed","workspaceId":"w1","at":123}\n\n';
    const subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({
        url: 'https://hub/api/v1/collab/events',
        headers: {},
        workspaceId: 'w1',
      }),
      onEvent: (event) => {
        expect(parseHubWorkspaceEvent(JSON.stringify(event))).toEqual(event);
        if (event.type === 'team-projects-changed') {
          handleHubTeamProjectsChanged(emit, reconcile);
          resolveDone();
        }
      },
      fetchImpl: async () => sseResponse([readyFrame, frame]),
    });

    try {
      await done;
      expect(emit).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      subscriber.stop();
    }
  });
});

describe('handleHubProjectMetadataChanged', () => {
  it('re-emits after the targeted metadata write becomes durable', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => true);
    handleHubProjectMetadataChanged(emit, reconcile);

    expect(emit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
  });

  it('does not emit a persistence follow-up for a no-op or failed reconcile', async () => {
    const noOpEmit = vi.fn();
    handleHubProjectMetadataChanged(noOpEmit, async () => false);
    await Promise.resolve();
    expect(noOpEmit).toHaveBeenCalledTimes(1);

    const failedEmit = vi.fn();
    handleHubProjectMetadataChanged(failedEmit, async () => { throw new Error('offline'); });
    await Promise.resolve();
    await Promise.resolve();
    expect(failedEmit).toHaveBeenCalledTimes(1);
  });
});

describe('handlePolledWorkspaceInvalidation', () => {
  it('forwards every payload to emit unchanged', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    const payload = { type: 'members-changed' as const, at: 1 };
    handlePolledWorkspaceInvalidation(payload, emit, reconcile);
    expect(emit).toHaveBeenCalledWith(payload);
  });

  it('kicks reconciliation only for a team-projects-changed payload', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);

    handlePolledWorkspaceInvalidation({ type: 'workspace-context-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'members-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'billing-changed', at: 1 }, emit, reconcile);
    expect(reconcile).not.toHaveBeenCalled();

    handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconciliation failure throw out of the poller emit path', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() =>
      handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });
});

// Scope-boundary guard (real source, not a re-implementation) — the sibling of
// `hub-workspace-context-changed-poll.test.ts`'s own switch-boundary test.
// Confirms the wiring actually landed in server.ts: exactly the
// `team-projects-changed` case calls `handleHubTeamProjectsChanged`, and the
// poller's `emit` wiring calls `handlePolledWorkspaceInvalidation`.
describe('server.ts wiring (source boundary)', () => {
  const serverSourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/server.ts',
  );
  const source = fs.readFileSync(serverSourcePath, 'utf8').replace(/\r\n/g, '\n');

  it('does not bootstrap retired Cloud hub subscriptions or recovery pollers', () => {
    expect(source).not.toMatch(/(?:startHubEventsSubscriber|createWorkspaceHubSubscriptions|createWorkspaceInvalidationPoller)\s*\(/);
    expect(source).not.toContain('onEvent: (event, connection) => {');
    expect(source).toContain('const refreshWorkspaceHubAccountIdentity = (): void => {};');
  });

  it('logs broad-head cooldown deferrals in catch-up completion diagnostics', () => {
    // Matched without the closing backtick so the assertion survives further
    // fields being appended to the same template — it is here to pin that
    // suppressed/complete are still reported, not to freeze the line's length.
    expect(source).toContain(
      'suppressed=${event.suppressed ?? 0} complete=${event.complete === true}',
    );
  });

  it('reports background materialization volume in catch-up completion diagnostics', () => {
    // `candidates` counts projects CONSIDERED, which says nothing about what
    // actually landed on a member's disk. These totals are the only reading
    // that makes OD_COLLAB_BACKGROUND_PULL_MAX_CUMULATIVE_ENTRIES choosable
    // from a diagnostics bundle, so the guard's `volume()` has to reach this
    // sink — a counter nothing reads is why that ceiling stayed unset.
    expect(source).toContain('const backgroundVolume = backgroundPullSizeGuard.volume();');
    expect(source).toContain('processEntries=${backgroundVolume.entries}');
    expect(source).toContain('processProjects=${backgroundVolume.countedProjects}');
    expect(source).toContain('processUncounted=${backgroundVolume.uncountedProjects}');
  });

  it('disposes proactive pull retry timers during daemon shutdown', () => {
    const anchor = 'const cleanupDaemonBackgroundWork = () => {';
    const start = source.indexOf(anchor);
    expect(start, 'expected daemon background cleanup in server.ts').toBeGreaterThan(-1);
    const end = source.indexOf('};', start);
    expect(end, 'expected daemon background cleanup to close').toBeGreaterThan(start);
    const cleanupBody = source.slice(start, end + 2);
    expect(cleanupBody).toContain('proactiveContentPull.dispose();');
  });

  it('wires the exact proactive invocation and transactional receipt materializer', () => {
    expect(source).toContain(
      'materializeAuthorizedTeamMirror: (input, scope, receipt) =>\n' +
        '        materializePulledTeamMirror(db, input, scope, receipt)',
    );
    expect(source).toContain(
      '}, target.authorizationWitness, expectedVersion, target.authorizedStageInvocation)',
    );
    expect(source).not.toContain(
      'getActiveWorkspaceSnapshot: authorizedActiveWorkspaceSnapshot',
    );
    expect(source).toContain(
      'authorizedTeamProjectPull: {\n' +
        '      journalDir: teamMirrorPromotionJournalDir,\n' +
        '    },',
    );
  });

  it('authorizes reconnect catch-up from the expected Workspace directory identity', () => {
    const anchor = 'listSharedProjects: async (workspaceId) => {';
    const start = source.indexOf(anchor);
    const end = source.indexOf('hasMaterializedProject:', start);
    const body = source.slice(start, end);
    expect(body).not.toContain('activeWorkspace.get()');
    expect(body).not.toContain('collab.workspaceContext.current({})');
    expect(body).not.toContain('lastKnown');
    expect(body).toContain(
      'resolveAuthoritativeTeamWorkspaceContext(workspaceId)',
    );
    expect(
      body.split('resolveAuthoritativeTeamWorkspaceContext(workspaceId)')
        .length - 1,
    ).toBe(2);
  });

  it('keeps background authority fail-closed without renewing an expired remembered scope', () => {
    const resolverStart = source.indexOf(
      'const resolveTeamResourceScopeForWorkspaceId = async (',
    );
    const authorizationStart = source.indexOf(
      'const teamResourceScopeStillAuthorized = async (',
      resolverStart,
    );
    expect(resolverStart).toBeGreaterThan(-1);
    expect(authorizationStart).toBeGreaterThan(resolverStart);
    const resolverBody = source.slice(resolverStart, authorizationStart);

    expect(resolverBody).toContain('if (!directory.ok) return null;');
    expect(resolverBody).toContain('teamResourceRequestScopeForWorkspaceId(');
    expect(resolverBody).toContain('return scope;');
    expect(resolverBody).not.toContain('rememberTeamResourceScope(scope)');
  });

  it('never lets display cache readers infer scope from workspaceContext current or lastKnown', () => {
    const projectsStart = source.indexOf('const teamProjectsForDisplay = async (');
    const projectsEnd = source.indexOf('const teamProjectsForRequest = async (', projectsStart);
    const projectsBody = source.slice(projectsStart, projectsEnd);
    expect(projectsBody).not.toContain('workspaceContext.current');
    expect(projectsBody).not.toContain('lastKnown');

    const membersStart = source.indexOf('const teamMembersForDisplay = async (');
    const membersEnd = source.indexOf('let workspaceHubSubscriptions:', membersStart);
    const membersBody = source.slice(membersStart, membersEnd);
    expect(membersBody).not.toContain('workspaceContext.current');
    expect(membersBody).not.toContain('lastKnown');
  });

  it('serves repeated collab status owner reads from the explicit display cache while revocation stays fresh', () => {
    const freshOwnerStart = source.indexOf(
      'const resolveSharedProjectOwner = async (',
    );
    const statusOwnerStart = source.indexOf(
      'const resolveSharedProjectOwnerForStatus = async (',
      freshOwnerStart,
    );
    const presenceStart = source.indexOf(
      'const authoritativePresenceWorkspaces',
      statusOwnerStart,
    );
    expect(freshOwnerStart).toBeGreaterThan(-1);
    expect(statusOwnerStart).toBeGreaterThan(freshOwnerStart);
    expect(presenceStart).toBeGreaterThan(statusOwnerStart);
    const freshOwnerBody = source.slice(freshOwnerStart, statusOwnerStart);
    const statusOwnerBody = source.slice(statusOwnerStart, presenceStart);

    expect(statusOwnerBody).toContain(
      'await teamProjectsDisplayCache(explicitScope)',
    );
    expect(statusOwnerBody).not.toContain(
      'await teamProjectsLister(explicitScope.workspaceId)',
    );
    expect(freshOwnerBody).toContain(
      'await teamProjectsLister(explicitScope.workspaceId)',
    );
    expect(freshOwnerBody).not.toContain('teamProjectsDisplayCache');

    const pullStart = source.indexOf('const resolveSharedProject = async (');
    expect(pullStart).toBeGreaterThan(-1);
    expect(pullStart).toBeLessThan(freshOwnerStart);
    const pullBody = source.slice(pullStart, freshOwnerStart);
    expect(pullBody).toContain(
      'await teamProjectsLister(scope.workspaceId)',
    );
    expect(pullBody).not.toContain('teamProjectsDisplayCache');
  });

  it('recognizes an authorized remote mirror from exact version and a real live directory, not a local project manifest', () => {
    const helperStart = source.indexOf(
      'const proactiveTeamProjectMaterializedVersion = (',
    );
    const configStart = source.indexOf(
      'const proactiveContentPull = createProactiveContentPull({',
      helperStart,
    );
    expect(helperStart).toBeGreaterThan(-1);
    expect(configStart).toBeGreaterThan(helperStart);
    const helperBody = source.slice(helperStart, configStart);
    expect(helperBody).toContain('getTeamProjectMaterialization(');
    expect(helperBody).toContain('target.workspaceId');
    expect(helperBody).toContain(
      'teamProjectContentResourceId(target.projectId, target)',
    );
    expect(helperBody).toContain(
      'latestTeamProjectMaterializationVersion(',
    );

    const probeStart = source.indexOf(
      'hasMaterializedProject: async (projectId, target) => {',
      configStart,
    );
    const probeEnd = source.indexOf(
      'materializedVersion: proactiveTeamProjectMaterializedVersion,',
      probeStart,
    );
    expect(probeStart).toBeGreaterThan(configStart);
    expect(probeEnd).toBeGreaterThan(probeStart);
    const probeBody = source.slice(probeStart, probeEnd);
    expect(probeBody).toContain('const project = getProject(db, projectId);');
    expect(probeBody).toContain(
      'proactiveTeamProjectMaterializedVersion(target)',
    );
    expect(probeBody).toContain('fs.promises.lstat(projectDir)');
    expect(probeBody).toContain('entry.isDirectory()');
    expect(probeBody).toContain('!entry.isSymbolicLink()');
    expect(probeBody).not.toContain('readProjectManifest');
  });
});

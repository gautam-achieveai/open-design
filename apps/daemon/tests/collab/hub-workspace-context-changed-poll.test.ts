import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  handleHubVerifiedConnection,
  handleHubWorkspaceAccessRevoked,
  handleHubWorkspaceContextChanged,
} from '../../src/server.js';

describe('handleHubVerifiedConnection', () => {
  it('catches up billing on the first workspace-verified connection', () => {
    const catchUpPublishedHeads = vi.fn(async () => undefined);
    const catchUpWorkspaceBilling = vi.fn();

    handleHubVerifiedConnection(
      'workspace-1',
      catchUpPublishedHeads,
      catchUpWorkspaceBilling,
    );

    expect(catchUpPublishedHeads).toHaveBeenCalledWith('workspace-1');
    expect(catchUpWorkspaceBilling).toHaveBeenCalledWith('workspace-1');
  });
});

// Regression coverage for the fix wiring the hub's real `workspace-context-changed`
// push (`startHubEventsSubscriber`'s `onEvent` in server.ts) to an immediate
// `workspaceInvalidationPoller.pollOnce()` — the same catch-up `onReconnect`
// already runs. Before this fix, the event only forwarded a thin SSE nudge to
// the web; the daemon's own last-known-membership cache (consumed by
// `enforceWorkspaceProjectMutation`'s mutation gate) had no accelerated path
// and stayed stale for up to the poller's ~15s cadence — e.g. a member removed
// from a team kept passing the mutation gate for that long even though Vela
// had already told this daemon something changed.
describe('handleHubWorkspaceContextChanged', () => {
  it('triggers an immediate workspace-invalidation poll cycle', async () => {
    const pollWorkspaceInvalidation = vi.fn(async () => undefined);
    const invalidateWorkspaceDirectory = vi.fn();

    handleHubWorkspaceContextChanged(
      'workspace-1',
      pollWorkspaceInvalidation,
      invalidateWorkspaceDirectory,
    );

    expect(invalidateWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect(pollWorkspaceInvalidation).toHaveBeenCalledTimes(1);
    expect(invalidateWorkspaceDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      pollWorkspaceInvalidation.mock.invocationCallOrder[0]!,
    );
  });

  it('never lets a poll failure throw or reject out of the hub event handler', async () => {
    const pollWorkspaceInvalidation = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() =>
      handleHubWorkspaceContextChanged('workspace-1', pollWorkspaceInvalidation)
    ).not.toThrow();
    // Let the fire-and-forget `.catch()` settle before asserting nothing leaked.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pollWorkspaceInvalidation).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });
});

describe('handleHubWorkspaceAccessRevoked', () => {
  it('invalidates directory and billing state before starting reconciliation', () => {
    const pollWorkspaceInvalidation = vi.fn(async () => undefined);
    const invalidateWorkspaceDirectory = vi.fn();
    const revokeWorkspaceBilling = vi.fn();

    handleHubWorkspaceAccessRevoked(
      'workspace-1',
      pollWorkspaceInvalidation,
      invalidateWorkspaceDirectory,
      revokeWorkspaceBilling,
    );

    expect(invalidateWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect(revokeWorkspaceBilling).toHaveBeenCalledWith('workspace-1');
    expect(pollWorkspaceInvalidation).toHaveBeenCalledTimes(1);
    expect(invalidateWorkspaceDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      pollWorkspaceInvalidation.mock.invocationCallOrder[0]!,
    );
    expect(revokeWorkspaceBilling.mock.invocationCallOrder[0]).toBeLessThan(
      pollWorkspaceInvalidation.mock.invocationCallOrder[0]!,
    );
  });
});

// Scope-boundary guard (real source, not a re-implementation): the fix is
// deliberately scoped to ONLY the `workspace-context-changed` hub event.
// `team-projects-changed`, `comment-changed`, `presence-changed`,
// `billing-changed`, `project-metadata-changed`, and `project-content-changed`
// already have their own handling and must not gain a redundant immediate
// poll trigger as a side effect of this change (or of some later edit next to
// it) — each keeps costing exactly the requests its own case already made.
describe('retired hub wiring (source boundary)', () => {
  it('does not start Cloud subscribers or forward their context and metadata changes', () => {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'), 'utf8');
    expect(source).not.toContain('onEvent: (event, connection) => {');
    expect(source).not.toMatch(/startHubEventsSubscriber\s*\(/);
  });
});

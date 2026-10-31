
import type { Express, Request } from 'express';
import type { CollabCloudMemberDirectoryEntry, TeamProject, WorkspaceBillingCatalog, WorkspaceBillingPreflight, WorkspaceTeamBillingPlanId, WorkspaceBillingSummary, WorkspaceWalletBalance, WorkspaceDirectoryItem, WorkspaceCollabContext, WorkspaceInviteRole, WorkspaceInvalidationSsePayload } from '@open-design/contracts';
import { workspaceSeatCapacityState } from '@open-design/contracts';
import { type WorkspaceContextProvider } from '../collab/workspace-context.js';

import { type InviteContinueOutcome } from '../collab/invite-continue.js';
import { type CreateInviteOutcome, type CreateWorkspaceInviteInput } from '../collab/invite-create.js';
import { type VelaWorkspaceBillingProjection } from '../integrations/vela-billing.js';
import { type WorkspaceDirectoryFetchResult } from '../collab/vela-workspace-context.js';
import { type WorkspaceBillingRuntimeCoordinator } from '../collab/workspace-billing-runtime.js';
import { type VerifiedWorkspaceRequestContextResult } from '../collab/request-workspace-context.js';



export type WorkspaceEventSink = (payload: WorkspaceInvalidationSsePayload) => void;
export type WorkspaceEventSinksByWorkspace =
  Map<string, Set<WorkspaceEventSink>>;

/**
 * Deliver one thin invalidation only to clients whose EventSource connection
 * was freshly verified for the affected Workspace. Member identity is still
 * verified at subscription time; delivery is workspace-wide because roster,
 * catalog, context, and team billing changes legitimately invalidate every
 * active member's view of that Workspace.
 */
export function emitWorkspaceEventToScope(
  sinksByWorkspace: WorkspaceEventSinksByWorkspace,
  workspaceIdInput: string,
  payload: WorkspaceInvalidationSsePayload,
): boolean {
  const workspaceId = workspaceIdInput.trim();
  if (!workspaceId) return false;
  const sinks = sinksByWorkspace.get(workspaceId);
  if (!sinks || sinks.size === 0) return false;
  for (const sink of Array.from(sinks)) {
    try {
      sink(payload);
    } catch {
      sinks.delete(sink);
    }
  }
  if (sinks.size === 0) sinksByWorkspace.delete(workspaceId);
  return true;
}

/**
 * Deliver an account-level dirty signal through every already-authorized local
 * Workspace stream. The payload deliberately contains no Workspace id/content,
 * so this broad local nudge reveals no cross-workspace data; each browser then
 * re-reads the account directory through the daemon's current credential.
 */
export function emitWorkspaceEventToAllScopes(
  sinksByWorkspace: WorkspaceEventSinksByWorkspace,
  payload: Extract<
    WorkspaceInvalidationSsePayload,
    { type: 'workspace-directory-changed' }
  >,
): boolean {
  let emitted = false;
  for (const [workspaceId, sinks] of Array.from(sinksByWorkspace)) {
    for (const sink of Array.from(sinks)) {
      try {
        sink(payload);
        emitted = true;
      } catch {
        sinks.delete(sink);
      }
    }
    if (sinks.size === 0) sinksByWorkspace.delete(workspaceId);
  }
  return emitted;
}

export interface RegisterCollabContextRoutesDeps {
  workspaceContext: WorkspaceContextProvider;
  /** Current settings-backed AMR environment for synthesized contexts. */
  configuredEnv?: () => Record<string, string>;
  /** Optional settled verifier for exact-scoped display GETs. Mutations and
   * SSE subscriptions retain their fresh directory verification below. */
  verifyWorkspaceReadAuthority?: (
    req: Request,
  ) => Promise<VerifiedWorkspaceRequestContextResult>;
  /** Returns an exact, strict-SSE-backed membership only in adaptive mode.
   * Null preserves the legacy directory preflight byte-for-byte. */
  readCachedWorkspaceAuthority?: (
    req: Request,
    workspaceId: string,
  ) => WorkspaceCollabContext | null;
  /** Injectable for tests; defaults to consuming against B with the vela session. */
  consumeInvite?: (nonce: string) => Promise<InviteContinueOutcome>;
  /** Injectable for tests; defaults to creating invites on B with the vela session. */
  createInvite?: (input: CreateWorkspaceInviteInput) => Promise<CreateInviteOutcome>;
  /** Injectable for tests; defaults to the vela billing CLI 收口. */
  fetchBilling?: () => Promise<WorkspaceBillingSummary | null>;
  fetchBillingPreflight?: (workspaceId: string, modelId: string | null) => Promise<WorkspaceBillingPreflight | null>;
  /** Capability and gap-free upstream health for the currently verified identity. */
  quotaRealtimeHealthy?: (workspaceId: string) => boolean;
  /** Injectable for tests; returns one backend-proven v2 workspace wallet. */
  fetchWorkspaceBalance?: (workspaceId: string) => Promise<WorkspaceWalletBalance | null>;
  /** Injectable for tests; returns the additive atomic plan+wallet projection. */
  fetchWorkspaceBillingProjection?: (
    workspaceId: string,
  ) => Promise<VelaWorkspaceBillingProjection>;
  /** Daemon-owned exact-scope billing state. Shared with upstream SSE hooks. */
  billingRuntime?: WorkspaceBillingRuntimeCoordinator;
  /** Injectable for tests; defaults to the vela billing catalog CLI 收口. */
  fetchBillingCatalog?: (workspaceId: string) => Promise<WorkspaceBillingCatalog | null>;
  /** Injectable for tests; defaults to the vela billing checkout CLI 收口. */
  startCheckout?: (input: {
    workspaceId?: string;
    planId?: WorkspaceTeamBillingPlanId;
    seats?: number;
  }) => Promise<string | null>;
  /** Injectable for tests; defaults to the resource-hub team-project lister
   *  built from the same workspace context + env-configured hub client the share
   *  path uses. */
  listTeamProjects?: (context: WorkspaceCollabContext) => Promise<TeamProject[]>;
  /**
   * The team's collab-cloud member directory (memberId → {displayName, role}),
   * so the web client can resolve comment authors + the shared-project owner to
   * a name + role. Empty off-team / when the collab cloud is unconfigured. STUB:
   * B's roster is the real source; the collab-cloud directory stands in for it.
   */
  listMembers?: (
    context: WorkspaceCollabContext,
  ) => Promise<CollabCloudMemberDirectoryEntry[]>;
  /**
   * Client-local restart default. Data-plane routes never use it as authority;
   * each tab continues to carry its exact Workspace and member identity.
   */
  activeWorkspace?: {
    get(): string | null;
    set(workspaceId: string): Promise<void>;
    clear(): Promise<void>;
    clearIf(workspaceId: string): Promise<boolean>;
  };
  /**
   * Announce that one tab selected `workspaceId`, after a fresh membership
   * directory read confirms the exact Workspace/member pair.
   *
   * Caches are keyed by explicit scope, so this only warms the selected scope;
   * it never changes or checks daemon-global active/current state. It is
   * deliberately fire-and-forget: the response must not wait on warming.
   */
  onWorkspaceSwitched?: (workspaceId: string) => void;
  /** Injectable for tests; defaults to the Vela workspace directory API. */
  listWorkspaceDirectory?: () => Promise<WorkspaceDirectoryItem[]>;
  /**
   * Directory read with an authoritative-success bit. An unavailable backend
   * must never be collapsed into a confirmed empty membership list.
   */
  fetchWorkspaceDirectory?: () => Promise<WorkspaceDirectoryFetchResult>;
  /**
   * Force-refresh the membership authority after an invite continuation is
   * consumed. The consume mutates B before the daemon's settled directory
   * lease expires; refreshing here prevents the accepted Workspace from being
   * rejected by the next exact-scope request as a stale non-membership.
   */
  refreshWorkspaceDirectoryAfterMutation?: () => Promise<WorkspaceDirectoryFetchResult>;
  /**
   * Collab realtime hop-2 — the workspace-scoped invalidation SSE seams. When
   * both are provided the daemon registers `GET /api/workspace/events`; the route
   * adds its per-connection sink to `workspaceEventSinks` (fed by the
   * workspace-invalidation poller) and drops it on disconnect. Omitted in tests
   * that do not exercise the stream — the route then 404s cleanly.
   */
  createSseResponse?: (res: unknown, opts?: unknown) => {
    send: (event: string, data: unknown, id?: string | number | null) => boolean;
  };
  workspaceEventSinks?: WorkspaceEventSinksByWorkspace;
  /** Keep one upstream Vela carrier while this local Workspace SSE is open. */
  retainWorkspaceEventInterest?: (workspaceId: string) => () => void;
  /** Best-effort PostHog group update; never affects the route response. */
  observeWorkspace?: (
    req: Request,
    context: WorkspaceCollabContext,
    properties?: Record<string, unknown>,
  ) => Promise<void> | void;
}

const ASSIGNABLE_ROLES = new Set<WorkspaceInviteRole>(['admin', 'member']);

/**
 * Enrichment may add billing and display metadata, but it must not rewrite the
 * exact Workspace authority already proven by the membership directory.
 */
function enrichVerifiedWorkspaceContext(
  verified: WorkspaceCollabContext,
  enriched: WorkspaceCollabContext | null | undefined,
): WorkspaceCollabContext {
  if (
    !enriched
    || enriched.workspaceId !== verified.workspaceId
    || enriched.workspaceMemberId !== verified.workspaceMemberId
  ) {
    return verified;
  }
  const { teamId: _enrichedTeamId, ...enrichedMetadata } = enriched;
  return {
    ...enrichedMetadata,
    workspaceId: verified.workspaceId,
    workspaceType: verified.workspaceType,
    workspaceMemberId: verified.workspaceMemberId,
    role: verified.role,
    memberStatus: verified.memberStatus,
    lifecycleState: verified.lifecycleState,
    permissions: verified.permissions,
    ...(verified.teamId ? { teamId: verified.teamId } : {}),
  };
}

function workspaceGroupProperties(
  context: WorkspaceCollabContext,
): Record<string, unknown> {
  const planId = context.planId?.trim().toLowerCase();
  const seatSummary = context.seatSummary;
  const seatState = workspaceSeatCapacityState(seatSummary);
  return {
    workspace_type: context.workspaceType,
    workspace_lifecycle: context.lifecycleState,
    billing_state: context.billingState,
    plan_bucket: !planId || planId === 'free' ? 'free' : 'paid',
    provider_mode: context.providerMode,
    ...(seatState !== 'unknown'
      ? {
          seat_limit: seatSummary.seatLimit,
          member_count: seatSummary.usedSeats,
        }
      : {}),
    seat_state: seatState,
  };
}

/**
 * Normalize an invite-create request body into validated { email, role } items.
 * Accepts either the canonical `{ invites: [...] }` batch shape or a single
 * top-level `{ email, role }`. Rows without a non-empty email are dropped; a
 * missing/unknown role defaults to 'member' (never 'owner').
 */
function parseInviteCreateItems(
  body: unknown,
): Array<{ email: string; role: WorkspaceInviteRole }> {
  const raw = body as { invites?: unknown; email?: unknown; role?: unknown } | null;
  const source: unknown[] = Array.isArray(raw?.invites)
    ? raw!.invites
    : raw && typeof raw === 'object' && typeof raw.email === 'string'
      ? [raw]
      : [];
  const items: Array<{ email: string; role: WorkspaceInviteRole }> = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { email?: unknown; role?: unknown };
    if (typeof rec.email !== 'string') continue;
    const email = rec.email.trim();
    if (!email) continue;
    const role: WorkspaceInviteRole =
      typeof rec.role === 'string' && ASSIGNABLE_ROLES.has(rec.role as WorkspaceInviteRole)
        ? (rec.role as WorkspaceInviteRole)
        : 'member';
    items.push({ email, role });
  }
  return items;
}

/**
 * Workspace-context route : the daemon's single B-integration seam. The
 * web client fetches an explicitly selected workspace context here to decide
 * whether collab runs and who the present member is (resolveCollabSession). In
 * production the provider proxies B; the dev provider is settable via PUT so a
 * demo/tools-dev run can exercise the full path before B is reachable.
 */
export function registerCollabContextRoutes(app: Express, _deps: RegisterCollabContextRoutesDeps): void {
  // Compatibility reads expose no account identity. There is no mutable local
  // Team context or implicit account provider after Cloud retirement.
  app.get('/api/workspace/context', (_req, res) => res.json({ context: null }));
  app.get('/api/workspace/directory', (_req, res) => res.json({ items: [] }));
}

function parseTeamBillingPlanId(value: unknown): WorkspaceTeamBillingPlanId | null {
  return value === 'team_plus' || value === 'team_pro' || value === 'team_max' ? value : null;
}

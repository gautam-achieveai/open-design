import { createHmac } from "node:crypto";
import type { BrowserPerformanceNativeChallenge } from "@open-design/contracts";

type Value = Record<string, unknown>;
const record = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);

function workspaceHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!record(value) || !record(value.permissions)) return null;
  const fields = { workspaceId: "id", workspaceType: "type", workspaceMemberId: "member-id", role: "role", lifecycleState: "lifecycle-state", memberStatus: "member-status" };
  const headers: Record<string, string> = {};
  for (const [field, name] of Object.entries(fields)) {
    if (!bounded(value[field])) return null;
    headers[`x-od-workspace-${name}`] = value[field];
  }
  for (const [field, name] of [["canShareProjects", "can-share-projects"], ["canWriteSyncedFiles", "can-write-synced-files"]]) {
    if (typeof value.permissions[field!] !== "boolean") return null;
    headers[`x-od-workspace-${name}`] = String(value.permissions[field!]);
  }
  return headers;
}

function challenge(value: unknown, approvalId: string): BrowserPerformanceNativeChallenge | null {
  if (!record(value) || !record(value.challenge)) return null;
  const item = value.challenge;
  if (item.approvalId !== approvalId || !bounded(item.projectId) || !bounded(item.tabId) || !bounded(item.reportId) ||
    !bounded(item.location, 2_048) || !bounded(item.bindingDigest) || !bounded(item.expiresAt) ||
    !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now() ||
    typeof item.cpu !== "number" || !Number.isFinite(item.cpu) || item.cpu < 1 || item.cpu > 20) return null;
  return item as unknown as BrowserPerformanceNativeChallenge;
}

type DecisionResult = { ok: true; decision: "approved" | "denied" } | { ok: false; reason: string };

/** Main-only transaction: renderer cannot supply a decision, action details or a signing payload. */
export function createPerformanceApprovalConfirmer(deps: {
  discoverDaemonUrl(): Promise<string | null>;
  secret: Buffer | null;
  alive(): boolean;
  confirm(challenge: BrowserPerformanceNativeChallenge): Promise<boolean>;
  onApproved(challenge: BrowserPerformanceNativeChallenge): boolean;
  fetchImpl?: typeof fetch;
}): (request: unknown, senderAlive?: () => boolean) => Promise<DecisionResult> {
  const pending = new Set<string>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (request, senderAlive = () => true) => {
    const alive = () => deps.alive() && senderAlive();
    if (!record(request) || !bounded(request.approvalId) || !/^[A-Za-z0-9_-]+$/.test(request.approvalId)) return { ok: false, reason: "invalid approval request" };
    const approvalId = request.approvalId;
    if (pending.has(approvalId) || pending.size >= 16) return { ok: false, reason: "native confirmation is already pending" };
    const headers = workspaceHeaders(request.workspaceContext);
    if (!headers) return { ok: false, reason: "invalid workspace routing context" };
    if (!deps.secret || !alive()) return { ok: false, reason: "native confirmation is unavailable" };
    pending.add(approvalId);
    try {
      const address = await deps.discoverDaemonUrl();
      if (!address) return { ok: false, reason: "daemon API URL is unavailable" };
      const base = new URL(address);
      if (!["http:", "https:"].includes(base.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
        return { ok: false, reason: "native confirmation requires the trusted local daemon" };
      }
      const endpoint = new URL(`/api/mcp/approvals/${encodeURIComponent(approvalId)}`, base);
      const load = async () => {
        const response = await fetchImpl(`${endpoint.href}/native-challenge`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return null;
        return challenge(await response.json(), approvalId);
      };
      const original = await load();
      if (!original || !alive()) return { ok: false, reason: "approval is unavailable, expired or no longer authorized" };
      const approved = await deps.confirm(original);
      if (!alive()) return { ok: false, reason: "confirmation window closed" };
      const current = await load();
      if (!alive()) return { ok: false, reason: "confirmation window closed" };
      if (!current || current.bindingDigest !== original.bindingDigest || current.cpu !== original.cpu || current.reportId !== original.reportId || current.tabId !== original.tabId || current.projectId !== original.projectId) {
        return { ok: false, reason: "approval changed or expired; request a new confirmation" };
      }
      const decision = approved ? "approve" : "deny";
      const signature = createHmac("sha256", deps.secret).update(JSON.stringify([
        "od.capture-throttle.native-decision.v1", approvalId, decision, original.bindingDigest,
      ])).digest("base64url");
      const response = await fetchImpl(`${endpoint.href}/${decision}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ nativeConfirmation: { bindingDigest: original.bindingDigest, signature } }),
      });
      if (!response.ok) return { ok: false, reason: "daemon rejected the native decision; refresh the approval" };
      if (approved && (!alive() || !deps.onApproved(original))) return { ok: false, reason: "browser target changed during native confirmation" };
      return { ok: true, decision: approved ? "approved" : "denied" };
    } catch {
      return { ok: false, reason: "native confirmation failed; refresh the approval before retrying" };
    } finally { pending.delete(approvalId); }
  };
}

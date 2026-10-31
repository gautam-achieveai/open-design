# HTTP-first MCP — review plan

Status: **implementation in progress**. Slice 2 passed its browser-read gate;
slice 3 passed the native Claude/CLI approval gate with current Electron/native
integration still unverified. Slice 4 passed its HTTP business-service, mature ACP
and SDK compatibility-carrier checks; the hand-written server is removed.
Slice 5 and the full validation gate remain open.

Scope correction: Vela/OpenDesign Cloud support is being removed at the user's
request. The remaining native-browser acceptance scenario is real Electron UI
approval of one native-agent click. Broader native-client expansion is stopped;
the original Slice 5/full acceptance is not claimed complete.

Implementation checkpoint: 2026-10-29. The proposal and decision history below
are retained; phase evidence and remaining work are recorded in the execution ledger.

Date: 2026-10-27

Related docs: `docs/prompt-composition.md`, `docs/architecture.md`,
`docs/agent-adapters.md`, `specs/current/daemon-http-adapter.md`

## How to review this plan

- Read §1–§10 as the proposal; where you disagree, mark the section.
- §11 is the only part that **blocks progress** — each item is phrased as a
  question, my recommendation, and what I need from you. Reply with your call
  per item (accept / change / drop) and I will fold the decisions back into
  this document before any implementation starts.
- §12–§14 state what is excluded and how the plan will be validated; flag
  anything there that reads as a surprise.

## 1. Premise (your direction, restated for confirmation)

Convert essentially everything to a **localhost-based HTTP MCP server**; the
stdio MCP server provides no significant benefit and should stop being the
primary investment.

Concretely, this plan proposes **one in-process Streamable HTTP MCP endpoint,
hosted by the existing daemon on the same loopback origin** — no separate MCP
server process, no extra port. REST, `od` CLI, and MCP become three thin
surfaces over the same domain services and validation.

*Please confirm this restatement matches your intent — especially "everything"
(see decision 7 in §11).*

## 2. Problem statement

1. **Browser and tool access is CLI-mediated.** `skills/agent-browser/SKILL.md`
   and the composed prompt teach agents to discover and invoke
   `od browser ...`. Every tool call is a process spawn plus HTTP proxy plus
   text parsing, and the model cannot receive structured tool results (a
   screenshot is a file path string, not MCP image content).
2. **Two parallel MCP implementations exist.** `apps/daemon/src/mcp.ts`
   (SDK-based stdio, project-oriented catalog) and
   `apps/daemon/src/mcp-live-artifacts-server.ts` (hand-rolled stdio JSON-RPC,
   live artifacts + connectors). Neither is reachable over HTTP, and the
   hand-rolled one is a third protocol to maintain.
3. **Runtime compatibility is fragile.** `apps/daemon/src/runtimes/defs/kimi.ts`
   declares `acpStdioMcpRemovedInVersion: '0.37.0'`; Kimi 0.37.0–0.38.0 reject
   stdio MCP entries and only `http`/`sse` survive (see
   `apps/daemon/src/agent-protocol/acp/stdio-mcp.ts`). The stdio guard has to
   *withhold* servers from those builds, which silently degrades the agent.
   HTTP works everywhere stdio does, and in more places.
4. **Codex is not wired for MCP injection at all**
   (`externalMcpInjection` in `apps/daemon/src/runtimes/types.ts` supports
   `claude-mcp-json | acp-merge | opencode-env-content | mimo-env-content`).
5. **Approval semantics are unsafe to port blindly.** The browser contracts
   (`packages/contracts/src/api/browser-control.ts`) let a model supply
   `approved: true` on mutating operations, and the CLI mirrors that with
   `--approve`. Exposing the same field as first-class MCP tools would let the
   model grant itself consent. Any migration must install a real approval
   boundary, not a renamed flag.

## 3. Current-state map (verified)

| Capability | HTTP boundary (daemon) | CLI surface | MCP today |
| --- | --- | --- | --- |
| Browser control | `apps/daemon/src/routes/browser-control.ts` → `services/browser-command-broker.ts` | `od browser ...` in `apps/daemon/src/cli.ts` | none |
| Projects / files / search / runs | `/api/*` routes | `od project ...`, `od research ...` | `apps/daemon/src/mcp.ts` (stdio, SDK) |
| Live artifacts / connectors | `/api/*` routes | partial | `apps/daemon/src/mcp-live-artifacts-server.ts` (stdio, hand-rolled) |
| Design systems / libraries, media, exports | `/api/*` routes | `od media ...` | none |

Supporting machinery that already exists and should be reused, not reinvented:

- `@modelcontextprotocol/sdk` **1.29.0** is already a daemon dependency —
  the Streamable HTTP server ships in the SDK, no new dependency.
- Run-scoped tool tokens: `apps/daemon/src/tool-tokens.ts`
  (`ToolTokenRegistry`, endpoint/operation allowlists, TTL, revoke-by-run) and
  request helpers in `apps/daemon/src/http/tool-request-auth.ts`.
- Loopback Host/Origin/peer validation: `apps/daemon/src/http/local-daemon-request.ts`.
- Runtime MCP injection choke points:
  `apps/daemon/src/runtimes/mcp.ts` (`buildLiveArtifactsMcpServersForAgent`),
  `apps/daemon/src/server.ts` (~line 13432), and ACP merge in
  `apps/daemon/src/agent-protocol/acp/stdio-mcp.ts` (`buildAcpMcpServers`
  currently emits stdio only and drops HTTP/SSE entries).

## 4. Proposed target architecture

### 4.1 One endpoint, one registry

- The daemon hosts **one Streamable HTTP MCP endpoint** at
  `POST /mcp` on its existing loopback origin (path itself is decision 1 in
  §11). One endpoint serves all tools; the registry is partitioned by tool
  name prefix (`browser_*`, `project_*`, `file_*`, `artifact_*`,
  `connector_*`, `run_*`, …).
- **One shared tool registry module** in the daemon maps each MCP tool to the
  same domain-service functions the REST routes and `od` CLI call. REST, CLI,
  and MCP are all adapters over the registry; no parallel implementations.
- The registry is the single place that knows input schemas (zod), output
  shaping, redaction, and cost/payload limits.
- The endpoint is in-process; there is no MCP child process and no second
  port. Concurrency and lifecycle inherit the daemon's.

### 4.2 Structured result conventions

- `browser_screenshot` → MCP `image` content (PNG bytes), not a path string.
- `browser_snapshot`, `browser_inspect`, `browser_evaluate`,
  `browser_console`, network tools → structured JSON resources with a
  documented truncation budget; never raw base64 or megabyte dumps in
  transcripts.
- File/artifact writes → structured result with path, byte count, and a
  content hash; large blobs by reference to the existing artifact URL.
- Every tool result carries a small, stable envelope
  (`{ ok, data | error, meta: { truncated?, ms?, toolVersion } }`).

## 5. Proposed authentication — two modes

### 5.1 Mode A: agents launched by OpenDesign

- At run start the daemon **mints a short-lived, run-scoped bearer token**
  bound to (run id, project id, allowed tool prefixes). The existing
  `ToolTokenRegistry` is extended with an MCP audience rather than building a
  second token system.
- The run config for Claude, Kimi, Codex, OpenCode, ACP, and compatible
  runtimes registers the HTTP MCP server (URL + `Authorization` header) using
  each runtime's native remote-MCP mechanism.
- The token is **revoked at run completion** (success, failure, cancel) and
  expires on a short TTL regardless.
- Tokens never appear in: the project repo, the prompt text, run logs, argv,
  or any user project file. Header injection only.

### 5.2 Mode B: external agents connecting from another workspace

- A **user-managed local MCP credential** is created from Settings (Web + CLI
  closure per the capability-exposure rule): name, allowed tool prefixes,
  expiry. Stored in the daemon data root, shown once.
- `od mcp install <agent>` is changed to register an **HTTP URL plus
  authorization header** in the target agent's config, instead of a stdio
  launch spec.
- External credentials are revocable and auditable from the same Settings
  surface.

## 6. Agent compatibility matrix (proposed per-runtime treatment)

| Runtime | Injection mechanism today | HTTP MCP support | Proposal |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` / `--mcp-config` (`claude-mcp-json`) | yes (remote MCP) | register HTTP server + header |
| Kimi (ACP) | ACP merge (`acp-merge`), stdio withheld ≥ 0.37.0 | **http/sse only** | register HTTP entry; remove the stdio guard once parity is proven |
| Codex | **not wired** | yes (config `mcp_servers`) | add `externalMcpInjection` variant for Codex config |
| OpenCode | inline env config | yes | switch env config to HTTP URL + header |
| MiMo | inline env config | yes | same as OpenCode |
| ACP others | `buildAcpMcpServers` emits stdio only | varies | teach `buildAcpMcpServers` to emit HTTP entries with header auth |

## 7. Proposed tool migration inventory

Roughly, in priority order; exact names are set when the registry lands.

1. **Browser** (new as MCP tools; wraps `browser-command-broker`):
   `browser_snapshot`, `browser_inspect`, `browser_screenshot`,
   `browser_console`, `browser_network_list`, `browser_network_get`,
   `browser_network_failures`, `browser_navigate`, `browser_click`,
   `browser_type`, `browser_scroll`, `browser_viewport`, `browser_style`,
   `browser_evaluate`, `browser_devtools`.
2. **Live artifacts + connectors** (migrate from the hand-rolled stdio
   server): `live_artifacts_create/list/update/refresh`,
   `connectors_list`, `connectors_execute`.
3. **Project / file / search** (migrate from `mcp.ts`):
   `list_projects`, `get_project`, `get_file`, `write_file`, `delete_file`,
   `list_files`, `search_files`.
4. **Runs**: `start_run`, `get_run`, `cancel_run`, `get_active_context`.
5. **Artifacts**: `get_artifact`, `create_artifact`.
6. **Catalog**: `list_skills`, `list_plugins`. The Vela login pair is cancelled.
7. Later: design systems/libraries, media, exports — only where a
   first-class tool beats the CLI/REST the agent can already call (decision 7).

## 8. Proposed approval boundary for mutating tools

This is decision 4 in §11; the recommended shape is:

- **Phase 1 ships read-only browser tools unlocked** (snapshot, inspect,
  screenshot, console, network-*) plus all project/file/artifact read tools.
- **Consequential browser operations require an OpenDesign-hosted grant**:
  `browser_click`, `browser_type`, `browser_navigate`, `browser_evaluate`,
  `browser_style`, storage/cache mutation, DevTools actions that alter page
  state. The MCP call returns a structured `approval_required` result; the
  daemon surfaces a one-click approval in the web UI (and a
  `od mcp approve` CLI peer) bound to (run, tab, operation class, time
  window). The model-supplied `approved: true` field is **removed from the
  MCP surface entirely**; it remains internally as the representation of a
  daemon-held grant, never of model intent.
- Grants are scoped, logged, and expire; the transcript shows what was
  approved, not a model assertion.

## 9. Proposed implementation slices

Each slice is independently shippable and lands behind the previous one.

### Slice 1 — Foundation and auth

- Streamable HTTP MCP endpoint mounted in the daemon at the chosen path,
  loopback-gated via `local-daemon-request.ts`, SDK 1.29.0 transport.
- Shared registry module skeleton with input validation, result envelope,
  redaction, and payload budgets.
- Mode A run-scoped token (extend `ToolTokenRegistry` with MCP audience) and
  header auth on the endpoint; Mode B user-managed credential + Settings
  closure (Web + `od mcp token create/list/revoke`).
- Unit + route-level tests; no tools registered yet except one smoke tool.

### Slice 2 — Browser vertical slice (read-only)

- Read-only browser tools from §7.1 wired through the registry to
  `browser-command-broker`; approval bridge scaffolded but not yet required
  (nothing mutating exposed).
- Structured results per §4.2; screenshot as MCP image content.
- Prompt composition (`apps/daemon/src/prompts/`) updated so launched agents
  are told the MCP tools exist; `skills/agent-browser/SKILL.md` rewritten for
  tool-first with CLI as fallback.
- Mock-agent e2e: a fixture MCP client performs snapshot → inspect →
  screenshot against a keyless fake page.

### Slice 3 — Approval bridge + mutating browser tools

- Grant model, web UI approval surface, `od mcp approve` CLI peer.
- Mutating browser tools exposed, gated on grants; `approved: true` removed
  from the MCP-facing schema.
- Tests: grant scoping, expiry, cross-run isolation, rejection paths.

### Slice 4 — Live artifacts + connectors migration

- Migrate `mcp-live-artifacts-server.ts` tools into the registry; delete the
  hand-rolled stdio server once parity tests pass.
- Update `runtimes/mcp.ts` injection to register the HTTP endpoint for
  `mature-acp` instead of spawning the stdio server.

### Slice 5 — Full project/run catalog migration

- Migrate `mcp.ts` tool catalog into the registry; route `od mcp` client
  operations through the registry.
- `od mcp install <agent>` registers HTTP URL + header for all supported
  agents, including the new Codex path.
- Teach `buildAcpMcpServers` to emit HTTP entries (fixes HTTP/SSE being
  dropped today).

### Slice 6 — Stdio deprecation

- `od mcp` stdio server kept as compatibility only, printing a deprecation
  notice; `od mcp install` no longer offers stdio.
- Remove the Kimi stdio-withhold guard once HTTP parity is proven against
  real Kimi builds.
- Delete stdio servers after one release cycle of deprecation telemetry.

## 10. Observability, redaction, and limits

- Every MCP call logged with tool name, run id, token audience, duration,
  byte size — never arguments that contain secrets or full payloads;
  redaction runs in the registry, one choke point.
- Payload budgets per tool class (snapshot/evaluate JSON caps, screenshot
  dimension caps) with explicit `truncated` metadata.
- Endpoint rate limits per token; concurrent in-flight call cap per run so a
  looping agent cannot starve the daemon.
- Diagnostics surface in Settings: connected agents, active tokens, per-tool
  call counts.

## 11. Decisions for your review

Reply per item: **accept / change / drop**.

1. **Endpoint path.** *Question:* where should the MCP endpoint live?
   *Recommendation:* `POST /mcp` on the daemon's existing loopback origin —
   a second port would complicate packaged namespace/port isolation.
   *Need from you:* accept `POST /mcp`, or name a preferred path.
2. **Mode A token TTL.** *Question:* how long should a run-scoped token live?
   *Recommendation:* 15 minutes with sliding renewal while the run is active,
   always revoked at run completion.
   *Need from you:* accept or set a TTL.
3. **External credential lifetime.** *Question:* default lifetime for
   user-managed local credentials (Mode B)?
   *Recommendation:* 30 days, rotatable, revocable from Settings.
   *Need from you:* accept or set a lifetime.
4. **Approval model.** *Question:* how should mutating browser tools be
   gated? *Recommendation:* the §8 grant bridge — read-only tools unlocked,
   consequential operations need a one-click OpenDesign approval.
   *Need from you:* accept the grant bridge, or pick the alternative (blunt
   per-run "allow mutations" toggle — not recommended), or propose another.
5. **Codex injection.** *Question:* is adding a Codex `externalMcpInjection`
   variant in scope for Slice 5? *Recommendation:* yes — you named Codex
   explicitly and it is currently not wired at all.
   *Need from you:* confirm scope.
6. **Stdio retirement timing.** *Question:* when do the stdio MCP servers go
   away? *Recommendation:* compatibility-only after Slice 5, deleted after
   one release cycle of deprecation telemetry.
   *Need from you:* confirm the window, or keep stdio longer.
7. **Scope of "everything".** *Question:* does "convert everything to HTTP
   MCP" include first-class tools for design systems, media, and exports, or
   is REST/CLI coverage there sufficient? *Recommendation:* defer those to a
   later pass; browser + live artifacts + project/run catalog first.
   *Need from you:* confirm the deferral or expand scope.

## 12. Explicitly out of scope

- Any non-loopback exposure of the MCP endpoint (no tunneling, no remote).
- Replacing the `od` CLI (it stays as fallback and for UI/CLI parity).
- Changes to the daemon data-directory contract or sidecar identity stamps.
- Multi-user / multi-tenant token semantics.

## 13. Validation commands

Per slice, before handoff:

```text
pnpm --filter @open-design/daemon typecheck
pnpm --filter @open-design/contracts typecheck
focused daemon registry, auth, and route tests
mock-agent MCP client e2e against a keyless fake page
git diff --check
```

Before Slice 5 completion (stdio deprecation gate):

```text
pnpm guard
pnpm typecheck
pnpm --filter @open-design/daemon test
real-agent compatibility smoke: Claude, Kimi ≥ 0.37, Codex, OpenCode
```

## 14. Acceptance for the whole effort

- A launched Claude, Kimi, Codex, or OpenCode agent can snapshot, inspect,
  screenshot, and (after one approval click) click around the in-app browser
  using MCP tools — with zero `od` CLI invocations in the transcript.
- `od mcp install <agent>` from another workspace registers one HTTP MCP
  server with a scoped credential.
- No token appears in any prompt, log, argv, or project file.
- The hand-rolled stdio JSON-RPC server is deleted; the SDK stdio server is
  on a documented deprecation path.

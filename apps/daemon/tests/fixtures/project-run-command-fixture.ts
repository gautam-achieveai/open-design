import express from 'express';
import type { Database } from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getGlobalDispatcher } from 'undici';
import * as dbApi from '../../src/db.js';
import * as projectFiles from '../../src/projects.js';
import { writeAppConfig, readAppConfig } from '../../src/app-config.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { createAuthorizeProjectRequest, createSynchronousProjectRequestDecision } from '../../src/collab/project-request-authority.js';
import { registerProjectRoutes } from '../../src/routes/project/index.js';
import { registerRunRoutes } from '../../src/routes/runs.js';
import { createChatRunService } from '../../src/runtimes/runs.js';
import { createProjectRunCommandService } from '../../src/services/project-run-commands.js';
import { McpCredentialStore } from '../../src/mcp-http/credentials.js';
import { McpToolRegistry } from '../../src/mcp-http/registry.js';
import { registerProjectRunCommandMcpTools } from '../../src/mcp-http/project-run-command-tools.js';
import { registerExternalRunStatusMcpTool } from '../../src/mcp-http/external-run-status-tools.js';
import { resolveMcpGrant } from '../../src/mcp-http/auth.js';
import { registerMcpHttpRoutes } from '../../src/mcp-http/routes.js';
import { ToolTokenRegistry } from '../../src/tool-tokens.js';

const noop = () => undefined;
const proxy = (values: Record<string, unknown> = {}) => new Proxy(values, { get: (obj, key) => key in obj ? obj[String(key)] : noop });
export const closeProjectRunFixturePool = () => getGlobalDispatcher().close();

// Name the fixture boundary explicitly so declaration checking does not expand
// SQLite's private namespace through the inferred service return types.
interface ProjectRunCommandFixture {
  root: string;
  db: Database;
  projectsRoot: string;
  runs: ReturnType<typeof createChatRunService>;
  design: { runs: ReturnType<typeof createChatRunService>; analytics: { capture: typeof noop }; getAppVersion: () => string };
  project: ReturnType<typeof registerProjectRoutes>;
  runRoutes: ReturnType<typeof registerRunRoutes>;
  commands: ReturnType<typeof createProjectRunCommandService>;
  registry: McpToolRegistry;
  tokens: ToolTokenRegistry;
  store: McpCredentialStore;
  credential: ReturnType<McpCredentialStore['create']>;
  state: {
    starts: number; resumeStarts: number; pauseCloud: boolean;
    lastError: { name: string; message: string; stack?: string } | null;
    beforeCreateValidation: (() => void | Promise<void>) | undefined;
    beforeRegistryRead: (() => void | Promise<void>) | undefined;
    onClaim: (() => void) | undefined;
    beforeEventsRead: (() => void | Promise<void>) | undefined;
    beforeOrigins: (() => void | Promise<void>) | undefined;
    queryGets: number;
  };
  base: string;
  call: (name: string, args: unknown, headers?: Record<string, string>) => Promise<{
    ok: boolean; data?: Record<string, unknown>; error?: { code: string };
  }>;
  restartRegistry: () => void;
  close: () => Promise<void>;
}

/** Actual REST handlers, SQLite and run registry; only the physical agent is synthetic. */
export async function createProjectRunCommandFixture(options: { localCatalog?: boolean } = {}): Promise<ProjectRunCommandFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-project-run-command-'));
  const db: Database = dbApi.openDatabase(root, { dataDir: root });
  const projectsRoot = path.join(root, 'projects');
  await fs.mkdir(projectsRoot);
  await writeAppConfig(root, { odNextStrategyMode: 'off' });
  const tokens = new ToolTokenRegistry();
  const makeRuns = () => createChatRunService({ createSseResponse: () => ({ send: () => true, end: noop, cleanup: noop }),
    createSseErrorPayload: (code: string, message: string, init: Record<string, unknown> = {}) => ({ error: { code, message, ...init } }),
    runsLogDir: path.join(root, 'runs') as unknown as null, maxEvents: 2 });
  const runs = makeRuns();
  const authorityDeps = { db,
    getWorkspaceProject: dbApi.getWorkspaceProject, getWorkspaceProjectByProjectId: dbApi.getWorkspaceProjectByProjectId, sendApiError,
    ...(options.localCatalog ? {
      isProjectUnavailable: (_db: unknown, id: string) => dbApi.findTeamWorkspaceIdForProject(db, id) !== null,
      isProjectRevoked: (_db: unknown, id: string) => Boolean(dbApi.getProject(db, id)?.metadata?.teamMirrorRevokedAt),
    } : {}),
  };
  const authority = { authorizeProjectRequest: createAuthorizeProjectRequest(authorityDeps as Parameters<typeof createAuthorizeProjectRequest>[0]),
    decideProjectRequestSync: createSynchronousProjectRequestDecision(authorityDeps as Parameters<typeof createSynchronousProjectRequestDecision>[0]) };
  const app = express(); app.use(express.json());
  const design = { runs, analytics: { capture: noop }, getAppVersion: () => 'fixture' };
  const state = { starts: 0, resumeStarts: 0, pauseCloud: true, lastError: null as null | { name: string; message: string; stack?: string },
    beforeCreateValidation: undefined as (() => void | Promise<void>) | undefined,
    beforeRegistryRead: undefined as (() => void | Promise<void>) | undefined, onClaim: undefined as (() => void) | undefined,
    beforeEventsRead: undefined as (() => void | Promise<void>) | undefined,
    beforeOrigins: undefined as (() => void | Promise<void>) | undefined, queryGets: 0 };
  const countGets = (service: typeof runs) => {
    const get = service.get;
    service.get = (...args) => { state.queryGets++; return get(...args); };
  };
  countGets(runs);
  const project = registerProjectRoutes(app, {
    db, design, http: { sendApiError, createSseResponse: noop },
    paths: { PROJECTS_DIR: projectsRoot, RUNTIME_DATA_DIR: root, DESIGN_SYSTEMS_DIR: root, SKILLS_DIR: root, BRANDS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root },
    projectStore: proxy({ ...dbApi, dbDeleteProject: dbApi.deleteProject, removeProjectDir: projectFiles.removeProjectDir, validateLinkedDirs: () => ({ dirs: [] }) }),
    projectFiles: proxy({ ...projectFiles, listTabs: () => [], setTabs: noop }),
    conversations: proxy({ ...dbApi }), templates: proxy({ ...dbApi }),
    status: proxy({ ...dbApi, listLatestProjectRunStatuses: () => new Map(), listProjectsAwaitingInput: () => new Set(),
      // This fixture has no persisted display-status history to decorate.
      composeProjectDisplayStatus: (status: { value: string }) => status }),
    events: proxy({ activeProjectEventSinks: new Map() }), ids: { randomId: randomUUID }, telemetry: { reportFinalizedMessage: noop },
    appConfig: { readAppConfig, writeAppConfig }, agents: {}, collabSync: proxy(),
    validation: { validateProjectDesignSystemId: async (id: unknown) => ({ ok: true, id: id ?? null }),
      validateProjectSkillId: async (id: unknown) => { await state.beforeCreateValidation?.(); return { ok: true, id: id ?? null }; } },
    authorizeProjectRequest: authority.authorizeProjectRequest,
    ...(options.localCatalog ? { canReadLocalProject: (id: string) =>
      authority.decideProjectRequestSync({ headers: {}, get: () => undefined }, id, { mode: 'read' }).ok } : {}),
  } as unknown as Parameters<typeof registerProjectRoutes>[1]);
  const runRoutes = registerRunRoutes(app, { db, design, http: { sendApiError, createSseResponse: noop },
    paths: { PROJECTS_DIR: projectsRoot, RUNTIME_DATA_DIR: root, BUNDLED_PLUGINS_DIR: path.join(root, 'plugins') },
    lifecycle: { isDaemonShuttingDown: () => false },
    agents: { detectAgents: async () => [{ id: 'codex', available: true }], getAgentDef: (id: string) => ({ id, name: id }) },
    chat: { startChatRun: async (_meta: unknown, run: ReturnType<typeof runs.create>) => {
      state.starts++;
      if (run.agentId === 'amr' && state.pauseCloud) {
        Object.assign(run, { failureAction: 'recharge' });
        runs.fail(run, 'AMR_INSUFFICIENT_BALANCE', 'Synthetic paused cloud run', { failureAction: 'recharge' });
      } else { run.status = 'running'; if (run.agentId === 'amr') state.resumeStarts++; runs.emit(run, 'text_delta', { text: 'Synthetic agent accepted' }); }
    } },
    plugins: { connectorService: { listFastDefinitions: () => [] }, detectSkillPluginCandidateOnRunSuccess: noop, firePipelineForRun: noop,
      loadPluginRegistryView: async () => { await state.beforeRegistryRead?.(); return { skills: [], designSystems: [], craft: [], atoms: [], scenarios: [] }; }, renderPluginBriefTemplate: (value: string) => value },
    telemetry: { reportRunCompletionTelemetryFallback: noop, resolveRunProjectKindForAnalytics: () => null,
      runArtifactBaselines: { take: noop }, runRetryEventsForAnalytics: () => [] },
    messages: { pinAssistantMessageOnRunCreate: () => { state.onClaim?.(); return { ok: true }; }, reconcileAssistantMessageOnRunEnd: noop },
    projectStore: { getWorkspaceProject: dbApi.getWorkspaceProject, getWorkspaceProjectByProjectId: dbApi.getWorkspaceProjectByProjectId },
    authorizeProjectRequest: authority.authorizeProjectRequest,
    resources: { listAllSkillLikeEntries: async () => [] },
  } as unknown as Parameters<typeof registerRunRoutes>[1]);
  const commands = createProjectRunCommandService({ createProject: project.handleProjectCreate, getRun: runRoutes.handleRunQuery,
    deleteProject: project.handleProjectDelete, startRun: async (...args) => {
      try { return await runRoutes.handleRunCreate(...args); }
      catch (error) {
        state.lastError = error instanceof Error ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
          : { name: 'unknown', message: String(error) };
        throw error;
      }
    } });
  const store = new McpCredentialStore({ filePath: path.join(root, 'credentials.json') });
  const credential = store.create({ name: 'Synthetic command fixture', allowedOperations:
    ['project/project:create', 'project/project:delete', 'run/run:start', 'run/run:read'] });
  const registry = new McpToolRegistry();
  registerProjectRunCommandMcpTools(registry, { toolTokenRegistry: tokens, credentialStore: store, commands,
    getProject: id => dbApi.getProject(db, id),
    getProjectWorkspaceId: id => dbApi.getWorkspaceProjectByProjectId(db, id)?.workspaceId ?? null,
    readUnboundProjectDetail: project.readUnboundProjectDetail,
    isUnboundProjectCurrentlyVisible: project.isUnboundProjectCurrentlyVisible,
    decideProjectRequest: authority.decideProjectRequestSync });
  let base = '';
  registerExternalRunStatusMcpTool(registry, { toolTokenRegistry: tokens, credentialStore: store,
    peekRunProjectId: id => design.runs.peekProjectId(id), peekInMemoryRun: runRoutes.peekInMemoryRun, queryRun: commands.getRun,
    readRunEvents: async (run, assertCurrent) => { const events = await design.runs.readEvents(run, assertCurrent); await state.beforeEventsRead?.(); assertCurrent(); return events; },
    readUnboundProjectDetail: project.readUnboundProjectDetail, isUnboundProjectCurrentlyVisible: project.isUnboundProjectCurrentlyVisible,
    decideProjectRequest: authority.decideProjectRequestSync,
    getOrigins: async () => { await state.beforeOrigins?.(); return { daemonBaseUrl: base, webBaseUrl: base }; } });
  registerMcpHttpRoutes(app, { registry, resolveGrant: req => resolveMcpGrant(req, { toolTokenRegistry: tokens, credentialStore: store }),
    serverInfo: { name: 'open-design-command-fixture', version: '0' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener missing');
  base = `http://127.0.0.1:${address.port}`;
  let sequence = 0;
  const call = async (name: string, args: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
    const reply = await response.json() as { result?: { structuredContent: { ok: boolean; data?: Record<string, unknown>; error?: { code: string } } }; error?: unknown };
    if (!reply.result) throw new Error(`Fixture HTTP ${response.status} missing MCP result`);
    return reply.result.structuredContent;
  };
  return { root, db, projectsRoot, runs, design, project, runRoutes, commands, registry, tokens, store, credential, state, base, call,
    restartRegistry: () => { design.runs = makeRuns(); countGets(design.runs); state.queryGets = 0; },
    close: async () => {
      tokens.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const service of new Set([runs, design.runs])) {
        for (const run of service.list({})) if (!service.isTerminal(run.status)) await service.cancel(run, 'project_cleanup');
        await Promise.all(service.list({}).map(run => run.eventsLogFinalFlush ?? Promise.resolve()));
      }
      dbApi.closeDatabase();
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('od-project-run-command-')) throw new Error('Unsafe fixture root');
      await fs.rm(root, { recursive: true, force: true });
    } };
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DecideProjectRequestSync } from '../collab/project-request-authority.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { isSafeId } from '../projects.js';
import { LocalCommandFailure, type ProjectRunCommandService } from '../services/project-run-commands.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import { resolveMcpGrant } from './auth.js';
import type { McpCredentialStore } from './credentials.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk, type McpToolContext } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const OPERATIONS = { create_project: 'project/project:create', delete_project: 'project/project:delete', start_run: 'run/run:start' } as const;
const id = z.string().min(1).max(128).refine(isSafeId, 'invalid project id');
const optionalName = z.string().min(1).max(512).optional();
const attribution = z.unknown().optional().describe('Unsupported by HTTP MCP.');
const schemas = {
  create_project: z.object({ name: z.string().trim().min(1).max(500), id: id.optional(),
    designSystem: optionalName, skill: optionalName, pluginWorkflowId: attribution }).strict(),
  delete_project: z.object({ project: id, confirm: z.literal(true), pluginWorkflowId: attribution }).strict(),
  start_run: z.object({ project: id, prompt: z.string().optional(), skill: optionalName,
    skills: z.array(z.string().min(1).max(512)).max(100).optional(), plugin: optionalName,
    inputs: z.record(z.string(), z.unknown()).optional(), agent: optionalName, model: optionalName,
    serviceTier: optionalName, requestId: z.string().min(1).max(128).optional(), resume: z.boolean().optional(),
    pluginWorkflowId: attribution }).strict(),
};
type Name = keyof typeof schemas;
type Args = { project?: string; name?: string; id?: string; pluginWorkflowId?: unknown } & Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function containsCredentialField(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)$/iu.test(key)
    || containsCredentialField(child, depth + 1));
}

function safeReply(value: unknown, bearer: string | null): boolean {
  const text = JSON.stringify(value);
  return text.length <= 20_000 && !/(?:odtt_|odmcp_)[A-Za-z0-9_-]+/u.test(text)
    && !(bearer && text.includes(bearer)) && toolOkFitsUtf8Bytes(value, false, 1, 32_000);
}

/** External commands share unchanged REST preparation and its commit hooks. */
export function registerProjectRunCommandMcpTools(registry: McpToolRegistry, deps: {
  toolTokenRegistry: ToolTokenRegistry; credentialStore: McpCredentialStore;
  commands: ProjectRunCommandService;
  getProject: (id: string) => { id: string } | null | undefined;
  getProjectWorkspaceId: (id: string) => string | null;
  readUnboundProjectDetail: (id: string) => Promise<{ revalidate: () => boolean } | null>;
  isUnboundProjectCurrentlyVisible: (id: string) => boolean;
  decideProjectRequest: DecideProjectRequestSync;
}): void {
  const invoke = async (name: Name, args: Args, context: McpToolContext) => {
    const denied = () => toolError('PROJECT_SCOPE_DENIED', 'Project command unavailable in this scope', 0);
    const partial = () => toolError('COMMAND_STARTED_RESULT_UNAVAILABLE',
      'The command may have changed state; its result is unavailable. Check current state before retrying. Reuse the original requestId for a run retry.', 0);
    let effectsStarted = false;
    try {
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      if (containsCredentialField(args.inputs)) return toolError('UNSUPPORTED_ARGUMENT', 'Raw credentials are not accepted in run inputs', 0);
      const request = context.request;
      if (!request || context.grant.kind !== 'external' || !context.grant.credentialId) return denied();
      const hasWorkspace = () => Object.keys(request.headers ?? {}).some(key => key.toLowerCase().startsWith('x-od-workspace-'))
        || request.get('x-od-workspace-id') !== undefined || request.get('x-od-workspace-member-id') !== undefined;
      const currentCredential = () => {
        if (context.signal?.aborted || hasWorkspace()) return false;
        const auth = resolveMcpGrant(request, deps);
        return auth.ok && auth.grant.kind === 'external' && auth.grant.credentialId === context.grant.credentialId
          && operationAllowed(auth.grant.allowedOperations, OPERATIONS[name]);
      };
      if (!currentCredential()) return denied();
      let projectId: string;
      let initial: { revalidate: () => boolean } | null = null;
      const body: Record<string, unknown> = {};
      let requestId: string | undefined;
      if (name === 'create_project') {
        const base = args.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
        projectId = args.id ?? `${base}-${randomUUID().replaceAll('-', '').slice(0, 4)}`;
        Object.assign(body, { id: projectId, name: args.name, skipDiscoveryBrief: true });
        if (args.designSystem) body.designSystemId = args.designSystem;
        if (args.skill) body.skillId = args.skill;
      } else {
        projectId = args.project!;
        initial = await deps.readUnboundProjectDetail(projectId);
        if (!initial || !initial.revalidate() || !currentCredential()) return denied();
        if (name === 'start_run') {
          requestId = typeof args.requestId === 'string' ? args.requestId : randomUUID();
          Object.assign(body, { projectId, clientRequestId: requestId });
          if (typeof args.prompt === 'string' && args.prompt.length) Object.assign(body, { message: args.prompt, currentPrompt: args.prompt });
          for (const [from, to] of [['skill', 'skillId'], ['skills', 'skillIds'], ['plugin', 'pluginId'],
            ['inputs', 'pluginInputs'], ['agent', 'agentId'], ['model', 'model'], ['serviceTier', 'serviceTier'], ['resume', 'resume']] as const) {
            if (args[from] !== undefined) body[to] = args[from];
          }
        }
      }
      const current = () => currentCredential() && (name === 'create_project'
        ? !deps.getProject(projectId) && deps.getProjectWorkspaceId(projectId) === null
        : (effectsStarted || initial!.revalidate()) && deps.isUnboundProjectCurrentlyVisible(projectId)
          && deps.decideProjectRequest(request, projectId, { mode: 'write', capability: 'writeFiles' }).ok);
      if (!current()) return denied();
      const input = { body, projectId, signal: context.signal, assertCurrent: current,
        onMutationStarting: () => { effectsStarted = true; } };
      const result = await (name === 'create_project' ? deps.commands.createProject(input)
        : name === 'delete_project' ? deps.commands.deleteProject(input) : deps.commands.startRun(input));
      effectsStarted ||= result.mutationStarted;
      if (!currentCredential()) return effectsStarted ? partial() : denied();
      if (result.status >= 400) {
        if (!current()) return effectsStarted ? partial() : denied();
        if (!safeReply(result.body, bearerTokenFromRequest(request) ?? null)) return effectsStarted ? partial() : denied();
        const error = record(record(result.body).error);
        return toolError(typeof error.code === 'string' ? error.code : 'COMMAND_REJECTED',
          typeof error.message === 'string' ? error.message : 'The local command was rejected', 0);
      }
      const stillCurrent = name === 'delete_project' ? !deps.getProject(projectId) && deps.getProjectWorkspaceId(projectId) === null
        : deps.isUnboundProjectCurrentlyVisible(projectId)
          && deps.decideProjectRequest(request, projectId, { mode: 'write', capability: 'writeFiles' }).ok;
      if (!stillCurrent || !currentCredential()) return effectsStarted ? partial() : denied();
      const data = { ...record(result.body), ...(name === 'start_run' ? { projectId, requestId } : {}) };
      if (!safeReply(data, bearerTokenFromRequest(request) ?? null)) return effectsStarted ? partial() : denied();
      return toolOk(data, 0);
    } catch (error) {
      return effectsStarted || (error instanceof LocalCommandFailure && error.mutationStarted) ? partial() : denied();
    }
  };
  for (const name of Object.keys(schemas) as Name[]) {
    registry.register({ name, operation: OPERATIONS[name], version: 1, schema: schemas[name] as z.ZodType<Args>,
      annotations: { readOnlyHint: false, ...(name === 'delete_project' ? { destructiveHint: true } : {}) },
      description: name === 'create_project' ? 'Create an empty unbound local project using the existing project command.'
        : name === 'delete_project' ? 'Permanently delete an exact unbound project; confirm:true is required.'
        : 'Start a run on an exact unbound project. Reuse requestId for retries; paused cloud runs retain their existing resume semantics.',
      handler: (args, context) => invoke(name, args, context) });
  }
}

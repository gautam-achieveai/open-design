import { z } from 'zod';
import { ArtifactPublicationBlockedError } from '../artifacts/publication-guard.js';
import { ArtifactRegressionError } from '../artifacts/stub-guard.js';
import type { ProjectFileMutationOperations, ProjectFileOperationHooks } from '../services/project-file-mutations.js';
import { resolveProjectWriteAccess, type ProjectReadAccess, type ProjectReadAccessDeps } from './project-read-access.js';
import { McpToolRegistry, toolError, toolOk, type McpToolContext, type McpToolResult } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const project = z.string().min(1).max(128).optional();
const path = z.string().min(1).max(4096);
const content = z.string().max(1_000_000);
const encoding = z.enum(['utf8', 'base64']).default('utf8');
const aliasNotice = 'Ordinary in-root aliases affect their target; history and bookkeeping use the requested path. The result reports the canonical affected path.';
type Access = Extract<ProjectReadAccess, { ok: true }>;

export interface ProjectFileMutationMcpToolsDeps extends ProjectReadAccessDeps {
  operations: ProjectFileMutationOperations;
}

export function registerProjectFileMutationMcpTools(registry: McpToolRegistry, deps: ProjectFileMutationMcpToolsDeps): void {
  const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project write access denied', 0);
  const partial = () => toolError('PROJECT_FILE_MUTATION_PARTIAL',
    'The operation may have changed project files; its full result is unavailable. Check the current state before retrying.', 0);
  async function mutate(projectArg: string | undefined, context: McpToolContext, operation: string,
    perform: (access: Access, hooks: ProjectFileOperationHooks) => Promise<McpToolResult>): Promise<McpToolResult> {
    let mayHaveChanged = false;
    let access: Access | undefined;
    try {
      const resolved = await resolveProjectWriteAccess(projectArg, context, operation, deps);
      if (!resolved.ok) return resolved.result;
      access = resolved;
      const assertCurrent = () => {
        if (!resolved.current()) throw Object.assign(new Error('project mutation authority changed'), { code: 'PROJECT_MUTATION_DENIED' });
      };
      assertCurrent();
      const result = await perform(resolved, { assertCurrent, beforeMutation: () => { assertCurrent(); mayHaveChanged = true; } });
      return resolved.current() ? result : mayHaveChanged ? partial() : denied();
    } catch (error) {
      if (mayHaveChanged) return partial();
      if (access && !access.current()) return denied();
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'PROJECT_MUTATION_DENIED') return denied();
      if (code === 'EEXIST') return toolError('FILE_EXISTS', 'File already exists', 0);
      if (code === 'ENOENT') return toolError('FILE_NOT_FOUND', 'File not found', 0);
      if (code === 'EPATHESCAPE') return toolError('FILE_PATH_DENIED', 'Path is outside the project', 0);
      if (code === 'ARTIFACT_MANIFEST_REQUIRED') return toolError('ARTIFACT_MANIFEST_REQUIRED', 'This artifact requires a manifest', 0);
      if (code === 'ARTIFACT_MANIFEST_INVALID') return toolError('ARTIFACT_MANIFEST_INVALID', 'Artifact manifest is invalid', 0);
      if (error instanceof ArtifactPublicationBlockedError) return toolError('ARTIFACT_PUBLICATION_BLOCKED', 'Artifact still contains unresolved publication placeholders', 0);
      if (error instanceof ArtifactRegressionError) return toolError('ARTIFACT_REGRESSION', 'Artifact would replace a larger published artifact with a stub', 0);
      return toolError('PROJECT_FILE_MUTATION_FAILED', 'Could not change this project file', 0);
    }
  }

  async function write(args: { project: string | undefined; name: string; content: string; encoding: 'utf8' | 'base64';
    artifactManifest?: unknown; overwrite?: boolean | undefined }, context: McpToolContext, artifact: boolean) {
    return mutate(args.project, context, artifact ? 'project/artifact:create' : 'project/files:write', async (access, hooks) => {
      const result = await deps.operations.writeJson(access.projectId, access.project, { name: args.name, content: args.content,
        encoding: args.encoding, artifactManifest: args.artifactManifest, artifact, overwrite: artifact ? false : args.overwrite }, hooks);
      const receipt = result.receipt;
      if (!receipt || receipt.path.length > 8192) return partial();
      const warning = result.response.versionWarning;
      const data = { projectId: access.projectId, ...receipt, committed: true, partial: Boolean(warning),
        versionId: result.response.version?.id ?? null,
        ...(warning ? { historyWarning: warning.code, checkStateBeforeRetry: true } : {}) };
      return toolOkFitsUtf8Bytes(data, false, 1, 31_000) ? toolOk(data, 0) : partial();
    });
  }

  registry.register({ name: 'write_file', operation: 'project/files:write', version: 1,
    annotations: { destructiveHint: true },
    description: `Write or overwrite a project file and capture HTML history through the shared REST operation. Uses this run project or an explicit visible unbound project for a headerless external credential. Returns actual bytes/hash. A partial outcome requires checking state before retrying. ${aliasNotice}`,
    schema: z.object({ project, path, content, encoding, overwrite: z.boolean().default(true), artifactManifest: z.unknown().optional() }).strict(),
    handler: (args, context) => write({ project: args.project, name: args.path, content: args.content, encoding: args.encoding,
      artifactManifest: args.artifactManifest, overwrite: args.overwrite }, context, false) });
  registry.register({ name: 'create_artifact', operation: 'project/artifact:create', version: 1,
    annotations: { destructiveHint: true },
    description: `Create an artifact with validated or inferred manifest; existing targets are never overwritten. Uses the shared REST operation and HTML history. Returns actual bytes/hash. A partial outcome requires checking state before retrying. ${aliasNotice}`,
    schema: z.object({ project, name: path, content, encoding, artifactManifest: z.unknown().optional() }).strict(),
    handler: (args, context) => write({ project: args.project, name: args.name, content: args.content, encoding: args.encoding,
      artifactManifest: args.artifactManifest }, context, true) });
  registry.register({ name: 'delete_file', operation: 'project/files:delete', version: 1,
    annotations: { destructiveHint: true },
    description: `Delete a project file, tombstone its HTML history and update artifact bookkeeping through the shared REST operation. Uses this run project or an explicit visible unbound external project. A partial outcome requires checking state before retrying. ${aliasNotice}`,
    schema: z.object({ project, path }).strict(),
    handler: (args, context) => mutate(args.project, context, 'project/files:delete', async (access, hooks) => {
      const result = await deps.operations.deleteFile(access.project, args.path, hooks);
      if (!result.canonicalPath || result.canonicalPath.length > 8192) return partial();
      const data = { projectId: access.projectId, path: result.canonicalPath, deleted: true,
        partial: result.bookkeepingWarning, ...(result.bookkeepingWarning ? { bookkeepingWarning: 'ARTIFACT_TOMBSTONE_FAILED', checkStateBeforeRetry: true } : {}) };
      return toolOkFitsUtf8Bytes(data, false, 1, 31_000) ? toolOk(data, 0) : partial();
    }) });
}

import { z } from 'zod';
import { artifactBundlePayload, ArtifactBundleAccessError, ArtifactBundleBudgetExceededError,
  buildArtifactBundle, DEFAULT_ARTIFACT_BUNDLE_MAX_BYTES } from '../services/artifact-bundle.js';
import { listAuthorizedProjectFiles } from '../services/project-file-list.js';
import { isTextualProjectFile, readAuthorizedProjectFile, type ReadProjectFile } from '../services/project-file-read.js';
import { resolveProjectReadAccess, type ProjectReadAccessDeps } from './project-read-access.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';

const OPERATION = 'project/artifact:read';
const RESULT_BYTES = 31_000;
const CONTENT_BYTES = Math.floor(RESULT_BYTES / 2);

/** Lower-bound JSON walk before exact sizing; no unbounded candidate is serialized. */
function fitsBundlePreflight(value: unknown): boolean {
  let remaining = CONTENT_BYTES, nodes = 0;
  const ancestors = new WeakSet<object>();
  const string = (text: string) => {
    if (text.length + 2 > remaining) return false;
    remaining -= Buffer.byteLength(text, 'utf8') + 2;
    return remaining >= 0;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 4000 || depth > 24 || remaining < 0) return false;
    if (typeof item === 'string') return string(item);
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') {
      remaining -= item === undefined ? 4 : String(item).length;
      return remaining >= 0;
    }
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    ancestors.add(item);
    remaining -= 2;
    try {
      if (Array.isArray(item)) {
        for (const child of item) { if (!visit(child, depth + 1)) return false; remaining--; }
      } else {
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          if (!string(key) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
          remaining -= 2;
        }
      }
      return remaining >= 0;
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

export interface ArtifactReadMcpToolsDeps extends ProjectReadAccessDeps {
  projectsRoot: string;
  listFiles: Parameters<typeof listAuthorizedProjectFiles>[3];
  readProjectFile: ReadProjectFile;
}

export function registerArtifactReadMcpTool(registry: McpToolRegistry, deps: ArtifactReadMcpToolsDeps): void {
  registry.register({
    name: 'get_artifact', operation: OPERATION, version: 1,
    annotations: { readOnlyHint: true, idempotentHint: true },
    description: 'Bundle an entry and its relative HTML/CSS/JS dependencies through depth 3 (auto), all visible project files (all), or only the entry (shallow). Defaults to metadata.entryFile. Uses this run project or an explicit visible unbound project for a headerless external credential. Binary files contain metadata only. Output is below 32 KiB; an oversized required entry needs paged get_file reads.',
    schema: z.object({ project: z.string().min(1).max(8192).optional(), entry: z.string().min(1).max(8192).optional(),
      include: z.enum(['auto', 'all', 'shallow']).default('auto'),
      maxBytes: z.number().finite().positive().default(DEFAULT_ARTIFACT_BUNDLE_MAX_BYTES),
      pluginWorkflowId: z.unknown().optional().describe('Unsupported by HTTP MCP.') }).strict(),
    handler: async (args, context) => {
      const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
      if (args.pluginWorkflowId !== undefined) return toolError('UNSUPPORTED_ARGUMENT', 'pluginWorkflowId attribution is not supported by HTTP MCP', 0);
      try {
        const access = await resolveProjectReadAccess(args.project, context, OPERATION, deps);
        if (!access.ok) return access.result;
        if (!access.current()) return denied();
        const declared = access.project.metadata?.entryFile;
        const entry = args.entry ?? (typeof declared === 'string' && declared.length > 0 ? declared : null);
        if (!entry) return toolError('ARTIFACT_ENTRY_REQUIRED', 'Pass entry or set metadata.entryFile', 0);
        const bundle = await buildArtifactBundle({ entry, include: args.include,
          maxBytes: Math.min(args.maxBytes, CONTENT_BYTES), current: access.current,
          readFile: async (name, remaining) => {
            const result = await readAuthorizedProjectFile(access.project, deps.projectsRoot, name, deps.readProjectFile);
            if (!result.ok) throw new ArtifactBundleAccessError('project access denied');
            const file = result.file;
            const mime = file.mime.split(';')[0]!.trim();
            if (!isTextualProjectFile(mime)) return { name, mime, size: file.size, content: null, binary: true };
            if (file.buffer.byteLength > remaining) throw new ArtifactBundleBudgetExceededError('entry or dependency exceeds remaining budget');
            return { name, mime, size: file.buffer.byteLength, content: file.buffer.toString('utf8'), binary: false };
          },
          listFiles: async () => {
            const result = await listAuthorizedProjectFiles(access.project, deps.projectsRoot, undefined, deps.listFiles);
            if (!result.ok) throw new ArtifactBundleAccessError('project access denied');
            return result.files;
          } });
        if (!access.current()) return denied();
        const payload = artifactBundlePayload(access.project, entry, bundle);
        const data = (count: number) => ({ ...payload, files: payload.files.slice(0, count),
          truncated: bundle.truncated || count < payload.files.length });
        let low = 0, high = payload.files.length, count = -1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = data(middle);
          if (fitsBundlePreflight(candidate) && toolOkFitsUtf8Bytes(candidate, candidate.truncated, 1, RESULT_BYTES)) { count = middle; low = middle + 1; }
          else high = middle - 1;
        }
        if (count < 0 || (count === 0 && args.include !== 'all')) {
          return toolError('ARTIFACT_RESULT_TOO_LARGE', 'Required entry or metadata exceeds the result limit; use get_file', 0);
        }
        const result = data(count);
        return toolOk(result, 0, result.truncated ? { truncated: true } : undefined);
      } catch (error) {
        if (error instanceof ArtifactBundleAccessError) return denied();
        if (error instanceof ArtifactBundleBudgetExceededError) return toolError('ARTIFACT_ENTRY_TOO_LARGE', 'Required entry exceeds the text budget; use get_file', 0);
        return toolError('ARTIFACT_READ_FAILED', 'Could not read this project artifact', 0);
      }
    },
  });
}

import { z } from 'zod';
import type { ProjectFile, ProjectMetadata } from '@open-design/contracts';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { listAuthorizedProjectFiles } from '../services/project-file-list.js';
import { isTextualProjectFile, readAuthorizedProjectFile,
  searchAuthorizedProjectFiles, type ReadProjectFile, type SearchProjectFiles } from '../services/project-file-read.js';
import { McpToolRegistry, toolError, toolOk } from './registry.js';
import { collectionPage, collectionPageSchema } from './collection-pages.js';
import { toolOkFitsUtf8Bytes } from './result-budget.js';
import { resolveProjectReadAccess, type ProjectReadAccessDeps } from './project-read-access.js';

const OPERATION = 'project/files:list';

export interface ProjectFileMcpToolsDeps extends ProjectReadAccessDeps {
  projectsRoot: string;
  listFiles: (root: string, projectId: string, options: { since: number | undefined; metadata: ProjectMetadata | null | undefined }) => Promise<ProjectFile[]>;
  readProjectFile?: ReadProjectFile;
  searchProjectFiles?: SearchProjectFiles;
}

const READ_OPERATION = 'project/files:read';
const SEARCH_OPERATION = 'project/files:search';
const RESULT_BYTES = 31_000;
const projectArgument = z.string().min(1).max(8192).optional();

export function registerProjectFileMcpTools(registry: McpToolRegistry, deps: ProjectFileMcpToolsDeps): void {
  const denied = () => toolError('PROJECT_SCOPE_DENIED', 'project access denied', 0);
  registry.register({
    name: 'list_files', operation: OPERATION, version: 1,
    description: 'List files in the current run project, or an explicit visible unbound project for a headerless external credential. Follow page.nextCursor; if inventory changes, restart the listing.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    schema: z.object({ project: z.string().min(1).max(8192).optional(), since: z.number().finite().optional(),
      cursor: z.string().min(1).max(collectionPageSchema.cursor.maxLength).optional(), limit: z.number().int().min(1).max(collectionPageSchema.maxItems).optional() }).strict(),
    handler: async (args, context) => {
      try {
        const access = await resolveProjectReadAccess(args.project, context, OPERATION, deps);
        if (!access.ok) return access.result;
        if (!access.current()) return denied();
        const { projectId } = access;
        const result = await listAuthorizedProjectFiles(access.project, deps.projectsRoot, args.since, deps.listFiles);
        if (!result.ok) return denied();
        // Listing yields to the filesystem. Do not publish its result if the
        // caller, run, or persisted project authority changed in the meantime.
        if (!access.current()) return denied();
        const page = collectionPage({ entries: result.files, domain: 'list_files', scope: { projectId,
          ...(access.principal.kind === 'run' ? { runId: access.principal.id } : { credentialId: access.principal.id }),
          since: args.since ?? null },
          cursor: args.cursor, limit: args.limit, token: bearerTokenFromRequest(access.request),
          render: (files) => ({ files }),
          compact: (file) => ({ name: file.name, ...(file.path === undefined ? {} : { path: file.path }),
            size: file.size, mtime: file.mtime, kind: file.kind, mime: file.mime, entryTruncated: true }),
        });
        if (!page.ok) return toolError(page.code, page.code === 'INVENTORY_CHANGED' ? 'File inventory changed; restart listing' : 'Unable to return this file page', 0);
        return toolOk(page.data, 0, page.truncated ? { truncated: true } : undefined);
      } catch {
        return toolError('PROJECT_FILES_FAILED', 'Could not list project files', 0);
      }
    },
  });

  const read = deps.readProjectFile;
  if (read) registry.register({
    name: 'get_file', operation: READ_OPERATION, version: 1,
    description: 'Read a text file in the current run project, or an explicit visible unbound project for a headerless external credential. offset is a zero-based line; limit defaults to 2000. Follow nextOffset for more lines. Binary files are metadata-only through list_files. Very long individual lines require search_files.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    schema: z.object({ project: projectArgument, path: z.string().min(1).max(8192),
      offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(2000).default(2000) }).strict(),
    handler: async (args, context) => {
      try {
        const access = await resolveProjectReadAccess(args.project, context, READ_OPERATION, deps);
        if (!access.ok) return access.result;
        if (!access.current()) return denied();
        const result = await readAuthorizedProjectFile(access.project, deps.projectsRoot, args.path, read);
        if (!result.ok || !access.current()) return denied();
        const file = result.file;
        if (!isTextualProjectFile(file.mime)) return toolError('FILE_BINARY_UNSUPPORTED', 'Binary content is not returned; use list_files for metadata', 0);
        const lines = file.buffer.toString('utf8').split('\n');
        const offset = Math.min(args.offset, lines.length);
        const requestedLines = Math.min(args.limit, lines.length - offset);
        // Content occurs in both MCP representations. A window larger than
        // half the wire budget cannot fit, even before JSON escaping/metadata.
        // Bound the prefix before join/serialization, including a huge line.
        const contentBudget = Math.floor(RESULT_BYTES / 2);
        let contentBytes = 0, maximum = 0;
        for (; maximum < requestedLines; maximum++) {
          const line = lines[offset + maximum]!;
          const remaining = contentBudget - contentBytes - (maximum > 0 ? 1 : 0);
          if (line.length > remaining) break;
          const bytes = Buffer.byteLength(line, 'utf8');
          if (bytes > remaining) break;
          contentBytes += bytes + (maximum > 0 ? 1 : 0);
        }
        const data = (count: number) => ({ projectId: access.projectId, path: file.name, mime: file.mime,
          content: lines.slice(offset, offset + count).join('\n'), offset, returnedLines: count, totalLines: lines.length,
          nextOffset: offset + count < lines.length ? offset + count : null });
        let low = 0, high = maximum, count = -1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (toolOkFitsUtf8Bytes(data(middle), offset + middle < lines.length, 1, RESULT_BYTES)) { count = middle; low = middle + 1; }
          else high = middle - 1;
        }
        if (count < 0 || (count === 0 && requestedLines > 0)) return toolError('FILE_WINDOW_TOO_LARGE', 'A selected line exceeds the result limit; use search_files for bounded snippets', 0);
        const truncated = offset + count < lines.length;
        return toolOk(data(count), 0, truncated ? { truncated: true } : undefined);
      } catch {
        return toolError('PROJECT_FILE_READ_FAILED', 'Could not read this project file', 0);
      }
    },
  });

  const search = deps.searchProjectFiles;
  if (search) registry.register({
    name: 'search_files', operation: SEARCH_OPERATION, version: 1,
    description: 'Search textual files in the current run project, or an explicit visible unbound project for a headerless external credential, for a case-insensitive literal substring. Use pattern to narrow filenames. Results contain bounded snippets; truncated means refine the query or pattern.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    schema: z.object({ project: projectArgument, query: z.string().min(1).max(4096),
      pattern: z.string().min(1).max(4096).optional(), max: z.number().int().min(1).max(1000).default(200) }).strict(),
    handler: async (args, context) => {
      try {
        const access = await resolveProjectReadAccess(args.project, context, SEARCH_OPERATION, deps);
        if (!access.ok) return access.result;
        if (!access.current()) return denied();
        const result = await searchAuthorizedProjectFiles(access.project, deps.projectsRoot, args.query,
          { max: args.max, pattern: args.pattern }, search);
        if (!result.ok || !access.current()) return denied();
        const data = (count: number) => ({ projectId: access.projectId, query: args.query, matches: result.matches.slice(0, count) });
        const truncated = (count: number) => count < result.matches.length || result.matches.length >= args.max;
        let low = 0, high = result.matches.length, count = -1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (toolOkFitsUtf8Bytes(data(middle), truncated(middle), 1, RESULT_BYTES)) { count = middle; low = middle + 1; }
          else high = middle - 1;
        }
        if (count < 0) return toolError('SEARCH_WINDOW_TOO_LARGE', 'Search query exceeds the result limit', 0);
        return toolOk(data(count), 0, truncated(count) ? { truncated: true } : undefined);
      } catch {
        return toolError('PROJECT_FILE_SEARCH_FAILED', 'Could not search project files', 0);
      }
    },
  });
}

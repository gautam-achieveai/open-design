import path from 'node:path';
import type { ProjectMetadata } from '@open-design/contracts';
import { PREVIEW_URL_GUARD_MAX_HTML_BYTES } from '@open-design/contracts/runtime/preview-guards';
import { isProjectFileVersionPath } from '../project-file-versions.js';

type ReadableProject = { id: string; metadata?: ProjectMetadata | null };
export interface ProjectFileContent {
  buffer: Buffer;
  name: string;
  mime: string;
  size: number;
}
export type ReadProjectFile = (projectsRoot: string, projectId: string, relPath: string,
  metadata?: unknown) => Promise<ProjectFileContent>;
export interface ProjectSearchMatch { file: string; line: number; snippet: string }
export type SearchProjectFiles = (projectsRoot: string, projectId: string, query: string,
  options: { max: number; pattern: string | null | undefined; metadata: ProjectMetadata | null | undefined }) => Promise<ProjectSearchMatch[]>;

export function isRevokedProjectFileAccess(project: { metadata?: ProjectMetadata | null }): boolean {
  return Boolean((project.metadata as (ProjectMetadata & { teamMirrorRevokedAt?: unknown }) | null | undefined)?.teamMirrorRevokedAt);
}

/** Shared policy for plain raw reads after project read authorization. */
export async function readAuthorizedProjectFile(project: ReadableProject, projectsRoot: string,
  relPath: string, readProjectFile: ReadProjectFile): Promise<{ ok: true; file: ProjectFileContent } | { ok: false }> {
  if (isRevokedProjectFileAccess(project) || isProjectFileVersionPath(relPath)) return { ok: false };
  const file = await readProjectFile(projectsRoot, project.id, relPath, project.metadata);
  // Match the raw route: large HTML bypasses its preview transformation.
  const transformed = /^text\/html(?:;|$)/i.test(file.mime) && file.size <= PREVIEW_URL_GUARD_MAX_HTML_BYTES
    ? await maybeResolveVitePreviewHtml({ file, projectId: project.id, relPath,
      metadata: project.metadata, projectsRoot, readProjectFile }) : file.buffer;
  if (isRevokedProjectFileAccess(project)) return { ok: false };
  return { ok: true, file: { ...file, buffer: Buffer.isBuffer(transformed) ? transformed : Buffer.from(transformed) } };
}

/** Shared search policy; callers revalidate current project authority before disclosure. */
export async function searchAuthorizedProjectFiles(project: ReadableProject, projectsRoot: string,
  query: string, options: { max: number; pattern?: string | null | undefined },
  searchProjectFiles: SearchProjectFiles): Promise<{ ok: true; matches: ProjectSearchMatch[] } | { ok: false }> {
  if (isRevokedProjectFileAccess(project)) return { ok: false };
  const matches = await searchProjectFiles(projectsRoot, project.id, query,
    { max: options.max, pattern: options.pattern, metadata: project.metadata });
  if (isRevokedProjectFileAccess(project)) return { ok: false };
  return { ok: true, matches: matches.filter(match => !isProjectFileVersionPath(match.file)) };
}

export function isTextualProjectFile(mime: string): boolean {
  return /^text\//i.test(mime) || /^application\/(json|javascript|typescript|xml|x-(?:yaml|toml|httpd-php|sh))\b/i.test(mime)
    || /\+(?:json|xml)\b/i.test(mime) || /^image\/svg\+xml/i.test(mime);
}

/** The same raw HTML substitution used by browser previews and tool reads. */
export async function maybeResolveVitePreviewHtml({ file, projectId, relPath, metadata, projectsRoot, readProjectFile }: {
  file: { mime: string; buffer: Buffer };
  projectId: string;
  relPath: string;
  metadata?: unknown;
  projectsRoot: string;
  readProjectFile: (projectsRoot: string, projectId: string, relPath: string, metadata?: unknown) => Promise<{ buffer: Buffer }>;
}): Promise<Buffer | string> {
  if (!/^text\/html(?:;|$)/i.test(file.mime)) return file.buffer;
  const html = file.buffer.toString('utf8');
  if (!/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']\/src\/[^"']+["'][^>]*>\s*<\/script>/i.test(html)) return file.buffer;
  const ownerDir = path.posix.dirname(relPath);
  const distRelPath = ownerDir === '.' ? 'dist/index.html' : `${ownerDir}/dist/index.html`;
  try {
    const distFile = await readProjectFile(projectsRoot, projectId, distRelPath, metadata);
    return distFile.buffer.toString('utf8').replace(
      /\b(href|src)\s*=\s*(["'])\/assets\//gi,
      (_match, attr: string, quote: string) => `${attr}=${quote}dist/assets/`,
    );
  } catch {
    return file.buffer;
  }
}

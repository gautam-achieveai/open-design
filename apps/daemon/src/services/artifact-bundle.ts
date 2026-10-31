export type ArtifactBundleInclude = 'auto' | 'all' | 'shallow';
export const DEFAULT_ARTIFACT_BUNDLE_MAX_BYTES = 1_500_000;
const MAX_FILES = 200;
const MAX_DEPTH = 3;

export interface ArtifactBundleFile {
  name: string;
  mime: string;
  size: number | null;
  content: string | null;
  binary: boolean;
}
export interface ArtifactBundle {
  files: ArtifactBundleFile[];
  truncated: boolean;
  skippedFileCount: number;
}
export class ArtifactBundleBudgetExceededError extends Error {}
export class ArtifactBundleAccessError extends Error {}

/** Shared traversal. Adapters own project resolution, actual reads and result transport. */
export async function buildArtifactBundle(options: {
  entry: string;
  include: ArtifactBundleInclude;
  maxBytes: number;
  readFile: (name: string, remainingBytes: number) => Promise<ArtifactBundleFile>;
  listFiles: () => Promise<readonly { name: string }[]>;
  current?: () => boolean;
}): Promise<ArtifactBundle> {
  const assertCurrent = () => {
    if (options.current && !options.current()) throw new ArtifactBundleAccessError('project access denied');
  };
  const read = async (name: string, remainingBytes: number) => {
    assertCurrent();
    const file = await options.readFile(name, remainingBytes);
    assertCurrent();
    const bytes = !file.binary && typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : 0;
    if (bytes > remainingBytes) throw new ArtifactBundleBudgetExceededError(`file ${name} exceeds remaining budget`);
    return { file, bytes };
  };
  const files: ArtifactBundleFile[] = [];
  let usedBytes = 0, truncated = false, skippedFileCount = 0;
  const add = async (name: string) => {
    try {
      const result = await read(name, options.maxBytes - usedBytes);
      files.push(result.file);
      usedBytes += result.bytes;
      return result.file;
    } catch (error) {
      if (error instanceof ArtifactBundleAccessError) throw error;
      if (error instanceof ArtifactBundleBudgetExceededError) truncated = true;
      else skippedFileCount++;
      return null;
    }
  };
  if (options.include === 'all') {
    assertCurrent();
    const inventory = await options.listFiles();
    assertCurrent();
    for (const item of inventory) {
      if (files.length >= MAX_FILES || usedBytes >= options.maxBytes) { truncated = true; break; }
      await add(item.name);
    }
    return { files, truncated, skippedFileCount };
  }

  // The required entry must succeed; an empty bundle would hide a typo or
  // oversized entry. Apply its byte budget in both auto and shallow modes.
  const entry = await read(options.entry, options.maxBytes);
  files.push(entry.file);
  usedBytes += entry.bytes;
  if (options.include === 'shallow') return { files, truncated, skippedFileCount };
  const visited = new Set([options.entry]);
  let frontier = entry.file.binary ? [] : extractRelativeRefs(entry.file.content ?? '', options.entry, entry.file.mime);
  outer: for (let depth = 1; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const name of frontier) {
      if (visited.has(name)) continue;
      visited.add(name);
      if (files.length >= MAX_FILES || usedBytes >= options.maxBytes) { truncated = true; break outer; }
      const file = await add(name);
      if (!file || file.binary) continue;
      for (const ref of extractRelativeRefs(file.content ?? '', name, file.mime)) {
        if (!visited.has(ref)) next.push(ref);
      }
    }
    frontier = next;
  }
  return { files, truncated, skippedFileCount };
}

export function artifactBundlePayload(project: { id?: string; name?: string | null; metadata?: unknown }, entry: string, bundle: ArtifactBundle) {
  return { entryFile: entry, projectId: project.id, projectName: project.name,
    truncated: bundle.truncated, skippedFileCount: bundle.skippedFileCount,
    files: bundle.files.map(file => ({ name: file.name, mime: file.mime, size: file.size,
      binary: file.binary, content: file.binary ? null : file.content })), manifest: project.metadata ?? null };
}

const HTML_REF_PATTERNS = [
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<video\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<audio\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi,
];
const CSS_REF_PATTERNS = [
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
];
const JS_REF_PATTERNS = [
  /\bimport\s+[^'"]*?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const SRCSET_PATTERN = /\bsrcset=["']([^"']+)["']/gi;

function isJsLike(mime: string, fromPath: string): boolean {
  return /javascript|typescript/i.test(mime) || /\.(?:m?jsx?|tsx?|cjs)$/i.test(fromPath);
}
function isCssLike(mime: string, fromPath: string): boolean {
  return /^text\/css\b/i.test(mime) || /\.css$/i.test(fromPath);
}
function isHtmlLike(mime: string, fromPath: string): boolean {
  return /^text\/html\b/i.test(mime) || /\.html?$/i.test(fromPath);
}

/** Existing HTML/CSS/JS relative-reference rules, shared with the stdio adapter. */
export function extractRelativeRefs(text: string, fromPath: string, fromMime: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  const patterns: RegExp[] = [];
  if (isHtmlLike(fromMime, fromPath)) patterns.push(...HTML_REF_PATTERNS, ...CSS_REF_PATTERNS);
  if (isCssLike(fromMime, fromPath)) patterns.push(...CSS_REF_PATTERNS);
  if (isJsLike(fromMime, fromPath)) patterns.push(...JS_REF_PATTERNS);
  if (patterns.length === 0) patterns.push(...CSS_REF_PATTERNS);
  const candidates: string[] = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const ref = (match[1] ?? '').trim();
    if (ref) candidates.push(ref);
  }
  if (isHtmlLike(fromMime, fromPath)) for (const match of text.matchAll(SRCSET_PATTERN)) {
    for (const part of (match[1] ?? '').split(',')) {
      const ref = part.trim().split(/\s+/)[0];
      if (ref) candidates.push(ref);
    }
  }
  for (const raw of candidates) {
    if (/^(?:https?:|\/\/|data:|mailto:|tel:|#)/i.test(raw)) continue;
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
    const resolved = raw.startsWith('/') ? raw.slice(1) : dir + raw;
    const segments = resolved.replace(/[?#].*$/, '').split('/').filter(Boolean);
    const normalized: string[] = [];
    let escaped = false;
    for (const segment of segments) {
      if (segment === '.') continue;
      if (segment === '..') {
        if (normalized.length === 0) { escaped = true; break; }
        normalized.pop();
      } else normalized.push(segment);
    }
    if (!escaped && normalized.length > 0) refs.add(normalized.join('/'));
  }
  return [...refs];
}

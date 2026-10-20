// Git hygiene for imported-folder projects (project metadata.baseDir set).
//
// An imported folder is the user's own directory — very often a real code
// repository the user also develops in with other tools. Two things follow:
//
//   1. Anything the daemon stages into that directory for the agent
//      (`.od-skills/`, `.od-frames/`) must not show up as untracked changes in
//      the user's `git status`. We record those names in the repository's
//      local, uncommitted `info/exclude` — never in the tracked `.gitignore`.
//   2. The project file listing should reflect the files the user considers
//      part of the repo, so paths git ignores (build output, caches, local
//      env dirs) are left out of it.
//
// Both helpers are fail-soft: a missing git binary, an unreadable git dir, or
// a folder that is not a work tree degrades to the previous behavior instead
// of breaking a run or a listing.

import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { OD_NEXT_DEVICE_FRAME_ROOT } from '@open-design/contracts';
import { SKILLS_CWD_ALIAS } from './cwd-aliases.js';

export const OD_STAGING_GIT_EXCLUDE_MARKER = '# OpenDesign staging (local, not committed)';

/**
 * Top-level directories the daemon stages into a project cwd. Patterns carry
 * no leading slash so they also match when the imported folder is a
 * subdirectory of the repository rather than its root.
 */
export const OD_STAGING_GIT_EXCLUDE_PATTERNS: readonly string[] = [
  `${SKILLS_CWD_ALIAS}/`,
  `${OD_NEXT_DEVICE_FRAME_ROOT}/`,
];

export type OdStagingGitExcludeResult =
  | { status: 'not-git' }
  | { status: 'present'; excludePath: string }
  | { status: 'added'; excludePath: string; added: string[] }
  | { status: 'failed'; reason: string };

/**
 * Locate the `info/exclude` file git consults for `cwd`, or null when `cwd`
 * is not inside a git work tree. Walks up from `cwd` to the nearest `.git`
 * entry: a directory is the git dir itself; a file (`gitdir: <path>`, used by
 * linked worktrees and submodules) points at it. A linked worktree's private
 * git dir names the shared repository through `commondir`, and `info/exclude`
 * lives in that shared directory — which is the file git actually reads.
 */
export async function resolveGitInfoExcludePath(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const st = await lstat(dotGit).catch((err) => {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    });
    if (st?.isDirectory()) return path.join(dotGit, 'info', 'exclude');
    if (st?.isFile()) {
      const raw = await readFile(dotGit, 'utf8');
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(raw)?.[1];
      if (!pointer) throw new Error(`unrecognized .git file at ${dotGit}`);
      const gitDir = path.resolve(dir, pointer);
      const commonDir = await readFile(path.join(gitDir, 'commondir'), 'utf8')
        .then((value) => path.resolve(gitDir, value.trim()))
        .catch((err) => {
          if (err && err.code === 'ENOENT') return gitDir;
          throw err;
        });
      return path.join(commonDir, 'info', 'exclude');
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Invariant: after this resolves, when `cwd` sits inside a git work tree,
 * that repository's local `info/exclude` contains every pattern in
 * {@link OD_STAGING_GIT_EXCLUDE_PATTERNS} exactly once under the OpenDesign
 * marker, so the daemon's staged directories never appear in `git status`.
 *
 * The file is only ever appended to — existing lines, including the user's
 * own excludes, are never rewritten or reordered — and a pattern already
 * present (anywhere in the file) is not added again. The tracked `.gitignore`
 * is never touched. Never throws: every failure is reported through `warn`
 * and the result, because a run must not fail over git bookkeeping.
 */
export async function ensureOdStagingGitExcluded(
  cwd: string,
  warn: (message: string) => void = () => {},
): Promise<OdStagingGitExcludeResult> {
  try {
    const excludePath = await resolveGitInfoExcludePath(cwd);
    if (!excludePath) return { status: 'not-git' };
    const existing = await readFile(excludePath, 'utf8').catch((err) => {
      if (err && err.code === 'ENOENT') return '';
      throw err;
    });
    const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missing = OD_STAGING_GIT_EXCLUDE_PATTERNS.filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return { status: 'present', excludePath };
    const block = [
      ...(lines.has(OD_STAGING_GIT_EXCLUDE_MARKER) ? [] : [OD_STAGING_GIT_EXCLUDE_MARKER]),
      ...missing,
    ];
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await mkdir(path.dirname(excludePath), { recursive: true });
    await appendFile(excludePath, `${separator}${block.join('\n')}\n`, 'utf8');
    return { status: 'added', excludePath, added: missing };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[od] git exclude for OpenDesign staging skipped: ${reason}`);
    return { status: 'failed', reason };
  }
}

export interface GitIgnoredPaths {
  /** Ignored directories, relative to the listed root, posix, no trailing slash. */
  dirs: Set<string>;
  /** Ignored files, relative to the listed root, posix. */
  files: Set<string>;
}

const GIT_LIST_TIMEOUT_MS = 5000;
const GIT_LIST_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Ask git which untracked paths under `dir` its exclude rules ignore
 * (`.gitignore`, `info/exclude`, `core.excludesFile`). Whole ignored
 * directories come back collapsed (`build/`), so the output stays small even
 * when they hold thousands of files, and tracked files are never reported —
 * a force-added file inside an ignored directory keeps its directory visible.
 *
 * Returns null — meaning "list the tree as before" — when `dir` is not in a
 * work tree, git is missing, the command fails or times out, or `dir` itself
 * is ignored (the user explicitly imported it, so hiding everything in it
 * would be wrong).
 */
export function listGitIgnoredPaths(dir: string): Promise<GitIgnoredPaths | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: GIT_LIST_TIMEOUT_MS,
        maxBuffer: GIT_LIST_MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const ignored: GitIgnoredPaths = { dirs: new Set(), files: new Set() };
        for (const entry of stdout.split('\0')) {
          if (!entry) continue;
          if (entry === './') {
            resolve(null);
            return;
          }
          if (entry.endsWith('/')) ignored.dirs.add(entry.slice(0, -1));
          else ignored.files.add(entry);
        }
        resolve(ignored);
      },
    );
  });
}

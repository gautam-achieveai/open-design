import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OD_STAGING_GIT_EXCLUDE_MARKER,
  ensureOdStagingGitExcluded,
} from '../src/imported-repo-git.js';
import { listFiles, listProjectFolders } from '../src/projects.js';

const tempRoots: string[] = [];

async function makeTemp(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureOdStagingGitExcluded', () => {
  it('creates info/exclude under the marker, idempotently, and git honors it', async () => {
    const repo = await makeTemp('od-git-exclude-');
    git(repo, 'init', '-q');
    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    await rm(excludePath, { force: true });
    await writeTree(repo, {
      '.od-skills/skill-abc/SKILL.md': 'x',
      '.od-frames/iphone.html': 'x',
      'index.html': 'x',
    });

    const first = await ensureOdStagingGitExcluded(repo);
    const second = await ensureOdStagingGitExcluded(repo);

    expect(first).toEqual({ status: 'added', excludePath, added: ['.od-skills/', '.od-frames/'] });
    expect(second).toEqual({ status: 'present', excludePath });
    expect(await readFile(excludePath, 'utf8')).toBe(
      `${OD_STAGING_GIT_EXCLUDE_MARKER}\n.od-skills/\n.od-frames/\n`,
    );
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('?? index.html\n');
    expect(await readFile(path.join(repo, '.gitignore'), 'utf8').catch(() => null)).toBeNull();
  });

  it('appends after existing user lines without rewriting them or duplicating patterns', async () => {
    const repo = await makeTemp('od-git-exclude-');
    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    await writeTree(repo, { '.git/info/exclude': '# mine\n*.local\n.od-frames/' });

    const result = await ensureOdStagingGitExcluded(repo);

    expect(result).toEqual({ status: 'added', excludePath, added: ['.od-skills/'] });
    expect(await readFile(excludePath, 'utf8')).toBe(
      `# mine\n*.local\n.od-frames/\n${OD_STAGING_GIT_EXCLUDE_MARKER}\n.od-skills/\n`,
    );
  });

  it('resolves a worktree .git file through commondir to the shared exclude', async () => {
    const root = await makeTemp('od-git-exclude-');
    const common = path.join(root, 'main', '.git');
    const worktreeGitDir = path.join(common, 'worktrees', 'wt');
    const worktree = path.join(root, 'wt');
    await writeTree(root, {
      'main/.git/HEAD': 'ref: refs/heads/main\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
      'wt/.git': `gitdir: ${worktreeGitDir}\n`,
    });

    const result = await ensureOdStagingGitExcluded(path.join(worktree));

    expect(result).toMatchObject({ status: 'added', excludePath: path.join(common, 'info', 'exclude') });
    expect(await readFile(path.join(common, 'info', 'exclude'), 'utf8')).toContain('.od-skills/\n');
  });

  it('finds the repository from an imported subfolder', async () => {
    const repo = await makeTemp('od-git-exclude-');
    await writeTree(repo, { '.git/HEAD': 'ref: refs/heads/main\n', 'apps/site/index.html': 'x' });

    const result = await ensureOdStagingGitExcluded(path.join(repo, 'apps', 'site'));

    expect(result).toMatchObject({ status: 'added', excludePath: path.join(repo, '.git', 'info', 'exclude') });
  });

  it('is a no-op outside a git work tree', async () => {
    const dir = await makeTemp('od-git-exclude-');

    expect(await ensureOdStagingGitExcluded(dir)).toEqual({ status: 'not-git' });
  });

  it('warns instead of throwing when the git dir cannot be used', async () => {
    const repo = await makeTemp('od-git-exclude-');
    // An unparseable .git file stands in for any unreadable git dir.
    await writeTree(repo, { '.git': 'not a gitdir pointer\n' });
    const warnings: string[] = [];

    const result = await ensureOdStagingGitExcluded(repo, (msg) => warnings.push(msg));

    expect(result.status).toBe('failed');
    expect(warnings).toEqual([expect.stringContaining('git exclude for OpenDesign staging skipped')]);
  });
});

describe('listFiles / listProjectFolders on an imported git work tree', () => {
  async function makeImportedRepo() {
    const repo = await makeTemp('od-git-list-');
    git(repo, 'init', '-q');
    await writeTree(repo, {
      '.gitignore': 'build/\n*.log\n',
      'tracked.html': 't',
      'untracked.html': 'u',
      'debug.log': 'l',
      'build/out.html': 'b',
      'src/app.ts': 's',
    });
    await mkdir(path.join(repo, 'empty-folder'));
    git(repo, 'add', '.gitignore', 'tracked.html', 'src/app.ts');
    return repo;
  }

  it('omits git-ignored paths and keeps tracked plus untracked files, newest first', async () => {
    const repo = await makeImportedRepo();
    const metadata = { baseDir: repo };

    const files = await listFiles(path.join(repo, 'unused-projects-root'), 'p1', { metadata });
    const folders = await listProjectFolders(path.join(repo, 'unused-projects-root'), 'p1', { metadata });

    expect(files.map((f) => f.name).sort()).toEqual(['src/app.ts', 'tracked.html', 'untracked.html']);
    const mtimes = files.map((f) => f.mtime);
    expect(mtimes).toEqual([...mtimes].sort((a, b) => b - a));
    expect(files[0]).toEqual(expect.objectContaining({ type: 'file', localPath: expect.any(String) }));
    // Empty folders are not ignored by git, so a folder the user just
    // created in the file panel stays visible.
    expect(folders.map((f) => f.name)).toEqual(['empty-folder', 'src']);
  });

  it('falls back to the plain walk when the imported folder itself is git-ignored', async () => {
    const repo = await makeImportedRepo();

    const files = await listFiles(path.join(repo, 'x'), 'p1', { metadata: { baseDir: path.join(repo, 'build') } });

    expect(files.map((f) => f.name)).toEqual(['out.html']);
  });

  it('leaves managed projects unfiltered even when they sit inside a git repo', async () => {
    const repo = await makeImportedRepo();
    const projectsRoot = path.join(repo, 'build', 'projects');
    await writeTree(projectsRoot, { 'p1/index.html': 'i', 'p1/debug.log': 'l' });

    const files = await listFiles(projectsRoot, 'p1');

    expect(files.map((f) => f.name).sort()).toEqual(['debug.log', 'index.html']);
  });
});


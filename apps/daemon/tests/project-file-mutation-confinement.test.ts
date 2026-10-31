import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeProjectFile } from '../src/projects.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('confines prospective targets of dangling symlinks while preserving in-root links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'od-dangling-write-'));
  roots.push(root);
  const project = path.join(root, 'p');
  await mkdir(project);
  const outside = path.join(root, 'outside.txt');
  await symlink(outside, path.join(project, 'outside-alias.txt'), 'file');
  await expect(writeProjectFile(root, 'p', 'outside-alias.txt', Buffer.from('outside-marker'))).rejects.toMatchObject({ code: 'EPATHESCAPE' });
  await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  const inside = path.join(project, 'inside.txt');
  await symlink(inside, path.join(project, 'inside-alias.txt'), 'file');
  let canonicalPath: string | undefined;
  await writeProjectFile(root, 'p', 'inside-alias.txt', Buffer.from('inside'), {
    mutationHooks: { contentCommitted: value => { canonicalPath = value.path; } },
  });
  expect(await readFile(inside, 'utf8')).toBe('inside');
  expect(canonicalPath).toBe('inside.txt');
});

it('does not overwrite a file created after the initial no-overwrite check', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'od-create-collision-'));
  roots.push(root);
  const project = path.join(root, 'p');
  await mkdir(project);
  const target = path.join(project, 'artifact.txt');
  let appeared = false;
  await expect(writeProjectFile(root, 'p', 'artifact.txt', Buffer.from('loser'), { overwrite: false,
    mutationHooks: { beforeMutation: () => {
      if (!appeared) { appeared = true; writeFileSync(target, 'winner'); }
    } },
  })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(target, 'utf8')).toBe('winner');
});

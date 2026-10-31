import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runVelaCommandMock } = vi.hoisted(() => ({ runVelaCommandMock: vi.fn() }));
vi.mock('../../src/integrations/vela-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/integrations/vela-command.js')>(),
  runVelaCommand: runVelaCommandMock,
}));
import { generateMedia } from '../../src/media/index.js';

describe('retired Cloud media models', () => {
  let root: string;
  let projectDir: string;
  beforeEach(async () => {
    runVelaCommandMock.mockReset();
    root = await mkdtemp(path.join(os.tmpdir(), 'od-vela-media-test-'));
    projectDir = path.join(root, 'projects', 'project-1');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'reference.png'), 'original reference');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['image', 'vela/gpt-image-2'],
    ['image', 'nano-banana'],
    ['image', 'codex-gpt-image-2'],
    ['video', 'vela/doubao-seedance-2-0-260128'],
  ] as const)('rejects %s model %s without launching Cloud or changing project bytes', async (surface, model) => {
    vi.stubEnv('OD_MEDIA_ALLOW_STUBS', '1');
    vi.stubEnv('OD_MEDIA_MODEL_ALIASES', JSON.stringify({ [model]: 'retired-tenant-alias' }));
    await expect(generateMedia({
      projectRoot: root, projectsRoot: path.join(root, 'projects'), projectId: 'project-1',
      prompt: 'Synthetic media request', surface, model, output: 'output.bin', image: 'reference.png',
    })).rejects.toThrow('unknown model: ' + model);
    expect(runVelaCommandMock).not.toHaveBeenCalled();
    expect(await readdir(projectDir)).toEqual(['reference.png']);
    expect(await readFile(path.join(projectDir, 'reference.png'), 'utf8')).toBe('original reference');
  });
});

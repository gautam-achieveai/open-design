import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const clipper = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(clipper, 'manifest.json'), 'utf8')) as {
  manifest_version: number;
  background: { service_worker?: string; scripts?: string[] };
};

test('unpacked Chromium manifest has no Firefox-only background scripts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal('scripts' in manifest.background, false);
});

test('Firefox manifest retains the same extension except for the background runtime', () => {
  const firefox = JSON.parse(readFileSync(join(clipper, 'manifest.firefox.json'), 'utf8')) as typeof manifest;
  assert.deepEqual(firefox.background, { scripts: ['background.js'] });
  assert.deepEqual({ ...firefox, background: manifest.background }, manifest);
});

import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = import.meta.dirname;
const destination = process.argv[2] ? resolve(process.argv[2]) : null;
if (!destination || existsSync(destination)) {
  console.error('Usage: pnpm exec tsx clipper/prepare-firefox.ts <new-output-directory>');
  process.exitCode = 1;
} else {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === 'tests' || name === 'store' || name === 'prepare-firefox.ts'
      || name === 'manifest.firefox.json') continue;
    cpSync(join(source, name), join(destination, name), { recursive: true });
  }
  copyFileSync(join(source, 'manifest.firefox.json'), join(destination, 'manifest.json'));
  console.log(`Firefox extension ready at ${destination}`);
}

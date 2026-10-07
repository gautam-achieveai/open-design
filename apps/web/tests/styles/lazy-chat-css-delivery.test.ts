import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceFile, isImportDeclaration, isStringLiteral, ScriptTarget } from 'typescript';
import { describe, expect, it } from 'vitest';

const layoutPath = fileURLToPath(new URL('../../app/layout.tsx', import.meta.url));
const layout = createSourceFile(layoutPath, readFileSync(layoutPath, 'utf8'), ScriptTarget.Latest);
const routeStylesheets = new Set<string>();
for (const statement of layout.statements) {
  if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue;
  const path = statement.moduleSpecifier.text;
  if (path.endsWith('.css')) routeStylesheets.add(resolve(dirname(layoutPath), path));
}

describe('client-only chat stylesheet delivery', () => {
  // ClientApp dynamically imports App with ssr:false. The lazy module's CSS
  // can remain preload-only after HMR, so these visible chat surfaces must
  // follow the existing root-route stylesheet ownership pattern. DOM tests
  // load modules independently and cannot detect an omitted route stylesheet.
  it.each([
    ['chat theme seam', 'chat/ChatRoot.module.css'],
    ['annotation draft cards', 'chat/BrowserAnnotationDraftCard.module.css'],
    ['execution record and icon layout', 'chat/primitives/record.module.css'],
    ['next-step suggestions and their arrow sizing', 'NextStepActions.module.css'],
  ])('loads %s before the lazy App mounts', (_surface, stylesheet) => {
    const requiredPath = fileURLToPath(new URL(`../../src/components/${stylesheet}`, import.meta.url));
    expect(routeStylesheets.has(requiredPath)).toBe(true);
  });
});

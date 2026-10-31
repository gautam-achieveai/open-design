import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const overlayStyles = readFileSync(
  resolve(process.cwd(), 'src/components/HoverTouchpointOverlay.module.css'),
  'utf8',
);

describe('HoverTouchpointOverlay host positioning', () => {
  it('keeps the hover entry positioned relative to its host', () => {
    const entryRuleStart = overlayStyles.indexOf('.entry {');
    const entryRuleEnd = overlayStyles.indexOf('}', entryRuleStart);
    const entryRule = overlayStyles.slice(entryRuleStart, entryRuleEnd);
    expect(entryRule).toContain('position: relative');
    expect(entryRule).not.toContain('bottom:');
    expect(entryRule).not.toContain('right:');
    expect(entryRule).not.toContain('position: fixed');
  });
});

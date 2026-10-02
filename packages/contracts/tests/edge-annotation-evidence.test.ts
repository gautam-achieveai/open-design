import { describe, expect, it } from 'vitest';
import {
  normalizeEdgeAnnotationScope,
  normalizeEdgeAnnotationAncestors,
  normalizeEdgeAnnotationStyle,
  normalizeEdgeAnnotationText,
} from '../src/api/edge-annotations.js';

describe('optional browser annotation evidence', () => {
  it('normalizes bounded frame/root scope without persisting browser document identity', () => {
    const scope = { frame: 'child', url: 'https://child.example.test/frame', selectorRoot: 'open-shadow',
      shadowHosts: ['body > x-card', 'section > x-button'], screenshot: 'not-supported' };
    expect(normalizeEdgeAnnotationScope({ ...scope, documentId: 'private-browser-identity', unknown: 'discard' })).toEqual(scope);
    expect(normalizeEdgeAnnotationScope({ ...scope, shadowHosts: Array(9).fill('x-host') })).toBeUndefined();
    expect(normalizeEdgeAnnotationScope({ ...scope, shadowHosts: ['<private>'] })).toBeUndefined();
    expect(normalizeEdgeAnnotationScope({ ...scope, url: 'https://child.test/?access_token=private' })).toBeUndefined();
    expect(normalizeEdgeAnnotationScope({ ...scope, selectorRoot: 'document' })).toBeUndefined();
    expect(normalizeEdgeAnnotationScope({ ...scope, url: 'about:blank' })).toBeUndefined();
  });
  it('bounds ordinary copy and drops credential assignments without blocking a note', () => {
    expect(normalizeEdgeAnnotationText('Use <Enter> to save\nnow', 300)).toBe('Use Enter to save now');
    expect(normalizeEdgeAnnotationText('Password: increase contrast', 300)).toBe('Password: increase contrast');
    expect(normalizeEdgeAnnotationText('token=private-value', 300)).toBe('');
    expect(normalizeEdgeAnnotationText('A'.repeat(400), 300)).toHaveLength(300);
    expect(normalizeEdgeAnnotationText(undefined, 300)).toBe('');
    expect(normalizeEdgeAnnotationText('main\n  button Save', 1200, true)).toBe('main\n  button Save');
  });

  it('retains only safe measured styles, including quoted font families', () => {
    expect(normalizeEdgeAnnotationStyle({
      color: 'rgb(10, 20, 30)', fontFamily: '"Segoe UI", sans-serif',
      unknown: 'private', backgroundColor: 'url(<private>)', fontSize: 123,
    })).toEqual({ color: 'rgb(10, 20, 30)', fontFamily: '"Segoe UI", sans-serif' });
    expect(normalizeEdgeAnnotationStyle({ fontFamily: 'token=private-value' })).toEqual({});
    expect(normalizeEdgeAnnotationStyle(null)).toEqual({});
    expect(normalizeEdgeAnnotationStyle([])).toEqual({});
  });

  it('bounds and filters optional ancestor metadata', () => {
    const ancestors = [null, ...Array(10).fill({ tag: 'main', selector: 'main' })];
    expect(normalizeEdgeAnnotationAncestors(ancestors)).toHaveLength(7);
    expect(normalizeEdgeAnnotationAncestors({})).toEqual([]);
    expect(normalizeEdgeAnnotationAncestors([{ tag: 'div', selector: '<private>' }])).toEqual([]);
  });
});

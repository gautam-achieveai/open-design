import { describe, expect, it } from 'vitest';
import { projectPluginCatalog } from '../src/services/plugin-catalog.js';

describe('plugin catalog shared projection', () => {
  it('preserves legacy missing and malformed manifest fallbacks', () => {
    const records = [null, {}, { id: 'missing', title: 'fallback' }, { id: 'null', manifest: null },
      { id: 'number', manifest: 17 }, { id: 'od-null', manifest: { title: 'title', od: null } },
      { id: 'nested', title: 'outer', fsPath: 'private-path', manifest: { title: 'inner', description: 'desc', tags: ['x', 42], od: { taskKind: 'primary', kind: 'secondary' } } },
      { id: 'odd', manifest: { title: '', description: 3, tags: 'not-array', od: { taskKind: 4, kind: 'fallback' } } }];
    const serialized = JSON.parse(JSON.stringify(projectPluginCatalog(records)));
    expect(serialized).toEqual([{}, {}, { id: 'missing', title: 'fallback' }, { id: 'null', title: 'null' },
      { id: 'number', title: 'number' }, { id: 'od-null', title: 'title' },
      { id: 'nested', title: 'inner', description: 'desc', kind: 'primary', tags: ['x', 42] },
      { id: 'odd', title: '' }]);
    expect(JSON.stringify(serialized)).not.toContain('private-path');
  });
});

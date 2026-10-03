import { describe, expect, it } from 'vitest';

import {
  mergeRunContextSelections,
  normalizeWorkspaceContextItems,
  renderRunContextPrompt,
} from '../../src/runtimes/chat-run-context.js';

describe('chat run context helpers', () => {
  it('discovers the daemon browser broker before inspecting the selected tab', () => {
    const prompt = renderRunContextPrompt({ workspaceItems: [
      { kind: 'browser', id: 'browser-ref', tabId: 'tab-selected', label: 'Example', url: 'https://example.com' },
    ] }, {});
    expect(prompt).toContain('browser tabs --project "$OD_PROJECT_ID" --json');
    expect(prompt).toContain('browser snapshot --project "$OD_PROJECT_ID" --tab <selected-tab-id> --json');
    expect(prompt).toContain('tab: `tab-selected`');
    expect(prompt).toContain('do not switch to another tab');
    expect(prompt).toContain('Do not launch a separate browser or attach through remote CDP');
    expect(prompt).not.toContain('If only URL/title context is available and no inspection tool is mounted');
    const withoutTab = renderRunContextPrompt({ workspaceItems: [
      { kind: 'browser', id: 'context-only', label: 'Example', url: 'https://example.com' },
    ] }, {});
    expect(withoutTab).toContain('confirm the intended tab');
    expect(withoutTab).not.toContain('--tab "context-only"');
  });

  it('normalizes workspace context items and dedupes by kind/id', () => {
    expect(normalizeWorkspaceContextItems([
      { kind: 'browser', id: ' tab-1 ', label: ' Docs ', url: ' https://example.com/docs ' },
      { kind: 'browser', id: 'tab-1', label: 'Duplicate' },
      { kind: 'unknown', id: 'x', label: 'Ignored' },
      { kind: 'file', id: 'file-1', label: 'App', path: 'src/app.ts' },
      null,
    ])).toEqual([
      {
        kind: 'browser',
        id: 'tab-1',
        label: 'Docs',
        url: 'https://example.com/docs',
      },
      {
        kind: 'file',
        id: 'file-1',
        label: 'App',
        path: 'src/app.ts',
      },
    ]);
  });

  it('merges project metadata context before per-run context without duplicate ids', () => {
    expect(mergeRunContextSelections(
      { pluginIds: ['brand-kit'], connectorIds: ['figma'] },
      { pluginIds: ['brand-kit', 'motion'], mcpServerIds: ['browser'] },
    )).toEqual({
      pluginIds: ['brand-kit', 'motion'],
      mcpServerIds: ['browser'],
      connectorIds: ['figma'],
    });
  });

  it('renders selected workspace and connector context for the agent prompt', () => {
    const prompt = renderRunContextPrompt(
      {
        workspaceItems: [
          {
            kind: 'terminal',
            id: 'term-1',
            label: 'Dev server',
            tabId: 'terminal-tab',
          },
        ],
        connectorIds: ['figma'],
      },
      {
        contextConnectors: [
          {
            id: 'figma',
            name: 'Figma',
            provider: 'figma',
            status: 'connected',
          },
        ],
      },
    );

    expect(prompt).toContain('## Selected run context');
    expect(prompt).toContain('terminal: Dev server (`term-1`)');
    expect(prompt).toContain('Selected connectors');
    expect(prompt).toContain('- Figma (`figma`)');
  });
});

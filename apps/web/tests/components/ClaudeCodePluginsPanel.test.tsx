// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCodePluginsResponse } from '@open-design/contracts';

import {
  ClaudeCodePluginsList,
  ClaudeCodePluginsPanel,
} from '../../src/components/ClaudeCodePluginsPanel';

afterEach(() => {
  cleanup();
});

const fixture: ClaudeCodePluginsResponse = {
  available: true,
  configDir: '/home/u/.claude',
  marketplaces: [
    { name: 'claude-plugins-official', sourceKind: 'github', sourceLabel: 'anthropics/claude-plugins-official' },
    { name: 'gb-plugins-marketplace', sourceKind: 'directory', sourceLabel: 'B:\\sources\\claude_plugins' },
  ],
  plugins: [
    {
      id: 'development@gb-plugins-marketplace',
      name: 'development',
      marketplace: 'gb-plugins-marketplace',
      version: '2.1.1',
      enabled: true,
      installPath: '/home/u/.claude/plugins/cache/gb/development/2.1.1',
      description: 'Dev workflows',
      skills: [
        { name: 'agile-development', description: 'Team mode' },
        { name: 'brainstorming' },
      ],
      commands: ['work-on'],
      agents: ['architect', 'critic'],
    },
    {
      id: 'cc-plugin@builtin',
      name: 'cc-plugin',
      marketplace: 'builtin',
      enabled: false,
      skills: [],
      commands: [],
      agents: [],
    },
  ],
  warnings: ['gone@x: install path not found (/nope)'],
};

describe('ClaudeCodePluginsList', () => {
  it('lists marketplaces and plugins with enabled state, version, and counts', () => {
    render(<ClaudeCodePluginsList data={fixture} />);

    expect(screen.getByText('anthropics/claude-plugins-official')).toBeTruthy();
    expect(screen.getByText('Plugins (1/2 enabled)')).toBeTruthy();

    const dev = screen.getByTestId('claude-code-plugin-development@gb-plugins-marketplace');
    expect(within(dev).getByText('Enabled')).toBeTruthy();
    expect(within(dev).getByText('v2.1.1')).toBeTruthy();
    expect(within(dev).getByText('Skills 2 · Commands 1 · Agents 2')).toBeTruthy();
    expect(within(dev).getByText('Skills (2)')).toBeTruthy();
    expect(within(dev).getByText('agile-development')).toBeTruthy();

    const builtin = screen.getByTestId('claude-code-plugin-cc-plugin@builtin');
    expect(within(builtin).getByText('Disabled')).toBeTruthy();
    expect(within(builtin).getByText('Not installed')).toBeTruthy();
    expect(within(builtin).queryByText(/^Skills \(/)).toBeNull();

    expect(screen.getByText('Warnings (1)')).toBeTruthy();
  });

  it('shows the unavailable state with the config dir', () => {
    render(
      <ClaudeCodePluginsList
        data={{ available: false, configDir: '/home/u/.claude', marketplaces: [], plugins: [], warnings: [] }}
      />,
    );
    expect(screen.getByTestId('claude-code-plugins-unavailable').textContent).toBe(
      'No Claude Code plugins found in /home/u/.claude.',
    );
  });

  it('shows the empty state when the registry has no plugins', () => {
    render(<ClaudeCodePluginsList data={{ ...fixture, plugins: [], warnings: [] }} />);
    expect(screen.getByText('Claude Code has no plugins installed.')).toBeTruthy();
    expect(screen.getByText('Plugins (0/0 enabled)')).toBeTruthy();
  });
});

describe('ClaudeCodePluginsPanel', () => {
  it('renders the loaded inventory', async () => {
    render(<ClaudeCodePluginsPanel load={async () => ({ ok: true, data: fixture })} />);
    expect(await screen.findByText('Plugins (1/2 enabled)')).toBeTruthy();
  });

  it('shows a load failure and retries on demand', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'HTTP 500: boom' })
      .mockResolvedValueOnce({ ok: true, data: fixture });
    render(<ClaudeCodePluginsPanel load={load} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not read Claude Code plugins: HTTP 500: boom');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Plugins (1/2 enabled)')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

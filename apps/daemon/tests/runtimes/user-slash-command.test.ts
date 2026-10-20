import { describe, expect, it } from 'vitest';

import {
  renderUserSlashCommandNote,
  userSlashCommandName,
} from '../../src/runtimes/user-slash-command.js';

describe('user slash commands', () => {
  it('names the command a turn starts with, keeping plugin-scoped names', () => {
    expect(userSlashCommandName('/review the auth module')).toBe('review');
    expect(userSlashCommandName('  /code-reviewer:pr-review')).toBe('code-reviewer:pr-review');
  });

  it('ignores paths, mid-text slashes, and OpenDesign’s own composer commands', () => {
    for (const text of ['/Users/me/repo is slow', 'please run /review', '/search cats', '/MCP', '/hatch', '/', null]) {
      expect(userSlashCommandName(text)).toBeNull();
    }
  });

  it('adds no note to a turn without a command, so its body stays byte-identical', () => {
    expect(renderUserSlashCommandNote('make the header sticky')).toBe('');
  });

  it('tells the agent to load the named skill and pass the rest as arguments', () => {
    const note = renderUserSlashCommandNote('/review auth');
    expect(note).toContain('`/review`');
    expect(note).toContain('skill tool');
  });
});

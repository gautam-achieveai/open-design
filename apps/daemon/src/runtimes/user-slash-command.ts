/**
 * A turn the user starts with `/name` asks for one of their own agent skills or
 * commands — the same thing typing it in the agent CLI's own prompt does.
 *
 * The daemon never sends the user's words first: they sit under the composed
 * `# Instructions` block, so the CLI's own slash-command parsing does not see
 * them. This note restores the intent in words every agent can act on. The
 * composer's own commands (`/search`, `/mcp`, `/hatch`) are handled by
 * OpenDesign before or around the agent and are left alone.
 *
 * Invariant: a turn that does not start with a user slash command yields no
 * note, so the composed body stays byte-identical for every other turn.
 */
const OPENDESIGN_COMPOSER_COMMANDS = new Set(['search', 'mcp', 'hatch']);

// `/name` followed by whitespace or the end. A path such as `/Users/me/x`
// does not match: the name stops at the second `/`, which is neither.
const SLASH_COMMAND = /^\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/;

export function userSlashCommandName(turnText: unknown): string | null {
  if (typeof turnText !== 'string') return null;
  const match = SLASH_COMMAND.exec(turnText.trimStart());
  if (!match) return null;
  const name = match[1]!;
  return OPENDESIGN_COMPOSER_COMMANDS.has(name.toLowerCase()) ? null : name;
}

export function renderUserSlashCommandNote(turnText: unknown): string {
  const name = userSlashCommandName(turnText);
  if (!name) return '';
  return `The user started this turn with the slash command \`/${name}\`. It names one of their own installed skills or commands: load it with your skill tool first, pass the text after the command as its arguments, and follow it. If no skill or command by that name exists, say so and handle the turn as plain text.`;
}

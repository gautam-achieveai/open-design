// Read-only view of the Claude Code plugins installed in the user's Claude
// config dir. Claude Code loads these itself when OpenDesign spawns `claude`;
// OpenDesign only surfaces them. Nothing here installs, copies, or edits them.

export type ClaudeCodeMarketplaceSourceKind = 'github' | 'git' | 'directory' | 'url' | 'unknown';

export interface ClaudeCodeMarketplaceSummary {
  name: string;
  sourceKind: ClaudeCodeMarketplaceSourceKind;
  /** Human-readable source: `owner/repo`, a git URL, a folder path, or a URL. */
  sourceLabel: string;
}

export interface ClaudeCodePluginSkillSummary {
  name: string;
  description?: string;
}

export interface ClaudeCodePluginSummary {
  /** `<plugin>@<marketplace>`, the key Claude Code uses in settings.json. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  /** `settings.json` `enabledPlugins[id] === true`. */
  enabled: boolean;
  installPath?: string;
  description?: string;
  skills: ClaudeCodePluginSkillSummary[];
  commands: string[];
  agents: string[];
}

export interface ClaudeCodePluginsResponse {
  /** False when the Claude config dir has no plugin registry to read. */
  available: boolean;
  configDir: string;
  marketplaces: ClaudeCodeMarketplaceSummary[];
  plugins: ClaudeCodePluginSummary[];
  /** Non-fatal problems: malformed files, missing install dirs, caps hit. */
  warnings: string[];
}

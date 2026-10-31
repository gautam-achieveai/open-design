import { BROWSER_MCP_TOOLING_DIRECTIVE } from '@open-design/contracts';

// Native clients supply tool descriptions to the model independently of the
// frozen strategy input. Availability does not add a post-Build workflow.
// Claude Code 2.1.312 forwards only the first paragraph to its model.
export const BROWSER_SNAPSHOT_TOOL_DESCRIPTION =
  `Read the accessibility snapshot of a browser tab. ${BROWSER_MCP_TOOLING_DIRECTIVE}`;

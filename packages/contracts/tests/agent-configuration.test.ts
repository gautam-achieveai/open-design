import { describe, expect, it } from 'vitest';

import {
  AGENT_CONFIGURATION_DIRECTIVE,
  AGENT_CONFIGURATION_TRUST_RULE,
} from '../src/prompts/agent-configuration.js';
import { composeOdNextStrategyStableRequestContextV2 } from '../src/prompts/od-next-strategy.js';

/**
 * OD Next carries the user's-agent-configuration rule in its per-run stable
 * context, so a run on the OD Next side follows CLAUDE.md and installed skills
 * exactly as a legacy run does. Only filesystem runs have an agent CLI that
 * loads that configuration; a text-artifact run must not mention it.
 */
describe('OD Next stable context — the user’s own agent configuration', () => {
  it('filesystem runs carry the directive as an instruction block', () => {
    const context = composeOdNextStrategyStableRequestContextV2({});
    expect(context).toContain('<od-next-context kind="instruction" name="agent-configuration">');
    expect(context).toContain(AGENT_CONFIGURATION_DIRECTIVE.trim());
  });

  it('text-artifact runs carry no agent-configuration block', () => {
    const context = composeOdNextStrategyStableRequestContextV2({}, 'text_artifact');
    expect(context).not.toContain('name="agent-configuration"');
    expect(context).not.toContain(AGENT_CONFIGURATION_TRUST_RULE);
  });
});

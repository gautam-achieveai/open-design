// Core MCP tools registered at daemon startup. Slice 1 ships exactly one
// smoke tool so the endpoint, auth, and registry can be exercised end to
// end; the browser/project/run catalog lands in later slices.

import { z } from 'zod';
import { McpToolRegistry, toolOk } from './registry.js';

export function registerCoreMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: 'od_ping',
    description:
      'Connectivity check for the OpenDesign MCP server. Returns pong plus the ' +
      'caller identity (run id / project id for launched-agent tokens, credential ' +
      'name for external tokens). Use before anything else to verify the endpoint ' +
      'and token work.',
    operation: 'mcp:ping',
    version: 1,
    schema: z.object({
      message: z.string().max(200).optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args, context) => toolOk({
      pong: true,
      message: args.message ?? null,
      caller: {
        kind: context.grant.kind,
        runId: context.grant.runId,
        projectId: context.grant.projectId,
        credentialId: context.grant.credentialId,
        name: context.grant.name,
      },
    }, 0),
  });
}

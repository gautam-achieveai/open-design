// MCP endpoint auth: resolves a bearer token to an auth grant.
//
// Mode A — run-scoped tokens minted by OpenDesign for launched agents
//          (`odtt_…`, ToolTokenRegistry). Revoked at run completion.
// Mode B — user-managed local credentials (`odmcp_…`, McpCredentialStore).
//
// Endpoint/operation allowlisting is enforced per tool call by the registry;
// here we only establish *which* principal is calling.

import type { Request } from 'express';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import { MCP_TOOL_ENDPOINT, type ToolTokenRegistry } from '../tool-tokens.js';
import type { McpCredentialStore } from './credentials.js';
import type { McpAuthGrant } from './registry.js';

export type McpAuthResolution =
  | { ok: true; grant: McpAuthGrant }
  | { ok: false; status: 401; code: 'UNAUTHORIZED' | 'TOOL_TOKEN_MISSING' | 'TOOL_TOKEN_EXPIRED'; message: string };

export function resolveMcpGrant(
  req: Request,
  options: {
    toolTokenRegistry: ToolTokenRegistry;
    credentialStore: McpCredentialStore;
  },
): McpAuthResolution {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'TOOL_TOKEN_MISSING',
      message: 'Authorization: Bearer <token> is required (run token or local MCP credential)',
    };
  }

  const runValidation = options.toolTokenRegistry.validate(token, { endpoint: MCP_TOOL_ENDPOINT });
  if (runValidation.ok) {
    return {
      ok: true,
      grant: {
        kind: 'run',
        runId: runValidation.grant.runId,
        projectId: runValidation.grant.projectId,
        credentialId: null,
        name: null,
        allowedOperations: runValidation.grant.allowedOperations,
      },
    };
  }

  const credential = options.credentialStore.validateToken(token);
  if (credential.ok) {
    return {
      ok: true,
      grant: {
        kind: 'external',
        runId: null,
        projectId: null,
        credentialId: credential.credential.id,
        name: credential.credential.name,
        allowedOperations: credential.credential.allowedOperations,
      },
    };
  }
  if (credential.code === 'MCP_CREDENTIAL_EXPIRED') {
    return { ok: false, status: 401, code: 'TOOL_TOKEN_EXPIRED', message: credential.message };
  }
  return {
    ok: false,
    status: 401,
    code: 'UNAUTHORIZED',
    message: 'token is not a valid run token or local MCP credential',
  };
}

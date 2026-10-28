// Shared MCP tool registry — the single place that knows MCP tool metadata,
// argument validation, result shaping, redaction, and payload budgets for
// the daemon-hosted Streamable HTTP MCP endpoint.
//
// REST routes and the `od` CLI are thin surfaces over the same domain
// services; this registry is the third surface. Tool handlers call the same
// service functions the HTTP routes call — never a parallel implementation.
//
// Plan: specs/current/http-first-mcp-implementation-plan.md (Slice 1).

import { z } from 'zod';

// ── Auth grants ────────────────────────────────────────────────────────────

export interface McpAuthGrant {
  /** `run` — Mode A, token minted by OpenDesign for a launched-agent run.
   *  `external` — Mode B, user-managed local credential from Settings/CLI. */
  kind: 'run' | 'external';
  runId: string | null;
  projectId: string | null;
  credentialId: string | null;
  /** Display name for external credentials; null for run grants. */
  name: string | null;
  /** Authz tags this grant may exercise; null means unrestricted.
   * Entries may be exact tags (`mcp:ping`) or prefix globs (`browser/*`). */
  allowedOperations: readonly string[] | null;
}

export function operationAllowed(
  allowed: readonly string[] | null,
  operation: string,
): boolean {
  if (allowed === null) return true;
  for (const entry of allowed) {
    if (entry === '*' || entry === operation) return true;
    if (entry.endsWith('*') && operation.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

// ── Tool results ───────────────────────────────────────────────────────────

export type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; text: string; mimeType?: string };

export interface McpToolResultMeta {
  ms: number;
  truncated?: boolean;
}

export type McpToolStructured =
  | { ok: true; data: unknown; meta: McpToolResultMeta }
  | { ok: false; error: { code: string; message: string }; meta: McpToolResultMeta };

// Type alias (not interface) so the shape stays assignable to the SDK's
// index-signature result types.
export type McpToolResult = {
  content: McpToolContent[];
  /** Carried in the MCP `structuredContent` field — the stable envelope. */
  structuredContent: McpToolStructured;
  isError?: boolean;
};

export interface McpToolContext {
  grant: McpAuthGrant;
  signal: AbortSignal | undefined;
}

export interface McpToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  /** Authz tag checked against the caller's grant, e.g. `mcp:ping`,
   *  `browser/snapshot`. */
  operation: string;
  version: number;
  /** Zod schema validating the tool arguments. Serialized to JSON Schema
   *  (draft-07) for MCP `tools/list`. */
  schema: z.ZodType<TArgs>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Cap on text content characters; larger payloads are truncated with
   *  `meta.truncated` set. */
  maxResultChars?: number;
  handler: (args: TArgs, context: McpToolContext) => Promise<McpToolResult>;
}

export function toolOk(data: unknown, ms: number, extra?: { truncated?: boolean }): McpToolResult {
  const text = safeJson(data);
  const meta: McpToolResultMeta = { ms, ...(extra?.truncated ? { truncated: true } : {}) };
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: true, data, meta },
  };
}

export function toolError(code: string, message: string, ms: number): McpToolResult {
  return {
    content: [{ type: 'text', text: safeJson({ ok: false, error: { code, message } }) }],
    structuredContent: { ok: false, error: { code, message }, meta: { ms } },
    isError: true,
  };
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : 'null';
  } catch {
    return '"<unserializable result>"';
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

export interface McpToolRegistryOptions {
  now?: () => number;
  /** Observability sink. Entries are pre-redacted: never arguments, never
   *  full payloads. */
  log?: (entry: McpToolLogEntry) => void;
}

export interface McpToolLogEntry {
  tool: string;
  operation: string;
  grantKind: 'run' | 'external';
  runId: string | null;
  credentialId: string | null;
  ms: number;
  resultChars: number;
  truncated: boolean;
  outcome: 'ok' | 'error' | 'denied' | 'invalid_args';
  errorMessage?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 32_000;

export function createMcpToolRegistry(options: McpToolRegistryOptions = {}): McpToolRegistry {
  return new McpToolRegistry(options);
}

export class McpToolRegistry {
  readonly #tools = new Map<string, McpToolDefinition>();
  readonly #now: () => number;
  readonly #log: ((entry: McpToolLogEntry) => void) | undefined;

  constructor(options: McpToolRegistryOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log;
  }

  register<TArgs>(tool: McpToolDefinition<TArgs>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`MCP tool "${tool.name}" is already registered`);
    }
    if (!tool.name || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`MCP tool name "${tool.name}" must be snake_case`);
    }
    if (!tool.operation) throw new Error(`MCP tool "${tool.name}" needs an operation tag`);
    this.#tools.set(tool.name, tool as McpToolDefinition);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Wire shape for MCP `tools/list`, filtered by the caller's grant. */
  listWireTools(grant: McpAuthGrant): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: McpToolDefinition['annotations'];
    _meta?: { 'open-design/version': number };
  }> {
    const tools: Array<ReturnType<McpToolRegistry['listWireTools']>[number]> = [];
    for (const tool of this.#tools.values()) {
      if (!operationAllowed(grant.allowedOperations, tool.operation)) continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<string, unknown>,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        _meta: { 'open-design/version': tool.version },
      });
    }
    return tools;
  }

  async call(
    name: string,
    rawArgs: unknown,
    grant: McpAuthGrant,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const started = this.#now();
    const finish = (result: McpToolResult, outcome: McpToolLogEntry['outcome']): McpToolResult => {
      const ms = this.#now() - started;
      result.structuredContent.meta.ms = ms;
      this.#emitLog(name, grant, started, result, outcome);
      return result;
    };

    const tool = this.#tools.get(name);
    if (!tool) {
      return finish(toolError('TOOL_NOT_FOUND', `unknown tool "${name}"`, 0), 'error');
    }
    if (!operationAllowed(grant.allowedOperations, tool.operation)) {
      return finish(toolError(
        'TOOL_OPERATION_DENIED',
        `operation "${tool.operation}" is not allowed for this token`,
        0,
      ), 'denied');
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return finish(toolError('INVALID_ARGS', issues || 'invalid arguments', 0), 'invalid_args');
    }

    let result: McpToolResult;
    try {
      result = await tool.handler(parsed.data, { grant, signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finish(toolError('TOOL_HANDLER_FAILED', redactSecrets(message), 0), 'error');
    }

    const cap = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    let truncated = false;
    result.content = result.content.map((block) => {
      if (block.type === 'text' && block.text.length > cap) {
        truncated = true;
        return { ...block, text: `${block.text.slice(0, cap)}\n…<truncated>` };
      }
      return block;
    });
    if (truncated) result.structuredContent.meta.truncated = true;
    return finish(result, result.isError ? 'error' : 'ok');
  }

  #emitLog(
    name: string,
    grant: McpAuthGrant,
    started: number,
    result: McpToolResult,
    outcome: McpToolLogEntry['outcome'],
  ): void {
    if (!this.#log) return;
    const errorMessage = result.structuredContent.ok
      ? undefined
      : redactSecrets(result.structuredContent.error.message);
    this.#log({
      tool: name,
      operation: this.#tools.get(name)?.operation ?? '',
      grantKind: grant.kind,
      runId: grant.runId,
      credentialId: grant.credentialId,
      ms: this.#now() - started,
      resultChars: result.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0),
      truncated: result.structuredContent.meta.truncated === true,
      outcome,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}

const SECRET_PATTERN = /(odtt_|odmcp_)[A-Za-z0-9_-]+/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '<redacted-token>');
}

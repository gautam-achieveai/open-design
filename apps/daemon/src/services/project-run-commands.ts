import type { Request, Response } from 'express';

/** Optional only for non-REST callers; native REST keeps its existing policy. */
export interface LocalCommandExecution {
  assertCurrent: () => void;
  beforeMutation: () => void;
}
export type LocalCommandHandler = (request: Request, response: Response, execution?: LocalCommandExecution) => Promise<unknown>;
export interface LocalCommandResult { status: number; body: unknown; mutationStarted: boolean }
export class LocalCommandFailure extends Error {
  constructor(readonly mutationStarted: boolean) { super('Local command result unavailable'); }
}
export interface LocalCommandInput {
  body?: Record<string, unknown>; projectId?: string; runId?: string; signal?: AbortSignal | undefined;
  assertCurrent: () => boolean; onMutationStarting?: () => void;
}

/** Only the request/response properties consumed by the named native handlers. */
export async function invokeLocalCommand(handler: LocalCommandHandler, input: LocalCommandInput, route: {
  method: 'GET' | 'POST' | 'DELETE'; path: string; origin?: { protocol: 'http' | 'https'; host: string };
}): Promise<LocalCommandResult> {
  let mutationStarted = false, accessLost = false;
  const assertCurrent = () => {
    if (input.signal?.aborted || !input.assertCurrent()) {
      accessLost = true;
      throw new LocalCommandFailure(mutationStarted);
    }
  };
  const execution: LocalCommandExecution = { assertCurrent, beforeMutation: () => {
    assertCurrent(); mutationStarted = true; input.onMutationStarting?.();
  } };
  const headers: Record<string, string> = { 'x-od-client': 'mcp' };
  if (route.origin) headers.host = route.origin.host;
  // Never borrow caller bearer, workspace or analytics headers.
  const request = { body: input.body ?? {}, params: { id: input.runId ?? input.projectId }, query: {}, headers,
    method: route.method, route: { path: route.path }, ...(route.origin ? { protocol: route.origin.protocol } : {}),
    get: (name: string) => headers[name.toLowerCase()],
    get aborted() { return input.signal?.aborted === true; } } as unknown as Request;
  let result: { status: number; body: unknown } | undefined;
  const response = {
    req: request, statusCode: 200, headersSent: false,
    get destroyed() { return input.signal?.aborted === true; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) {
      if (this.headersSent) throw new Error('Command already answered');
      this.headersSent = true;
      result = { status: this.statusCode, body };
      return this;
    },
  };
  try {
    assertCurrent();
    await handler(request, response as unknown as Response, execution);
    if (accessLost || !result) throw new LocalCommandFailure(mutationStarted);
    return { ...result, mutationStarted };
  } catch {
    throw new LocalCommandFailure(mutationStarted);
  }
}

/** Reuse the exact prepared REST commands; no HTTP self-call or caller headers. */
export function createProjectRunCommandService(handlers: {
  createProject: LocalCommandHandler; deleteProject: LocalCommandHandler;
  startRun: LocalCommandHandler; getRun?: LocalCommandHandler;
}) {
  const execute = async (kind: keyof typeof handlers, input: LocalCommandInput): Promise<LocalCommandResult> => {
    const handler = handlers[kind];
    if (!handler) throw new LocalCommandFailure(false);
    const path = kind === 'createProject' ? '/api/projects' : kind === 'deleteProject' ? '/api/projects/:id'
      : kind === 'getRun' ? '/api/runs/:id' : '/api/runs';
    return invokeLocalCommand(handler, input, { path,
      method: kind === 'deleteProject' ? 'DELETE' : kind === 'getRun' ? 'GET' : 'POST' });
  };
  return {
    createProject: (input: LocalCommandInput) => execute('createProject', input),
    deleteProject: (input: LocalCommandInput) => execute('deleteProject', input),
    startRun: (input: LocalCommandInput) => execute('startRun', input),
    getRun: (input: LocalCommandInput) => execute('getRun', input),
  };
}
export type ProjectRunCommandService = ReturnType<typeof createProjectRunCommandService>;

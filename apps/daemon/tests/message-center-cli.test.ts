import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder: (fn: (req: CapturedRequest) => StubResponse) => void;
  close: () => Promise<void>;
}

interface StubResponse {
  status: number;
  body: unknown;
}

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder: (req: CapturedRequest) => StubResponse = (_req) => ({
    status: 200,
    body: { ok: true },
  });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw,
      };
      requests.push(captured);
      const response = responder(captured);
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server has no address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder: (fn) => {
      responder = fn;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args],
      {
        cwd: DAEMON_ROOT,
        env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
}

describe('od message-center CLI', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.setResponder(() => ({ status: 200, body: { ok: true } }));
  });

  it("rejects retired Cloud command without HTTP: prints usage on `od message-center help` and exits 0", async () => {
    const result = await runCli(['message-center', 'help']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects retired Cloud command without HTTP: lists messages through the daemon route and maps locale/filter query params", async () => {
    const result = await runCli([
      'message-center',
      'list',
      '--locale',
      'en',
      '--filter',
      'unread',
      '--limit',
      '50',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects retired Cloud command without HTTP: emits raw JSON for `message-center list --json`", async () => {
    const result = await runCli([
      'message-center',
      'list',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects retired Cloud command without HTTP: POSTs the message read endpoint on `message-center read <id>`", async () => {
    const result = await runCli([
      'message-center',
      'read',
      'release/2026',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects retired Cloud command without HTTP: POSTs the read-all endpoint on `message-center read-all --json`", async () => {
    const result = await runCli([
      'message-center',
      'read-all',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects retired Cloud command without HTTP: fails fast when `message-center read` is missing an id", async () => {
    const result = await runCli(['message-center', 'read', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: od message-center');
    expect(stub.requests).toHaveLength(0);
  });
});

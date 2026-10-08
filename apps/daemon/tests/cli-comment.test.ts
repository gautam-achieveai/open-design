// Contract test for `od comment …` and `od run start --comment`.
//
// AGENTS.md "Capability exposure": numbered pins are reachable from the
// canvas, the in-app browser, and the Clipper; this proves the CLI drives the
// same `/api/projects/:id/conversations/:cid/comments` rows and stages them
// into `POST /api/runs` as `commentAttachments` numbered by `pinSeq` — the
// number the user sees on the pin — not by batch position.
//
// Stub HTTP server rather than a booted daemon: what needs proving is routing,
// flag parsing, and the emitted request. Row semantics are covered against the
// real daemon in project-comment-permissions.test.ts.

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

interface CapturedRequest { method: string; url: string; body: string }

const COMMENTS_ROUTE = '/api/projects/p1/conversations/c1/comments';
const pin = (id: string, pinSeq: number, filePath: string, note: string) => ({
  id, pinSeq, filePath, note, status: 'open', elementId: `el-${id}`, selector: `#${id}`, label: id,
  text: 'Save', position: { x: 1, y: 2, width: 30, height: 10 }, htmlHint: 'button', selectionKind: 'element',
  attachments: id === 'c3' ? [{ path: 'browser-annotations/clipper-1.png', name: 'clipper-1.png' }] : [],
  metadata: filePath.startsWith('browser:') ? { source: 'browser' } : undefined,
});
const ROWS = [pin('c1', 1, 'index.html', 'first'), pin('c3', 3, 'browser:https://mail.example.com/inbox', 'inbox pin'),
  pin('c7', 7, 'index.html', 'seventh')];

async function startStubServer() {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const captured = { method: req.method ?? '', url: req.url ?? '', body: raw };
      requests.push(captured);
      res.setHeader('content-type', 'application/json');
      if (captured.method === 'GET' && captured.url === COMMENTS_ROUTE) {
        res.end(JSON.stringify({ comments: ROWS }));
      } else if (captured.method === 'POST' && captured.url === COMMENTS_ROUTE) {
        res.end(JSON.stringify({ comment: { ...pin('c9', 9, 'index.html', JSON.parse(raw).note), ...JSON.parse(raw).target } }));
      } else if (captured.method === 'PATCH' && captured.url === `${COMMENTS_ROUTE}/c3`) {
        res.end(JSON.stringify({ comment: { ...ROWS[1], status: JSON.parse(raw).status } }));
      } else if (captured.method === 'DELETE' && captured.url === `${COMMENTS_ROUTE}/c7`) {
        res.end(JSON.stringify({ ok: true }));
      } else if (captured.method === 'POST' && captured.url === '/api/runs') {
        res.end(JSON.stringify({ runId: 'run-9' }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unexpected' }));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((ok, fail) => { server.close((err) => (err ? fail(err) : ok())); }),
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args],
      { cwd: DAEMON_ROOT, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od comment CLI', () => {
  let stub: Awaited<ReturnType<typeof startStubServer>>;
  const scope = ['--project', 'p1', '--conversation', 'c1'];

  beforeAll(async () => { stub = await startStubServer(); });
  afterAll(async () => { await stub.close(); });
  beforeEach(() => { stub.requests.length = 0; });

  it('lists pins from the conversation comments route, filtered by file key', async () => {
    const result = await runCli(['comment', 'list', ...scope, '--path', 'index.html', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(stub.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${COMMENTS_ROUTE}`]);
    expect(JSON.parse(result.stdout).comments.map((c: { id: string }) => c.id)).toEqual(['c1', 'c7']);

    const text = await runCli(['comment', 'list', ...scope, '--daemon-url', stub.baseUrl]);
    expect(text.stdout.split('\n').filter(Boolean)).toHaveLength(4); // header + 3 pins
    expect(text.stdout).toContain('#3\tc3\topen\tbrowser:https://mail.example.com/inbox\t#c3\t1 img\tinbox pin');
  }, 40_000);

  it('adds, re-statuses, and deletes a pin through the same routes the UI uses', async () => {
    const added = await runCli(['comment', 'add', ...scope, '--path', 'index.html', '--selector', 'main h1',
      '--message', 'tighten this', '--json', '--daemon-url', stub.baseUrl]);
    expect(added.code).toBe(0);
    const post = stub.requests.find((r) => r.method === 'POST');
    expect(post?.url).toBe(COMMENTS_ROUTE);
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      note: 'tighten this', target: { filePath: 'index.html', selector: 'main h1', elementId: 'main h1' },
    });

    const status = await runCli(['comment', 'status', 'c3', ...scope, '--status', 'resolved', '--json', '--daemon-url', stub.baseUrl]);
    expect(status.code).toBe(0);
    const patch = stub.requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toBe(`${COMMENTS_ROUTE}/c3`);
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ status: 'resolved' });
    expect(JSON.parse(status.stdout).comment.status).toBe('resolved');

    const removed = await runCli(['comment', 'delete', 'c7', ...scope, '--daemon-url', stub.baseUrl]);
    expect(removed.code).toBe(0);
    expect(stub.requests.find((r) => r.method === 'DELETE')?.url).toBe(`${COMMENTS_ROUTE}/c7`);
    expect(removed.stdout.trim()).toBe('[comment] deleted c7');
  }, 40_000);

  it('stages --comment ids into POST /api/runs numbered by pinSeq, and refuses unknown ids', async () => {
    const result = await runCli(['run', 'start', ...scope, '--message', 'fix #3 and #7', '--comment', 'c3,c7',
      '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    const run = stub.requests.find((r) => r.url === '/api/runs');
    expect(run?.method).toBe('POST');
    const body = JSON.parse(run?.body ?? '{}');
    expect(body.message).toBe('fix #3 and #7');
    expect(body.commentAttachments).toMatchObject([
      { id: 'c3', order: 3, filePath: 'browser:https://mail.example.com/inbox', selector: '#c3', comment: 'inbox pin',
        source: 'saved-comment', metadata: { source: 'browser' }, imageAttachments: [{ path: 'browser-annotations/clipper-1.png' }] },
      { id: 'c7', order: 7, filePath: 'index.html', comment: 'seventh', source: 'saved-comment' },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ runId: 'run-9' });

    stub.requests.length = 0;
    const missing = await runCli(['run', 'start', ...scope, '--message', 'x', '--comment', 'c3,nope', '--daemon-url', stub.baseUrl]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('nope');
    expect(stub.requests.some((r) => r.url === '/api/runs')).toBe(false);
  }, 40_000);
});

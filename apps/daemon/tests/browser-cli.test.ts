import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  workspaceId?: string;
  workspaceMemberId?: string;
}

describe('od browser CLI', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: CapturedRequest[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body,
          ...(req.headers['x-od-workspace-id'] ? { workspaceId: String(req.headers['x-od-workspace-id']) } : {}),
          ...(req.headers['x-od-workspace-member-id'] ? { workspaceMemberId: String(req.headers['x-od-workspace-member-id']) } : {}),
        });
        res.setHeader('connection', 'close');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/projects/p1/conversations/c1/messages') {
          res.end(JSON.stringify({ messages: [{ id: 'message-1', role: 'user', content: 'Make Save visible',
            chatImages: [{ id: 'message-1', mimeType: 'image/png', bytes: 78, width: 16, height: 8 }] }] }));
          return;
        }
        if (req.url?.includes('/conversations/c1/messages/message-1/edge-image')) {
          res.setHeader('content-type', 'image/png');
          res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAAFUlEQVR4nGM4ceLEf0oww6gBw8EAACA2q5Dak2CeAAAAAElFTkSuQmCC', 'base64'));
          return;
        }
        if (req.url === '/api/projects/p1/edge-annotations/pending?conversationId=c1') {
          res.end(JSON.stringify({ annotations: [{ id: 'annotation-1', note: 'Review Save',
            evidence: { url: 'https://app.example.test/dashboard' } }] }));
          return;
        }
        if (req.url === '/api/projects/p1/conversations/c1/messages/message-1/annotation-context/annotation-1') {
          res.end(JSON.stringify({ url: 'https://app.example.test/dashboard',
            target: { selector: '#save', text: 'Save' } }));
          return;
        }
        if (req.url === '/api/projects/p1/edge-annotations/draft') {
          res.end(JSON.stringify({ id: 'annotation-1', conversationId: 'c1',
            note: 'Review Save', evidence: { url: 'https://app.example.test/dashboard' } }));
          return;
        }
        if (req.url?.endsWith('/edge-annotations/pair')) {
          res.end(JSON.stringify({ code: 'pair.secret', pairId: 'pair', expiresAt: 12345 }));
          return;
        }
        if (req.url?.includes('/edge-annotations?conversationId=')) {
          res.end(JSON.stringify({ grants: [] }));
          return;
        }
        if (req.url === '/api/projects/p1/edge-annotations/post') {
          res.end(JSON.stringify({ projectId: 'p1', conversationId: 'c1', messageId: 'message-1', replayed: false }));
          return;
        }
        if (req.url?.endsWith('/tabs')) {
          res.end(JSON.stringify({
            activeTabId: 'tab-a',
            tabs: [{
              projectId: 'p1',
              tabId: 'tab-a',
              url: 'https://example.com/',
              title: 'Example',
              active: true,
              registeredAt: 1,
              updatedAt: 1,
              leaseExpiresAt: 30_001,
            }],
          }));
          return;
        }
        if (body && JSON.parse(body).command?.operation === 'style') {
          const command = JSON.parse(body).command;
          res.end(JSON.stringify({ commandId: 'command-1', tab: { projectId: 'p1', tabId: 'tab-a' },
            result: { operation: 'style', applied: true, inspection: { selector: command.target.selector,
              position: { x: 1, y: 2, width: 160, height: 30 }, style: command.styles } } }));
          return;
        }
        res.end(JSON.stringify({
          commandId: 'command-1',
          tab: {
            projectId: 'p1',
            tabId: 'tab-a',
            url: 'https://example.com/',
            title: 'Example',
          },
          result: { operation: 'click', clicked: true },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing stub address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
  });

  // Integration: real CLI processes prove flag parsing, file/stdin and HTTP parity.
  it('posts approved typed styles from a file to the shared browser command route (integration)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'od-browser-styles-'));
    try {
      const path = join(dir, 'styles.json');
      const styles = { color: 'red', marginLeft: '-2px' };
      await writeFile(path, JSON.stringify(styles));
      const args = ['browser', 'style', '--project', 'p1', '--tab', 'tab-a', '--selector', 'h1',
        '--styles-file', path, '--json', '--daemon-url', baseUrl];
      const refused = await runCli(args);
      expect(refused.code).toBe(2);
      expect(requests).toHaveLength(0);
      const applied = await runCli([...args, '--approve']);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout).commandId).toBe('command-1');
      expect(JSON.parse(applied.stdout).result).toMatchObject({ operation: 'style', applied: true });
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ tabId: 'tab-a',
        command: { operation: 'style', approved: true, target: { selector: 'h1' }, styles } });
      await writeFile(path, '{"__proto__":"red"}');
      const invalid = await runCli([...args, '--approve']);
      expect(invalid.code).toBe(2);
      expect(requests).toHaveLength(1);
      const stdinArgs = args.map((value) => value === path ? '-' : value);
      const piped = await runCli([...stdinArgs, '--approve'], JSON.stringify(styles));
      expect(piped.code).toBe(0);
      expect(JSON.parse(requests[1]!.body).command.styles).toEqual(styles);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('posts a finite viewport preset to the shared command route with JSON output', async () => {
    const result = await runCli(['browser', 'viewport', 'mobile', '--project', 'p1', '--tab', 'tab-a', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).commandId).toBe('command-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/projects/p1/browser/commands' });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ command: { operation: 'viewport', preset: 'mobile' }, tabId: 'tab-a' });
    const invalid = await runCli(['browser', 'viewport', 'phone', '--project', 'p1', '--daemon-url', baseUrl]);
    expect(invalid.code).toBe(2);
    expect(requests).toHaveLength(1);
  });

  async function runCli(args: string[], input?: string) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    try {
      const completion = execFileP(
        process.execPath,
        [TSX_CLI, CLI_SRC, ...args],
        { cwd: DAEMON_ROOT, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (input !== undefined) completion.child.stdin?.end(input);
      const { stdout, stderr } = await completion;
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number | null };
      return {
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
        code: failed.code ?? 1,
      };
    }
  }

  it('pairs an Edge work-profile tab through the project HTTP contract', async () => {
    const result = await runCli([
      'browser', 'edge', 'pair', '--project', 'p1', '--conversation', 'c1',
      '--extension-id', 'a'.repeat(32), '--json', '--daemon-url', baseUrl,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'pair.secret' });
    expect(requests).toContainEqual({
      method: 'POST', url: '/api/projects/p1/edge-annotations/pair',
      body: JSON.stringify({ conversationId: 'c1', extensionId: 'a'.repeat(32) }),
    });
  });

  it('stages a note with JSON evidence, then reads pending and message-bound context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'od-edge-json-cli-'));
    try {
      const prompt = join(dir, 'note.txt');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(prompt, 'Review Save');
      const staged = await runCli(['browser', 'edge', 'draft', '--project', 'p1', '--conversation', 'c1',
        '--url', 'https://app.example.test/dashboard', '--prompt-file', prompt,
        '--daemon-url', baseUrl, '--json']);
      expect(staged.code).toBe(0);
      expect(JSON.parse(staged.stdout)).toMatchObject({ id: 'annotation-1' });
      expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/projects/p1/edge-annotations/draft' });
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ note: 'Review Save',
        url: 'https://app.example.test/dashboard' });
      const pending = await runCli(['browser', 'edge', 'pending', '--project', 'p1',
        '--conversation', 'c1', '--daemon-url', baseUrl, '--json']);
      expect(JSON.parse(pending.stdout)).toMatchObject({ annotations: [{ id: 'annotation-1' }] });
      const context = await runCli(['browser', 'edge', 'context', '--project', 'p1',
        '--conversation', 'c1', '--message', 'message-1', '--annotation', 'annotation-1',
        '--daemon-url', baseUrl, '--json']);
      expect(JSON.parse(context.stdout)).toMatchObject({ target: { selector: '#save' } });
      expect(requests.at(-1)).toMatchObject({ method: 'GET',
        url: '/api/projects/p1/conversations/c1/messages/message-1/annotation-context/annotation-1' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('lists paired grants without a temporary annotation inbox', async () => {
    const result = await runCli([
      'browser', 'edge', 'status', '--project', 'p1', '--conversation', 'c1', '--json', '--daemon-url', baseUrl,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ grants: [] });
    expect(result.stdout).not.toContain('iVBORw');
    expect(requests).toContainEqual({
      method: 'GET', url: '/api/projects/p1/edge-annotations?conversationId=c1', body: '',
    });
  });

  it('reads posted chat messages through the existing conversation endpoint', async () => {
    const result = await runCli(['browser', 'edge', 'messages', '--project', 'p1',
      '--conversation', 'c1', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ messages: [{ id: 'message-1',
      chatImages: [{ mimeType: 'image/png' }] }] });
    expect(requests).toContainEqual({ method: 'GET', url: '/api/projects/p1/conversations/c1/messages', body: '' });
  });

  it('downloads the message-owned PNG without embedding bytes in status JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'od-edge-crop-'));
    try {
      const output = join(dir, 'element.png');
      const result = await runCli([
        'browser', 'edge', 'image', '--project', 'p1', '--conversation', 'c1',
        '--message', 'message-1', '--output', output, '--json', '--daemon-url', baseUrl,
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ path: output, bytes: expect.any(Number) });
      expect((await readFile(output)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(requests).toContainEqual({ method: 'GET',
        url: '/api/projects/p1/conversations/c1/messages/message-1/edge-image', body: '' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('posts evidence directly as chat with or without a screenshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'od-edge-post-'));
    try {
      const screenshot = join(dir, 'crop.png');
      const prompt = join(dir, 'note.txt');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAAFUlEQVR4nGM4ceLEf0oww6gBw8EAACA2q5Dak2CeAAAAAElFTkSuQmCC', 'base64'));
      await writeFile(prompt, 'Make Save visible');
      const args = ['browser', 'edge', 'post', '--project', 'p1', '--conversation', 'c1',
        '--url', 'https://app.example.test/dashboard', '--screenshot', screenshot,
        '--prompt-file', prompt, '--event-id', 'cli-1', '--daemon-url', baseUrl];
      const result = await runCli([...args, '--json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ messageId: 'message-1', replayed: false });
      expect(requests.map((request) => request.url)).toEqual(['/api/projects/p1/edge-annotations/post']);
      const body = JSON.parse(requests[0]!.body);
      expect(body).toMatchObject({ conversationId: 'c1', eventId: 'cli-1', note: 'Make Save visible',
        url: 'https://app.example.test/dashboard' });
      expect(body.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
      const textOnly = await runCli(args.filter((arg) => arg !== '--screenshot' && arg !== screenshot));
      expect(textOnly.code).toBe(0);
      expect(JSON.parse(requests[1]!.body).screenshotDataUrl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes an explicitly supplied workspace identity through every Edge chat operation', async () => {
    const scoped = ['--workspace', 'w1', '--workspace-member', 'm1', '--daemon-url', baseUrl];
    const dir = await mkdtemp(join(tmpdir(), 'od-edge-scoped-'));
    try {
      const screenshot = join(dir, 'crop.png');
      const prompt = join(dir, 'note.txt');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAAFUlEQVR4nGM4ceLEf0oww6gBw8EAACA2q5Dak2CeAAAAAElFTkSuQmCC', 'base64'));
      await writeFile(prompt, 'Review Save');
      const actions = [
        ['pair', '--extension-id', 'a'.repeat(32)],
        ['status'], ['messages'],
        ['image', '--message', 'message-1', '--output', join(dir, 'saved.png')],
        ['post', '--url', 'https://app.example.test/page', '--screenshot', screenshot,
          '--prompt-file', prompt, '--approve'],
      ];
      for (const action of actions) {
        const outcome = await runCli(['browser', 'edge', action[0]!, '--project', 'p1', '--conversation', 'c1',
          ...action.slice(1), ...scoped]);
        expect(outcome.code).toBe(0);
      }
      expect(requests).toHaveLength(actions.length);
      for (const request of requests) {
        expect(request).toMatchObject({ workspaceId: 'w1', workspaceMemberId: 'm1' });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('lists tabs through the project browser route and emits JSON', async () => {
    const result = await runCli([
      'browser',
      'tabs',
      '--project',
      'p1',
      '--json',
      '--daemon-url',
      baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ activeTabId: 'tab-a' });
    expect(requests).toContainEqual({
      method: 'GET',
      url: '/api/projects/p1/browser/tabs',
      body: '',
    });
  });

  it('refuses a consequential click without --approve', async () => {
    const result = await runCli([
      'browser',
      'click',
      '--project',
      'p1',
      '--selector',
      '#buy',
      '--daemon-url',
      baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--approve');
    expect(requests).toHaveLength(0);
  });

  it('posts an approved click to the active embedded tab', async () => {
    const result = await runCli([
      'browser',
      'click',
      '--project',
      'p1',
      '--selector',
      '#buy',
      '--approve',
      '--json',
      '--daemon-url',
      baseUrl,
    ]);

    expect(result.code).toBe(0);
    const request = requests.at(-1);
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/projects/p1/browser/commands');
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      command: {
        operation: 'click',
        approved: true,
        target: { selector: '#buy' },
      },
    });
  });

  it('requires approval for scroll and does not send an unapproved command', async () => {
    const result = await runCli([
      'browser',
      'scroll',
      '--project',
      'p1',
      '--delta-y',
      '500',
      '--daemon-url',
      baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--approve');
    expect(requests).toHaveLength(0);
  });
});

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Integration: launches the real CLI against a disposable loopback server.
it('lists and approves browser requests with the requested workspace scope', async () => {
  const requests: Array<{ method: string; url: string; workspace: string; member: string }> = [];
  const approval = { id: 'one', status: 'pending', operation: 'browser_click', projectId: 'p1', tabId: 't1',
    principal: { kind: 'run', id: 'r1' }, location: 'https://example.invalid/', preview: 'Click #go', partial: false,
    expiresAt: '2099-01-01T00:00:00Z' };
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', workspace: String(req.headers['x-od-workspace-id'] ?? ''),
      member: String(req.headers['x-od-workspace-member-id'] ?? '') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { approvals: [approval] } : { approval: { ...approval, status: 'approved' } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const repo = resolve(import.meta.dirname, '../../..');
  const tsx = resolve(repo, 'node_modules/tsx/dist/cli.mjs');
  const cli = resolve(import.meta.dirname, '../src/cli.ts');
  const run = promisify(execFile);
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  try {
    const common = ['--workspace', 'w1', '--workspace-member', 'm1', '--daemon-url', base];
    const list = await run(process.execPath, [tsx, cli, 'mcp', 'approvals', ...common, '--json'], { env });
    expect(JSON.parse(list.stdout).approvals[0].id).toBe('one');
    expect(list.stdout).not.toContain('Local apps and agents');
    const decide = await run(process.execPath, [tsx, cli, 'mcp', 'approve', 'one', ...common], { env });
    expect(decide.stdout).toContain('Local apps and agents can make this decision too.');
    expect(requests).toEqual([
      { method: 'GET', url: '/api/mcp/approvals', workspace: 'w1', member: 'm1' },
      { method: 'POST', url: '/api/mcp/approvals/one/approve', workspace: 'w1', member: 'm1' },
    ]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30_000);

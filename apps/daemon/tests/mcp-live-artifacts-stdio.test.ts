import { afterEach, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { McpToolRegistry, toolOk } from '../src/mcp-http/registry.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { McpCredentialStore } from '../src/mcp-http/credentials.js';
import { registerMcpHttpRoutes } from '../src/mcp-http/routes.js';
import { resolveMcpGrant } from '../src/mcp-http/auth.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('od-stdio-bridge-')) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('uses SDK stdio and the HTTP registry for the complete legacy catalog, then exits on EOF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-stdio-bridge-')); roots.push(root);
  const tokenRegistry = new ToolTokenRegistry(), registry = new McpToolRegistry();
  const credentialStore = new McpCredentialStore({ filePath: path.join(root, 'credentials.json') });
  const names = ['live_artifacts_create', 'live_artifacts_list', 'live_artifacts_update', 'live_artifacts_refresh', 'connectors_list', 'connectors_execute'];
  const observed: Array<{ name: string; args: unknown }> = [];
  for (const name of [...names, 'unrelated_tool']) registry.register({ name, operation: name, version: 1, description: 'Synthetic',
    schema: z.record(z.string(), z.unknown()), handler: async args => { observed.push({ name, args }); return toolOk({ name, args }, 0); } });
  const token = tokenRegistry.mint({ runId: 'r', projectId: 'p', allowedEndpoints: ['/mcp'], allowedOperations: [...names, 'unrelated_tool'] });
  const app = express(); app.use(express.json());
  registerMcpHttpRoutes(app, { registry, resolveGrant: req => resolveMcpGrant(req, { credentialStore, toolTokenRegistry: tokenRegistry }), serverInfo: { name: 'fixture', version: '1' } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener');
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/mcp-live-artifacts.ts')).href;
  const client = new Client({ name: 'fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '-e', `import { runLiveArtifactsMcpServer } from ${JSON.stringify(moduleUrl)}; const result=await runLiveArtifactsMcpServer(); process.exit(result.exitCode);`],
    env: { OD_DAEMON_URL: `http://127.0.0.1:${address.port}`, OD_TOOL_TOKEN: token.token }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const child = (transport as unknown as { _process: ChildProcess })._process;
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(names.slice().sort());
    for (const name of names) {
      const args = { nested: { text: 'Synthetic payload', count: 3 }, ...(name === 'connectors_list' ? { useCase: 'personal_daily_digest' } : {}) };
      const result = await client.callTool({ name, arguments: args });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { name, args }, meta: { toolVersion: 1 } });
    }
    expect(observed).toHaveLength(6);
    await expect(client.callTool({ name: 'unrelated_tool', arguments: {} })).rejects.toThrow('Unknown compatibility tool');
    expect(observed).toHaveLength(6);
    tokenRegistry.revokeToken(token.token);
    await expect(client.listTools()).rejects.toThrow('Unable to list daemon tools');
    await client.close();
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stderr).toContain('compatibility only');
    expect(stderr).not.toContain(token.token);
  } finally {
    await client.close(); tokenRegistry.clear(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

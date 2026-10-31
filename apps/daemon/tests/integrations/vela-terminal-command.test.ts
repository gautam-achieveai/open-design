import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  runVelaCommand,
} from '../../src/integrations/vela-command.js';
import {
  createAmrTerminalReportDeliveryService,
  createAmrTerminalReportOutboxStore,
  migrateAmrTerminalReportOutbox,
} from '../../src/storage/amr-terminal-report-outbox.js';

const fakeVela = path.resolve('tests/fixtures/fake-vela.mjs');
let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('canonical Vela terminal command integration', () => {
  it('does not launch a saved Vela binary for terminal reporting', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-vela-terminal-command-'));
    const logPath = path.join(tempDir, 'terminal.jsonl');
    const args = [
      'run', 'terminal', '--run-id', 'integration-run', '--outcome', 'failed',
      '--terminal-at', '2026-08-05T01:02:03.456Z', '--json',
    ];
    const common = {
      env: {
        ...process.env,
        OD_DATA_DIR: '',
        FAKE_VELA_TERMINAL_LOG: logPath,
      },
      configuredEnv: {
        VELA_BIN: fakeVela,
        VELA_INVOCATION_SOURCE: 'open-design',
      },
      maxBuffer: 64 * 1024,
    };

    await expect(runVelaCommand(args, common)).rejects.toThrow('AMR runtime definition is missing');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('keeps undeliverable legacy reports pending without launching a saved Vela binary', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-vela-terminal-settings-'));
    const logPath = path.join(tempDir, 'terminal.jsonl');
    fs.writeFileSync(
      path.join(tempDir, 'app-config.json'),
      JSON.stringify({
        agentCliEnv: {
          amr: {
            VELA_BIN: fakeVela,
            FAKE_VELA_TERMINAL_LOG: logPath,
          },
        },
      }),
    );
    const db = new Database(':memory:');
    try {
      migrateAmrTerminalReportOutbox(db);
      const store = createAmrTerminalReportOutboxStore(db);
      const terminalAt = Date.parse('2026-08-05T02:03:04.567Z');
      store.enqueue({ runId: 'settings-run', outcome: 'failed', terminalAt });
      const service = createAmrTerminalReportDeliveryService({
        store,
        env: {
          ...process.env,
          OD_DATA_DIR: tempDir,
          FAKE_VELA_TERMINAL_LOG: logPath,
        },
      });

      await service.processDue();

      expect(store.diagnostics()).toMatchObject({ pending: 1, delivered: 0 });
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      db.close();
    }
  });
});

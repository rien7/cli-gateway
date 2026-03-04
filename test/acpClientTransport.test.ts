import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { AcpClient } from '../src/acp/client.js';
import type { JsonRpcMessage } from '../src/acp/jsonrpc.js';
import type { StdioProcess } from '../src/acp/stdio.js';

class HangingRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private exitHandlers: Array<
    (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  > = [];

  write(): void {
    // Intentionally never responds.
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  onExit(
    cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.exitHandlers.push(cb);
  }

  kill(): void {
    // noop
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const handler of this.exitHandlers) {
      handler({ code, signal });
    }
  }
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

test('AcpClient rejects pending initialize when agent exits', async () => {
  const db = createDb();
  const rpc = new HangingRpc();

  const client = new AcpClient({
    db,
    workspaceRoot: '/tmp',
    agentCommand: 'node',
    agentArgs: [],
    rpc,
  });

  const pending = client.initialize();
  rpc.emitExit(1, null);

  await assert.rejects(pending, (error: any) => {
    assert.equal(error?.name, 'AcpTransportError');
    assert.ok(String(error?.message).includes('ACP agent exited'));
    return true;
  });

  client.close();
  db.close();
});

test('AcpClient request timeout surfaces transport error', async () => {
  const db = createDb();
  const rpc = new HangingRpc();

  const client = new AcpClient({
    db,
    workspaceRoot: '/tmp',
    agentCommand: 'node',
    agentArgs: [],
    rpc,
  });

  const pending = (client as any).request('initialize', {}, 5);

  await assert.rejects(pending, (error: any) => {
    assert.equal(error?.name, 'AcpTransportError');
    assert.ok(String(error?.message).includes('ACP request timed out'));
    return true;
  });

  client.close();
  db.close();
});

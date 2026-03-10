import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { AcpClient } from '../src/acp/client.js';
import { createRun, createSession } from '../src/gateway/sessionStore.js';
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

class PromptDrainRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private timers: NodeJS.Timeout[] = [];

  write(message: JsonRpcMessage): void {
    if (!('method' in message)) return;
    if (message.method !== 'session/prompt') return;

    const req = message;
    queueMicrotask(() => {
      this.emit({
        jsonrpc: '2.0',
        id: req.id,
        result: { stopReason: 'end' },
      } as JsonRpcMessage);

      for (let index = 0; index < 8; index += 1) {
        const timer = setTimeout(() => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-drain',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `chunk-${index}` },
              },
            },
          } as JsonRpcMessage);
        }, 10 * (index + 1));
        this.timers.push(timer);
      }
    });
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  private emit(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
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

test('AcpClient prompt drain respects max wait even if updates keep arriving', async () => {
  const db = createDb();
  const updates: string[] = [];
  const rpc = new PromptDrainRpc();
  createSession(db, {
    sessionKey: 'session-drain',
    agentCommand: 'node',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  createRun(db, {
    runId: 'run-drain',
    sessionKey: 'session-drain',
    promptText: 'go',
  });

  const client = new AcpClient({
    db,
    workspaceRoot: '/tmp',
    agentCommand: 'node',
    agentArgs: [],
    rpc,
    promptUpdateIdleMs: 20,
    promptUpdateMaxWaitMs: 65,
    events: {
      onSessionUpdate: (_run, _sessionId, update) => {
        updates.push(String(update?.content?.text ?? ''));
      },
    },
  });

  const startedAt = Date.now();
  const result = await client.prompt(
    {
      runId: 'run-drain',
      sessionKey: 'session-drain',
      createdAtMs: startedAt,
    },
    {
      sessionId: 'sess-drain',
      prompt: [{ type: 'text', text: 'go' }],
    },
  );

  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.stopReason, 'end');
  assert.ok(elapsedMs >= 60 && elapsedMs < 140, `unexpected drain time: ${elapsedMs}ms`);
  assert.ok(updates.length >= 4, `expected several drained updates, got ${updates.length}`);
  assert.ok(updates.length < 8, `expected max wait to cut off trailing updates, got ${updates.length}`);

  client.close();
  db.close();
});

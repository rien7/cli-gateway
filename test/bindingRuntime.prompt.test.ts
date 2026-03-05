import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { ToolAuth } from '../src/gateway/toolAuth.js';
import { BindingRuntime } from '../src/gateway/bindingRuntime.js';
import {
  createRun,
  createSession,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';
import type { OutboundSink, UiEvent } from '../src/gateway/types.js';
import type { StdioProcess } from '../src/acp/stdio.js';
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from '../src/acp/jsonrpc.js';

class FakeRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private stderrHandlers: Array<(line: string) => void> = [];
  written: JsonRpcMessage[] = [];

  private promptRequestId: number | null = null;
  private sessionId = 'sess-1';
  private workspaceFile: string;

  constructor(params: { workspaceFile: string }) {
    this.workspaceFile = params.workspaceFile;
  }

  write(message: JsonRpcMessage): void {
    this.written.push(message);

    // Client -> Agent requests
    if ('method' in message) {
      const req = message as JsonRpcRequest;

      if (req.method === 'initialize') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
            },
          } as JsonRpcResponse);
        });
        return;
      }

      if (req.method === 'session/new') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: this.sessionId },
          } as JsonRpcResponse);
        });
        return;
      }

      if (req.method === 'session/prompt') {
        this.promptRequestId = Number(req.id);

        queueMicrotask(() => {
          // emit a tool call update (UI)
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                title: 'terminal/create',
              },
            },
          } as any);

          // emit a plan update
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: { sessionUpdate: 'plan', steps: [{ title: 'x' }] },
            },
          } as any);

          // request permission
          this.emit({
            jsonrpc: '2.0',
            id: 999,
            method: 'session/request_permission',
            params: {
              sessionId: this.sessionId,
              toolCall: { title: 'fs/read_text_file', kind: 'read' },
              options: [
                { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          } as any);
        });

        return;
      }

      return;
    }

    // Client -> Agent responses (permission/tool results)
    if ('id' in message && 'result' in message) {
      const res = message as JsonRpcResponse;

      if (typeof res.id === 'number' && res.id === 999) {
        queueMicrotask(() => {
          // after permission allowed, ask to read a file
          this.emit({
            jsonrpc: '2.0',
            id: 1000,
            method: 'fs/read_text_file',
            params: {
              sessionId: this.sessionId,
              path: this.workspaceFile,
            },
          } as any);
        });
        return;
      }

      if (typeof res.id === 'number' && res.id === 1000) {
        queueMicrotask(() => {
          // after file read, emit an agent chunk and finish prompt
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'done' },
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: this.promptRequestId!,
            result: { stopReason: 'end' },
          } as any);
        });
        return;
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(cb: (line: string) => void): void {
    this.stderrHandlers.push(cb);
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

class DirectToolRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private sessionId = 'sess-direct-tool';
  private promptRequestId: number | null = null;
  private workspaceFile: string;

  constructor(params: { workspaceFile: string }) {
    this.workspaceFile = params.workspaceFile;
  }

  write(message: JsonRpcMessage): void {
    if (!('method' in message)) {
      if ('id' in message && 'result' in message) {
        const res = message as JsonRpcResponse;
        if (res.id === 700) {
          queueMicrotask(() => {
            this.emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'done' },
                },
              },
            } as any);

            this.emit({
              jsonrpc: '2.0',
              id: this.promptRequestId!,
              result: { stopReason: 'end' },
            } as JsonRpcResponse);
          });
        }
      }
      return;
    }

    const req = message as JsonRpcRequest;

    if (req.method === 'initialize') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
          },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/new') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: { sessionId: this.sessionId },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/prompt') {
      this.promptRequestId = Number(req.id);
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: 700,
          method: 'fs/read_text_file',
          params: {
            sessionId: this.sessionId,
            path: this.workspaceFile,
          },
        } as any);
      });
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

class SummaryFilterRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private promptRequestId: number | null = null;
  private sessionId = 'sess-summary';

  write(message: JsonRpcMessage): void {
    if ('method' in message) {
      const req = message as JsonRpcRequest;

      if (req.method === 'initialize') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
            },
          } as JsonRpcResponse);
        });
        return;
      }

      if (req.method === 'session/new') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: this.sessionId },
          } as JsonRpcResponse);
        });
        return;
      }

      if (req.method === 'session/prompt') {
        this.promptRequestId = Number(req.id);

        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                title: 'call_1234',
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-1',
                title: 'terminal/create',
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-1',
                title: 'terminal/create',
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-1',
                title: 'terminal/create',
                status: 'completed',
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'done' },
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: this.promptRequestId!,
            result: { stopReason: 'end' },
          } as JsonRpcResponse);
        });
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

class UiFlushRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private sessionId = 'sess-ui-flush';
  private promptRequestId: number | null = null;

  write(message: JsonRpcMessage): void {
    if (!('method' in message)) return;
    const req = message as JsonRpcRequest;

    if (req.method === 'initialize') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
          },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/new') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: { sessionId: this.sessionId },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/prompt') {
      this.promptRequestId = Number(req.id);
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'flush-1',
              title: 'terminal/create',
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'flush-1',
              title: 'terminal/create',
              status: 'completed',
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'done' },
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          id: this.promptRequestId!,
          result: { stopReason: 'end' },
        } as JsonRpcResponse);
      });
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

class ActionSummaryRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private promptRequestId: number | null = null;
  private sessionId = 'sess-actions';

  write(message: JsonRpcMessage): void {
    if (!('method' in message)) return;
    const req = message as JsonRpcRequest;

    if (req.method === 'initialize') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
          },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/new') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: { sessionId: this.sessionId },
        } as JsonRpcResponse);
      });
      return;
    }

    if (req.method === 'session/prompt') {
      this.promptRequestId = Number(req.id);
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'action-1',
              title: 'Run npm test, Read src/main.ts, Edit src/main.ts',
              status: 'in_progress',
              kind: 'execute',
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'action-1',
              status: 'completed',
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'done' },
            },
          },
        } as any);

        this.emit({
          jsonrpc: '2.0',
          id: this.promptRequestId!,
          result: { stopReason: 'end' },
        } as JsonRpcResponse);
      });
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

test('BindingRuntime prompt emits plan/tool UI and supports interactive permission', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');
  const filePath = path.join(workspaceRoot, 'hello.txt');
  fs.writeFileSync(filePath, 'hello', 'utf8');

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's1';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;

  const toolAuth = new ToolAuth(db);

  const rpc = new FakeRpc({ workspaceFile: filePath });

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: rpc,
    workspaceRoot,
  });

  const uiEvents: UiEvent[] = [];
  const permissionRequests: any[] = [];
  const chunks: string[] = [];

  const sink: OutboundSink = {
    sendText: async (t) => {
      chunks.push(t);
    },
    requestPermission: async (req) => {
      permissionRequests.push(req);
    },
    sendUi: async (e) => {
      uiEvents.push(e);
    },
  };

  createRun(db, { runId: 'r1', sessionKey, promptText: 'go' });

  const pending = rt.prompt({
    runId: 'r1',
    promptText: 'go',
    sink,
    uiMode: 'verbose',
  });

  // Wait for the client to send the prompt, then for permission request.
  await waitUntil(() =>
    rpc.written.some((m: any) => typeof m?.method === 'string' && m.method === 'session/prompt'),
  );

  await waitUntil(() => permissionRequests.length === 1, {
    debug: () =>
      JSON.stringify(
        rpc.written
          .filter((m: any) => typeof m?.method === 'string')
          .map((m: any) => m.method),
      ),
  });

  const res = await rt.decidePermission({ decision: 'allow', requestId: '999' });
  assert.equal(res.ok, true);

  const out = await pending;
  assert.equal(out.stopReason, 'end');

  assert.ok(uiEvents.some((e) => e.kind === 'plan'));
  assert.ok(
    uiEvents.some(
      (e) => e.kind === 'tool' && e.title.startsWith('terminal/create ·'),
    ),
  );
  assert.ok(chunks.join('').includes('done'));

  // ensure allow decision granted exactly once
  assert.equal(toolAuth.consume(sessionKey, 'read'), false);

  rt.close();
  db.close();
});

test('BindingRuntime prompts interactively when tool is called without session/request_permission', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');
  const filePath = path.join(workspaceRoot, 'hello.txt');
  fs.writeFileSync(filePath, 'hello', 'utf8');

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's-direct';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new DirectToolRpc({ workspaceFile: filePath }),
    workspaceRoot,
  });

  createRun(db, { runId: 'r-direct', sessionKey, promptText: 'go' });

  const permissionRequests: any[] = [];
  const chunks: string[] = [];

  const sink: OutboundSink = {
    sendText: async (t) => {
      chunks.push(t);
    },
    requestPermission: async (req) => {
      permissionRequests.push(req);
      const decision = await rt.decidePermission({
        decision: 'allow',
        requestId: req.requestId,
        actorUserId: 'u',
      });
      assert.equal(decision.ok, true);
    },
  };

  const out = await rt.prompt({
    runId: 'r-direct',
    promptText: 'go',
    sink,
    uiMode: 'verbose',
    actorUserId: 'u',
  });

  assert.equal(out.stopReason, 'end');
  assert.equal(permissionRequests.length, 1);
  assert.equal(permissionRequests[0].toolKind, 'read');
  assert.ok(String(permissionRequests[0].toolTitle).includes(filePath));
  assert.ok(chunks.join('').includes('done'));

  rt.close();
  db.close();
});

test('BindingRuntime summary filters call_* tool titles and keeps named tools', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's2';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'summary',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new SummaryFilterRpc(),
    workspaceRoot,
  });

  const uiEvents: UiEvent[] = [];
  const chunks: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => {
      chunks.push(t);
    },
    sendUi: async (e) => {
      uiEvents.push(e);
    },
  };

  createRun(db, { runId: 'r2', sessionKey, promptText: 'go' });

  const out = await rt.prompt({
    runId: 'r2',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(out.stopReason, 'end');
  assert.ok(chunks.join('').includes('done'));

  const toolTitles = uiEvents
    .filter((e) => e.kind === 'tool')
    .map((e) => e.title);

  assert.deepEqual(toolTitles, [
    'terminal/create · started',
    'terminal/create · running',
    'terminal/create · completed',
  ]);

  rt.close();
  db.close();
});

test('BindingRuntime prompt waits for pending summary tool UI delivery', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's3';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'summary',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new UiFlushRpc(),
    workspaceRoot,
  });

  createRun(db, { runId: 'r3', sessionKey, promptText: 'go' });

  let uiStarted = false;
  let releaseUi: () => void = () => {};
  const uiReleaseGate = new Promise<void>((resolve) => {
    releaseUi = resolve;
  });

  const uiEvents: UiEvent[] = [];
  const chunks: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => {
      chunks.push(t);
    },
    sendUi: async (e) => {
      uiStarted = true;
      await uiReleaseGate;
      uiEvents.push(e);
    },
  };

  const pending = rt.prompt({
    runId: 'r3',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  await waitUntil(() => uiStarted);

  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);

  releaseUi();
  const out = await pending;

  assert.equal(out.stopReason, 'end');
  assert.ok(chunks.join('').includes('done'));
  assert.deepEqual(
    uiEvents.filter((e) => e.kind === 'tool').map((e) => e.title),
    ['terminal/create · started', 'terminal/create · completed'],
  );

  rt.close();
  db.close();
});

test('BindingRuntime summary renders actionable tool titles', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');
  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's4';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'summary',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new ActionSummaryRpc(),
    workspaceRoot,
  });

  const uiEvents: UiEvent[] = [];
  const chunks: string[] = [];
  const sink: OutboundSink = {
    sendText: async (text) => {
      chunks.push(text);
    },
    sendUi: async (event) => {
      uiEvents.push(event);
    },
  };

  createRun(db, { runId: 'r4', sessionKey, promptText: 'go' });

  const out = await rt.prompt({
    runId: 'r4',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(out.stopReason, 'end');
  assert.ok(chunks.join('').includes('done'));

  const toolTitles = uiEvents
    .filter((event) => event.kind === 'tool')
    .map((event) => event.title);

  assert.deepEqual(toolTitles, [
    'run: npm test (+2 more) · started',
    'run: npm test (+2 more) · completed',
  ]);

  rt.close();
  db.close();
});

test('BindingRuntime verbose tool details include action breakdown', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-test-');
  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's5';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: workspaceRoot,
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new ActionSummaryRpc(),
    workspaceRoot,
  });

  const uiEvents: UiEvent[] = [];
  const sink: OutboundSink = {
    sendText: async () => {
      // noop
    },
    sendUi: async (event) => {
      uiEvents.push(event);
    },
  };

  createRun(db, { runId: 'r5', sessionKey, promptText: 'go' });

  const out = await rt.prompt({
    runId: 'r5',
    promptText: 'go',
    sink,
    uiMode: 'verbose',
  });

  assert.equal(out.stopReason, 'end');

  const firstTool = uiEvents.find((event) => event.kind === 'tool');
  assert.ok(firstTool);
  assert.ok(firstTool?.detail?.includes('actions:'));
  assert.ok(firstTool?.detail?.includes('1. run: npm test'));
  assert.ok(firstTool?.detail?.includes('2. read: src/main.ts'));
  assert.ok(firstTool?.detail?.includes('3. edit: src/main.ts'));

  rt.close();
  db.close();
});

async function waitUntil(
  check: () => boolean,
  opts?: { debug?: () => string },
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) {
      const extra = opts?.debug ? ` debug=${opts.debug()}` : '';
      throw new Error(`timeout${extra}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

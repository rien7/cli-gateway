import test from 'node:test';
import assert from 'node:assert/strict';

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
import type { OutboundSink } from '../src/gateway/types.js';
import type { StdioProcess } from '../src/acp/stdio.js';
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../src/acp/jsonrpc.js';

class NoopRpc implements StdioProcess {
  private handlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  write(message: JsonRpcMessage): void {
    this.written.push(message);
  }
  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.handlers.push(cb);
  }
  onStderr(): void {}
  kill(): void {}
}

class PermReqRpc implements StdioProcess {
  private handlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  write(message: JsonRpcMessage): void {
    this.written.push(message);

    if ('method' in message) {
      const req = message as JsonRpcRequest;
      if (req.method === 'initialize') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
          } as any),
        );
      }
      if (req.method === 'session/new') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: 'sess' },
          } as any),
        );
      }
      if (req.method === 'session/prompt') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 999,
            method: 'session/request_permission',
            params: {
              sessionId: 'sess',
              toolCall: { title: 'terminal/create', kind: 'execute' },
              options: [
                { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { stopReason: 'end' },
          } as any);
        });
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.handlers.push(cb);
  }

  onStderr(): void {}
  kill(): void {}

  private emit(message: JsonRpcMessage): void {
    this.handlers.forEach((h) => h(message));
  }
}

class BranchingRpc implements StdioProcess {
  private handlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];
  promptRequests: JsonRpcRequest[] = [];

  private readonly updates: any[];
  private readonly loadSession: boolean;
  private sessionId = 'sess-branch';

  constructor(params: { updates: any[]; loadSession: boolean }) {
    this.updates = params.updates;
    this.loadSession = params.loadSession;
  }

  write(message: JsonRpcMessage): void {
    this.written.push(message);
    if (!('method' in message)) return;

    const req = message as JsonRpcRequest;
    if (req.method === 'initialize') {
      queueMicrotask(() => {
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: this.loadSession },
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
      this.promptRequests.push(req);
      queueMicrotask(() => {
        this.updates.forEach((update) => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: this.sessionId, update },
          } as any);
        });
        this.emit({
          jsonrpc: '2.0',
          id: req.id,
          result: { stopReason: 'end' },
        } as JsonRpcResponse);
      });
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.handlers.push(cb);
  }

  onStderr(): void {}
  kill(): void {}

  private emit(message: JsonRpcMessage): void {
    this.handlers.forEach((h) => h(message));
  }
}

test('denyPermission returns denied message', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  createSession(db, {
    sessionKey: 's1',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's1').bindingKey;

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 1,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [
        { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      ],
    },
  };

  const texts: string[] = [];
  await rt.denyPermission({ sendText: async (t) => texts.push(t) } as any);
  assert.ok(texts.at(-1)?.includes('denied'));

  rt.close();
});

test('decidePermission rejects expired requestId', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  createSession(db, {
    sessionKey: 's1',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's1').bindingKey;

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 2,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'r1', name: 'Reject once', kind: 'reject_once' }],
    },
  };

  const expired = await rt.decidePermission({ decision: 'deny', requestId: '999' });
  assert.equal(expired.ok, false);
  assert.ok(expired.message.includes('expired'));

  rt.close();
});

test('decidePermission persists allow_always policy', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  createSession(db, {
    sessionKey: 's1',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's1').bindingKey;

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 5,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'a', name: 'Allow always', kind: 'allow_always' }],
    },
  };

  const allowed = await rt.decidePermission({ decision: 'allow', requestId: '5' });
  assert.equal(allowed.ok, true);
  assert.equal(toolAuth.consume('s1', 'execute'), true);

  rt.close();
});

test('decidePermission persists reject_always and can cancel if no option exists', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  createSession(db, {
    sessionKey: 's1',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's1').bindingKey;

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  // reject_always branch
  (rt as any).pendingPermission = {
    requestId: 2,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [
        { optionId: 'r2', name: 'Reject always', kind: 'reject_always' },
      ],
    },
  };

  const denied = await rt.decidePermission({ decision: 'deny', requestId: '2' });
  assert.equal(denied.ok, true);
  assert.equal(toolAuth.consume('s1', 'execute'), false);

  // cancelled branch: allow requested but no allow option exists
  (rt as any).pendingPermission = {
    requestId: 3,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'r1', name: 'Reject once', kind: 'reject_once' }],
    },
  };

  const cancelled = await rt.decidePermission({ decision: 'allow', requestId: '3' });
  assert.equal(cancelled.ok, true);
  assert.ok(cancelled.message.includes('cancelled'));

  rt.close();
});

test('permission fallback text is used when sink has no interactive UI', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  createRun(db, { runId: 'r1', sessionKey, promptText: 'go' });

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new PermReqRpc(),
    workspaceRoot: '/tmp',
  });

  const texts: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => texts.push(t),
  };

  const res = await rt.prompt({
    runId: 'r1',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(res.stopReason, 'end');
  assert.ok(texts.join('\n').includes('[permission required]'));

  rt.close();
});

test('BindingRuntime prompt supports sendAgentText and fallback text UI rendering', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's2';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  createRun(db, { runId: 'r2', sessionKey, promptText: '' });
  createRun(db, { runId: 'r3', sessionKey, promptText: '' });

  const rpc = new BranchingRpc({
    loadSession: true,
    updates: [
      {
        sessionUpdate: 'tool_call_update',
        title: 'Fetch https://example.com/data.json',
        status: 'running',
        kind: 'fetch',
        path: '/tmp/out.json',
        cwd: '/tmp',
        result: { exitCode: 7, message: 'network unstable' },
      },
      { sessionUpdate: 'plan', steps: [{ title: 'step-1' }] },
      { sessionUpdate: 'task', task: 'do-it' },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'chunked' },
      },
    ],
  });

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: rpc,
    workspaceRoot: '/tmp',
  });

  const textOut: string[] = [];
  const chunkOut: string[] = [];

  const first = await rt.prompt({
    runId: 'r2',
    promptText: '',
    sink: {
      sendText: async (t) => textOut.push(t),
      sendAgentText: async (t) => chunkOut.push(t),
    },
    uiMode: 'verbose',
  });
  assert.equal(first.stopReason, 'end');
  assert.equal(rt.getLoadSupported(), true);
  assert.equal(rt.getPendingPermission(), null);

  const firstPromptReq = rpc.promptRequests[0];
  assert.ok(firstPromptReq);
  const firstPromptBlocks = (firstPromptReq.params as any).prompt as any[];
  assert.equal(firstPromptBlocks.length, 1);
  assert.deepEqual(firstPromptBlocks[0], { type: 'text', text: '' });

  assert.equal(chunkOut.join(''), 'chunked');
  assert.ok(textOut.some((line) => line.includes('[tool]')));
  assert.ok(textOut.some((line) => line.includes('[plan]')));
  assert.ok(textOut.some((line) => line.includes('[task]')));

  textOut.length = 0;
  chunkOut.length = 0;
  const second = await rt.prompt({
    runId: 'r3',
    promptText: '',
    promptResources: [{ uri: '::not-a-valid-url::', mimeType: 'image/png' }],
    sink: {
      sendText: async (t) => textOut.push(t),
      sendAgentText: async (t) => chunkOut.push(t),
    },
    uiMode: 'summary',
  });
  assert.equal(second.stopReason, 'end');
  assert.equal(chunkOut.join(''), 'chunked');
  assert.ok(textOut.every((line) => !line.includes('[tool]')));

  const secondPromptReq = rpc.promptRequests[1];
  assert.ok(secondPromptReq);
  const secondPromptBlocks = (secondPromptReq.params as any).prompt as any[];
  const resourceBlock = secondPromptBlocks.find(
    (item) => item.type === 'resource_link',
  );
  assert.ok(resourceBlock);
  assert.equal(resourceBlock.name, 'attachment-1');

  rt.close();
  db.close();
});

test('BindingRuntime breaks text stream once per tool call id', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c-break',
    threadId: null,
    userId: 'u-break',
  };

  const sessionKey = 's-break';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  createRun(db, { runId: 'r-break', sessionKey, promptText: '' });

  const rpc = new BranchingRpc({
    loadSession: false,
    updates: [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'before tool' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-break-1',
        title: 'Read src/main.ts',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-break-1',
        status: 'completed',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after tool' },
      },
    ],
  });

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth: new ToolAuth(db),
    sessionKey,
    bindingKey,
    acpRpc: rpc,
    workspaceRoot: '/tmp',
  });

  const chunks: string[] = [];
  const breaks: number[] = [];
  const uiTitles: string[] = [];

  const sink: OutboundSink = {
    sendText: async () => {},
    sendAgentText: async (t) => chunks.push(t),
    breakTextStream: async () => {
      breaks.push(Date.now());
    },
    sendUi: async (event) => {
      if (event.kind === 'tool') uiTitles.push(event.title);
    },
  };

  const result = await rt.prompt({
    runId: 'r-break',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(result.stopReason, 'end');
  assert.equal(chunks.join(''), 'before toolafter tool');
  assert.equal(breaks.length, 1);
  assert.equal(uiTitles.length, 2);

  rt.close();
  db.close();
});

test('buildToolUiEvent infers actionable titles and detail fields across branches', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };
  createSession(db, {
    sessionKey: 's3',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's3').bindingKey;

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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth: new ToolAuth(db),
    sessionKey: 's3',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).currentUiMode = 'verbose';

  const first = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc1',
    title: 'Run npm test, Read src/main.ts, Edit src/main.ts',
    kind: 'execute',
    command: 'npm',
    args: ['test'],
    error: { message: 'broken' },
    result: { exitCode: 3 },
  });
  assert.equal(first.title, 'run: npm test (+2 more) · started');
  assert.ok(String(first.detail).includes('1. run: npm test'));
  assert.ok(String(first.detail).includes('error: broken'));

  const sticky = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc1',
    title: 'Delete /tmp/file.txt',
    status: 'completed',
  });
  assert.equal(sticky.title, 'run: npm test (+2 more) · completed');

  const fromQuery = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    call_id: 'tc2',
    title: 'tool_call',
    kind: 'search',
    arguments: { query: 'TODO' },
    status: 'done',
    result: { message: 'all good' },
  });
  assert.equal(fromQuery.title, 'search: TODO · completed');
  assert.ok(String(fromQuery.detail).includes('path:') === false);

  const patternCases: Array<[string, string]> = [
    ['List src', 'list: src'],
    ['Fetch https://example.com', 'fetch: https://example.com'],
    ['Move a.txt to b.txt', 'move: a.txt to b.txt'],
    ['Delete tmp.log', 'delete: tmp.log'],
  ];
  for (const [title, expectedPrefix] of patternCases) {
    const event = (rt as any).buildToolUiEvent({
      sessionUpdate: 'tool_call_update',
      id: `case-${title}`,
      title,
      status: 'running',
    });
    assert.ok(String(event.title).startsWith(`${expectedPrefix} ·`));
  }

  const inferredFromKind = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    title: '???',
    kind: 'read',
    path: '/tmp/notes.txt',
    cmd: 'cat',
    result: { args: ['notes.txt', '  ', 7], error: 'disk busy' },
    status: 'error',
  });
  assert.ok(String(inferredFromKind.title).includes('read:'));
  assert.ok(String(inferredFromKind.detail).includes('command: cat notes.txt'));
  assert.ok(String(inferredFromKind.detail).includes('error: disk busy'));

  (rt as any).currentUiMode = 'summary';
  const summaryHidden = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    title: 'call_1234',
    status: 'running',
  });
  assert.equal(summaryHidden, null);

  const explicitMethod = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    title: 'FS/Read_Text_File',
    status: 'running',
  });
  assert.equal(explicitMethod.title, 'fs/read_text_file · running');

  const nonAlpha = (rt as any).buildToolUiEvent({
    sessionUpdate: 'tool_call_update',
    title: '12345',
    status: 'running',
  });
  assert.equal(nonAlpha, null);

  rt.close();
  db.close();
});

test('selectPermissionOption and decidePermission validate actor and pending state', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };
  createSession(db, {
    sessionKey: 's4',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  const bindingKey = upsertBinding(db, key, 's4').bindingKey;
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
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's4',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  const texts: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => texts.push(t),
  };

  await rt.selectPermissionOption(1, sink, 'u');
  assert.equal(texts.at(-1), 'No pending permission request.');

  (rt as any).pendingPermission = {
    requestId: 10,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'a', name: 'Allow always', kind: 'allow_always' }],
    },
  };
  (rt as any).pendingPermissionActorUserId = 'owner';

  await rt.selectPermissionOption(1, sink, 'other-user');
  assert.equal(texts.at(-1), 'Not authorized.');

  await rt.selectPermissionOption(9, sink, 'owner');
  assert.equal(texts.at(-1), 'Invalid option index: 9');

  await rt.selectPermissionOption(1, sink, 'owner');
  assert.ok(String(texts.at(-1)).includes('OK: selected option 1'));
  assert.equal(toolAuth.consume('s4', 'execute'), true);

  const noPending = await rt.decidePermission({ decision: 'allow' });
  assert.equal(noPending.ok, false);
  assert.ok(noPending.message.includes('No pending permission request'));

  rt.close();
  db.close();
});

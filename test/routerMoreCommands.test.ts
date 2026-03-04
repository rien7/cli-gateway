import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import {
  createRun,
  createSession,
  finishRun,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function createConfig() {
  return {
    discordToken: undefined,
    discordAllowChannelId: undefined,
    telegramToken: undefined,
    feishuAppId: undefined,
    feishuAppSecret: undefined,
    feishuVerificationToken: undefined,
    feishuListenPort: 3030,
    acpAgentCommand: 'node',
    acpAgentArgs: [],
    workspaceRoot: '/tmp/cli-gateway-test',
    dbPath: ':memory:',
    schedulerEnabled: false,
    runtimeIdleTtlSeconds: 1,
    maxBindingRuntimes: 1,
    uiDefaultMode: 'verbose',
    uiJsonMaxChars: 1000,
    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 0,
  };
}

function createSink() {
  const texts: string[] = [];
  return {
    texts,
    sink: {
      sendText: async (t: string) => texts.push(t),
      flush: async () => {},
    },
  };
}

test('command usage errors are reported', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  await router.handleUserMessage(key, '/ui', sink as any);
  assert.equal(texts.at(-1), 'UI mode: verbose');

  await router.handleUserMessage(key, '/cron', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage:'));

  await router.handleUserMessage(key, '/allow', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage:'));

  router.close();
});

test('/new rotates session and closes runtime', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  // Seed a binding/session via /cron add.
  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/cron add 0 0 * * * hi', sink as any);

  // Inject a fake runtime.
  const binding = db
    .prepare(
      'SELECT session_key as sessionKey FROM bindings WHERE platform = ? LIMIT 1',
    )
    .get('discord') as { sessionKey: string };

  let closed = false;
  (router as any).runtimesBySessionKey.set(binding.sessionKey, {
    runtime: { close: () => (closed = true) },
    lastUsedMs: Date.now(),
  });

  texts.length = 0;
  await router.handleUserMessage(key, '/new', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: started a new session'));
  assert.equal(closed, true);

  const rebound = db
    .prepare(
      'SELECT session_key as sessionKey FROM bindings WHERE platform = ? LIMIT 1',
    )
    .get('discord') as { sessionKey: string };
  assert.notEqual(rebound.sessionKey, binding.sessionKey);

  router.close();
});

test('/cli show and switch updates session agent config', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  await router.handleUserMessage(key, '/cli show', sink as any);
  assert.ok(String(texts.at(-1)).startsWith('CLI: Custom (node'));

  texts.length = 0;
  await router.handleUserMessage(key, '/cli codex', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: CLI switched to Codex'));

  const binding = db
    .prepare('SELECT session_key as sessionKey FROM bindings LIMIT 1')
    .get() as { sessionKey: string };
  const row = db
    .prepare(
      'SELECT agent_command as command, agent_args_json as argsJson FROM sessions WHERE session_key = ?',
    )
    .get(binding.sessionKey) as { command: string; argsJson: string };
  assert.equal(row.command, 'npx');
  assert.deepEqual(JSON.parse(row.argsJson), [
    '-y',
    '@zed-industries/codex-acp@latest',
  ]);

  texts.length = 0;
  await router.handleUserMessage(key, '/cli claude', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: CLI switched to Claude Code'));

  const claudeRow = db
    .prepare(
      'SELECT agent_command as command, agent_args_json as argsJson FROM sessions WHERE session_key = ?',
    )
    .get(binding.sessionKey) as { command: string; argsJson: string };
  assert.equal(claudeRow.command, 'npx');
  assert.deepEqual(JSON.parse(claudeRow.argsJson), [
    '-y',
    '@zed-industries/claude-code-acp@latest',
  ]);

  router.close();
});

test('sink flush errors are swallowed', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        prompt: async () => ({ stopReason: 'end', lastSeq: 0 }),
        close: () => {},
      }) as any,
  });

  const texts: string[] = [];
  await router.handleUserMessage(
    key,
    'hi',
    {
      sendText: async (t: string) => texts.push(t),
      flush: async () => {
        throw new Error('flush failed');
      },
    } as any,
  );

  // No throw; run still recorded.
  const row = db
    .prepare('SELECT stop_reason as stopReason FROM runs ORDER BY started_at DESC LIMIT 1')
    .get() as { stopReason: string | null };
  assert.equal(row.stopReason, 'end');

  router.close();
});

test('/allow and /deny dispatch to runtime methods', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  // Create a binding/session row.
  const router1 = new GatewayRouter({ db, config: createConfig() as any });
  await router1.handleUserMessage(key, '/cron add 0 0 * * * hi', { sendText: async () => {} } as any);
  router1.close();

  const binding = db
    .prepare('SELECT session_key as sessionKey FROM bindings LIMIT 1')
    .get() as { sessionKey: string };

  let allowCalled = false;
  let denyCalled = false;

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        selectPermissionOption: async () => {
          allowCalled = true;
        },
        denyPermission: async () => {
          denyCalled = true;
        },
        close: () => {},
      }) as any,
  });

  // Ensure runtime exists for this session key.
  (router as any).getOrCreateRuntime({
    sessionKey: binding.sessionKey,
    bindingKey: 'discord:c:-:u',
  });

  const { sink } = createSink();
  await router.handleUserMessage(key, '/allow 1', sink as any);
  await router.handleUserMessage(key, '/deny', sink as any);

  assert.equal(allowCalled, true);
  assert.equal(denyCalled, true);

  router.close();
});

test('runtimeFactory receives session agent config instead of global defaults', async () => {
  const db = createDb();
  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const routerSeed = new GatewayRouter({ db, config: createConfig() as any });
  await routerSeed.handleUserMessage(key, '/cli codex', { sendText: async () => {} } as any);
  routerSeed.close();

  let seenCommand = '';
  let seenArgs: string[] = [];

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: ({ agentCommand, agentArgs }) =>
      ({
        hasSessionId: () => true,
        prompt: async () => {
          seenCommand = agentCommand;
          seenArgs = agentArgs;
          return { stopReason: 'end', lastSeq: 0 };
        },
        close: () => {},
      }) as any,
  });

  await router.handleUserMessage(
    key,
    'hello',
    { sendText: async () => {}, flush: async () => {} } as any,
  );

  assert.equal(seenCommand, 'npx');
  assert.deepEqual(seenArgs, ['-y', '@zed-industries/codex-acp@latest']);

  router.close();
});

test('unknown command falls through to runtime prompt', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  let prompted = false;

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        prompt: async () => {
          prompted = true;
          return { stopReason: 'end', lastSeq: 0 };
        },
        close: () => {},
      }) as any,
  });

  await router.handleUserMessage(key, '/foo', { sendText: async () => {} } as any);
  assert.equal(prompted, true);

  router.close();
});

test('router error path reports and records run error', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: (_p) => {
      return {
        hasSessionId: () => false,
        prompt: async () => {
          throw new Error('boom');
        },
        close: () => {},
      } as any;
    },
  });

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, 'hi', sink as any);

  assert.ok(String(texts.join('\n')).includes('Error: boom'));

  const row = db
    .prepare('SELECT error FROM runs ORDER BY started_at DESC LIMIT 1')
    .get() as { error: string | null };
  assert.ok(String(row.error).includes('boom'));

  router.close();
});

test('/cron enable usage requires jobId', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/cron enable', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage: /cron enable'));

  router.close();
});

test('/cli validates aliases, unchanged path, and show formatting fallbacks', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'cli-room',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  await router.handleUserMessage(key, '/cli wat', sink as any);
  assert.equal(texts.at(-1), 'Usage: /cli show|codex|claude');

  texts.length = 0;
  await router.handleUserMessage(key, '/cli claude-code', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: CLI switched to Claude Code'));

  texts.length = 0;
  await router.handleUserMessage(key, '/cli claude_code', sink as any);
  assert.ok(String(texts.at(-1)).includes('CLI unchanged: Claude Code'));

  const binding = db
    .prepare('SELECT session_key as sessionKey FROM bindings LIMIT 1')
    .get() as { sessionKey: string };

  db.prepare(
    'UPDATE sessions SET agent_command = ?, agent_args_json = ? WHERE session_key = ?',
  ).run('my cmd', JSON.stringify(['', 'a b', '$x']), binding.sessionKey);

  texts.length = 0;
  await router.handleUserMessage(key, '/cli show', sink as any);
  assert.equal(texts.at(-1), 'CLI: Custom ("my cmd" "" "a b" "$x")');

  db.prepare(
    'UPDATE sessions SET agent_command = ?, agent_args_json = ? WHERE session_key = ?',
  ).run('node', '{"oops"', binding.sessionKey);

  texts.length = 0;
  await router.handleUserMessage(key, '/cli show', sink as any);
  assert.equal(texts.at(-1), 'CLI: Custom (node)');

  router.close();
});

test('/last and /replay cover malformed and fallback branches', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const noBinding: ConversationKey = {
    platform: 'discord',
    chatId: 'none',
    threadId: null,
    userId: 'u',
  };
  const { sink: sinkNone, texts: textNone } = createSink();
  await router.handleUserMessage(noBinding, '/replay', sinkNone as any);
  assert.equal(textNone.at(-1), 'No session binding. Send a message first.');

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'history-room',
    threadId: null,
    userId: 'u',
  };
  createSession(db, {
    sessionKey: 's-history',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  upsertBinding(db, key, 's-history');

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/last', sink as any);
  assert.equal(texts.at(-1), 'No runs for this session yet.');

  createRun(db, { runId: 'r-empty', sessionKey: 's-history', promptText: 'x' });
  db.prepare(
    'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run('r-empty', 1, 'session/update', '{bad json', Date.now());
  finishRun(db, { runId: 'r-empty', stopReason: 'end' });

  texts.length = 0;
  await router.handleUserMessage(key, '/last', sink as any);
  assert.equal(texts.at(-1), 'end');

  createRun(db, { runId: 'r-error', sessionKey: 's-history', promptText: 'y' });
  finishRun(db, { runId: 'r-error', error: 'boom' });
  db.prepare('UPDATE runs SET started_at = ? WHERE run_id = ?').run(
    Date.now() + 1000,
    'r-error',
  );

  texts.length = 0;
  await router.handleUserMessage(key, '/last', sink as any);
  assert.equal(texts.at(-1), 'Last run error: boom');

  db.prepare(
    'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run(
    'r-error',
    1,
    'session/update',
    JSON.stringify({
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-replay', title: 'web/fetch' },
    }),
    Date.now(),
  );
  db.prepare(
    'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run('r-error', 2, 'session/update', '{still-bad', Date.now());
  db.prepare(
    'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run(
    'r-error',
    3,
    'session/update',
    JSON.stringify({ update: { sessionUpdate: 'noop' } }),
    Date.now(),
  );

  texts.length = 0;
  await router.handleUserMessage(key, '/replay r-error', sink as any);
  assert.ok(texts.join('\n').includes('[tool] web/fetch · started (tc-replay)'));

  const freshKey: ConversationKey = {
    platform: 'discord',
    chatId: 'fresh',
    threadId: null,
    userId: 'u',
  };
  createSession(db, {
    sessionKey: 's-fresh',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  upsertBinding(db, freshKey, 's-fresh');
  const { sink: freshSink, texts: freshTexts } = createSink();
  await router.handleUserMessage(freshKey, '/replay', freshSink as any);
  assert.equal(freshTexts.at(-1), 'No runs for this session yet.');

  router.close();
});

test('handlePermissionUi failure branches and runtime dispatch are covered', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  let out = await router.handlePermissionUi({
    platform: 'discord',
    sessionKey: 'missing-session',
    requestId: 'r1',
    decision: 'allow',
    actorUserId: 'u',
  });
  assert.equal(out.message, 'Unknown session binding.');

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'perm-room',
    threadId: null,
    userId: 'owner',
  };
  createSession(db, {
    sessionKey: 's-perm',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });
  upsertBinding(db, key, 's-perm');

  out = await router.handlePermissionUi({
    platform: 'telegram',
    sessionKey: 's-perm',
    requestId: 'r1',
    decision: 'allow',
    actorUserId: 'owner',
  });
  assert.equal(out.message, 'Permission binding platform mismatch.');

  out = await router.handlePermissionUi({
    platform: 'discord',
    sessionKey: 's-perm',
    requestId: 'r1',
    decision: 'allow',
    actorUserId: 'intruder',
  });
  assert.equal(out.message, 'Not authorized.');

  out = await router.handlePermissionUi({
    platform: 'discord',
    sessionKey: 's-perm',
    requestId: 'r1',
    decision: 'allow',
    actorUserId: 'owner',
  });
  assert.equal(out.message, 'No active runtime. Send a message first.');

  let called = false;
  (router as any).runtimesBySessionKey.set('s-perm', {
    runtime: {
      decidePermission: async () => {
        called = true;
        return { ok: true, message: 'OK: allowed.' };
      },
      close: () => {},
    },
    lastUsedMs: Date.now(),
  });

  out = await router.handlePermissionUi({
    platform: 'discord',
    sessionKey: 's-perm',
    requestId: 'r2',
    decision: 'deny',
    actorUserId: 'owner',
  });
  assert.equal(out.ok, true);
  assert.equal(called, true);

  router.close();
});

test('router start/gc/runtime-limit and empty message behavior', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });
  await router.start();

  let closedA = false;
  let closedB = false;
  (router as any).runtimesBySessionKey.set('old', {
    runtime: { close: () => (closedA = true) },
    lastUsedMs: Date.now() - 10_000,
  });
  (router as any).runtimesBySessionKey.set('new', {
    runtime: { close: () => (closedB = true) },
    lastUsedMs: Date.now(),
  });

  (router as any).enforceRuntimeLimit();
  assert.equal(closedA, true);
  assert.equal((router as any).runtimesBySessionKey.has('new'), true);

  const kept = (router as any).runtimesBySessionKey.get('new');
  kept.lastUsedMs = Date.now() - 10_000;
  (router as any).gc();
  assert.equal(closedB, true);
  assert.equal((router as any).runtimesBySessionKey.size, 0);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'empty-room',
    threadId: null,
    userId: 'u',
  };

  await router.handleUserMessage(
    key,
    '   ',
    {
      sendText: async () => {},
    } as any,
  );
  const runs = db.prepare('SELECT COUNT(*) as n FROM runs').get() as { n: number };
  assert.equal(runs.n, 0);

  const texts: string[] = [];
  await router.handleUserMessage(
    key,
    '/help',
    {
      sendText: async (t: string) => texts.push(t),
      flush: async () => {
        throw new Error('flush boom');
      },
    } as any,
  );
  assert.ok(String(texts.at(-1)).includes('Commands:'));

  router.close();
});

test('attachment-only prompts are persisted with attachment summary text', async () => {
  const db = createDb();
  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        prompt: async () => ({ stopReason: 'end', lastSeq: 0 }),
        close: () => {},
      }) as any,
  });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'resource-room',
    threadId: null,
    userId: 'u',
  };

  await router.handleUserMessage(
    key,
    '',
    { sendText: async () => {}, flush: async () => {} } as any,
    {
      resources: [
        { uri: 'https://example.com/a.png', mimeType: 'image/png' },
        { uri: 'https://example.com/b.png', mimeType: 'image/png' },
      ],
    },
  );

  const row = db
    .prepare('SELECT prompt_text as promptText FROM runs ORDER BY started_at DESC LIMIT 1')
    .get() as { promptText: string };
  assert.equal(row.promptText, '[attachments] 2 images');

  router.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDiscordSink } from '../src/channels/discordSink.js';

function createFakeChannel() {
  const sent: any[] = [];
  const edits: any[] = [];
  const reactions: Array<{ id: string; emoji: string }> = [];

  const channel = {
    send: async (payload: any) => {
      sent.push(payload);
      const id = String(sent.length);
      return {
        id,
        react: async (emoji: string) => {
          reactions.push({ id, emoji });
        },
      };
    },
    messages: {
      fetch: async (id: string) => ({
        edit: async (text: string) => {
          edits.push({ id, text });
        },
      }),
    },
  } as any;

  return { channel, sent, edits, reactions };
}

test('discord sink renders permission as embed + buttons', async () => {
  const { channel, sent, reactions } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'fs/read_text_file',
    toolKind: 'read',
    toolName: 'fs/read_text_file',
    toolArgs: { path: '/tmp/a.txt', line: 3 },
  });

  const msg = sent.at(-1);
  assert.ok(msg.embeds?.length);
  assert.ok(msg.components?.length);
  assert.ok(String(msg.content).includes('<@user1>'));
  const embed = msg.embeds[0]?.data ?? {};
  assert.equal(embed.title, undefined);
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  assert.deepEqual(
    fields.map((f: any) => f.name),
    ['Tool', 'Reason', 'Path'],
  );
  assert.equal(fields[0]?.value, 'fs/read_text_file');
  assert.equal(fields[1]?.value, '(not provided)');
  assert.ok(String(fields[2]?.value).includes('/tmp/a.txt'));
  assert.deepEqual(
    reactions.map((item) => item.emoji),
    ['👍', '👎'],
  );
});

test('discord sink renders execute permission with reason and command only', async () => {
  const { channel, sent } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'terminal/create',
    toolKind: 'execute',
    toolName: 'terminal/create',
    toolArgs: {
      reason: 'Run tests before patching',
      command: 'npm',
      args: ['test', '--', '--runInBand'],
      cwd: '/tmp',
    },
  });

  const msg = sent.at(-1);
  const embed = msg.embeds[0]?.data ?? {};
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  assert.deepEqual(
    fields.map((f: any) => f.name),
    ['Tool', 'Reason', 'Command'],
  );
  assert.equal(fields[1]?.value, 'Run tests before patching');
  assert.ok(String(fields[2]?.value).includes('npm test -- --runInBand'));
  assert.equal(fields.length, 3);
});

test('discord sink renders execute permission from json-string args payload', async () => {
  const { channel, sent } = createFakeChannel();
  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'functions.exec_command',
    toolKind: 'execute',
    toolName: 'functions.exec_command',
    toolArgs: JSON.stringify({
      cmd: 'bash scripts/run-guard.sh request-restart',
      justification: 'Request restart through run-guard',
    }),
  });

  const msg = sent.at(-1);
  const embed = msg.embeds[0]?.data ?? {};
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  assert.deepEqual(
    fields.map((f: any) => f.name),
    ['Tool', 'Reason', 'Command'],
  );
  assert.equal(fields[1]?.value, 'Request restart through run-guard');
  assert.ok(String(fields[2]?.value).includes('bash scripts/run-guard.sh request-restart'));
});

test('discord sink renders execute permission from double-encoded json payload', async () => {
  const { channel, sent } = createFakeChannel();
  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'functions.exec_command',
    toolKind: 'execute',
    toolName: 'functions.exec_command',
    toolArgs: JSON.stringify(
      JSON.stringify({
        cmd: 'echo hello world',
        justification: 'Run a quick health check',
      }),
    ),
  });

  const msg = sent.at(-1);
  const embed = msg.embeds[0]?.data ?? {};
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  assert.deepEqual(
    fields.map((f: any) => f.name),
    ['Tool', 'Reason', 'Command'],
  );
  assert.equal(fields[1]?.value, 'Run a quick health check');
  assert.ok(String(fields[2]?.value).includes('echo hello world'));
});

test('discord sink renders execute permission from key-value list payload', async () => {
  const { channel, sent } = createFakeChannel();
  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'functions.exec_command',
    toolKind: 'execute',
    toolName: 'functions.exec_command',
    toolArgs: {
      input: [
        { name: 'justification', value: 'Run a quick health check' },
        { key: 'cmd', value: 'echo hello world' },
      ],
    },
  });

  const msg = sent.at(-1);
  const embed = msg.embeds[0]?.data ?? {};
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  assert.deepEqual(
    fields.map((f: any) => f.name),
    ['Tool', 'Reason', 'Command'],
  );
  assert.equal(fields[1]?.value, 'Run a quick health check');
  assert.ok(String(fields[2]?.value).includes('echo hello world'));
});

test('discord sink renders tool UI events as plain text', async () => {
  const { channel, sent } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');

  await sink.sendUi!({
    kind: 'tool',
    mode: 'verbose',
    title: 'fs/read_text_file',
    detail: '{"a":1}',
  });

  const msg = sent.at(-1);
  assert.equal(typeof msg, 'string');
  assert.ok(msg.includes('[tool] fs/read_text_file'));
  assert.ok(msg.includes('{"a":1}'));
});

test('discord sink updates tool UI text when toolCallId repeats', async () => {
  const { channel, sent, edits } = createFakeChannel();
  const sink = createDiscordSink(channel, 'user1');

  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'fs/read_text_file · started',
    toolCallId: 'tc-1',
  });
  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'fs/read_text_file · completed',
    toolCallId: 'tc-1',
  });

  assert.equal(sent.length, 1);
  assert.equal(edits.length, 1);
  assert.ok(String(edits[0]?.text).includes('completed'));
});

test('discord sink truncates overlong embed titles for non-tool UI', async () => {
  const { channel, sent } = createFakeChannel();
  const sink = createDiscordSink(channel, 'user1');

  await sink.sendUi!({
    kind: 'plan',
    mode: 'summary',
    title: 'x'.repeat(400),
  });

  const msg = sent.at(-1);
  const raw = msg.embeds?.[0]?.data?.title ?? '';
  assert.ok(typeof raw === 'string');
  assert.ok(raw.length <= 256);
});

test('discord sink supports buffered streaming', async () => {
  const { channel, sent, edits } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');
  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  assert.ok(sent.length >= 1);
  assert.ok(edits.length >= 1);
});

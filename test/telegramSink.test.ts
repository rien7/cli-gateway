import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramSink } from '../src/channels/telegramSink.js';

function createFakeBot() {
  const calls: any[] = [];

  const bot = {
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push({ method: 'sendMessage', args });
        return { message_id: calls.length };
      },
      editMessageText: async (...args: any[]) => {
        calls.push({ method: 'editMessageText', args });
      },
    },
  } as any;

  return { bot, calls };
}

function createFetchRecorder() {
  const calls: any[] = [];

  const fetchFn = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      json: async () => ({ ok: true, result: true }),
    } as any;
  };

  return { fetchFn, calls };
}

test('telegram sink renders permission with inline keyboard + HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'fs/read_text_file',
    toolKind: 'read',
  });

  const call = calls.find((c) => c.method === 'sendMessage');
  assert.ok(call);
  assert.equal(call.args[0], 1);
  assert.equal(call.args[2].parse_mode, 'HTML');
  assert.ok(call.args[2].reply_markup);
});

test('telegram sink renders UI events with HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');
  await sink.sendUi!({
    kind: 'plan',
    mode: 'verbose',
    title: 'Plan updated',
    detail: '{"x":1}',
  });

  const call = calls.at(-1);
  assert.equal(call.method, 'sendMessage');
  assert.equal(call.args[2].parse_mode, 'HTML');
});

test('telegram sink streams drafts in private chat and sends final message on flush', async () => {
  const { bot, calls } = createFakeBot();
  const { fetchFn, calls: fetchCalls } = createFetchRecorder();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1', {
    fetchFn,
    draftId: 123,
    draftIntervalMs: 1,
  });

  await sink.sendText('a');
  await sink.sendText('b');
  await sink.flush();

  assert.ok(fetchCalls.some((c) => c.url.includes('/sendMessageDraft')));

  const draftCall = fetchCalls.find((c) => c.url.includes('/sendMessageDraft'));
  assert.ok(draftCall);
  const body = JSON.parse(draftCall.init.body);
  assert.equal(body.draft_id, 123);
  assert.equal(body.chat_id, 1);

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(!calls.some((c) => c.method === 'editMessageText'));

  const state = sink.getDeliveryState?.();
  assert.ok(state);
  assert.ok(state.messageId);
});

test('telegram sink draft timer updates without flush', async () => {
  const { bot } = createFakeBot();
  const { fetchFn, calls: fetchCalls } = createFetchRecorder();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1', {
    fetchFn,
    draftId: 123,
    draftIntervalMs: 5,
  });

  await sink.sendText('x');
  await new Promise((r) => setTimeout(r, 25));

  assert.ok(fetchCalls.some((c) => c.url.includes('/sendMessageDraft')));
});

test('telegram sink falls back to send+edit in group chat', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', -1, null, 'u1');
  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
});

test('telegram group sink renders permission and UI', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', -1, null, 'u1');

  await sink.requestPermission!({
    uiMode: 'summary',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'terminal/create',
    toolKind: 'execute',
  });

  await sink.sendUi!({
    kind: 'tool',
    mode: 'verbose',
    title: 'terminal/create',
    detail: '{"a":1}',
  });

  const permission = calls.find((c) => c.method === 'sendMessage');
  assert.ok(permission);
  assert.equal(permission.args[2].parse_mode, 'HTML');
  assert.ok(permission.args[2].reply_markup);

  const ui = calls.at(-1);
  assert.equal(ui.method, 'sendMessage');
  assert.equal(ui.args[2].parse_mode, 'HTML');
  assert.ok(String(ui.args[1]).includes('<pre><code>'));
});

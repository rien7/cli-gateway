import test from 'node:test';
import assert from 'node:assert/strict';

import { sendMessageDraft, setMessageReaction } from '../src/channels/telegramApi.js';

function createFetchRecorder(result: any) {
  const calls: any[] = [];

  const fetchFn = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      json: async () => result,
    } as any;
  };

  return { fetchFn, calls };
}

test('sendMessageDraft posts to Telegram API', async () => {
  const { fetchFn, calls } = createFetchRecorder({ ok: true, result: true });

  await sendMessageDraft(
    'TOKEN',
    { chatId: 1, threadId: null, draftId: 7, text: 'hi' },
    fetchFn as any,
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/botTOKEN/sendMessageDraft'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 1);
  assert.equal(body.draft_id, 7);
  assert.equal(body.text, 'hi');
});

test('setMessageReaction posts emoji reaction', async () => {
  const { fetchFn, calls } = createFetchRecorder({ ok: true, result: true });

  await setMessageReaction(
    'TOKEN',
    { chatId: 1, messageId: 2, emoji: '👀' },
    fetchFn as any,
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/botTOKEN/setMessageReaction'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 1);
  assert.equal(body.message_id, 2);
  assert.equal(body.reaction[0].emoji, '👀');
});

test('sendMessageDraft throws on API error', async () => {
  const { fetchFn } = createFetchRecorder({
    ok: false,
    error_code: 400,
    description: 'bad',
  });

  await assert.rejects(() =>
    sendMessageDraft(
      'TOKEN',
      { chatId: 1, threadId: null, draftId: 7, text: 'hi' },
      fetchFn as any,
    ),
  );
});

test('setMessageReaction throws on API error', async () => {
  const { fetchFn } = createFetchRecorder({
    ok: false,
    error_code: 400,
    description: 'bad',
  });

  await assert.rejects(() =>
    setMessageReaction(
      'TOKEN',
      { chatId: 1, messageId: 2, emoji: '👀' },
      fetchFn as any,
    ),
  );
});

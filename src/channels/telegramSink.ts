import { InlineKeyboard, type Bot } from 'grammy';

import type { OutboundSink } from '../gateway/router.js';
import { createBufferedSink } from './bufferedSink.js';
import { sendMessageDraft } from './telegramApi.js';

export function createTelegramSink(
  bot: Bot,
  token: string,
  chatId: number,
  threadId: number | null,
  userId: string,
  opts?: {
    fetchFn?: typeof fetch;
    draftId?: number;
    draftIntervalMs?: number;
  },
): OutboundSink & { flush: () => Promise<void> } {
  // sendMessageDraft only supports private chats.
  const useDraftStreaming = chatId > 0;

  if (!useDraftStreaming) {
    const buffered = createBufferedSink({
      maxLen: 3800,
      flushIntervalMs: 700,
      send: async (text) => {
        const msg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: threadId ?? undefined,
        });
        return { id: String(msg.message_id) };
      },
      edit: async (id, text) => {
        // grammY typings currently don't expose message_thread_id for editMessageText.
        await bot.api.editMessageText(chatId, Number(id), text, {
          ...(threadId ? ({ message_thread_id: threadId } as any) : {}),
        });
      },
    });

    return {
      sendText: buffered.sendText,
      flush: buffered.flush,
      getDeliveryState: buffered.getState,
      requestPermission: async (req) => {
        const allowData = `acpperm:${req.sessionKey}:${req.requestId}:allow`;
        const denyData = `acpperm:${req.sessionKey}:${req.requestId}:deny`;

        const keyboard = new InlineKeyboard()
          .text('✅ Allow', allowData)
          .text('❌ Deny', denyData);

        const toolKind = req.toolKind ? ` (${req.toolKind})` : '';
        const prefix =
          req.uiMode === 'summary' ? '[permission]' : 'Permission required:';
        const text = `${prefix} ${req.toolTitle}${toolKind}. Only user ${userId} can approve.`;

        await bot.api.sendMessage(chatId, escapeHtml(text), {
          message_thread_id: threadId ?? undefined,
          reply_markup: keyboard,
          parse_mode: 'HTML',
        });
      },
      sendUi: async (event) => {
        const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(event.title)}`;

        if (event.detail && event.mode === 'verbose') {
          const code = escapeHtml(truncate(event.detail, 3200));
          await bot.api.sendMessage(
            chatId,
            `${header}\n\n<pre><code>${code}</code></pre>`,
            {
              message_thread_id: threadId ?? undefined,
              parse_mode: 'HTML',
            },
          );
          return;
        }

        await bot.api.sendMessage(chatId, header, {
          message_thread_id: threadId ?? undefined,
          parse_mode: 'HTML',
        });
      },
    };
  }

  // Draft streaming path.
  const fetchFn = opts?.fetchFn ?? fetch;
  const draftId = opts?.draftId ?? randomDraftId();
  const draftIntervalMs = opts?.draftIntervalMs ?? 650;

  let text = '';
  let messageId: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let updating = false;
  let draftEnabled = true;

  async function updateDraft(): Promise<void> {
    if (!draftEnabled) return;
    if (updating) return;
    if (!text) return;

    updating = true;
    try {
      await sendMessageDraft(
        token,
        {
          chatId,
          threadId,
          draftId,
          text: truncate(text, 4096),
        },
        fetchFn,
      );
    } catch {
      // If Bot API doesn't support it (or chat doesn't), fall back silently.
      draftEnabled = false;
    } finally {
      updating = false;
    }
  }

  function scheduleDraft(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void updateDraft().catch(() => {
        // ignore
      });
    }, draftIntervalMs);
  }

  return {
    sendText: async (delta: string) => {
      if (!delta) return;
      text += delta;
      scheduleDraft();
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      // Best-effort draft update; do not block final send.
      try {
        await updateDraft();
      } catch {
        // ignore
      }

      const finalText = truncate(text, 4096);
      if (!finalText.trim()) return;

      const msg = await bot.api.sendMessage(chatId, finalText, {
        message_thread_id: threadId ?? undefined,
      });
      messageId = String(msg.message_id);

      // Store what we actually sent.
      text = finalText;
    },
    getDeliveryState: () => ({ text, messageId }),
    requestPermission: async (req) => {
      const allowData = `acpperm:${req.sessionKey}:${req.requestId}:allow`;
      const denyData = `acpperm:${req.sessionKey}:${req.requestId}:deny`;

      const keyboard = new InlineKeyboard()
        .text('✅ Allow', allowData)
        .text('❌ Deny', denyData);

      const toolKind = req.toolKind ? ` (${req.toolKind})` : '';
      const prefix =
        req.uiMode === 'summary' ? '[permission]' : 'Permission required:';
      const msgText = `${prefix} ${req.toolTitle}${toolKind}. Only user ${userId} can approve.`;

      await bot.api.sendMessage(chatId, escapeHtml(msgText), {
        message_thread_id: threadId ?? undefined,
        reply_markup: keyboard,
        parse_mode: 'HTML',
      });
    },
    sendUi: async (event) => {
      const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(event.title)}`;

      if (event.detail && event.mode === 'verbose') {
        const code = escapeHtml(truncate(event.detail, 3200));
        await bot.api.sendMessage(
          chatId,
          `${header}\n\n<pre><code>${code}</code></pre>`,
          {
            message_thread_id: threadId ?? undefined,
            parse_mode: 'HTML',
          },
        );
        return;
      }

      await bot.api.sendMessage(chatId, header, {
        message_thread_id: threadId ?? undefined,
        parse_mode: 'HTML',
      });
    },
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function randomDraftId(): number {
  // Must be non-zero.
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

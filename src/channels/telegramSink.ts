import { InlineKeyboard, type Bot } from 'grammy';

import type { OutboundSink } from '../gateway/router.js';
import type { UiEvent } from '../gateway/types.js';
import { createBufferedSink } from './bufferedSink.js';

type ToolUiEvent = Extract<UiEvent, { kind: 'tool' }>;

export function createTelegramSink(
  bot: Bot,
  _token: string,
  chatId: number,
  threadId: number | null,
  userId: string,
  opts?: {
    flushIntervalMs?: number;
  },
): OutboundSink & { flush: () => Promise<void> } {
  const isPrivateChat = chatId > 0;
  const toolUiMessageById = new Map<string, number>();
  let toolUiFallbackSeq = 0;

  if (!isPrivateChat) {
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
      sendAgentText: buffered.sendText,
      sendText: buffered.sendText,
      breakTextStream: buffered.breakMessage,
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
        if (event.kind === 'tool') {
          await upsertToolUiMessage({
            bot,
            chatId,
            threadId,
            event,
            toolUiMessageById,
            nextFallbackKey: () => `tool:${++toolUiFallbackSeq}`,
          });
          return;
        }

        const safeTitle = truncate(event.title, 500);
        const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(safeTitle)}`;

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

  // Private chat path: stream assistant text by editing one message.
  const agentBuffered = createBufferedSink({
    maxLen: 3800,
    flushIntervalMs: opts?.flushIntervalMs ?? 650,
    send: async (text) => {
      const msg = await bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId ?? undefined,
      });
      return { id: String(msg.message_id) };
    },
    edit: async (id, text) => {
      await bot.api.editMessageText(chatId, Number(id), text, {
        ...(threadId ? ({ message_thread_id: threadId } as any) : {}),
      });
    },
  });
  return {
    sendAgentText: agentBuffered.sendText,
    breakTextStream: agentBuffered.breakMessage,
    sendText: async (delta: string) => {
      if (!delta.trim()) return;
      await bot.api.sendMessage(chatId, truncate(delta, 4096), {
        message_thread_id: threadId ?? undefined,
      });
    },
    flush: async () => {
      await agentBuffered.flush();
    },
    getDeliveryState: agentBuffered.getState,
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
      if (event.kind === 'tool') {
        await upsertToolUiMessage({
          bot,
          chatId,
          threadId,
          event,
          toolUiMessageById,
          nextFallbackKey: () => `tool:${++toolUiFallbackSeq}`,
        });
        return;
      }

      const safeTitle = truncate(event.title, 500);
      const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(safeTitle)}`;

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

async function upsertToolUiMessage(params: {
  bot: Bot;
  chatId: number;
  threadId: number | null;
  event: ToolUiEvent;
  toolUiMessageById: Map<string, number>;
  nextFallbackKey: () => string;
}): Promise<void> {
  const key = params.event.toolCallId?.trim() || params.nextFallbackKey();
  const text = formatToolUiText(params.event);
  const existingId = params.toolUiMessageById.get(key);

  if (!existingId) {
    const msg = await params.bot.api.sendMessage(params.chatId, text, {
      message_thread_id: params.threadId ?? undefined,
      parse_mode: 'HTML',
    });
    params.toolUiMessageById.set(key, msg.message_id);
    return;
  }

  try {
    await params.bot.api.editMessageText(params.chatId, existingId, text, {
      ...(params.threadId ? ({ message_thread_id: params.threadId } as any) : {}),
      parse_mode: 'HTML',
    });
  } catch {
    const msg = await params.bot.api.sendMessage(params.chatId, text, {
      message_thread_id: params.threadId ?? undefined,
      parse_mode: 'HTML',
    });
    params.toolUiMessageById.set(key, msg.message_id);
  }
}

function formatToolUiText(event: ToolUiEvent): string {
  const safeTitle = truncate(event.title, 500);
  const header = `<b>[tool]</b> ${escapeHtml(safeTitle)}`;
  if (event.detail && event.mode === 'verbose') {
    const code = escapeHtml(truncate(event.detail, 3200));
    return `${header}\n\n<pre><code>${code}</code></pre>`;
  }
  return header;
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

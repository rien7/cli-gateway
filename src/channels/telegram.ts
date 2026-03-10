import { Bot } from 'grammy';

import type {
  CliInlineCommand,
  GatewayRouter,
  OutboundSink,
  UserResource,
} from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import {
  SHARED_CHAT_SCOPE_USER_ID,
  type ConversationKey,
} from '../gateway/sessionStore.js';
import { createTelegramSink } from './telegramSink.js';
import { setChatMenuButton, setMessageReaction } from './telegramApi.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
  ) => OutboundSink & { flush: () => Promise<void> };
};

const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 650;

type PendingTelegramMediaGroup = {
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  mediaGroupId: string;
  texts: string[];
  resources: UserResource[];
  messageIds: number[];
  flushTimer: ReturnType<typeof setTimeout> | null;
};

export async function startTelegram(
  router: GatewayRouter,
  config: AppConfig,
): Promise<TelegramController | null> {
  if (!config.telegramToken) {
    log.info('Telegram disabled: missing TELEGRAM_TOKEN');
    return null;
  }

  const bot = new Bot(config.telegramToken);
  const chatCommandSignatures = new Map<number, string>();
  const pendingMediaGroups = new Map<string, PendingTelegramMediaGroup>();

  const tgCommands = [
    { command: 'help', description: 'Show commands' },
    { command: 'ui', description: 'Set UI mode (verbose/summary)' },
    { command: 'cli', description: 'Show/switch ACP CLI preset' },
    { command: 'workspace', description: 'Show/set workspace' },
    { command: 'model', description: 'Show/list/set workspace model' },
    { command: 'effort', description: 'Show/list/set workspace effort' },
    { command: 'cron', description: 'Manage scheduler jobs' },
    { command: 'new', description: 'Reset conversation session' },
    { command: 'last', description: 'Show last run output' },
    { command: 'replay', description: 'Replay a run output' },
  ];

  // Best-effort: register commands.
  void bot.api
    .setMyCommands(tgCommands)
    .catch((err) => log.warn('Telegram setMyCommands(default) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_private_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(private) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_group_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(group) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_chat_administrators' } })
    .catch((err) => log.warn('Telegram setMyCommands(admins) error', err));

  // Force Telegram UI to show the command menu button.
  void setChatMenuButton(config.telegramToken, {}, fetch).catch((err: unknown) =>
    log.warn('Telegram setChatMenuButton(default) error', err),
  );

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';

    // Always answer quickly so the client doesn't spin.
    try {
      await ctx.answerCallbackQuery({ text: 'Processing...', show_alert: false });
    } catch {
      // ignore
    }

    if (!data.startsWith('acpperm:')) return;

    try {
      const parts = data.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
        return;
      }

      const actorUserId = String(ctx.from?.id ?? '');

      const res = await router.handlePermissionUi({
        platform: 'telegram',
        sessionKey,
        requestId,
        decision,
        actorUserId,
      });

      const msg = ctx.callbackQuery.message;
      if (msg) {
        const emoji = decision === 'allow' ? '👍' : '👎';
        void setMessageReaction(
          config.telegramToken,
          {
            chatId: msg.chat.id,
            messageId: msg.message_id,
            emoji,
            isBig: false,
          },
          fetch,
        ).catch(() => {
          // ignore
        });

        if (res.ok) {
          try {
            await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // ignore
          }
        }
      }

      // Visible confirmation.
      try {
        await ctx.reply(res.message);
      } catch (error) {
        log.error('Telegram permission reply error', error);
      }
    } catch (error) {
      log.error('Telegram callback handler error', error);
      try {
        await ctx.reply('Internal error.');
      } catch {
        // ignore
      }
    }
  });

  bot.on('message', async (ctx) => {
    try {
      const message = ctx.message as any;
      const rawText = extractTelegramInboundText(message);
      const resources = await extractTelegramImageResources(
        bot,
        config.telegramToken,
        message,
      );
      const mediaGroupId = extractTelegramMediaGroupId(message);

      if (mediaGroupId) {
        queueTelegramMediaGroup({
          pendingMediaGroups,
          groupKey: `${ctx.chat.id}:${mediaGroupId}`,
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          userId: String(ctx.from?.id ?? 'unknown'),
          fromId: ctx.from?.id,
          threadId: message.message_thread_id
            ? String(message.message_thread_id)
            : null,
          mediaGroupId,
          rawText,
          resources,
          messageId: Number(message.message_id),
          flush: (group) =>
            dispatchTelegramInbound({
              bot,
              router,
              config,
              tgCommands,
              chatCommandSignatures,
              chatId: group.chatId,
              chatType: group.chatType,
              userId: group.userId,
              fromId: group.fromId,
              threadId: group.threadId,
              rawText: mergeTelegramTexts(group.texts),
              resources: dedupeTelegramResources(group.resources),
              reactionMessageIds: dedupeTelegramMessageIds(group.messageIds),
              mediaGroupId: group.mediaGroupId,
            }),
        });
        return;
      }

      if (!rawText.trim() && resources.length === 0) return;
      dispatchTelegramInbound({
        bot,
        router,
        config,
        tgCommands,
        chatCommandSignatures,
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        userId: String(ctx.from?.id ?? 'unknown'),
        fromId: ctx.from?.id,
        threadId: message.message_thread_id
          ? String(message.message_thread_id)
          : null,
        rawText,
        resources,
        reactionMessageIds: [Number(message.message_id)],
      });
    } catch (error) {
      log.error('Telegram message handler error', error);
    }
  });

  bot.catch((err) => {
    log.error('Telegram bot error', err);
  });

  void startLongPolling(bot);

  return {
    createSink: (chatId, threadId, userId) =>
      createTelegramSink(
        bot,
        config.telegramToken,
        Number(chatId),
        threadId ? Number(threadId) : null,
        userId,
      ),
  };
}

function queueTelegramMediaGroup(params: {
  pendingMediaGroups: Map<string, PendingTelegramMediaGroup>;
  groupKey: string;
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  mediaGroupId: string;
  rawText: string;
  resources: UserResource[];
  messageId: number;
  flush: (group: PendingTelegramMediaGroup) => void;
}): void {
  const {
    pendingMediaGroups,
    groupKey,
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    mediaGroupId,
    rawText,
    resources,
    messageId,
    flush,
  } = params;

  const pending = pendingMediaGroups.get(groupKey) ?? {
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    mediaGroupId,
    texts: [],
    resources: [],
    messageIds: [],
    flushTimer: null,
  };

  if (rawText.trim()) {
    pending.texts.push(rawText.trim());
  }
  if (resources.length > 0) {
    pending.resources.push(...resources);
  }
  pending.messageIds.push(messageId);

  if (pending.flushTimer) {
    clearTimeout(pending.flushTimer);
  }

  pending.flushTimer = setTimeout(() => {
    const current = pendingMediaGroups.get(groupKey);
    if (!current) return;

    pendingMediaGroups.delete(groupKey);
    if (current.flushTimer) {
      clearTimeout(current.flushTimer);
      current.flushTimer = null;
    }

    flush(current);
  }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);

  pendingMediaGroups.set(groupKey, pending);
}

function dispatchTelegramInbound(params: {
  bot: Bot;
  router: GatewayRouter;
  config: AppConfig;
  tgCommands: Array<{ command: string; description: string }>;
  chatCommandSignatures: Map<number, string>;
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  rawText: string;
  resources: UserResource[];
  reactionMessageIds: number[];
  mediaGroupId?: string;
}): void {
  const {
    bot,
    router,
    config,
    tgCommands,
    chatCommandSignatures,
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    rawText,
    resources,
    reactionMessageIds,
    mediaGroupId,
  } = params;
  const messageIds = dedupeTelegramMessageIds(reactionMessageIds);
  const normalizedResources = dedupeTelegramResources(resources);

  if (!rawText.trim() && normalizedResources.length === 0) return;

  log.info('telegram inbound message', {
    chatId,
    fromId,
    text: rawText.slice(0, 120),
    imageCount: normalizedResources.length,
    mediaGroupId,
    groupedMessageCount: messageIds.length,
  });

  // Per-chat: ensure menu button is commands.
  void setChatMenuButton(config.telegramToken, { chatId }, fetch).catch(() => {
    // ignore
  });

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: String(chatId),
    threadId,
    userId,
    scopeUserId: chatType === 'private' ? null : SHARED_CHAT_SCOPE_USER_ID,
  };

  const inlineCommands = router.listCliInlineCommands(key);

  // Keep Telegram chat-scope command menu in sync with CLI inline commands.
  void syncTelegramCommandsForChat({
    bot,
    chatId,
    baseCommands: tgCommands,
    inlineCommands,
    signatures: chatCommandSignatures,
  }).catch(() => {
    // ignore
  });

  // /start should show help, not fall through to the agent.
  const remapped = remapTelegramInlineCommand(rawText, inlineCommands);
  const normalizedText = remapped.startsWith('/start') ? '/help' : remapped;
  const isCommand = normalizedText.startsWith('/');

  const sink = isCommand
    ? createTelegramCommandSink(bot, chatId, threadId ? Number(threadId) : null)
    : createTelegramSink(
        bot,
        config.telegramToken,
        chatId,
        threadId ? Number(threadId) : null,
        userId,
      );

  void updateTelegramMessageReactions(
    config.telegramToken,
    chatId,
    messageIds,
    '🤔',
  ).catch(() => {
    // ignore
  });

  // IMPORTANT: do not await; grammY processes updates sequentially.
  const p = router.handleUserMessage(
    key,
    normalizedText,
    sink,
    isCommand ? undefined : { resources: normalizedResources },
  );

  void p
    .then(async () => {
      await updateTelegramMessageReactions(
        config.telegramToken,
        chatId,
        messageIds,
        '🕊',
      );

      // Commands may change after this run (available_commands_update).
      void syncTelegramCommandsForChat({
        bot,
        chatId,
        baseCommands: tgCommands,
        inlineCommands: router.listCliInlineCommands(key),
        signatures: chatCommandSignatures,
      }).catch(() => {
        // ignore
      });
    })
    .catch(async (error) => {
      log.error('Telegram router handler error', error);
      try {
        await updateTelegramMessageReactions(
          config.telegramToken,
          chatId,
          messageIds,
          '😢',
        );
      } catch {
        // ignore
      }
    });
}

async function updateTelegramMessageReactions(
  token: string,
  chatId: number,
  messageIds: number[],
  emoji: string,
): Promise<void> {
  const ids = dedupeTelegramMessageIds(messageIds);
  if (ids.length === 0) return;

  await Promise.allSettled(
    ids.map((messageId) =>
      setMessageReaction(
        token,
        {
          chatId,
          messageId,
          emoji,
          isBig: false,
        },
        fetch,
      ),
    ),
  );
}

async function startLongPolling(bot: Bot): Promise<void> {
  for (;;) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      log.warn('Telegram deleteWebhook error', err);
    }

    log.info('Telegram long polling start', {
      allowedUpdates: ['message', 'callback_query'],
      dropPendingUpdates: true,
    });

    try {
      await bot.start({
        allowed_updates: ['message', 'callback_query'],
      });
      log.warn('Telegram polling stopped; restarting in 2s');
    } catch (err) {
      log.error('Telegram polling error; restarting in 2s', err);
    }

    await sleep(2000);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function remapTelegramInlineCommand(
  text: string,
  inlineCommands: CliInlineCommand[],
): string {
  if (!text.startsWith('/')) return text;

  const parts = text.trim().split(/\s+/);
  const first = parts[0] ?? '';

  const at = first.indexOf('@');
  const cmdToken = at >= 0 ? first.slice(0, at) : first;
  if (!cmdToken.startsWith('/')) return text;

  const cmd = cmdToken.slice(1).toLowerCase();
  if (!cmd) return text;

  const aliasMap = new Map<string, string>();
  for (const item of inlineCommands) {
    const tg = toTelegramCommandName(item.name);
    if (!tg || tg === item.name) continue;
    if (!aliasMap.has(tg)) aliasMap.set(tg, item.name);
  }

  const mapped = aliasMap.get(cmd);
  if (!mapped) return text;

  parts[0] = `/${mapped}`;
  return parts.join(' ');
}

function extractTelegramInboundText(message: any): string {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.caption === 'string') return message.caption;
  return '';
}

function extractTelegramMediaGroupId(message: any): string | null {
  const raw = message?.media_group_id;
  if (raw === null || raw === undefined) return null;
  const id = String(raw).trim();
  return id || null;
}

function mergeTelegramTexts(texts: string[]): string {
  if (texts.length === 0) return '';

  const out: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const normalized = String(text ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out.join('\n');
}

function dedupeTelegramResources(resources: UserResource[]): UserResource[] {
  if (resources.length === 0) return [];

  const out: UserResource[] = [];
  const seen = new Set<string>();

  for (const item of resources) {
    const uri = String(item?.uri ?? '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({
      uri,
      mimeType: item?.mimeType?.trim() || undefined,
    });
  }

  return out;
}

function dedupeTelegramMessageIds(ids: number[]): number[] {
  if (ids.length === 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();

  for (const item of ids) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

async function extractTelegramImageResources(
  bot: Bot,
  token: string,
  message: any,
): Promise<UserResource[]> {
  const out: UserResource[] = [];
  const seen = new Set<string>();

  const addByFileId = async (
    fileId: string | undefined,
    mimeType: string | undefined,
  ): Promise<void> => {
    if (!fileId) return;
    try {
      const file = await bot.api.getFile(fileId);
      const filePath = String((file as any)?.file_path ?? '').trim();
      if (!filePath) return;
      const uri = `https://api.telegram.org/file/bot${token}/${filePath}`;
      if (seen.has(uri)) return;
      seen.add(uri);
      out.push({ uri, mimeType: mimeType?.trim() || undefined });
    } catch (error) {
      log.warn('telegram getFile(image) error', error);
    }
  };

  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length > 0) {
    const weight = (item: any): number => {
      const fileSize = Number(item?.file_size ?? 0);
      if (Number.isFinite(fileSize) && fileSize > 0) return fileSize;
      const width = Number(item?.width ?? 0);
      const height = Number(item?.height ?? 0);
      return Math.max(0, width * height);
    };

    const best = photos
      .slice()
      .sort((a: any, b: any) => weight(a) - weight(b))
      .at(-1);
    await addByFileId(best?.file_id, 'image/jpeg');
  }

  const document = message?.document;
  if (
    document?.file_id &&
    typeof document?.mime_type === 'string' &&
    document.mime_type.toLowerCase().startsWith('image/')
  ) {
    await addByFileId(document.file_id, document.mime_type);
  }

  return out;
}

async function syncTelegramCommandsForChat(params: {
  bot: Bot;
  chatId: number;
  baseCommands: Array<{ command: string; description: string }>;
  inlineCommands: CliInlineCommand[];
  signatures: Map<number, string>;
}): Promise<void> {
  const merged = [...params.baseCommands];
  const seen = new Set<string>(params.baseCommands.map((c) => c.command));

  for (const item of params.inlineCommands) {
    const command = toTelegramCommandName(item.name);
    if (!command || seen.has(command)) continue;

    merged.push({
      command,
      description: truncateTelegramDescription(
        `cli-inline: ${item.description || item.name}`,
      ),
    });
    seen.add(command);

    // Telegram Bot API hard limit.
    if (merged.length >= 100) break;
  }

  const signature = JSON.stringify(merged);
  if (params.signatures.get(params.chatId) === signature) return;

  await params.bot.api.setMyCommands(merged, {
    scope: { type: 'chat', chat_id: params.chatId },
  });
  params.signatures.set(params.chatId, signature);
}

function toTelegramCommandName(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
    .replace(/[^a-z0-9_]/g, '');

  if (!normalized) return null;
  if (normalized.length > 32) return null;
  if (!/^[a-z]/.test(normalized)) return null;
  return normalized;
}

function truncateTelegramDescription(text: string): string {
  const trimmed = text.trim() || 'cli-inline command';
  if (trimmed.length <= 256) return trimmed;
  return trimmed.slice(0, 253) + '...';
}

function createTelegramCommandSink(
  bot: Bot,
  chatId: number,
  threadId: number | null,
): OutboundSink & { flush: () => Promise<void> } {
  let text = '';

  return {
    sendText: async (delta: string) => {
      text += delta;
    },
    flush: async () => {
      const out = text.trim();
      text = '';
      if (!out) return;
      await bot.api.sendMessage(chatId, out, {
        message_thread_id: threadId ?? undefined,
      });
    },
    sendUi: async (event) => {
      const header = `[${event.kind}] ${event.title}`;
      const body = event.detail && event.mode === 'verbose' ? `\n\n${event.detail}` : '';
      await bot.api.sendMessage(chatId, `${header}${body}`, {
        message_thread_id: threadId ?? undefined,
      });
    },
  };
}

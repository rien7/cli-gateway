import {
  ActionRowBuilder,
  type Attachment,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';

import type {
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
import { createDiscordSink } from './discordSink.js';
import {
  buildDiscordSlashCommands,
  mapDiscordSlashToRouterCommand,
} from './discordCommands.js';

export type DiscordController = {
  createSink: (
    channelId: string,
    userId: string,
  ) => Promise<OutboundSink & { flush: () => Promise<void> }>;
};

/* c8 ignore start */
export async function startDiscord(
  router: GatewayRouter,
  config: AppConfig,
): Promise<DiscordController | null> {
  if (!config.discordToken) {
    log.info('Discord disabled: missing DISCORD_TOKEN');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
  });

  const slashCommands = buildDiscordSlashCommands();

  client.on('ready', () => {
    log.info('Discord connected');
    void syncDiscordSlashCommands(client, slashCommands);
  });

  client.on('guildCreate', (guild) => {
    void guild.commands
      .set(slashCommands)
      .then(() => {
        log.info('Discord slash commands synced for new guild', {
          guildId: guild.id,
          count: slashCommands.length,
        });
      })
      .catch((error) => {
        log.warn('Discord guild slash command sync error', {
          guildId: guild.id,
          error,
        });
      });
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand({
          interaction,
          router,
          config,
        });
        return;
      }

      if (!interaction.isButton()) return;

      const parsed = parsePermissionCustomId(interaction.customId);
      if (!parsed) return;

      const { sessionKey, requestId, decision } = parsed;

      const res = await router.handlePermissionUi({
        platform: 'discord',
        sessionKey,
        requestId,
        decision,
        actorUserId: interaction.user.id,
      });

      if (!res.ok) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: res.message, ephemeral: true });
          return;
        }
        await interaction.reply({ content: res.message, ephemeral: true });
        return;
      }

      const prefix = decision === 'allow' ? '✅' : '❌';
      await interaction.update({
        content: prefix + ' ' + res.message,
        components: [],
      });
    } catch (error) {
      log.error('Discord interaction handler error', error);
    }
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;

      const decision = permissionDecisionFromEmoji(reaction.emoji.name);
      if (!decision) return;

      const message = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;

      const route = extractPermissionRouteFromComponents(message.components);
      if (!route) return;

      const res = await router.handlePermissionUi({
        platform: 'discord',
        sessionKey: route.sessionKey,
        requestId: route.requestId,
        decision,
        actorUserId: user.id,
      });

      if (!res.ok) {
        await message.reply(res.message);
        return;
      }

      const prefix = decision === 'allow' ? '✅' : '❌';
      await message.edit({ content: prefix + ' ' + res.message, components: [] });
    } catch (error) {
      log.error('Discord reaction handler error', error);
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;

      if (
        config.discordAllowChannelId &&
        message.channelId !== config.discordAllowChannelId
      ) {
        return;
      }

      const text = message.content ?? '';
      const resources = extractDiscordImageResources(
        message.attachments.map((a) => a),
      );
      if (!text.trim() && resources.length === 0) return;

      // Telegram parity: first-stage ack reaction while processing.
      await setDiscordInboundReaction(message, '🤔');

      const key: ConversationKey = {
        platform: 'discord',
        chatId: message.channelId,
        threadId: null,
        userId: message.author.id,
        scopeUserId:
          message.guildId === null ? null : SHARED_CHAT_SCOPE_USER_ID,
      };

      const channel = message.channel as TextBasedChannel;
      const globalContextText = extractDiscordChannelDescription(channel) ?? undefined;
      const sink = createDiscordSink(channel, message.author.id);

      await router.handleUserMessage(key, text, sink, {
        resources,
        globalContextText,
      });
      await finalizeDiscordInboundReaction(message, '🕊');
    } catch (error) {
      log.error('Discord message handler error', error);
      await finalizeDiscordInboundReaction(message, '😢');
    }
  });

  await client.login(config.discordToken);

  return {
    createSink: async (channelId: string, userId: string) => {
      const channel = (await client.channels.fetch(
        channelId,
      )) as TextBasedChannel | null;
      if (!channel) throw new Error(`Discord channel not found: ${channelId}`);
      return createDiscordSink(channel, userId);
    },
  };
}
/* c8 ignore stop */

function extractDiscordImageResources(
  attachments: Attachment[],
): UserResource[] {
  const out: UserResource[] = [];
  const seen = new Set<string>();

  for (const item of attachments) {
    const uri = String(item.url ?? '').trim();
    if (!uri || seen.has(uri)) continue;

    const mime = String(item.contentType ?? '').trim().toLowerCase();
    const looksLikeImage =
      mime.startsWith('image/') ||
      item.width !== null ||
      item.height !== null ||
      /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri);

    if (!looksLikeImage) continue;

    seen.add(uri);
    out.push({ uri, mimeType: mime || undefined });
  }

  return out;
}

export function extractDiscordChannelDescription(channel: unknown): string | null {
  if (!channel || typeof channel !== 'object') return null;

  const topic = normalizeDiscordChannelText(
    (channel as { topic?: unknown }).topic,
  );
  if (topic) return topic;

  const description = normalizeDiscordChannelText(
    (channel as { description?: unknown }).description,
  );
  if (description) return description;

  const parent = (channel as {
    parent?: { topic?: unknown; description?: unknown } | null;
  }).parent;
  const parentTopic = normalizeDiscordChannelText(parent?.topic);
  if (parentTopic) return parentTopic;

  return normalizeDiscordChannelText(parent?.description);
}

function normalizeDiscordChannelText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

async function syncDiscordSlashCommands(
  client: Client,
  slashCommands: ReturnType<typeof buildDiscordSlashCommands>,
): Promise<void> {
  try {
    if (!client.application) return;

    await client.application.commands.set(slashCommands);
    log.info('Discord global slash commands synced', {
      count: slashCommands.length,
    });
  } catch (error) {
    log.warn('Discord global slash command sync error', error);
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(slashCommands);
      log.info('Discord guild slash commands synced', {
        guildId: guild.id,
        count: slashCommands.length,
      });
    } catch (error) {
      log.warn('Discord guild slash command sync error', {
        guildId: guild.id,
        error,
      });
    }
  }
}

async function handleSlashCommand(params: {
  interaction: ChatInputCommandInteraction;
  router: GatewayRouter;
  config: AppConfig;
}): Promise<void> {
  const { interaction, router, config } = params;

  if (!interaction.channelId) {
    await interaction.reply({
      content: 'This command must be used in a channel.',
      ephemeral: true,
    });
    return;
  }

  if (
    config.discordAllowChannelId &&
    interaction.channelId !== config.discordAllowChannelId
  ) {
    await interaction.reply({
      content: 'This channel is not allowed by gateway config.',
      ephemeral: true,
    });
    return;
  }

  const text = mapDiscordSlashToRouterCommand(interaction);
  if (!text) {
    await interaction.reply({
      content: `Unknown command: /${interaction.commandName}`,
      ephemeral: true,
    });
    return;
  }

  const key: ConversationKey = {
    platform: 'discord',
    chatId: interaction.channelId,
    threadId: null,
    userId: interaction.user.id,
    scopeUserId: interaction.guildId === null ? null : SHARED_CHAT_SCOPE_USER_ID,
  };

  const sink = createDiscordInteractionSink(interaction);

  await interaction.deferReply();
  try {
    await router.handleUserMessage(key, text, sink);
    if (!sink.hasResponded()) {
      await interaction.editReply({ content: 'OK' });
    }
  } catch (error) {
    log.error('Discord slash command handler error', error);
    if (sink.hasResponded()) {
      await interaction.followUp({
        content: `Error: ${String((error as any)?.message ?? error)}`,
      });
      return;
    }
    await interaction.editReply({
      content: `Error: ${String((error as any)?.message ?? error)}`,
    });
  }
}

export function createDiscordInteractionSink(
  interaction: ChatInputCommandInteraction,
): OutboundSink & { flush: () => Promise<void>; hasResponded: () => boolean } {
  let text = '';
  let hasResponded = false;

  const sendChunk = async (chunk: string): Promise<void> => {
    if (!hasResponded) {
      hasResponded = true;
      if (interaction.deferred) {
        await interaction.editReply({ content: chunk });
        return;
      }
      if (interaction.replied) {
        await interaction.followUp({ content: chunk });
        return;
      }
      await interaction.reply({ content: chunk });
      return;
    }

    await interaction.followUp({ content: chunk });
  };

  const sendPermissionCard = async (req: {
    uiMode: 'verbose' | 'summary';
    sessionKey: string;
    requestId: string;
    toolTitle: string;
    toolKind: string | null;
    toolName?: string;
    toolArgs?: unknown;
  }): Promise<void> => {
    const allowId = `acpperm:${req.sessionKey}:${req.requestId}:allow`;
    const denyId = `acpperm:${req.sessionKey}:${req.requestId}:deny`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(allowId)
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(denyId)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
      .setColor(0xffcc00)
      .addFields(
        { name: 'Tool', value: truncate(resolvePermissionToolName(req), 256) },
        ...buildPermissionDetailFields(req),
      );

    if (!hasResponded) {
      hasResponded = true;
      if (interaction.deferred) {
        const msg = await interaction.editReply({
          content: `<@${interaction.user.id}>`,
          embeds: [embed],
          components: [row],
        });
        await addDiscordPermissionReactions(msg);
        return;
      }
      if (interaction.replied) {
        const msg = await interaction.followUp({
          content: `<@${interaction.user.id}>`,
          embeds: [embed],
          components: [row],
        });
        await addDiscordPermissionReactions(msg);
        return;
      }
      await interaction.reply({
        content: `<@${interaction.user.id}>`,
        embeds: [embed],
        components: [row],
      });
      const msg = await interaction.fetchReply();
      await addDiscordPermissionReactions(msg);
      return;
    }

    const msg = await interaction.followUp({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      components: [row],
    });
    await addDiscordPermissionReactions(msg);
  };

  return {
    sendText: async (delta) => {
      text += delta;
    },
    breakTextStream: async () => {
      const out = text.trim();
      text = '';
      if (!out) return;

      const chunks = splitText(out, 1900);
      for (const chunk of chunks) {
        await sendChunk(chunk);
      }
    },
    flush: async () => {
      const out = text.trim();
      text = '';
      if (!out) return;

      const chunks = splitText(out, 1900);
      for (const chunk of chunks) {
        await sendChunk(chunk);
      }
    },
    sendUi: async (event) => {
      if (event.kind === 'tool') {
        const body =
          event.mode === 'verbose' && event.detail
            ? `[tool] ${event.title}\n\n${event.detail}`
            : `[tool] ${event.title}`;
        await sendChunk(formatTextCodeBlock(body, 1900));
        return;
      }

      const head = `[${event.kind}] ${event.title}`;
      const body =
        event.mode === 'verbose' && event.detail ? `\n\n${event.detail}` : '';
      await sendChunk(truncate(head + body, 1900));
    },
    requestPermission: async (req) => {
      await sendPermissionCard(req);
    },
    hasResponded: () => hasResponded,
  };
}

function splitText(text: string, maxLen: number): string[] {
  if (!text) return [];

  const out: string[] = [];
  let remain = text;
  while (remain.length > maxLen) {
    out.push(remain.slice(0, maxLen));
    remain = remain.slice(maxLen);
  }
  if (remain) out.push(remain);
  return out;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function resolvePermissionToolName(req: {
  toolTitle: string;
  toolKind: string | null;
  toolName?: string;
}): string {
  const preferred = typeof req.toolName === 'string' ? req.toolName.trim() : '';
  if (preferred) return preferred;

  const title = req.toolTitle.trim();
  if (title) return title;

  return req.toolKind ?? 'unknown';
}

function buildPermissionDetailFields(req: {
  toolKind: string | null;
  toolTitle: string;
  toolArgs?: unknown;
}): Array<{ name: string; value: string }> {
  const kind = String(req.toolKind ?? '').trim().toLowerCase();
  const reason = extractFirstString(req.toolArgs, [
    'reason',
    'why',
    'rationale',
    'justification',
    'description',
    'input.reason',
    'input.why',
    'input.rationale',
    'input.justification',
    'arguments.reason',
    'arguments.why',
    'arguments.rationale',
    'arguments.justification',
    'params.reason',
    'params.why',
    'params.rationale',
    'params.justification',
  ]);

  if (kind === 'execute') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'Command',
        value: formatPermissionCodeBlock(
          extractCommand(req.toolArgs, req.toolTitle) ?? '(not provided)',
          'bash',
        ),
      },
    ];
  }

  if (kind === 'read' || kind === 'edit' || kind === 'delete') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'Path',
        value: formatPermissionCodeBlock(
          extractFirstString(req.toolArgs, [
            'path',
            'file',
            'filepath',
            'target',
            'input.path',
            'arguments.path',
            'params.path',
          ]) ?? '(not provided)',
          'text',
        ),
      },
    ];
  }

  if (kind === 'move') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'From',
        value: formatPermissionCodeBlock(
          extractFirstString(req.toolArgs, [
            'from',
            'source',
            'src',
            'input.from',
            'arguments.from',
            'params.from',
          ]) ?? '(not provided)',
          'text',
        ),
      },
      {
        name: 'To',
        value: formatPermissionCodeBlock(
          extractFirstString(req.toolArgs, [
            'to',
            'destination',
            'dest',
            'input.to',
            'arguments.to',
            'params.to',
          ]) ?? '(not provided)',
          'text',
        ),
      },
    ];
  }

  if (kind === 'search') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'Query',
        value: formatPermissionCodeBlock(
          extractFirstString(req.toolArgs, [
            'query',
            'pattern',
            'text',
            'input.query',
            'arguments.query',
            'params.query',
          ]) ?? '(not provided)',
          'text',
        ),
      },
    ];
  }

  if (kind === 'fetch') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'URL',
        value: formatPermissionCodeBlock(
          extractFirstString(req.toolArgs, [
            'url',
            'uri',
            'target',
            'input.url',
            'arguments.url',
            'params.url',
          ]) ?? '(not provided)',
          'text',
        ),
      },
    ];
  }

  if (kind === 'switch_mode') {
    return [
      {
        name: 'Reason',
        value: formatPermissionText(reason ?? '(not provided)'),
      },
      {
        name: 'Mode',
        value: formatPermissionText(
          extractFirstString(req.toolArgs, [
            'mode',
            'input.mode',
            'arguments.mode',
            'params.mode',
          ]) ?? '(not provided)',
        ),
      },
    ];
  }

  return [
    {
      name: 'Reason',
      value: formatPermissionText(reason ?? '(not provided)'),
    },
    {
      name: 'Arguments',
      value: formatPermissionCodeBlock(stringifyPermissionArgs(req.toolArgs), 'json'),
    },
  ];
}

function extractCommand(args: unknown, title: string): string | null {
  const command = extractFirstString(args, [
    'command',
    'cmd',
    'commandLine',
    'cmdline',
    'input.command',
    'input.cmd',
    'input.commandLine',
    'input.cmdline',
    'arguments.command',
    'arguments.cmd',
    'arguments.commandLine',
    'arguments.cmdline',
    'params.command',
    'params.cmd',
    'params.commandLine',
    'params.cmdline',
  ]);

  const argList = extractStringArray(args, [
    'args',
    'argv',
    'input.args',
    'input.argv',
    'arguments.args',
    'arguments.argv',
    'params.args',
    'params.argv',
  ]);

  if (!command) {
    if (argList.length > 0) return argList.join(' ');
    const fromTitle = title.match(/^(?:run|execute):\s+(.+)$/i)?.[1];
    return fromTitle ? fromTitle.trim() : null;
  }

  return argList.length > 0 ? `${command} ${argList.join(' ')}` : command;
}

function extractFirstString(root: unknown, paths: string[]): string | null {
  for (const pathExpr of paths) {
    const value = getPathValue(root, pathExpr);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  const fallbackKeys = collectPermissionKeyAliases(paths);
  return extractDeepStringByKeys(root, fallbackKeys);
}

function extractStringArray(root: unknown, paths: string[]): string[] {
  for (const pathExpr of paths) {
    const value = getPathValue(root, pathExpr);
    if (!Array.isArray(value)) continue;
    const out = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (out.length > 0) return out;
  }

  const fallbackKeys = collectPermissionKeyAliases(paths);
  return extractDeepStringArrayByKeys(root, fallbackKeys);
}

function getPathValue(root: unknown, pathExpr: string): unknown {
  const segments = pathExpr.split('.');
  let current: unknown = parseJsonContainer(root);
  for (const segment of segments) {
    current = parseJsonContainer(current);
    if (!current || typeof current !== 'object') return undefined;
    current = parseJsonContainer((current as Record<string, unknown>)[segment]);
  }
  return current;
}

function parseJsonContainer(value: unknown): unknown {
  let current: unknown = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!trimmed || !looksLikeJsonValue(trimmed)) return current;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return current;
    }
  }

  return current;
}

function collectPermissionKeyAliases(paths: string[]): string[] {
  const aliases = new Set<string>();
  for (const pathExpr of paths) {
    const pieces = pathExpr
      .split('.')
      .map((piece) => piece.trim())
      .filter(Boolean);
    const last = pieces.at(-1);
    if (last) aliases.add(last);
  }
  return Array.from(aliases);
}

function extractDeepStringByKeys(root: unknown, keys: string[]): string | null {
  const wanted = new Set(
    keys
      .map((item) => normalizePermissionKey(item))
      .filter(Boolean),
  );
  if (wanted.size === 0) return null;

  for (const node of iteratePermissionNodes(root)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;

    for (const [rawKey, rawValue] of Object.entries(record)) {
      const normalizedKey = normalizePermissionKey(rawKey);
      const value = parseJsonContainer(rawValue);
      if (wanted.has(normalizedKey)) {
        const direct = coercePermissionString(value);
        if (direct) return direct;

        const joined = joinPermissionStringArray(value);
        if (joined) return joined;
      }

      if (
        (normalizedKey === 'name' ||
          normalizedKey === 'key' ||
          normalizedKey === 'field') &&
        typeof value === 'string'
      ) {
        const namedKey = normalizePermissionKey(value);
        if (!wanted.has(namedKey)) continue;

        const pairValue = parseJsonContainer(
          record.value ??
            record.val ??
            record.argument ??
            record.arg ??
            record.content,
        );
        const pairString =
          coercePermissionString(pairValue) ??
          joinPermissionStringArray(pairValue);
        if (pairString) return pairString;
      }
    }
  }

  return null;
}

function extractDeepStringArrayByKeys(root: unknown, keys: string[]): string[] {
  const wanted = new Set(
    keys
      .map((item) => normalizePermissionKey(item))
      .filter(Boolean),
  );
  if (wanted.size === 0) return [];

  for (const node of iteratePermissionNodes(root)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;

    for (const [rawKey, rawValue] of Object.entries(record)) {
      const normalizedKey = normalizePermissionKey(rawKey);
      const value = parseJsonContainer(rawValue);
      if (wanted.has(normalizedKey)) {
        const direct = coercePermissionStringArray(value);
        if (direct.length > 0) return direct;

        const single = coercePermissionString(value);
        if (single) return [single];
      }

      if (
        (normalizedKey === 'name' ||
          normalizedKey === 'key' ||
          normalizedKey === 'field') &&
        typeof value === 'string'
      ) {
        const namedKey = normalizePermissionKey(value);
        if (!wanted.has(namedKey)) continue;

        const pairValue = parseJsonContainer(
          record.value ??
            record.val ??
            record.argument ??
            record.arg ??
            record.content,
        );

        const pairArray = coercePermissionStringArray(pairValue);
        if (pairArray.length > 0) return pairArray;

        const pairSingle = coercePermissionString(pairValue);
        if (pairSingle) return [pairSingle];
      }
    }
  }

  return [];
}

function* iteratePermissionNodes(root: unknown): Generator<unknown> {
  const queue: unknown[] = [parseJsonContainer(root)];
  const seen = new Set<object>();
  let budget = 600;

  while (queue.length > 0 && budget > 0) {
    budget -= 1;
    const current = parseJsonContainer(queue.shift());
    if (!current || typeof current !== 'object') continue;

    const identity = current as object;
    if (seen.has(identity)) continue;
    seen.add(identity);
    yield current;

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const value of Object.values(current as Record<string, unknown>)) {
      const parsed = parseJsonContainer(value);
      if (parsed && typeof parsed === 'object') {
        queue.push(parsed);
      }
    }
  }
}

function coercePermissionString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function coercePermissionStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinPermissionStringArray(value: unknown): string | null {
  const values = coercePermissionStringArray(value);
  if (values.length === 0) return null;
  return values.join(' ');
}

function looksLikeJsonValue(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('"') && value.endsWith('"'))
  );
}

function normalizePermissionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stringifyPermissionArgs(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value.trim() || '(none)';

  try {
    const compact = JSON.stringify(value);
    if (!compact) return '(none)';
    return truncate(compact, 960);
  } catch {
    return truncate(String(value), 960);
  }
}

function formatPermissionText(value: string): string {
  return truncate(value.trim() || '(none)', 1000);
}

function formatPermissionCodeBlock(value: string, language: string): string {
  const safe = (value.trim() || '(none)').replace(/```/g, '``\u200b`');
  return `\`\`\`${language}\n${truncate(safe, 960)}\n\`\`\``;
}

function formatTextCodeBlock(text: string, maxLen: number): string {
  const open = '```text\n';
  const close = '\n```';
  const safe = text.replace(/```/g, '``\u200b`').trimEnd();
  const body = truncate(safe, maxLen - open.length - close.length);
  return `${open}${body}${close}`;
}

type PermissionDecision = 'allow' | 'deny';

type PermissionRoute = {
  sessionKey: string;
  requestId: string;
};

export function parsePermissionCustomId(
  customId: string,
): (PermissionRoute & { decision: PermissionDecision }) | null {
  if (!customId.startsWith('acpperm:')) return null;

  const parts = customId.split(':');
  const sessionKey = String(parts[1] ?? '').trim();
  const requestId = String(parts[2] ?? '').trim();
  const decision = String(parts[3] ?? '').trim();

  if (!sessionKey || !requestId) return null;
  if (decision !== 'allow' && decision !== 'deny') return null;

  return {
    sessionKey,
    requestId,
    decision,
  };
}

export function permissionDecisionFromEmoji(
  emojiName: string | null,
): PermissionDecision | null {
  const value = String(emojiName ?? '').trim();
  if (!value) return null;

  if (value === '✅' || value === '👍') return 'allow';
  if (value === '❌' || value === '👎') return 'deny';
  return null;
}

export function extractPermissionRouteFromComponents(
  components: unknown,
): PermissionRoute | null {
  if (!Array.isArray(components) || components.length === 0) return null;

  for (const row of components) {
    if (!isRecord(row)) continue;

    const items = row.components;
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!isRecord(item)) continue;

      const parsed = parsePermissionCustomId(String(item.customId ?? ''));
      if (!parsed) continue;
      return { sessionKey: parsed.sessionKey, requestId: parsed.requestId };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function setDiscordInboundReaction(
  message: unknown,
  emoji: string,
): Promise<void> {
  const discordMessage = message as {
    react?: (nextEmoji: string) => Promise<unknown>;
  };
  if (
    !message ||
    typeof message !== 'object' ||
    typeof discordMessage.react !== 'function'
  ) {
    return;
  }

  try {
    await discordMessage.react(emoji);
  } catch {
    // best-effort only
  }
}

async function finalizeDiscordInboundReaction(
  message: unknown,
  emoji: string,
): Promise<void> {
  await clearDiscordInboundReaction(message, '🤔');
  await setDiscordInboundReaction(message, emoji);
}

async function clearDiscordInboundReaction(
  message: unknown,
  emoji: string,
): Promise<void> {
  if (!message || typeof message !== 'object') return;

  const clientUserId = String(
    (message as { client?: { user?: { id?: string } } }).client?.user?.id ?? '',
  ).trim();
  if (!clientUserId) return;

  const reactions = (message as { reactions?: unknown }).reactions as
    | {
        resolve?: (value: string) => { users?: { remove?: (userId: string) => Promise<unknown> } } | null;
      }
    | undefined;
  if (!reactions || typeof reactions.resolve !== 'function') return;

  const reaction = reactions.resolve(emoji);
  const remove = reaction?.users?.remove;
  if (typeof remove !== 'function') return;

  try {
    await remove(clientUserId);
  } catch {
    // best-effort only
  }
}

async function addDiscordPermissionReactions(message: unknown): Promise<void> {
  const discordMessage = message as {
    react?: (nextEmoji: string) => Promise<unknown>;
  };
  if (
    !message ||
    typeof message !== 'object' ||
    typeof discordMessage.react !== 'function'
  ) {
    return;
  }

  try {
    await discordMessage.react('👍');
  } catch {
    // best-effort only
  }
  try {
    await discordMessage.react('👎');
  } catch {
    // best-effort only
  }
}

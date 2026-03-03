import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
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
    ],
    partials: [Partials.Channel],
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

      const id = interaction.customId;
      if (!id.startsWith('acpperm:')) return;

      const parts = id.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
        return;
      }

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

      await interaction.update({ content: res.message, components: [] });
    } catch (error) {
      log.error('Discord interaction handler error', error);
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
      if (!text.trim()) return;

      const key: ConversationKey = {
        platform: 'discord',
        chatId: message.channelId,
        threadId: null,
        userId: message.author.id,
        scopeUserId:
          message.guildId === null ? null : SHARED_CHAT_SCOPE_USER_ID,
      };

      const channel = message.channel as TextBasedChannel;
      const sink = createDiscordSink(channel, message.author.id);

      await router.handleUserMessage(key, text, sink);
    } catch (error) {
      log.error('Discord message handler error', error);
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
      .setTitle('Permission required')
      .setColor(0xffcc00)
      .addFields(
        { name: 'Tool', value: truncate(req.toolTitle, 256) },
        { name: 'Kind', value: req.toolKind ?? 'unknown' },
      );

    if (req.uiMode === 'verbose') {
      embed.addFields(
        { name: 'Session', value: truncate(req.sessionKey, 512) },
        { name: 'Request', value: truncate(req.requestId, 256) },
      );
    }

    if (!hasResponded) {
      hasResponded = true;
      if (interaction.deferred) {
        await interaction.editReply({
          content: `<@${interaction.user.id}>`,
          embeds: [embed],
          components: [row],
        });
        return;
      }
      if (interaction.replied) {
        await interaction.followUp({
          content: `<@${interaction.user.id}>`,
          embeds: [embed],
          components: [row],
        });
        return;
      }
      await interaction.reply({
        content: `<@${interaction.user.id}>`,
        embeds: [embed],
        components: [row],
      });
      return;
    }

    await interaction.followUp({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      components: [row],
    });
  };

  return {
    sendText: async (delta) => {
      text += delta;
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

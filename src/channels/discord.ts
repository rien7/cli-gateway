import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  type TextBasedChannel,
  type SendableChannels,
} from 'discord.js';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createBufferedSink } from './bufferedSink.js';

export type DiscordController = {
  createSink: (
    channelId: string,
    userId: string,
  ) => Promise<OutboundSink & { flush: () => Promise<void> }>;
};

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

  client.on('ready', () => {
    log.info('Discord connected');
  });

  client.on('interactionCreate', async (interaction) => {
    try {
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

function createDiscordSink(
  channel: TextBasedChannel,
  userId: string,
): OutboundSink & { flush: () => Promise<void> } {
  const sendChannel = channel as unknown as SendableChannels;

  const buffered = createBufferedSink({
    maxLen: 1800,
    flushIntervalMs: 700,
    send: async (text) => {
      const msg = await sendChannel.send(text);
      return { id: msg.id };
    },
    edit: async (id, text) => {
      const msg = await sendChannel.messages.fetch(id);
      await msg.edit(text);
    },
  });

  return {
    sendText: buffered.sendText,
    flush: buffered.flush,
    getDeliveryState: buffered.getState,
    requestPermission: async (req) => {
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

      await sendChannel.send({
        content: `<@${userId}>`,
        embeds: [embed],
        components: [row],
      });
    },
    sendUi: async (event) => {
      const embed = new EmbedBuilder()
        .setTitle(`[${event.kind}] ${event.title}`)
        .setColor(colorForKind(event.kind));

      if (event.detail && event.mode === 'verbose') {
        embed.setDescription(
          `\`\`\`json\n${truncate(event.detail, 3800)}\n\`\`\``,
        );
      }

      await sendChannel.send({ embeds: [embed] });
    },
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function colorForKind(kind: string): number {
  switch (kind) {
    case 'tool':
      return 0x0099ff;
    case 'plan':
      return 0x8a2be2;
    case 'task':
      return 0x00aa55;
    default:
      return 0x666666;
  }
}

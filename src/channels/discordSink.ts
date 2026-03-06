import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextBasedChannel,
  type SendableChannels,
} from 'discord.js';

import type { OutboundSink } from '../gateway/router.js';
import { createBufferedSink } from './bufferedSink.js';

export function createDiscordSink(
  channel: TextBasedChannel,
  userId: string,
): OutboundSink & { flush: () => Promise<void> } {
  const sendChannel = channel as unknown as SendableChannels;
  const toolUiMessageById = new Map<string, string>();

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
    breakTextStream: buffered.breakMessage,
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
        .setColor(0xffcc00)
        .addFields(
          { name: 'Tool', value: truncate(resolvePermissionToolName(req), 256) },
          ...buildPermissionDetailFields(req),
        );

      const msg = await sendChannel.send({
        content: `<@${userId}> Please approve this tool call.`,
        embeds: [embed],
        components: [row],
      });

      await addDiscordPermissionReactions(msg);
    },
    sendUi: async (event) => {
      if (event.kind === 'tool') {
        const text = formatToolUiPlainText(event);

        if (event.toolCallId?.trim()) {
          const key = event.toolCallId.trim();
          const existingId = toolUiMessageById.get(key);
          if (existingId) {
            try {
              const existing = await sendChannel.messages.fetch(existingId);
              await existing.edit(text);
              return;
            } catch {
              // fall through and resend
            }
          }

          const msg = await sendChannel.send(text);
          toolUiMessageById.set(key, msg.id);
          return;
        }

        await sendChannel.send(text);
        return;
      }

      const title = truncate(`[${event.kind}] ${event.title}`, 256);
      const embed = new EmbedBuilder()
        .setTitle(title)
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

function formatToolUiPlainText(event: {
  title: string;
  detail?: string;
  mode: 'verbose' | 'summary';
}): string {
  const body =
    event.mode === 'verbose' && event.detail
      ? `[tool] ${event.title}\n\n${event.detail}`
      : `[tool] ${event.title}`;
  return formatTextCodeBlock(body, 1900);
}

function formatTextCodeBlock(text: string, maxLen: number): string {
  const open = '```text\n';
  const close = '\n```';
  const safe = text.replace(/```/g, '``\u200b`').trimEnd();
  const body = truncate(safe, maxLen - open.length - close.length);
  return `${open}${body}${close}`;
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

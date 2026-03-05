import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscordSlashCommands,
  mapDiscordSlashToRouterCommand,
  type DiscordSlashInteractionLike,
} from '../src/channels/discordCommands.js';

function makeInteraction(params: {
  commandName: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  subcommand?: string;
}): DiscordSlashInteractionLike {
  return {
    commandName: params.commandName,
    options: {
      getString: (name) => params.strings?.[name] ?? null,
      getInteger: (name) => params.integers?.[name] ?? null,
      getSubcommand: () => params.subcommand ?? 'help',
    },
  };
}

test('buildDiscordSlashCommands includes base command names', () => {
  const defs = buildDiscordSlashCommands();
  const names = defs.map((d) => d.name).sort();

  assert.deepEqual(names, [
    'allow',
    'cli',
    'cron',
    'deny',
    'help',
    'last',
    'new',
    'replay',
    'ui',
    'whitelist',
    'workspace',
  ]);
});

test('mapDiscordSlashToRouterCommand maps simple commands', () => {
  assert.equal(
    mapDiscordSlashToRouterCommand(makeInteraction({ commandName: 'help' })),
    '/help',
  );
  assert.equal(
    mapDiscordSlashToRouterCommand(makeInteraction({ commandName: 'new' })),
    '/new',
  );
  assert.equal(
    mapDiscordSlashToRouterCommand(makeInteraction({ commandName: 'last' })),
    '/last',
  );
  assert.equal(
    mapDiscordSlashToRouterCommand(makeInteraction({ commandName: 'deny' })),
    '/deny',
  );
});

test('mapDiscordSlashToRouterCommand maps optional args', () => {
  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'ui',
        strings: { mode: 'summary' },
      }),
    ),
    '/ui summary',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'workspace',
        strings: { path: '/tmp/work' },
      }),
    ),
    '/workspace /tmp/work',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'workspace',
        strings: { path: null },
      }),
    ),
    '/workspace show',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'cli',
        strings: { preset: 'claude' },
      }),
    ),
    '/cli claude',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'cli',
        strings: { preset: null },
      }),
    ),
    '/cli show',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'replay',
        strings: { run_id: 'run-1' },
      }),
    ),
    '/replay run-1',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'allow',
        integers: { index: 3 },
      }),
    ),
    '/allow 3',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'whitelist',
        subcommand: 'add',
        strings: { tool_kind: 'read', prefix: '/tmp/work' },
      }),
    ),
    '/whitelist add read /tmp/work',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'whitelist',
        subcommand: 'list',
      }),
    ),
    '/whitelist list',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'whitelist',
        subcommand: 'del',
        strings: { tool_kind: 'read', prefix: '/tmp/work' },
      }),
    ),
    '/whitelist del read /tmp/work',
  );
});

test('mapDiscordSlashToRouterCommand maps cron subcommands', () => {
  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'cron',
        subcommand: 'list',
      }),
    ),
    '/cron list',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'cron',
        subcommand: 'add',
        strings: { expr: '*/5 * * * *', prompt: 'ping {{date}}' },
      }),
    ),
    '/cron add */5 * * * * ping {{date}}',
  );

  assert.equal(
    mapDiscordSlashToRouterCommand(
      makeInteraction({
        commandName: 'cron',
        subcommand: 'disable',
        strings: { job_id: 'job-42' },
      }),
    ),
    '/cron disable job-42',
  );
});

test('mapDiscordSlashToRouterCommand returns null for unknown command', () => {
  assert.equal(
    mapDiscordSlashToRouterCommand(makeInteraction({ commandName: 'unknown' })),
    null,
  );
});

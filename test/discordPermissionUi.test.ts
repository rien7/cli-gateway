import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDiscordChannelDescription,
  extractPermissionRouteFromComponents,
  parsePermissionCustomId,
  permissionDecisionFromEmoji,
} from '../src/channels/discord.js';

test('parsePermissionCustomId parses valid acpperm ids', () => {
  assert.deepEqual(parsePermissionCustomId('acpperm:s1:r1:allow'), {
    sessionKey: 's1',
    requestId: 'r1',
    decision: 'allow',
  });

  assert.deepEqual(parsePermissionCustomId('acpperm:s2:r2:deny'), {
    sessionKey: 's2',
    requestId: 'r2',
    decision: 'deny',
  });
});

test('parsePermissionCustomId rejects malformed ids', () => {
  assert.equal(parsePermissionCustomId(''), null);
  assert.equal(parsePermissionCustomId('acpperm::r1:allow'), null);
  assert.equal(parsePermissionCustomId('acpperm:s1::allow'), null);
  assert.equal(parsePermissionCustomId('acpperm:s1:r1:maybe'), null);
  assert.equal(parsePermissionCustomId('hello:s1:r1:allow'), null);
});

test('permissionDecisionFromEmoji maps supported reactions', () => {
  assert.equal(permissionDecisionFromEmoji('✅'), 'allow');
  assert.equal(permissionDecisionFromEmoji('👍'), 'allow');
  assert.equal(permissionDecisionFromEmoji('❌'), 'deny');
  assert.equal(permissionDecisionFromEmoji('👎'), 'deny');
  assert.equal(permissionDecisionFromEmoji('😀'), null);
  assert.equal(permissionDecisionFromEmoji(null), null);
});

test('extractPermissionRouteFromComponents finds first permission route', () => {
  const route = extractPermissionRouteFromComponents([
    {
      components: [
        { customId: 'noop:x:y:z' },
        { customId: 'acpperm:session-1:req-7:allow' },
      ],
    },
  ]);

  assert.deepEqual(route, {
    sessionKey: 'session-1',
    requestId: 'req-7',
  });
});

test('extractPermissionRouteFromComponents returns null when absent', () => {
  assert.equal(extractPermissionRouteFromComponents(undefined), null);
  assert.equal(extractPermissionRouteFromComponents([]), null);
  assert.equal(
    extractPermissionRouteFromComponents([{ components: [{ customId: 'noop' }] }]),
    null,
  );
});

test('extractDiscordChannelDescription prefers channel topic then parent fallback', () => {
  assert.equal(
    extractDiscordChannelDescription({
      topic: '  team playbook  ',
      description: 'ignored',
      parent: { topic: 'parent topic' },
    }),
    'team playbook',
  );

  assert.equal(
    extractDiscordChannelDescription({
      topic: '  ',
      parent: { topic: '  parent rules  ' },
    }),
    'parent rules',
  );

  assert.equal(
    extractDiscordChannelDescription({
      topic: '',
      description: '',
      parent: { topic: ' ', description: '' },
    }),
    null,
  );
});

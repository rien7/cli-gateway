import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { parseToolKind, ToolAuth } from '../src/gateway/toolAuth.js';
import { createSession, upsertBinding, type ConversationKey } from '../src/gateway/sessionStore.js';

test('ToolAuth consume supports once grants and persistent policy', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const toolAuth = new ToolAuth(db);

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's1';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });

  const binding = upsertBinding(db, key, sessionKey);

  assert.equal(toolAuth.consume(sessionKey, 'read'), false);

  toolAuth.grantOnce(sessionKey, 'read', 2);
  assert.equal(toolAuth.consume(sessionKey, 'read'), true);
  assert.equal(toolAuth.consume(sessionKey, 'read'), true);
  assert.equal(toolAuth.consume(sessionKey, 'read'), false);

  toolAuth.setPersistentPolicy(binding.bindingKey, 'execute', 'reject');
  assert.equal(toolAuth.consume(sessionKey, 'execute'), false);

  toolAuth.setPersistentPolicy(binding.bindingKey, 'execute', 'allow');
  assert.equal(toolAuth.consume(sessionKey, 'execute'), true);

  const allowList = toolAuth.listPersistentPolicies(binding.bindingKey, 'allow');
  assert.deepEqual(
    allowList.map((row) => row.toolKind),
    ['execute'],
  );

  const removed = toolAuth.clearPersistentPolicy(
    binding.bindingKey,
    'execute',
    'allow',
  );
  assert.equal(removed, true);
  assert.equal(toolAuth.listPersistentPolicies(binding.bindingKey, 'allow').length, 0);

  toolAuth.setAllowPrefixRule(binding.bindingKey, 'read', '/tmp/allow');
  assert.equal(
    toolAuth.consume(sessionKey, 'read', {
      method: 'fs/read_text_file',
      params: { path: '/tmp/allow/a.txt' },
    }),
    true,
  );
  assert.equal(
    toolAuth.consume(sessionKey, 'read', {
      method: 'fs/read_text_file',
      params: { path: '/tmp/nope/a.txt' },
    }),
    false,
  );

  const removedPrefix = toolAuth.clearAllowPrefixRule(
    binding.bindingKey,
    'read',
    '/tmp/allow',
  );
  assert.equal(removedPrefix, true);
  assert.equal(toolAuth.listAllowPrefixRules(binding.bindingKey, 'read').length, 0);
});

test('parseToolKind normalizes values and rejects unknown kinds', () => {
  assert.equal(parseToolKind('READ'), 'read');
  assert.equal(parseToolKind(' execute '), 'execute');
  assert.equal(parseToolKind('unknown_kind'), null);
  assert.equal(parseToolKind(null), null);
});

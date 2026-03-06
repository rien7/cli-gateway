import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import {
  bindingKeyFromConversationKey,
  createRun,
  createSession,
  finishRun,
  getBinding,
  getSession,
  SHARED_CHAT_SCOPE_USER_ID,
  updateSessionAgentConfig,
  updateSessionCwd,
  upsertBinding,
  type ConversationKey,
  type Platform,
} from './sessionStore.js';
import {
  createJob,
  deleteJob,
  listJobsForBinding,
  setJobEnabled,
} from '../db/jobStore.js';
import { upsertDeliveryCheckpoint } from '../db/deliveryCheckpointStore.js';
import { getUiMode, setUiMode } from '../db/uiPrefStore.js';
import { ToolAuth, parseToolKind, TOOL_KINDS } from './toolAuth.js';
import { BindingRuntime } from './bindingRuntime.js';
import type { OutboundSink, UiMode } from './types.js';
import { buildReplayContextFromRecentRuns } from './history.js';
import { resolveWorkspacePath } from '../tools/workspace.js';

export type { OutboundSink } from './types.js';

export type CliInlineCommand = {
  name: string;
  description: string;
  inputHint: string | null;
};

export type UserResource = {
  uri: string;
  mimeType?: string;
};

export type UserMessageOptions = {
  resources?: UserResource[];
  globalContextText?: string;
};

type CliPresetId = 'codex' | 'claude';

type CliPreset = {
  id: CliPresetId;
  label: string;
  agentCommand: string;
  agentArgs: string[];
};

const CLI_PRESETS: Record<CliPresetId, CliPreset> = {
  codex: {
    id: 'codex',
    label: 'Codex',
    agentCommand: 'npx',
    agentArgs: ['-y', '@zed-industries/codex-acp@latest'],
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    agentCommand: 'npx',
    agentArgs: ['-y', '@zed-industries/claude-code-acp@latest'],
  },
};

export class GatewayRouter {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly onJobsChanged?: () => void;
  private readonly runtimeFactory?: (params: {
    db: Db;
    config: AppConfig;
    toolAuth: ToolAuth;
    sessionKey: string;
    bindingKey: string;
    workspaceRoot: string;
    agentCommand: string;
    agentArgs: string[];
  }) => BindingRuntime;

  private readonly runtimesBySessionKey = new Map<
    string,
    { runtime: BindingRuntime; lastUsedMs: number }
  >();

  private gcTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    db: Db;
    config: AppConfig;
    onJobsChanged?: () => void;
    runtimeFactory?: (params: {
      db: Db;
      config: AppConfig;
      toolAuth: ToolAuth;
      sessionKey: string;
      bindingKey: string;
      workspaceRoot: string;
      agentCommand: string;
      agentArgs: string[];
    }) => BindingRuntime;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.onJobsChanged = params.onJobsChanged;
    this.runtimeFactory = params.runtimeFactory;
    this.toolAuth = new ToolAuth(this.db);
  }

  async start(): Promise<void> {
    this.gcTimer = setInterval(() => {
      try {
        this.gc();
      } catch (error) {
        log.warn('runtime GC error', error);
      }
    }, 60_000);

    log.info('GatewayRouter ready');
  }

  close(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    for (const entry of this.runtimesBySessionKey.values()) {
      entry.runtime.close();
    }
    this.runtimesBySessionKey.clear();
  }

  private ensureBindingExists(key: ConversationKey): {
    bindingKey: string;
    sessionKey: string;
  } {
    const bindingKey = bindingKeyFromConversationKey(key);
    const existing = getBinding(this.db, key);
    if (existing) return { bindingKey, sessionKey: existing.sessionKey };

    const sessionKey = randomUUID();

    // Create a minimal session row; runtime will update loadSupported after initialize.
    createSession(this.db, {
      sessionKey,
      agentCommand: this.config.acpAgentCommand,
      agentArgs: this.config.acpAgentArgs,
      cwd: this.config.workspaceRoot,
      loadSupported: false,
    });

    upsertBinding(this.db, key, sessionKey);

    return { bindingKey, sessionKey };
  }

  private getOrCreateRuntime(params: {
    sessionKey: string;
    bindingKey: string;
  }): BindingRuntime {
    const existing = this.runtimesBySessionKey.get(params.sessionKey);
    if (existing) {
      existing.lastUsedMs = Date.now();
      return existing.runtime;
    }

    const sess = getSession(this.db, params.sessionKey);
    if (!sess) {
      throw new Error(`Missing session row: ${params.sessionKey}`);
    }

    const agentArgs = parseSessionAgentArgs(
      sess.agentArgsJson,
      this.config.acpAgentArgs,
    );

    const rt = this.runtimeFactory
      ? this.runtimeFactory({
          db: this.db,
          config: this.config,
          toolAuth: this.toolAuth,
          sessionKey: params.sessionKey,
          bindingKey: params.bindingKey,
          workspaceRoot: sess.cwd,
          agentCommand: sess.agentCommand,
          agentArgs,
        })
      : new BindingRuntime({
          db: this.db,
          config: this.config,
          toolAuth: this.toolAuth,
          sessionKey: params.sessionKey,
          bindingKey: params.bindingKey,
          workspaceRoot: sess.cwd,
          agentCommand: sess.agentCommand,
          agentArgs,
        });

    this.runtimesBySessionKey.set(params.sessionKey, {
      runtime: rt,
      lastUsedMs: Date.now(),
    });

    this.enforceRuntimeLimit();

    return rt;
  }

  private gc(): void {
    const now = Date.now();
    const ttlMs = this.config.runtimeIdleTtlSeconds * 1000;

    for (const [sessionKey, entry] of this.runtimesBySessionKey.entries()) {
      if (now - entry.lastUsedMs <= ttlMs) continue;
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }

    this.enforceRuntimeLimit();
  }

  private resolveWorkspaceArg(arg: string): string {
    const trimmed = arg.trim();
    if (!trimmed) {
      throw new Error('Empty workspace path');
    }

    const home = os.homedir();
    const expanded =
      trimmed === '~'
        ? home
        : trimmed.startsWith('~/')
          ? path.join(home, trimmed.slice(2))
          : trimmed;

    if (!path.isAbsolute(expanded)) {
      throw new Error('Workspace path must be absolute');
    }

    const stat = fs.statSync(expanded, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      throw new Error('Workspace path must exist and be a directory');
    }

    return expanded;
  }

  private enforceRuntimeLimit(): void {
    const max = this.config.maxBindingRuntimes;
    if (this.runtimesBySessionKey.size <= max) return;

    const entries = [...this.runtimesBySessionKey.entries()].sort(
      (a, b) => a[1].lastUsedMs - b[1].lastUsedMs,
    );

    const removeCount = Math.max(0, entries.length - max);
    for (let i = 0; i < removeCount; i += 1) {
      const [sessionKey, entry] = entries[i];
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }
  }

  async handlePermissionUi(params: {
    platform: Platform;
    sessionKey: string;
    requestId: string;
    decision: 'allow' | 'deny';
    actorUserId: string;
  }): Promise<{ ok: boolean; message: string }> {
    // Permissions require a live runtime because the ACP agent is process-local.
    // If the runtime has been GC'ed, the user must send a new message.

    const binding = this.db
      .prepare(
        'SELECT binding_key as bindingKey, platform, chat_id as chatId, user_id as userId FROM bindings WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1',
      )
      .get(params.sessionKey) as
      | {
          bindingKey: string;
          platform: Platform;
          chatId: string;
          userId: string;
        }
      | undefined;

    if (!binding) {
      return { ok: false, message: 'Unknown session binding.' };
    }

    if (binding.platform !== params.platform) {
      return { ok: false, message: 'Permission binding platform mismatch.' };
    }

    if (
      binding.userId !== params.actorUserId &&
      binding.userId !== SHARED_CHAT_SCOPE_USER_ID
    ) {
      return { ok: false, message: 'Not authorized.' };
    }

    const entry = this.runtimesBySessionKey.get(params.sessionKey);
    if (!entry) {
      return { ok: false, message: 'No active runtime. Send a message first.' };
    }

    return entry.runtime.decidePermission({
      decision: params.decision,
      requestId: params.requestId,
      actorUserId: params.actorUserId,
    });
  }

  private async handleCommand(
    key: ConversationKey,
    text: string,
    sink: OutboundSink,
  ): Promise<boolean> {
    if (!text.startsWith('/')) return false;

    const parts = text.trim().split(/\s+/);
    const cmd = normalizeCommand(parts[0]);

    switch (cmd) {
      case '/help': {
        const inline = this.listCliInlineCommands(key);
        const inlineLines = inline.length
          ? [
              '',
              'CLI Inline Commands:',
              ...inline.map((cmd) => {
                const desc = truncate(cmd.description, 120);
                const hint = cmd.inputHint ? ` (input: ${truncate(cmd.inputHint, 40)})` : '';
                return `/${cmd.name} (cli-inline) - ${desc}${hint}`;
              }),
            ]
          : [];

        await sink.sendText(
          [
            'Commands:',
            '/help',
            '/ui verbose|summary',
            '/cli show|codex|claude',
            '/workspace show|<absolute-path>',
            '/new',
            '/last',
            '/replay [runId]',
            '/allow <n>',
            '/deny',
            '/whitelist list|add|del|clear',
            '/cron help',
            ...inlineLines,
          ].join('\n'),
        );
        return true;
      }

      case '/new': {
        const binding = getBinding(this.db, key);
        const previousSession = binding
          ? getSession(this.db, binding.sessionKey)
          : null;

        if (binding) {
          const entry = this.runtimesBySessionKey.get(binding.sessionKey);
          entry?.runtime.close();
          this.runtimesBySessionKey.delete(binding.sessionKey);
        }

        const nextSessionKey = randomUUID();
        createSession(this.db, {
          sessionKey: nextSessionKey,
          agentCommand:
            previousSession?.agentCommand ?? this.config.acpAgentCommand,
          agentArgs: previousSession
            ? parseSessionAgentArgs(
                previousSession.agentArgsJson,
                this.config.acpAgentArgs,
              )
            : this.config.acpAgentArgs,
          cwd: previousSession?.cwd ?? this.config.workspaceRoot,
          loadSupported: false,
        });
        upsertBinding(this.db, key, nextSessionKey);

        await sink.sendText('OK: started a new session for this conversation.');
        return true;
      }

      case '/last': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const lastRun = this.db
          .prepare(
            'SELECT run_id as runId, stop_reason as stopReason, error FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
          )
          .get(binding.sessionKey) as
          | { runId: string; stopReason: string | null; error: string | null }
          | undefined;

        if (!lastRun) {
          await sink.sendText('No runs for this session yet.');
          return true;
        }

        const rows = this.db
          .prepare(
            'SELECT payload_json as payloadJson FROM events WHERE run_id = ? ORDER BY seq ASC',
          )
          .all(lastRun.runId) as Array<{ payloadJson: string }>;

        let text = '';
        for (const row of rows) {
          try {
            const payload = JSON.parse(row.payloadJson);
            const update = payload?.update;
            if (update?.sessionUpdate !== 'agent_message_chunk') continue;
            text += update?.content?.text ?? '';
          } catch {
            // ignore malformed rows
          }
        }

        if (!text.trim()) {
          const fallback =
            lastRun.error ? `Last run error: ${lastRun.error}` : lastRun.stopReason;
          await sink.sendText(fallback ? String(fallback) : '(no output)');
          return true;
        }

        await sink.sendText(text);
        return true;
      }

      case '/ui': {
        const { bindingKey } = this.ensureBindingExists(key);
        const arg = (parts[1] ?? '').toLowerCase();

        const current =
          getUiMode(this.db, bindingKey) ?? this.config.uiDefaultMode;

        if (!arg || arg === 'show') {
          await sink.sendText(`UI mode: ${current}`);
          return true;
        }

        if (arg !== 'verbose' && arg !== 'summary') {
          await sink.sendText('Usage: /ui verbose|summary');
          return true;
        }

        setUiMode(this.db, bindingKey, arg as UiMode);
        await sink.sendText(`OK: UI mode set to ${arg}`);
        return true;
      }

      case '/cli': {
        const { sessionKey } = this.ensureBindingExists(key);
        const sess = getSession(this.db, sessionKey);
        if (!sess) {
          await sink.sendText('Missing session row.');
          return true;
        }

        const argRaw = (parts[1] ?? 'show').toLowerCase();
        const selection = parseCliPresetArg(argRaw);
        if (!selection) {
          await sink.sendText('Usage: /cli show|codex|claude');
          return true;
        }

        const currentArgs = parseSessionAgentArgs(
          sess.agentArgsJson,
          this.config.acpAgentArgs,
        );
        const currentPreset = detectCliPreset(sess.agentCommand, currentArgs);

        if (selection === 'show') {
          const label = currentPreset
            ? CLI_PRESETS[currentPreset].label
            : 'Custom';
          await sink.sendText(
            `CLI: ${label} (${formatAgentSpec(sess.agentCommand, currentArgs)})`,
          );
          return true;
        }

        const target = CLI_PRESETS[selection];
        const unchanged =
          sess.agentCommand === target.agentCommand &&
          sameArgs(currentArgs, target.agentArgs);
        if (unchanged) {
          await sink.sendText(
            `CLI unchanged: ${target.label} (${formatAgentSpec(target.agentCommand, target.agentArgs)})`,
          );
          return true;
        }

        updateSessionAgentConfig(this.db, {
          sessionKey,
          agentCommand: target.agentCommand,
          agentArgs: target.agentArgs,
        });

        const entry = this.runtimesBySessionKey.get(sessionKey);
        if (entry) {
          entry.runtime.close();
          this.runtimesBySessionKey.delete(sessionKey);
        }

        await sink.sendText(
          `OK: CLI switched to ${target.label} (${formatAgentSpec(target.agentCommand, target.agentArgs)}).`,
        );
        return true;
      }

      case '/workspace':
      case '/ws': {
        const { sessionKey } = this.ensureBindingExists(key);

        const arg = parts.slice(1).join(' ').trim();
        const sess = getSession(this.db, sessionKey);
        if (!sess) {
          await sink.sendText('Missing session row.');
          return true;
        }

        if (!arg || arg === 'show') {
          await sink.sendText(`Workspace: ${sess.cwd}`);
          return true;
        }

        let nextCwd: string;
        try {
          nextCwd = this.resolveWorkspaceArg(arg);
        } catch (error: any) {
          await sink.sendText(`Error: ${String(error?.message ?? error)}`);
          return true;
        }

        updateSessionCwd(this.db, sessionKey, nextCwd);

        const entry = this.runtimesBySessionKey.get(sessionKey);
        if (entry) {
          entry.runtime.close();
          this.runtimesBySessionKey.delete(sessionKey);
        }

        await sink.sendText(`OK: workspace set to ${nextCwd}`);
        return true;
      }

      case '/replay': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);

        let runId = parts[1] ?? '';
        if (!runId) {
          const last = this.db
            .prepare(
              'SELECT run_id as runId FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
            )
            .get(binding.sessionKey) as { runId: string } | undefined;

          runId = last?.runId ?? '';
        }

        if (!runId) {
          await sink.sendText('No runs for this session yet.');
          return true;
        }

        const rows = this.db
          .prepare(
            'SELECT seq, method, payload_json as payloadJson FROM events WHERE run_id = ? ORDER BY seq ASC',
          )
          .all(runId) as Array<{ seq: number; method: string; payloadJson: string }>;

        let sent = false;
        let maxSeq = 0;

        for (const row of rows) {
          maxSeq = Math.max(maxSeq, row.seq);
          if (row.method !== 'session/update') continue;

          try {
            const payload = JSON.parse(row.payloadJson);
            const delta = renderSessionUpdateDelta(payload?.update);
            if (!delta) continue;
            await sink.sendText(delta);
            sent = true;
          } catch {
            // ignore malformed rows
          }
        }

        if (!sent) {
          await sink.sendText('(no replayable output)');
        }

        await sink.flush?.();

        const state = sink.getDeliveryState?.();
        if (state) {
          upsertDeliveryCheckpoint(this.db, {
            bindingKey,
            runId,
            lastSeq: maxSeq,
            messageId: state.messageId,
            text: state.text,
          });
        }

        return true;
      }

      case '/allow': {
        const idx = Number(parts[1] ?? '');
        if (!Number.isFinite(idx) || idx < 1) {
          await sink.sendText('Usage: /allow <n>');
          return true;
        }

        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);
        const rt = this.getOrCreateRuntime({
          sessionKey: binding.sessionKey,
          bindingKey,
        });

        await rt.selectPermissionOption(idx, sink, key.userId);
        return true;
      }

      case '/deny': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);
        const rt = this.getOrCreateRuntime({
          sessionKey: binding.sessionKey,
          bindingKey,
        });

        await rt.denyPermission(sink, key.userId);
        return true;
      }

      case '/whitelist':
      case '/wl': {
        const { bindingKey, sessionKey } = this.ensureBindingExists(key);
        const sub = String(parts[1] ?? 'list').trim().toLowerCase();
        const sess = getSession(this.db, sessionKey);
        const workspaceRoot = sess?.cwd ?? this.config.workspaceRoot;

        if (!sub || sub === 'list' || sub === 'show') {
          const globalRows = this.toolAuth.listPersistentPolicies(
            bindingKey,
            'allow',
          );
          const prefixRows = this.toolAuth.listAllowPrefixRules(bindingKey);

          if (globalRows.length === 0 && prefixRows.length === 0) {
            await sink.sendText('Whitelist: (empty)');
            return true;
          }

          const lines = ['Whitelist:'];
          for (const row of globalRows) {
            lines.push(`- ${row.toolKind} (all)`);
          }
          for (const row of prefixRows) {
            lines.push(`- ${row.toolKind} prefix: ${row.argPrefix}`);
          }

          await sink.sendText(lines.join('\n'));
          return true;
        }

        if (sub === 'add') {
          const toolKind = parseToolKind(parts[2]);
          const rawPrefix = parts.slice(3).join(' ').trim();
          if (!toolKind) {
            await sink.sendText(whitelistUsageText());
            return true;
          }

          if (!rawPrefix) {
            this.toolAuth.setPersistentPolicy(bindingKey, toolKind, 'allow');
            await sink.sendText(`OK: whitelisted ${toolKind} (all)`);
            return true;
          }

          const normalizedPrefix = normalizeWhitelistPrefix(
            toolKind,
            rawPrefix,
            workspaceRoot,
          );
          if (!normalizedPrefix) {
            await sink.sendText(whitelistUsageText());
            return true;
          }

          // Scoped prefix rules should not accidentally inherit broader allow-all.
          this.toolAuth.clearPersistentPolicy(bindingKey, toolKind, 'allow');
          this.toolAuth.setAllowPrefixRule(
            bindingKey,
            toolKind,
            normalizedPrefix,
          );
          await sink.sendText(
            `OK: whitelisted ${toolKind} prefix ${normalizedPrefix}`,
          );
          return true;
        }

        if (
          sub === 'del' ||
          sub === 'delete' ||
          sub === 'remove' ||
          sub === 'rm'
        ) {
          const toolKind = parseToolKind(parts[2]);
          const rawPrefix = parts.slice(3).join(' ').trim();
          if (!toolKind) {
            await sink.sendText(whitelistUsageText());
            return true;
          }

          if (rawPrefix) {
            const normalizedPrefix = normalizeWhitelistPrefix(
              toolKind,
              rawPrefix,
              workspaceRoot,
            );
            if (!normalizedPrefix) {
              await sink.sendText(whitelistUsageText());
              return true;
            }

            const removed = this.toolAuth.clearAllowPrefixRule(
              bindingKey,
              toolKind,
              normalizedPrefix,
            );
            await sink.sendText(
              removed
                ? `OK: removed ${toolKind} prefix ${normalizedPrefix}`
                : `Whitelist did not include ${toolKind} prefix ${normalizedPrefix}.`,
            );
            return true;
          }

          const removedAll = this.toolAuth.clearPersistentPolicy(
            bindingKey,
            toolKind,
            'allow',
          );
          const removedPrefixes = this.toolAuth.clearAllowPrefixRules(
            bindingKey,
            toolKind,
          );

          await sink.sendText(
            removedAll || removedPrefixes > 0
              ? `OK: removed ${toolKind} from whitelist`
              : `Whitelist did not include ${toolKind}.`,
          );
          return true;
        }

        if (sub === 'clear') {
          const removedAll = this.toolAuth.clearPersistentPolicies(
            bindingKey,
            'allow',
          );
          const removedPrefixes = this.toolAuth.clearAllowPrefixRules(bindingKey);
          const removed = removedAll + removedPrefixes;
          await sink.sendText(
            removed > 0
              ? `OK: cleared whitelist (${removed} entries).`
              : 'Whitelist already empty.',
          );
          return true;
        }

        await sink.sendText(whitelistUsageText());
        return true;
      }

      case '/cron': {
        const sub = parts[1];
        const bindingKey = bindingKeyFromConversationKey(key);

        if (!sub || sub === 'help') {
          await sink.sendText(
            [
              'Usage:',
              '/cron list',
              '/cron add <m h dom mon dow> <prompt...>',
              '/cron del <jobId>',
              '/cron enable <jobId>',
              '/cron disable <jobId>',
              '',
              'Template vars: {{now_iso}} {{date}}',
            ].join('\n'),
          );
          return true;
        }

        if (sub === 'list') {
          const jobs = listJobsForBinding(this.db, bindingKey);
          if (!jobs.length) {
            await sink.sendText('No jobs for this conversation.');
            return true;
          }

          await sink.sendText(
            jobs
              .map(
                (j) =>
                  `- ${j.jobId} enabled=${j.enabled ? '1' : '0'} cron="${j.cronExpr}" template="${truncate(j.promptTemplate, 80)}"`,
              )
              .join('\n'),
          );
          return true;
        }

        if (sub === 'add') {
          // Ensure binding exists so scheduler knows where to deliver.
          this.ensureBindingExists(key);

          // Expect 5 cron fields then prompt text.
          const cronExpr = parts.slice(2, 7).join(' ');
          const promptTemplate = parts.slice(7).join(' ');

          if (
            !cronExpr ||
            cronExpr.split(' ').filter(Boolean).length < 5 ||
            !promptTemplate
          ) {
            await sink.sendText(
              'Usage: /cron add <m h dom mon dow> <prompt...>',
            );
            return true;
          }

          const jobId = createJob(this.db, {
            bindingKey,
            cronExpr,
            promptTemplate,
          });
          this.onJobsChanged?.();
          await sink.sendText(`OK: job created ${jobId}`);
          return true;
        }

        if (sub === 'del') {
          const jobId = parts[2];
          if (!jobId) {
            await sink.sendText('Usage: /cron del <jobId>');
            return true;
          }
          deleteJob(this.db, jobId);
          this.onJobsChanged?.();
          await sink.sendText(`OK: job deleted ${jobId}`);
          return true;
        }

        if (sub === 'enable' || sub === 'disable') {
          const jobId = parts[2];
          if (!jobId) {
            await sink.sendText(`Usage: /cron ${sub} <jobId>`);
            return true;
          }
          setJobEnabled(this.db, jobId, sub === 'enable');
          this.onJobsChanged?.();
          await sink.sendText(`OK: job ${sub}d ${jobId}`);
          return true;
        }

        await sink.sendText('Unknown /cron subcommand. Try /cron help');
        return true;
      }

      default:
        return false;
    }
  }

  async handleUserMessage(
    key: ConversationKey,
    text: string,
    sink: OutboundSink,
    options?: UserMessageOptions,
  ): Promise<void> {
    const commandHandled = await this.handleCommand(key, text, sink);
    if (commandHandled) {
      try {
        await sink.flush?.();
      } catch (error) {
        log.warn('sink flush error (command)', error);
      }
      return;
    }

    const normalizedText = text.trim();
    const resources = sanitizeResources(options?.resources);
    if (!normalizedText && resources.length === 0) {
      return;
    }

    const { bindingKey, sessionKey } = this.ensureBindingExists(key);
    const rt = this.getOrCreateRuntime({ sessionKey, bindingKey });

    // Ensure session row exists (cron may have created binding+session already).
    const sess = getSession(this.db, sessionKey);

    /* c8 ignore next 11 */
    if (!sess) {
      // With foreign_keys=ON, a binding cannot exist without a session.
      // Keep as a defensive fallback.
      createSession(this.db, {
        sessionKey,
        agentCommand: this.config.acpAgentCommand,
        agentArgs: this.config.acpAgentArgs,
        cwd: this.config.workspaceRoot,
        loadSupported: false,
      });
    }

    const runId = randomUUID();
    createRun(this.db, {
      runId,
      sessionKey,
      promptText: formatPromptTextForStorage(text, resources),
    });

    let contextText = '';
    const isFreshSession = !rt.hasSessionId();
    if (isFreshSession) {
      const contextParts: string[] = [];

      const globalContextText = formatGlobalContextText(
        options?.globalContextText,
      );
      if (globalContextText) {
        contextParts.push(globalContextText);
      }

      if (this.config.contextReplayEnabled && this.config.contextReplayRuns > 0) {
        const replayContextText = buildReplayContextFromRecentRuns(this.db, {
          sessionKey,
          excludeRunId: runId,
          maxRuns: this.config.contextReplayRuns,
          maxChars: this.config.contextReplayMaxChars,
        });
        if (replayContextText) {
          contextParts.push(replayContextText);
        }
      }

      contextText = contextParts.join('\n\n');
    }

    try {
      const uiMode = getUiMode(this.db, bindingKey) ?? this.config.uiDefaultMode;

      const result = await rt.prompt({
        runId,
        promptText: normalizedText || text,
        promptResources: resources,
        sink,
        uiMode,
        contextText,
        actorUserId: key.userId,
      });

      finishRun(this.db, { runId, stopReason: result.stopReason });
    } catch (error: any) {
      finishRun(this.db, { runId, error: String(error?.message ?? error) });

      if (isAcpTransportError(error)) {
        const stale = this.runtimesBySessionKey.get(sessionKey);
        stale?.runtime.close();
        this.runtimesBySessionKey.delete(sessionKey);
      }

      await sink.sendText(`Error: ${String(error?.message ?? error)}`);
    } finally {
      try {
        await sink.flush?.();
      } catch (error) {
        log.warn('sink flush error', error);
      }

      const state = sink.getDeliveryState?.();
      if (state) {
        const row = this.db
          .prepare('SELECT MAX(seq) as maxSeq FROM events WHERE run_id = ?')
          .get(runId) as { maxSeq: number | null } | undefined;

        upsertDeliveryCheckpoint(this.db, {
          bindingKey,
          runId,
          lastSeq: row?.maxSeq ?? 0,
          messageId: state.messageId,
          text: state.text,
        });
      }
    }
  }

  listCliInlineCommands(key: ConversationKey): CliInlineCommand[] {
    const binding = getBinding(this.db, key);
    if (!binding) return [];
    return this.listCliInlineCommandsBySession(binding.sessionKey);
  }

  listCliInlineCommandsBySession(sessionKey: string): CliInlineCommand[] {
    const row = this.db
      .prepare(
        `
        SELECT e.payload_json as payloadJson
        FROM events e
        JOIN runs r ON r.run_id = e.run_id
        WHERE
          r.session_key = ?
          AND e.method = 'session/update'
          AND json_extract(e.payload_json, '$.update.sessionUpdate') = 'available_commands_update'
        ORDER BY e.created_at DESC, e.seq DESC
        LIMIT 1
        `,
      )
      .get(sessionKey) as { payloadJson: string } | undefined;

    if (!row?.payloadJson) return [];

    try {
      const payload = JSON.parse(row.payloadJson);
      const list = payload?.update?.availableCommands;
      if (!Array.isArray(list)) return [];

      const out: CliInlineCommand[] = [];
      const seen = new Set<string>();

      for (const item of list) {
        const name = String(item?.name ?? '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        out.push({
          name,
          description: String(item?.description ?? '').trim(),
          inputHint: item?.input?.hint ? String(item.input.hint) : null,
        });
      }

      return out;
    } catch {
      return [];
    }
  }
}

function parseSessionAgentArgs(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string')
    ) {
      return parsed;
    }
  } catch {
    // ignore invalid persisted JSON
  }
  return [...fallback];
}

function parseCliPresetArg(raw: string): CliPresetId | 'show' | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'show') return 'show';
  if (value === 'codex') return 'codex';
  if (value === 'claude' || value === 'claude-code' || value === 'claude_code') {
    return 'claude';
  }
  return null;
}

function detectCliPreset(command: string, args: string[]): CliPresetId | null {
  for (const preset of Object.values(CLI_PRESETS)) {
    if (command !== preset.agentCommand) continue;
    if (!sameArgs(args, preset.agentArgs)) continue;
    return preset.id;
  }
  return null;
}

function sameArgs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function formatAgentSpec(command: string, args: string[]): string {
  const quotedArgs = args.map((item) => quoteArg(item));
  const parts = [quoteArg(command), ...quotedArgs].filter(Boolean);
  return parts.join(' ');
}

function quoteArg(text: string): string {
  if (!text) return '""';
  if (!/[\s"'`$\\]/.test(text)) return text;
  return JSON.stringify(text);
}

function renderSessionUpdateDelta(update: any): string {
  if (!update || typeof update !== 'object') return '';

  if (update.sessionUpdate === 'agent_message_chunk') {
    return update?.content?.text ?? '';
  }

  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const id = String(update?.toolCallId ?? update?.id ?? '').trim();
    const status =
      update.sessionUpdate === 'tool_call'
        ? 'started'
        : String(update?.status ?? update?.state ?? 'running').trim() || 'running';
    const title = String(update?.title ?? id ?? 'tool_call').trim() || 'tool_call';
    return formatTextCodeBlock(
      id
        ? `[tool] ${title} · ${status} (${id})`
        : `[tool] ${title} · ${status}`,
    );
  }

  if (update.sessionUpdate === 'plan') {
    return '\n[plan]\n';
  }

  return '';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function formatTextCodeBlock(text: string): string {
  const safe = text.trim().replace(/```/g, '``\u200b`');
  return `\n\`\`\`text\n${safe}\n\`\`\`\n`;
}

function whitelistUsageText(): string {
  return [
    'Usage:',
    '/whitelist list',
    '/whitelist add <tool_kind> [prefix]',
    '/whitelist del <tool_kind> [prefix]',
    '/whitelist clear',
    '',
    'prefix rules:',
    '- read|edit|delete|move: absolute path prefix under current workspace',
    '- execute/others: string prefix on command/arguments',
    '',
    `tool_kind: ${TOOL_KINDS.join('|')}`,
  ].join('\n');
}

const PATH_PREFIX_WHITELIST_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
]);

function normalizeWhitelistPrefix(
  toolKind: string,
  rawPrefix: string,
  workspaceRoot: string,
): string | null {
  const trimmed = rawPrefix.trim();
  if (!trimmed) return null;

  if (PATH_PREFIX_WHITELIST_KINDS.has(toolKind)) {
    if (!path.isAbsolute(trimmed)) return null;
    try {
      return resolveWorkspacePath(workspaceRoot, trimmed);
    } catch {
      return null;
    }
  }

  const normalized = trimmed.replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeCommand(raw: string | undefined): string {
  if (!raw) return '';
  const command = raw.toLowerCase();

  // Telegram commands may include "/cmd@botname". Keep only "/cmd".
  const at = command.indexOf('@');
  if (at > 1 && command.startsWith('/')) {
    return command.slice(0, at);
  }

  return command;
}

function sanitizeResources(resources: UserMessageOptions['resources']): UserResource[] {
  if (!resources || resources.length === 0) return [];

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

function formatGlobalContextText(input: string | undefined): string {
  const text = String(input ?? '').trim();
  if (!text) return '';
  return `Global context (channel description):\n${text}`;
}

function formatPromptTextForStorage(text: string, resources: UserResource[]): string {
  const trimmed = text.trim();
  if (resources.length === 0) return text;

  const attachmentSummary =
    resources.length === 1
      ? '[attachment] image'
      : `[attachments] ${resources.length} images`;

  if (!trimmed) return attachmentSummary;
  return `${text}\n${attachmentSummary}`;
}

function isAcpTransportError(error: unknown): boolean {
  const name = String((error as { name?: unknown } | null)?.name ?? '').trim();
  if (name === 'AcpTransportError') return true;

  const message = String(
    (error as { message?: unknown } | null)?.message ?? error ?? '',
  ).toLowerCase();

  return (
    message.includes('acp process is not running') ||
    message.includes('acp agent exited') ||
    message.includes('acp request timed out')
  );
}

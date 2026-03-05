import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { OutboundSink, ToolUiStage, UiMode } from './types.js';
import { AcpClient, type PermissionRequest } from '../acp/client.js';
import type { ContentBlock, InitializeResult } from '../acp/types.js';
import {
  SHARED_CHAT_SCOPE_USER_ID,
  updateAcpSessionId,
  updateLoadSupported,
} from './sessionStore.js';
import { ToolAuth, parseToolKind, type ToolKind } from './toolAuth.js';

export class BindingRuntime {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly sessionKey: string;
  private readonly bindingKey: string;

  private readonly client: AcpClient;
  private init: InitializeResult | null = null;

  private acpSessionId: string | null = null;

  private queue: Promise<unknown> = Promise.resolve();
  private activeSink: OutboundSink | null = null;

  private pendingPermission: PermissionRequest | null = null;
  private pendingPermissionActorUserId: string | null = null;

  private currentRunId: string | null = null;
  private currentRunLastSeq = 0;
  private currentUiMode: UiMode = 'verbose';
  private currentActorUserId: string | null = null;
  private sinkWriteQueue: Promise<void> = Promise.resolve();
  private toolCallTitles = new Map<string, string>();
  private toolCallTextBreaks = new Set<string>();

  private readonly workspaceRoot: string;
  private readonly agentCommand: string;
  private readonly agentArgs: string[];

  constructor(params: {
    db: Db;
    config: AppConfig;
    toolAuth: ToolAuth;
    sessionKey: string;
    bindingKey: string;
    workspaceRoot: string;
    agentCommand?: string;
    agentArgs?: string[];
    acpRpc?: import('../acp/stdio.js').StdioProcess;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = params.toolAuth;
    this.sessionKey = params.sessionKey;
    this.bindingKey = params.bindingKey;
    this.workspaceRoot = params.workspaceRoot;
    this.agentCommand = params.agentCommand ?? this.config.acpAgentCommand;
    this.agentArgs = params.agentArgs ?? this.config.acpAgentArgs;

    this.client = new AcpClient({
      db: this.db,
      workspaceRoot: this.workspaceRoot,
      agentCommand: this.agentCommand,
      agentArgs: this.agentArgs,
      toolAuth: this.toolAuth,
      rpc: params.acpRpc,
      events: {
        onSessionUpdate: (run, _sessionId, update, eventSeq) => {
          if (run.runId === this.currentRunId) {
            this.currentRunLastSeq = Math.max(this.currentRunLastSeq, eventSeq);
          }

          this.enqueueSinkWrite(async () => {
            if (run.runId !== this.currentRunId) return;

            const sink = this.activeSink;
            if (!sink) return;

            if (update?.sessionUpdate === 'agent_message_chunk') {
              const block = update?.content;
              const text = block?.text ?? '';
              if (!text) return;
              if (sink.sendAgentText) {
                await sink.sendAgentText(text);
              } else {
                await sink.sendText(text);
              }
            }

            if (
              update?.sessionUpdate === 'tool_call' ||
              update?.sessionUpdate === 'tool_call_update'
            ) {
              const ui = this.buildToolUiEvent(update);
              if (!ui) return;

              if (this.shouldBreakTextStreamForToolUpdate(update, ui.toolCallId)) {
                await sink.breakTextStream?.();
              }

              const detail =
                this.currentUiMode === 'verbose'
                  ? ui.detail ?? renderJson(update, this.config.uiJsonMaxChars)
                  : undefined;

              if (!sink.sendUi && this.currentUiMode === 'summary') {
                return;
              }

              if (sink.sendUi) {
                await sink.sendUi({
                  kind: 'tool',
                  mode: this.currentUiMode,
                  title: ui.title,
                  detail,
                  toolCallId: ui.toolCallId,
                  stage: ui.stage,
                  status: ui.status,
                });
              } else {
                await sink.sendText(
                  this.currentUiMode === 'verbose'
                    ? `\n[tool]\n${ui.title}\n${detail ?? ''}\n`
                    : `\n[tool] ${ui.title}`,
                );
              }
            }

            if (update?.sessionUpdate === 'plan') {
              const detail = renderJson(update, this.config.uiJsonMaxChars);
              if (sink.sendUi) {
                await sink.sendUi({
                  kind: 'plan',
                  mode: this.currentUiMode,
                  title: 'Plan updated',
                  detail: this.currentUiMode === 'verbose' ? detail : undefined,
                });
              } else {
                await sink.sendText(
                  this.currentUiMode === 'verbose'
                    ? `\n[plan]\n${detail}\n`
                    : '\n[plan updated]\n',
                );
              }
            }

            if (update?.sessionUpdate === 'task') {
              const detail = renderJson(update, this.config.uiJsonMaxChars);
              if (sink.sendUi) {
                await sink.sendUi({
                  kind: 'task',
                  mode: this.currentUiMode,
                  title: 'Task update',
                  detail: this.currentUiMode === 'verbose' ? detail : undefined,
                });
              } else {
                await sink.sendText(
                  this.currentUiMode === 'verbose'
                    ? `\n[task]\n${detail}\n`
                    : '\n[task updated]\n',
                );
              }
            }
          });
        },
        onClientTool: (run, event) => {
          this.enqueueSinkWrite(async () => {
            if (run.runId !== this.currentRunId) return;
            // No-op for UI: tool updates are emitted via session/update
            // (tool_call/tool_call_update) to avoid duplicate user messages.
            void event;
          });
        },
        onPermissionRequest: (req) => {
          this.pendingPermission = req;
          this.pendingPermissionActorUserId = this.currentActorUserId;

          const toolKind = toToolKind(req.params.toolCall?.kind);
          if (toolKind) {
            const policy = this.toolAuth.evaluatePersistentPolicy(
              this.bindingKey,
              toolKind,
              {
                toolCall: req.params.toolCall,
                workspaceRoot: this.workspaceRoot,
              },
            );
            const hasScopedAllowRules =
              this.toolAuth.listAllowPrefixRules(this.bindingKey, toolKind)
                .length > 0;

            if (policy === 'allow' || (policy !== 'reject' && hasScopedAllowRules)) {
              const option = req.params.options.find(
                (o) => o.kind === 'allow_always' || o.kind === 'allow_once',
              );
              if (option) {
                this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
                void this.client.respondPermission(req, {
                  kind: 'selected',
                  optionId: option.optionId,
                });
                this.pendingPermission = null;
                this.pendingPermissionActorUserId = null;
                this.enqueueSinkWrite(async () => {
                  const sink = this.activeSink;
                  if (!sink) return;
                  await sink.sendText(`[permission] auto-allowed (${toolKind})`);
                });
                return;
              }
            }
            if (policy === 'reject') {
              const option = req.params.options.find(
                (o) => o.kind === 'reject_always' || o.kind === 'reject_once',
              );
              if (option) {
                void this.client.respondPermission(req, {
                  kind: 'selected',
                  optionId: option.optionId,
                });
                this.pendingPermission = null;
                this.pendingPermissionActorUserId = null;
                this.enqueueSinkWrite(async () => {
                  const sink = this.activeSink;
                  if (!sink) return;
                  await sink.sendText(`[permission] auto-rejected (${toolKind})`);
                });
                return;
              }
            }
          }

          const title =
            req.params.toolCall?.title ??
            req.params.toolCall?.toolCallId ??
            'tool_call';

          this.enqueueSinkWrite(async () => {
            const sink = this.activeSink;
            if (!sink) return;

            if (sink.requestPermission) {
              await sink.requestPermission({
                uiMode: this.currentUiMode,
                sessionKey: this.sessionKey,
                requestId: String(req.requestId),
                toolTitle: title,
                toolKind: toolKind ?? null,
              });
              return;
            }

            await sink.sendText(formatPermissionRequest(req));
          });
        },
        onAgentStderr: (line) => {
          log.debug('[agent stderr]', line);
        },
      },
    });
  }

  close(): void {
    this.client.close();
  }

  private enqueueSinkWrite(action: () => Promise<void>): void {
    this.sinkWriteQueue = this.sinkWriteQueue.then(async () => {
      try {
        await action();
      } catch (error) {
        log.warn('sink write event error', error);
      }
    });
  }

  private async flushSinkWriteQueue(): Promise<void> {
    await this.sinkWriteQueue;
  }

  async ensureInitialized(): Promise<InitializeResult> {
    if (this.init) return this.init;
    this.init = await this.client.initialize();
    updateLoadSupported(
      this.db,
      this.sessionKey,
      Boolean(this.init.agentCapabilities?.loadSession),
    );

    log.info('ACP initialized (runtime)', {
      bindingKey: this.bindingKey,
      protocolVersion: this.init.protocolVersion,
    });
    return this.init;
  }

  async ensureSessionId(): Promise<string> {
    if (this.acpSessionId) return this.acpSessionId;

    await this.ensureInitialized();

    const newSession = await this.client.newSession({
      cwd: this.workspaceRoot,
      mcpServers: [],
    });

    this.acpSessionId = newSession.sessionId;
    updateAcpSessionId(this.db, this.sessionKey, this.acpSessionId);
    return this.acpSessionId;
  }

  getLoadSupported(): boolean {
    return Boolean(this.init?.agentCapabilities?.loadSession);
  }

  getPendingPermission(): PermissionRequest | null {
    return this.pendingPermission;
  }

  async selectPermissionOption(
    idx: number,
    sink: OutboundSink,
    actorUserId?: string,
  ): Promise<void> {
    const pr = this.pendingPermission;
    if (!pr) {
      await sink.sendText('No pending permission request.');
      return;
    }

    if (!this.isPermissionActorAuthorized(actorUserId)) {
      await sink.sendText('Not authorized.');
      return;
    }

    const opt = pr.params.options[idx - 1];
    if (!opt) {
      await sink.sendText(`Invalid option index: ${idx}`);
      return;
    }

    const toolKind = toToolKind(pr.params.toolCall?.kind);
    if (toolKind) {
      if (opt.kind === 'allow_always') {
        this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'allow');
      }
      if (opt.kind === 'reject_always') {
        this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'reject');
      }
      if (opt.kind === 'allow_once' || opt.kind === 'allow_always') {
        this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
      }
    }

    await this.client.respondPermission(pr, {
      kind: 'selected',
      optionId: opt.optionId,
    });

    this.pendingPermission = null;
    this.pendingPermissionActorUserId = null;
    await sink.sendText(`OK: selected option ${idx} (${opt.name})`);
  }

  hasSessionId(): boolean {
    return Boolean(this.acpSessionId);
  }

  async decidePermission(params: {
    decision: 'allow' | 'deny';
    requestId?: string;
    actorUserId?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const pr = this.pendingPermission;
    if (!pr) {
      return { ok: false, message: 'No pending permission request.' };
    }

    if (params.requestId && String(pr.requestId) !== params.requestId) {
      return { ok: false, message: 'Permission request expired.' };
    }

    if (!this.isPermissionActorAuthorized(params.actorUserId)) {
      return { ok: false, message: 'Not authorized.' };
    }

    const toolKind = toToolKind(pr.params.toolCall?.kind);

    const allowOnce = pr.params.options.find((o) => o.kind === 'allow_once');
    const allowAlways = pr.params.options.find((o) => o.kind === 'allow_always');

    const rejectOnce = pr.params.options.find((o) => o.kind === 'reject_once');
    const rejectAlways = pr.params.options.find((o) => o.kind === 'reject_always');

    const selected =
      params.decision === 'allow'
        ? (allowOnce ?? allowAlways)
        : (rejectOnce ?? rejectAlways);

    if (selected && toolKind && selected.kind === 'allow_always') {
      this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'allow');
    }

    if (selected && toolKind && selected.kind === 'reject_always') {
      this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'reject');
    }

    if (selected && toolKind && (selected.kind === 'allow_once' || selected.kind === 'allow_always')) {
      this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
    }

    if (selected) {
      await this.client.respondPermission(pr, {
        kind: 'selected',
        optionId: selected.optionId,
      });
      this.pendingPermission = null;
      this.pendingPermissionActorUserId = null;

      return {
        ok: true,
        message:
          params.decision === 'allow'
            ? 'OK: allowed.'
            : 'OK: denied.',
      };
    }

    await this.client.respondPermission(pr, { kind: 'cancelled' });
    this.pendingPermission = null;
    this.pendingPermissionActorUserId = null;
    return { ok: true, message: 'OK: cancelled permission request.' };
  }

  async denyPermission(sink: OutboundSink, actorUserId?: string): Promise<void> {
    const res = await this.decidePermission({ decision: 'deny', actorUserId });
    await sink.sendText(res.message);
  }

  prompt(params: {
    runId: string;
    promptText: string;
    promptResources?: Array<{ uri: string; mimeType?: string }>;
    sink: OutboundSink;
    uiMode: UiMode;
    contextText?: string;
    actorUserId?: string;
  }): Promise<{ stopReason: string; lastSeq: number }> {
    const next = this.queue.then(async () => {
      const isFreshSession = !this.acpSessionId;
      const sessionId = await this.ensureSessionId();

      this.currentRunId = params.runId;
      this.currentRunLastSeq = 0;
      this.currentUiMode = params.uiMode;
      this.currentActorUserId = params.actorUserId ?? null;
      this.activeSink = params.sink;
      this.sinkWriteQueue = Promise.resolve();
      this.toolCallTitles = new Map<string, string>();
      this.toolCallTextBreaks = new Set<string>();

      try {
        const run = {
          runId: params.runId,
          sessionKey: this.sessionKey,
          createdAtMs: Date.now(),
        };

        const blocks: ContentBlock[] = [];

        if (isFreshSession && params.contextText?.trim()) {
          blocks.push({ type: 'text', text: params.contextText });
        }

        if (params.promptText.trim()) {
          blocks.push({ type: 'text', text: params.promptText });
        }

        for (const [index, resource] of (params.promptResources ?? []).entries()) {
          blocks.push({
            type: 'resource_link',
            uri: resource.uri,
            name: deriveResourceName(resource.uri, index),
            mimeType: resource.mimeType,
          });
        }

        if (blocks.length === 0) {
          blocks.push({ type: 'text', text: params.promptText });
        }

        const result = await this.client.prompt(run, {
          sessionId,
          prompt: blocks,
        });

        await this.flushSinkWriteQueue();
        return { stopReason: result.stopReason, lastSeq: this.currentRunLastSeq };
      } finally {
        await this.flushSinkWriteQueue();
        this.activeSink = null;
        this.currentRunId = null;
        this.currentUiMode = 'verbose';
        this.currentActorUserId = null;
        this.toolCallTitles = new Map<string, string>();
        this.toolCallTextBreaks = new Set<string>();
      }
    });

    // Keep the queue alive even if this prompt fails.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }

  private isPermissionActorAuthorized(actorUserId?: string): boolean {
    const expected = this.pendingPermissionActorUserId;
    if (!expected || expected === SHARED_CHAT_SCOPE_USER_ID) return true;
    if (!actorUserId) return true;
    return expected === actorUserId;
  }

  private buildToolUiEvent(
    update: any,
  ): {
    title: string;
    detail?: string;
    toolCallId?: string;
    stage: ToolUiStage;
    status: string;
  } | null {
    const stage = inferToolStage(update);
    const status = toolStatusLabel(stage, update);
    const toolCallId = extractToolCallId(update) ?? undefined;

    const rawTitle = String(update?.title ?? toolCallId ?? 'tool_call').trim();
    const inferredActions = inferToolActions(update, rawTitle);

    let baseTitle =
      this.currentUiMode === 'summary'
        ? normalizeSummaryToolTitle(rawTitle, inferredActions)
        : normalizeVerboseToolTitle(rawTitle, inferredActions);
    if (!baseTitle) return null;

    if (toolCallId) {
      const existingTitle = this.toolCallTitles.get(toolCallId);
      if (!existingTitle && baseTitle) {
        this.toolCallTitles.set(toolCallId, baseTitle);
      } else if (existingTitle) {
        baseTitle = existingTitle;
      }
    }

    const detail =
      this.currentUiMode === 'verbose'
        ? buildToolDetailText({
            update,
            rawTitle,
            inferredActions,
            toolCallId,
            status,
          })
        : undefined;

    return {
      title: `${baseTitle} · ${status}`,
      detail,
      toolCallId,
      stage,
      status,
    };
  }

  private shouldBreakTextStreamForToolUpdate(
    update: any,
    toolCallId?: string,
  ): boolean {
    const kind = String(update?.sessionUpdate ?? '').trim();
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return false;

    if (toolCallId) {
      if (this.toolCallTextBreaks.has(toolCallId)) {
        return false;
      }
      this.toolCallTextBreaks.add(toolCallId);
      return true;
    }

    return kind === 'tool_call';
  }
}

function toToolKind(kind: unknown): ToolKind | null {
  return parseToolKind(kind);
}

function formatPermissionRequest(req: PermissionRequest): string {
  const options = req.params.options
    .map((o, i) => `${i + 1}. ${o.name} (${o.kind})`)
    .join('\n');

  return `\n[permission required]\nTool: ${req.params.toolCall?.title ?? req.params.toolCall?.toolCallId ?? 'tool_call'}\n${options}\nReply with /allow <n> or /deny`;
}

function renderJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + '...';
  } catch {
    return String(value);
  }
}

function normalizeSummaryToolTitle(
  title: string,
  inferredActions: ToolAction[],
): string | null {
  const inferredTitle = summarizeInferredActions(inferredActions, 86);
  if (inferredTitle) return inferredTitle;

  const trimmed = title.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'tool_call') return null;
  if (lowered.startsWith('call_')) return null;
  if (!/[a-z]/i.test(trimmed)) return null;

  // Keep explicit tool method names when available.
  const explicitMethod = trimmed.match(
    /\b(fs\/[a-z0-9_/-]+|terminal\/[a-z0-9_/-]+|web\/[a-z0-9_/-]+|browser\/[a-z0-9_/-]+)\b/i,
  )?.[1];
  if (explicitMethod) return explicitMethod.toLowerCase();

  return trimmed;
}

function normalizeVerboseToolTitle(
  title: string,
  inferredActions: ToolAction[],
): string {
  const inferredTitle = summarizeInferredActions(inferredActions, 96);
  if (inferredTitle) return inferredTitle;

  const trimmed = title.trim();
  return trimmed || 'tool_call';
}

function inferToolStage(update: any): ToolUiStage {
  if (update?.sessionUpdate === 'tool_call') return 'start';
  const status = `${update?.status ?? update?.state ?? update?.outcome ?? ''}`
    .toLowerCase()
    .trim();
  if (status) {
    if (
      status.includes('complete') ||
      status.includes('success') ||
      status.includes('fail') ||
      status.includes('error') ||
      status.includes('cancel') ||
      status.includes('done') ||
      status.includes('finish') ||
      status.includes('end')
    ) {
      return 'complete';
    }
  }

  if (
    update?.error ||
    update?.result !== undefined ||
    update?.output !== undefined ||
    update?.exitCode !== undefined
  ) {
    return 'complete';
  }

  return 'update';
}

function toolStatusLabel(stage: ToolUiStage, update: any): string {
  if (stage === 'start') return 'started';

  const statusRaw = `${update?.status ?? update?.state ?? update?.outcome ?? ''}`
    .toLowerCase()
    .trim();

  if (stage === 'complete') {
    if (
      statusRaw.includes('fail') ||
      statusRaw.includes('error') ||
      update?.error
    ) {
      return 'failed';
    }
    if (statusRaw.includes('cancel')) return 'cancelled';
    return 'completed';
  }

  return statusRaw || 'running';
}

function extractToolCallId(update: any): string | null {
  const candidates = [
    update?.toolCallId,
    update?.tool_call_id,
    update?.callId,
    update?.call_id,
    update?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function deriveResourceName(uri: string, index: number): string {
  const fallback = `attachment-${index + 1}`;
  const trimmed = String(uri ?? '').trim();
  if (!trimmed) return fallback;

  try {
    const parsed = new URL(trimmed);
    const leaf = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const decoded = decodeURIComponent(leaf).trim();
    return decoded || fallback;
  } catch {
    return fallback;
  }
}

type ToolActionVerb =
  | 'run'
  | 'read'
  | 'edit'
  | 'list'
  | 'search'
  | 'fetch'
  | 'move'
  | 'delete'
  | 'unknown';

type ToolAction = {
  verb: ToolActionVerb;
  target: string;
};

function inferToolActions(update: any, rawTitle: string): ToolAction[] {
  const fromTitle = parseToolActionsFromTitle(rawTitle);
  if (fromTitle.length > 0) return fromTitle;

  const kind = String(update?.kind ?? '').trim().toLowerCase();
  if (!kind) return [];

  const command = extractCommandHint(update);
  const path = extractPathHint(update);
  const query = extractSearchHint(update);
  const target = path ?? query ?? command ?? '';

  if (kind === 'execute' && command) {
    return [{ verb: 'run', target: command }];
  }
  if (kind === 'read' && target) {
    return [{ verb: 'read', target }];
  }
  if (kind === 'edit' && target) {
    return [{ verb: 'edit', target }];
  }
  if (kind === 'search' && target) {
    return [{ verb: 'search', target }];
  }
  if (kind === 'fetch' && target) {
    return [{ verb: 'fetch', target }];
  }
  if (kind === 'move' && target) {
    return [{ verb: 'move', target }];
  }
  if (kind === 'delete' && target) {
    return [{ verb: 'delete', target }];
  }

  return [];
}

function parseToolActionsFromTitle(title: string): ToolAction[] {
  const trimmed = title.trim();
  if (!trimmed) return [];

  const parts = splitToolTitleParts(trimmed);
  if (parts.length > 1) {
    const parsed = parts.map((part) => parseToolActionPart(part));
    if (parsed.every(Boolean)) return parsed as ToolAction[];
  }

  const one = parseToolActionPart(trimmed);
  return one ? [one] : [];
}

function splitToolTitleParts(title: string): string[] {
  if (!title.includes(',')) return [title];
  return title
    .split(/\s*,\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseToolActionPart(text: string): ToolAction | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const patterns: Array<[RegExp, ToolActionVerb]> = [
    [/^(?:run|execute)\s+(.+)$/i, 'run'],
    [/^(?:read|view)\s+(.+)$/i, 'read'],
    [/^(?:write|edit|modify|update)\s+(.+)$/i, 'edit'],
    [/^(?:list)\s+(.+)$/i, 'list'],
    [/^(?:search|find|grep)\s+(.+)$/i, 'search'],
    [/^(?:fetch|download|request)\s+(.+)$/i, 'fetch'],
    [/^(?:move|rename)\s+(.+)$/i, 'move'],
    [/^(?:delete|remove|rm)\s+(.+)$/i, 'delete'],
  ];

  for (const [pattern, verb] of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const target = match[1]?.trim();
    if (!target) return null;
    return { verb, target };
  }

  return null;
}

function summarizeInferredActions(
  actions: ToolAction[],
  targetMaxLen: number,
): string | null {
  if (actions.length === 0) return null;

  const first = formatToolAction(actions[0], targetMaxLen);
  if (actions.length === 1) return first;

  return `${first} (+${actions.length - 1} more)`;
}

function formatToolAction(action: ToolAction, targetMaxLen: number): string {
  return `${action.verb}: ${truncateInline(action.target, targetMaxLen)}`;
}

function truncateInline(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
}

function buildToolDetailText(params: {
  update: any;
  rawTitle: string;
  inferredActions: ToolAction[];
  toolCallId?: string;
  status: string;
}): string | undefined {
  const lines: string[] = [];

  if (params.inferredActions.length > 0) {
    lines.push('actions:');
    params.inferredActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${formatToolAction(action, 180)}`);
    });
  } else if (params.rawTitle && params.rawTitle !== 'tool_call') {
    lines.push(`title: ${truncateInline(params.rawTitle, 220)}`);
  }

  const kind = String(params.update?.kind ?? '').trim();
  if (kind) lines.push(`kind: ${kind}`);
  lines.push(`status: ${params.status}`);

  if (params.toolCallId) {
    lines.push(`tool_call_id: ${params.toolCallId}`);
  }

  const cwd = extractFirstString(params.update, ['cwd', 'input.cwd', 'arguments.cwd']);
  if (cwd) lines.push(`cwd: ${truncateInline(cwd, 220)}`);

  const command = extractCommandHint(params.update);
  if (command && params.inferredActions.every((action) => action.verb !== 'run')) {
    lines.push(`command: ${truncateInline(command, 220)}`);
  }

  const path = extractPathHint(params.update);
  if (
    path &&
    params.inferredActions.every(
      (action) => !['read', 'edit', 'move', 'delete'].includes(action.verb),
    )
  ) {
    lines.push(`path: ${truncateInline(path, 220)}`);
  }

  const exitCode = extractExitCode(params.update);
  if (exitCode !== null) lines.push(`exit_code: ${exitCode}`);

  const errorText = extractErrorText(params.update);
  if (errorText) lines.push(`error: ${truncateInline(errorText, 220)}`);

  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

function extractCommandHint(update: any): string | null {
  const command = extractFirstString(update, [
    'command',
    'cmd',
    'input.command',
    'arguments.command',
    'result.command',
  ]);
  if (!command) return null;

  const args = extractStringArray(update, [
    'args',
    'input.args',
    'arguments.args',
    'result.args',
  ]);
  return args.length > 0 ? `${command} ${args.join(' ')}` : command;
}

function extractPathHint(update: any): string | null {
  return extractFirstString(update, [
    'path',
    'file',
    'filepath',
    'target',
    'uri',
    'input.path',
    'input.file',
    'input.uri',
    'arguments.path',
    'arguments.file',
    'result.path',
  ]);
}

function extractSearchHint(update: any): string | null {
  return extractFirstString(update, [
    'query',
    'pattern',
    'text',
    'input.query',
    'input.pattern',
    'arguments.query',
    'arguments.pattern',
  ]);
}

function extractExitCode(update: any): number | null {
  const direct = update?.exitCode;
  if (typeof direct === 'number') return direct;

  const nested = getPathValue(update, 'result.exitCode');
  if (typeof nested === 'number') return nested;

  return null;
}

function extractErrorText(update: any): string | null {
  const direct = update?.error;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (direct && typeof direct === 'object') {
    const message = (direct as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  return extractFirstString(update, ['result.error', 'result.message']);
}

function extractFirstString(root: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const value = getPathValue(root, p);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function extractStringArray(root: unknown, paths: string[]): string[] {
  for (const p of paths) {
    const value = getPathValue(root, p);
    if (!Array.isArray(value)) continue;
    const out = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (out.length > 0) return out;
  }
  return [];
}

function getPathValue(root: unknown, pathExpr: string): unknown {
  const segments = pathExpr.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

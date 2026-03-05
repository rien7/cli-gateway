import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { ToolAuth, ToolKind } from '../gateway/toolAuth.js';
import { resolveWorkspacePath } from '../tools/workspace.js';
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import { spawnAcpAgent, type StdioProcess } from './stdio.js';
import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  RequestPermissionParams,
  RequestPermissionResult,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalKillParams,
  TerminalOutputParams,
  TerminalOutputResult,
  TerminalReleaseParams,
  TerminalWaitForExitParams,
} from './types.js';

export type AcpRun = {
  runId: string;
  sessionKey: string;
  createdAtMs: number;
};

export type PermissionRequest = {
  requestId: JsonRpcId;
  sessionKey: string;
  sessionId: string;
  params: RequestPermissionParams;
  createdAtMs: number;
};

export type PermissionDecision =
  | { kind: 'selected'; optionId: string }
  | { kind: 'cancelled' };

export type ClientToolEvent = {
  phase: 'start' | 'end' | 'error';
  method: string;
  params: unknown;
  result?: unknown;
  error?: string;
};

export type AcpClientEvents = {
  onSessionUpdate?: (
    run: AcpRun,
    sessionId: string,
    update: any,
    eventSeq: number,
  ) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
  onClientTool?: (run: AcpRun, event: ClientToolEvent) => void;
  onAgentStderr?: (line: string) => void;
};

type PendingRequest = {
  method: string;
  resolve: (res: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

const ACP_BOOTSTRAP_TIMEOUT_MS = 30_000;

export class AcpClient {
  private readonly db: Db;
  private readonly workspaceRoot: string;
  private readonly agentCommand: string;
  private readonly agentArgs: string[];
  private readonly toolAuth: ToolAuth | null;

  private readonly rpc: StdioProcess;
  private nextId = 1;

  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  // run-scoped state
  private currentRun: AcpRun | null = null;
  private readonly runSeq = new Map<string, number>();
  private readonly pendingLocalPermissions = new Map<
    JsonRpcId,
    {
      resolve: (decision: PermissionDecision) => void;
      reject: (error: Error) => void;
    }
  >();

  private readonly events: AcpClientEvents;

  constructor(params: {
    db: Db;
    workspaceRoot: string;
    agentCommand: string;
    agentArgs: string[];
    toolAuth?: ToolAuth;
    events?: AcpClientEvents;
    rpc?: StdioProcess;
  }) {
    this.db = params.db;
    this.workspaceRoot = params.workspaceRoot;
    this.agentCommand = params.agentCommand;
    this.agentArgs = params.agentArgs;
    this.toolAuth = params.toolAuth ?? null;
    this.events = params.events ?? {};

    this.rpc =
      params.rpc ?? spawnAcpAgent(this.agentCommand, this.agentArgs);
    this.rpc.onMessage((m) => this.handleMessage(m));
    this.rpc.onStderr((line) => this.events.onAgentStderr?.(line));
    this.rpc.onExit?.((info) => {
      this.rejectAllPending(
        this.makeTransportError(
          'ACP agent exited (code=' +
            String(info.code) +
            ', signal=' +
            String(info.signal) +
            ')',
        ),
      );
      this.rejectAllLocalPermissions(
        this.makeTransportError(
          'ACP agent exited while waiting for permission response',
        ),
      );
    });
  }

  close(): void {
    this.rejectAllPending(this.makeTransportError('ACP client closed'));
    this.rejectAllLocalPermissions(this.makeTransportError('ACP client closed'));
    this.rpc.kill();
  }

  private initPromise: Promise<InitializeResult> | null = null;

  async initialize(): Promise<InitializeResult> {
    if (this.initPromise) return this.initPromise;

    const params: InitializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: 'cli-gateway',
        title: 'cli-gateway',
        version: '0.1.0',
      },
    };

    this.initPromise = this.request<InitializeParams, InitializeResult>(
      'initialize',
      params,
      ACP_BOOTSTRAP_TIMEOUT_MS,
    );

    return this.initPromise;
  }

  async newSession(params: NewSessionParams): Promise<NewSessionResult> {
    return this.request<NewSessionParams, NewSessionResult>(
      'session/new',
      params,
      ACP_BOOTSTRAP_TIMEOUT_MS,
    );
  }

  async prompt(run: AcpRun, params: PromptParams): Promise<PromptResult> {
    this.currentRun = run;
    this.runSeq.set(run.runId, 0);

    try {
      const result = await this.request<PromptParams, PromptResult>(
        'session/prompt',
        params,
      );
      return result;
    } finally {
      this.currentRun = null;
      this.runSeq.delete(run.runId);
    }
  }

  notifyCancel(sessionId: string): void {
    this.rpc.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
  }

  async respondPermission(
    req: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<void> {
    const local = this.pendingLocalPermissions.get(req.requestId);
    if (local) {
      this.pendingLocalPermissions.delete(req.requestId);
      local.resolve(decision);
      return;
    }

    const outcome: RequestPermissionResult['outcome'] =
      decision.kind === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: decision.optionId };

    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: req.requestId,
      result: { outcome },
    };

    this.rpc.write(msg);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.resolve(message);
      }
      return;
    }

    if (isNotification(message)) {
      if (message.method === 'session/update') {
        const params = message.params as any;
        const sessionId = params?.sessionId as string | undefined;
        const update = params?.update;
        if (this.currentRun && sessionId) {
          const eventSeq = this.appendEvent(
            this.currentRun.runId,
            'session/update',
            params,
          );
          void this.events.onSessionUpdate?.(
            this.currentRun,
            sessionId,
            update,
            eventSeq,
          );
        }
      }
      return;
    }

    if (isRequest(message)) {
      // Agent -> Client requests
      void this.handleAgentRequest(message);
      return;
    }
  }

  private async handleAgentRequest(req: JsonRpcRequest): Promise<void> {
    const run = this.currentRun;

    const emitTool = (event: ClientToolEvent) => {
      if (!run) return;
      this.events.onClientTool?.(run, event);
    };

    try {
      switch (req.method) {
        case 'session/request_permission': {
          const params = req.params as RequestPermissionParams;
          const sessionKey = this.currentRun?.sessionKey ?? 'unknown';
          const pr: PermissionRequest = {
            requestId: req.id,
            sessionKey,
            sessionId: params.sessionId,
            params,
            createdAtMs: Date.now(),
          };
          this.events.onPermissionRequest?.(pr);
          return;
        }

        case 'fs/read_text_file': {
          const params = req.params as FsReadTextFileParams;
          emitTool({ phase: 'start', method: req.method, params });

          await this.ensureAuthorized({
            kind: 'read',
            method: req.method,
            params,
          });
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          const content = readTextFileWithLimit(
            resolvedPath,
            params.line,
            params.limit,
          );
          this.respond(req.id, { content } satisfies FsReadTextFileResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params,
            result: { bytes: content.length },
          });
          return;
        }

        case 'fs/write_text_file': {
          const params = req.params as FsWriteTextFileParams;
          emitTool({ phase: 'start', method: req.method, params: { path: params.path } });

          await this.ensureAuthorized({
            kind: 'edit',
            method: req.method,
            params,
          });
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          fs.writeFileSync(resolvedPath, params.content, 'utf8');
          this.respond(req.id, {});

          emitTool({
            phase: 'end',
            method: req.method,
            params: { path: params.path },
            result: { bytes: params.content.length },
          });
          return;
        }

        case 'terminal/create': {
          const params = req.params as TerminalCreateParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
          });

          await this.ensureAuthorized({
            kind: 'execute',
            method: req.method,
            params,
          });
          const terminalId = await this.terminalCreate(params);
          this.respond(req.id, { terminalId } satisfies TerminalCreateResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
            result: { terminalId },
          });
          return;
        }

        case 'terminal/output': {
          const params = req.params as TerminalOutputParams;
          const out = this.terminalOutput(params);
          this.respond(req.id, out satisfies TerminalOutputResult);
          return;
        }

        case 'terminal/wait_for_exit': {
          const params = req.params as TerminalWaitForExitParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: { terminalId: params.terminalId },
          });

          const res = await this.terminalWaitForExit(params);
          this.respond(req.id, res);

          emitTool({
            phase: 'end',
            method: req.method,
            params: { terminalId: params.terminalId },
            result: res,
          });
          return;
        }

        case 'terminal/kill': {
          const params = req.params as TerminalKillParams;
          await this.ensureAuthorized({
            kind: 'execute',
            method: req.method,
            params,
          });
          this.terminalKill(params);
          this.respond(req.id, {});
          return;
        }

        case 'terminal/release': {
          const params = req.params as TerminalReleaseParams;
          this.terminalRelease(params);
          this.respond(req.id, {});
          return;
        }

        default: {
          this.respondError(req.id, -32601, `Method not found: ${req.method}`);
        }
      }
    } catch (error: any) {
      log.error('Agent request handler error', req.method, error);
      emitTool({
        phase: 'error',
        method: req.method,
        params: req.params,
        error: String(error?.message ?? error),
      });
      this.respondError(req.id, -32000, String(error?.message ?? error));
    }
  }

  private request<TParams, TResult>(
    method: string,
    params: TParams,
    timeoutMs?: number,
  ): Promise<TResult> {
    const id = this.nextId++;

    return new Promise<TResult>((resolve, reject) => {
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              this.rejectPendingRequest(
                id,
                this.makeTransportError(
                  'ACP request timed out: ' + method + ' (' + String(timeoutMs) + 'ms)',
                ),
              );
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        method,
        resolve: (res) => {
          if ('error' in res) {
            const code =
              typeof res.error?.code === 'number'
                ? ' (code ' + String(res.error.code) + ')'
                : '';
            const data =
              res.error?.data !== undefined
                ? '; data=' + String(res.error.data)
                : '';
            reject(new Error(String(res.error.message) + code + data));
            return;
          }

          resolve(res.result as TResult);
        },
        reject,
        timer,
      });

      try {
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        this.rpc.write(req);
      } catch (error: any) {
        this.rejectPendingRequest(
          id,
          this.makeTransportError(String(error?.message ?? error)),
        );
      }
    });
  }

  private rejectPendingRequest(id: JsonRpcId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const id of this.pending.keys()) {
      const detail = this.makeTransportError(
        error.message + '; pending_id=' + String(id),
      );
      this.rejectPendingRequest(id, detail);
    }
  }

  private rejectAllLocalPermissions(error: Error): void {
    for (const [id, pending] of this.pendingLocalPermissions.entries()) {
      this.pendingLocalPermissions.delete(id);
      const detail = this.makeTransportError(
        error.message + '; permission_request_id=' + String(id),
      );
      pending.reject(detail);
    }
  }

  private makeTransportError(message: string): Error {
    const err = new Error(message);
    err.name = 'AcpTransportError';
    return err;
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.rpc.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.rpc.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private appendEvent(runId: string, method: string, payload: unknown): number {
    const prev = this.runSeq.get(runId) ?? 0;
    const seq = prev + 1;
    this.runSeq.set(runId, seq);

    this.db
      .prepare(
        'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
      )
      .run(runId, seq, method, JSON.stringify(payload), Date.now());

    return seq;
  }

  private async ensureAuthorized(params: {
    kind: ToolKind;
    method: string;
    params: unknown;
  }): Promise<void> {
    const { kind } = params;
    const sessionKey = this.currentRun?.sessionKey;

    // Tool calls should only occur within a prompt turn.
    if (!sessionKey) {
      throw new Error(
        `Tool call not allowed outside prompt turn (kind=${kind})`,
      );
    }

    // If auth is not wired, default deny (secure by default).
    if (!this.toolAuth) {
      throw new Error(`Tool call denied (no ToolAuth): ${kind}`);
    }

    if (this.toolAuth.consume(sessionKey, kind)) {
      return;
    }

    if (!this.events.onPermissionRequest) {
      throw new Error(
        `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
      );
    }

    const req = buildLocalPermissionRequest({
      sessionKey,
      kind,
      method: params.method,
      params: params.params,
    });

    const decision = await new Promise<PermissionDecision>((resolve, reject) => {
      this.pendingLocalPermissions.set(req.requestId, { resolve, reject });

      try {
        this.events.onPermissionRequest?.(req);
      } catch (error: any) {
        this.pendingLocalPermissions.delete(req.requestId);
        reject(new Error(String(error?.message ?? error)));
      }
    });

    if (decision.kind === 'cancelled') {
      throw new Error(
        `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
      );
    }

    if (this.toolAuth.consume(sessionKey, kind)) {
      return;
    }

    throw new Error(
      `Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`,
    );
  }

  // terminal management (minimal)

  private readonly terminals = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      output: string;
      truncated: boolean;
      byteLimit: number;
    }
  >();

  private async terminalCreate(params: TerminalCreateParams): Promise<string> {
    const terminalId = randomUUID();
    const cwd = params.cwd
      ? resolveWorkspacePath(this.workspaceRoot, params.cwd)
      : this.workspaceRoot;

    const byteLimit = params.outputByteLimit ?? 256_000;

    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: {
        ...process.env,
        ...(params.env ?? []).reduce<Record<string, string>>((acc, kv) => {
          acc[kv.name] = kv.value;
          return acc;
        }, {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = { child, output: '', truncated: false, byteLimit };
    this.terminals.set(terminalId, state);

    const onData = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      state.output += chunk;
      if (state.output.length > state.byteLimit) {
        state.output = state.output.slice(
          state.output.length - state.byteLimit,
        );
        state.truncated = true;
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    return terminalId;
  }

  private terminalOutput(params: TerminalOutputParams): TerminalOutputResult {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    const exitStatus =
      state.child.exitCode !== null || state.child.signalCode !== null
        ? { exitCode: state.child.exitCode, signal: state.child.signalCode }
        : null;

    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus,
    };
  }

  private terminalWaitForExit(
    params: TerminalWaitForExitParams,
  ): Promise<{ exitCode?: number | null; signal?: string | null }> {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    return new Promise((resolve) => {
      state.child.once('exit', (code, signal) => {
        resolve({ exitCode: code, signal });
      });
    });
  }

  private terminalKill(params: TerminalKillParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);
    state.child.kill('SIGKILL');
  }

  private terminalRelease(params: TerminalReleaseParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) return;
    state.child.kill('SIGKILL');
    this.terminals.delete(params.terminalId);
  }
}

function buildLocalPermissionRequest(params: {
  sessionKey: string;
  kind: ToolKind;
  method: string;
  params: unknown;
}): PermissionRequest {
  const sessionId =
    typeof (params.params as { sessionId?: unknown } | null)?.sessionId ===
    'string'
      ? String((params.params as { sessionId?: string }).sessionId)
      : 'unknown';

  return {
    requestId: `localperm-${randomUUID()}`,
    sessionKey: params.sessionKey,
    sessionId,
    createdAtMs: Date.now(),
    params: {
      sessionId,
      toolCall: {
        title: buildLocalToolTitle(params.method, params.params),
        kind: params.kind,
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'allow_always',
          name: 'Always allow',
          kind: 'allow_always',
        },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        {
          optionId: 'reject_always',
          name: 'Always reject',
          kind: 'reject_always',
        },
      ],
    },
  };
}

function buildLocalToolTitle(method: string, rawParams: unknown): string {
  const params = (rawParams ?? {}) as Record<string, unknown>;

  if (method === 'fs/read_text_file') {
    const target = stringOrFallback(params.path, '<path>');
    return truncateInline(`read: ${target}`, 180);
  }

  if (method === 'fs/write_text_file') {
    const target = stringOrFallback(params.path, '<path>');
    return truncateInline(`edit: ${target}`, 180);
  }

  if (method === 'terminal/create') {
    const command = stringOrFallback(params.command, '<command>');
    const args = Array.isArray(params.args)
      ? params.args
          .filter((item): item is string => typeof item === 'string')
          .join(' ')
      : '';
    const full = args ? `${command} ${args}` : command;
    return truncateInline(`run: ${full}`, 180);
  }

  if (method === 'terminal/kill') {
    const terminalId = stringOrFallback(params.terminalId, '<terminal_id>');
    return truncateInline(`run: kill terminal ${terminalId}`, 180);
  }

  return truncateInline(method, 180);
}

function truncateInline(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function readTextFileWithLimit(
  filePath: string,
  line?: number,
  limit?: number,
): string {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!line || !limit) return content;

  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, line - 1);
  return lines.slice(startIndex, startIndex + limit).join('\n');
}

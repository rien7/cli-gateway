import path from 'node:path';

import type { Db } from '../db/db.js';
import { resolveWorkspacePath } from '../tools/workspace.js';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type PersistentToolPolicy = 'allow' | 'reject';

export const TOOL_KINDS: ToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
];

export function parseToolKind(value: unknown): ToolKind | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return TOOL_KINDS.includes(normalized as ToolKind)
    ? (normalized as ToolKind)
    : null;
}

export type ToolMatchContext = {
  method?: string;
  params?: unknown;
  toolCall?: unknown;
  workspaceRoot?: string;
};

export type ToolAllowPrefixRule = {
  toolKind: ToolKind;
  argPrefix: string;
};

const PATH_PREFIX_TOOL_KINDS = new Set<ToolKind>([
  'read',
  'edit',
  'delete',
  'move',
]);

export class ToolAuth {
  private readonly db: Db;
  private readonly onceGrants = new Map<string, Map<ToolKind, number>>();

  constructor(db: Db) {
    this.db = db;
  }

  grantOnce(sessionKey: string, toolKind: ToolKind, count = 1): void {
    const perSession =
      this.onceGrants.get(sessionKey) ?? new Map<ToolKind, number>();
    perSession.set(toolKind, (perSession.get(toolKind) ?? 0) + count);
    this.onceGrants.set(sessionKey, perSession);
  }

  setPersistentPolicy(
    bindingKey: string,
    toolKind: ToolKind,
    policy: PersistentToolPolicy,
  ): void {
    const now = Date.now();

    this.db
      .prepare(
        `
        INSERT INTO tool_policies(binding_key, tool_kind, policy, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(binding_key, tool_kind) DO UPDATE SET
          policy = excluded.policy,
          updated_at = excluded.updated_at
        `,
      )
      .run(bindingKey, toolKind, policy, now, now);
  }

  getPersistentPolicy(
    bindingKey: string,
    toolKind: ToolKind,
  ): PersistentToolPolicy | null {
    const row = this.db
      .prepare(
        'SELECT policy FROM tool_policies WHERE binding_key = ? AND tool_kind = ? LIMIT 1',
      )
      .get(bindingKey, toolKind) as
      | { policy: PersistentToolPolicy }
      | undefined;

    return row?.policy ?? null;
  }

  listPersistentPolicies(
    bindingKey: string,
    policy?: PersistentToolPolicy,
  ): Array<{ toolKind: ToolKind; policy: PersistentToolPolicy }> {
    const rows = policy
      ? (this.db
          .prepare(
            `
            SELECT tool_kind as toolKind, policy
            FROM tool_policies
            WHERE binding_key = ? AND policy = ?
            ORDER BY tool_kind ASC
            `,
          )
          .all(bindingKey, policy) as Array<{
          toolKind: string;
          policy: PersistentToolPolicy;
        }>)
      : (this.db
          .prepare(
            `
            SELECT tool_kind as toolKind, policy
            FROM tool_policies
            WHERE binding_key = ?
            ORDER BY tool_kind ASC
            `,
          )
          .all(bindingKey) as Array<{
          toolKind: string;
          policy: PersistentToolPolicy;
        }>);

    return rows
      .map((row) => {
        const toolKind = parseToolKind(row.toolKind);
        if (!toolKind) return null;
        return { toolKind, policy: row.policy };
      })
      .filter(Boolean) as Array<{
      toolKind: ToolKind;
      policy: PersistentToolPolicy;
    }>;
  }

  clearPersistentPolicy(
    bindingKey: string,
    toolKind: ToolKind,
    policy?: PersistentToolPolicy,
  ): boolean {
    const result = policy
      ? this.db
          .prepare(
            `
            DELETE FROM tool_policies
            WHERE binding_key = ? AND tool_kind = ? AND policy = ?
            `,
          )
          .run(bindingKey, toolKind, policy)
      : this.db
          .prepare(
            `
            DELETE FROM tool_policies
            WHERE binding_key = ? AND tool_kind = ?
            `,
          )
          .run(bindingKey, toolKind);

    return result.changes > 0;
  }

  clearPersistentPolicies(
    bindingKey: string,
    policy?: PersistentToolPolicy,
  ): number {
    const result = policy
      ? this.db
          .prepare(
            `
            DELETE FROM tool_policies
            WHERE binding_key = ? AND policy = ?
            `,
          )
          .run(bindingKey, policy)
      : this.db
          .prepare(
            `
            DELETE FROM tool_policies
            WHERE binding_key = ?
            `,
          )
          .run(bindingKey);

    return result.changes;
  }

  setAllowPrefixRule(
    bindingKey: string,
    toolKind: ToolKind,
    argPrefix: string,
  ): void {
    const normalizedPrefix = normalizeStoredPrefix(toolKind, argPrefix);
    if (!normalizedPrefix) {
      throw new Error('Invalid allow prefix.');
    }

    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO tool_allow_prefixes(binding_key, tool_kind, arg_prefix, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(binding_key, tool_kind, arg_prefix) DO UPDATE SET
          updated_at = excluded.updated_at
        `,
      )
      .run(bindingKey, toolKind, normalizedPrefix, now, now);
  }

  listAllowPrefixRules(
    bindingKey: string,
    toolKind?: ToolKind,
  ): ToolAllowPrefixRule[] {
    const rows = toolKind
      ? (this.db
          .prepare(
            `
            SELECT tool_kind as toolKind, arg_prefix as argPrefix
            FROM tool_allow_prefixes
            WHERE binding_key = ? AND tool_kind = ?
            ORDER BY tool_kind ASC, arg_prefix ASC
            `,
          )
          .all(bindingKey, toolKind) as Array<{
          toolKind: string;
          argPrefix: string;
        }>)
      : (this.db
          .prepare(
            `
            SELECT tool_kind as toolKind, arg_prefix as argPrefix
            FROM tool_allow_prefixes
            WHERE binding_key = ?
            ORDER BY tool_kind ASC, arg_prefix ASC
            `,
          )
          .all(bindingKey) as Array<{
          toolKind: string;
          argPrefix: string;
        }>);

    return rows
      .map((row) => {
        const parsedKind = parseToolKind(row.toolKind);
        if (!parsedKind) return null;
        const normalizedPrefix = normalizeStoredPrefix(parsedKind, row.argPrefix);
        if (!normalizedPrefix) return null;
        return {
          toolKind: parsedKind,
          argPrefix: normalizedPrefix,
        } satisfies ToolAllowPrefixRule;
      })
      .filter(Boolean) as ToolAllowPrefixRule[];
  }

  clearAllowPrefixRule(
    bindingKey: string,
    toolKind: ToolKind,
    argPrefix: string,
  ): boolean {
    const normalizedPrefix = normalizeStoredPrefix(toolKind, argPrefix);
    if (!normalizedPrefix) return false;

    const result = this.db
      .prepare(
        `
        DELETE FROM tool_allow_prefixes
        WHERE binding_key = ? AND tool_kind = ? AND arg_prefix = ?
        `,
      )
      .run(bindingKey, toolKind, normalizedPrefix);

    return result.changes > 0;
  }

  clearAllowPrefixRules(bindingKey: string, toolKind?: ToolKind): number {
    const result = toolKind
      ? this.db
          .prepare(
            `
            DELETE FROM tool_allow_prefixes
            WHERE binding_key = ? AND tool_kind = ?
            `,
          )
          .run(bindingKey, toolKind)
      : this.db
          .prepare(
            `
            DELETE FROM tool_allow_prefixes
            WHERE binding_key = ?
            `,
          )
          .run(bindingKey);

    return result.changes;
  }

  evaluatePersistentPolicy(
    bindingKey: string,
    toolKind: ToolKind,
    context?: ToolMatchContext,
  ): PersistentToolPolicy | null {
    const policy = this.getPersistentPolicy(bindingKey, toolKind);
    if (policy === 'reject') return 'reject';
    if (policy === 'allow') return 'allow';

    return this.matchesAllowPrefixRule(bindingKey, toolKind, context)
      ? 'allow'
      : null;
  }

  consume(
    sessionKey: string,
    toolKind: ToolKind,
    context?: ToolMatchContext,
  ): boolean {
    const bindingRow = this.db
      .prepare(
        'SELECT binding_key as bindingKey FROM bindings WHERE session_key = ? LIMIT 1',
      )
      .get(sessionKey) as { bindingKey: string } | undefined;

    if (!bindingRow) return false;

    const persistent = this.evaluatePersistentPolicy(
      bindingRow.bindingKey,
      toolKind,
      context,
    );
    if (persistent === 'reject') return false;
    if (persistent === 'allow') return true;

    const perSession = this.onceGrants.get(sessionKey);
    const remaining = perSession?.get(toolKind) ?? 0;
    if (remaining <= 0) return false;

    perSession!.set(toolKind, remaining - 1);
    return true;
  }

  private matchesAllowPrefixRule(
    bindingKey: string,
    toolKind: ToolKind,
    context?: ToolMatchContext,
  ): boolean {
    if (!context) return false;

    const rules = this.listAllowPrefixRules(bindingKey, toolKind);
    if (rules.length === 0) return false;

    const candidates = extractMatchCandidates(toolKind, context);
    if (candidates.length === 0) return false;

    for (const rule of rules) {
      if (candidates.some((candidate) => prefixMatches(toolKind, candidate, rule.argPrefix))) {
        return true;
      }
    }

    return false;
  }
}

function extractMatchCandidates(
  toolKind: ToolKind,
  context: ToolMatchContext,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const normalized = normalizeCandidate(toolKind, raw, context.workspaceRoot);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const params = asRecord(context.params);
  const method = String(context.method ?? '').trim();

  if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
    push(params?.path);
  }

  if (method === 'terminal/create') {
    push(formatCommandLine(params?.command, params?.args));
  }

  const toolCall = asRecord(context.toolCall);
  if (toolCall) {
    push(toolCall.path);
    push(getPathValue(toolCall, 'arguments.path'));
    push(getPathValue(toolCall, 'input.path'));
    push(formatCommandLine(toolCall.command, toolCall.args));
    push(formatCommandLine(getPathValue(toolCall, 'arguments.command'), getPathValue(toolCall, 'arguments.args')));
    push(extractTargetFromToolTitle(toolKind, toolCall.title));
  }

  if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
    push(params?.file);
    push(params?.target);
    push(params?.uri);
  } else if (toolKind === 'execute') {
    push(params?.command);
  } else {
    push(params?.path);
    push(params?.query);
    push(params?.pattern);
    push(params?.text);
  }

  return out;
}

function normalizeCandidate(
  toolKind: ToolKind,
  raw: string,
  workspaceRoot?: string,
): string | null {
  if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
    return normalizePathPrefix(raw, workspaceRoot);
  }
  return normalizeTextPrefix(raw);
}

function normalizeStoredPrefix(toolKind: ToolKind, raw: string): string | null {
  if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
    return normalizePathPrefix(raw);
  }
  return normalizeTextPrefix(raw);
}

function normalizePathPrefix(raw: string, workspaceRoot?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;

  if (workspaceRoot) {
    try {
      return resolveWorkspacePath(workspaceRoot, trimmed);
    } catch {
      return null;
    }
  }

  return path.resolve(trimmed);
}

function normalizeTextPrefix(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function prefixMatches(toolKind: ToolKind, candidate: string, prefix: string): boolean {
  if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
    return pathPrefixMatches(candidate, prefix);
  }
  return candidate.startsWith(prefix);
}

function pathPrefixMatches(candidate: string, prefix: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedPrefix = path.resolve(prefix);

  if (normalizedCandidate === normalizedPrefix) return true;
  return normalizedCandidate.startsWith(normalizedPrefix + path.sep);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getPathValue(source: unknown, pathExpr: string): unknown {
  const parts = pathExpr.split('.');
  let current: unknown = source;

  for (const part of parts) {
    const obj = asRecord(current);
    if (!obj) return undefined;
    current = obj[part];
  }

  return current;
}

function formatCommandLine(commandRaw: unknown, argsRaw: unknown): string | null {
  if (typeof commandRaw !== 'string' || !commandRaw.trim()) return null;
  const command = commandRaw.trim();

  const args = Array.isArray(argsRaw)
    ? argsRaw.filter((item): item is string => typeof item === 'string')
    : [];

  const full = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  return normalizeTextPrefix(full);
}

function extractTargetFromToolTitle(
  toolKind: ToolKind,
  titleRaw: unknown,
): string | null {
  if (typeof titleRaw !== 'string') return null;
  const title = titleRaw.trim();
  if (!title) return null;

  if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
    const match = title.match(/^(?:read|edit|delete|move)\s*:\s*(.+)$/i);
    if (match) {
      return match[1]?.trim() ?? null;
    }
    return null;
  }

  if (toolKind === 'execute') {
    const match = title.match(/^run\s*:\s*(.+)$/i);
    if (match) {
      return match[1]?.trim() ?? null;
    }
  }

  return null;
}

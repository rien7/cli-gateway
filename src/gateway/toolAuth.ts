import type { Db } from '../db/db.js';

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

  consume(sessionKey: string, toolKind: ToolKind): boolean {
    const bindingRow = this.db
      .prepare(
        'SELECT binding_key as bindingKey FROM bindings WHERE session_key = ? LIMIT 1',
      )
      .get(sessionKey) as { bindingKey: string } | undefined;

    if (!bindingRow) return false;

    const policy = this.getPersistentPolicy(bindingRow.bindingKey, toolKind);
    if (policy === 'reject') return false;
    if (policy === 'allow') return true;

    const perSession = this.onceGrants.get(sessionKey);
    const remaining = perSession?.get(toolKind) ?? 0;
    if (remaining <= 0) return false;

    perSession!.set(toolKind, remaining - 1);
    return true;
  }
}

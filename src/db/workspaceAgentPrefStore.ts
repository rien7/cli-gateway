import type { Db } from './db.js';

export type WorkspaceAgentPrefs = {
  workspaceRoot: string;
  model: string | null;
  reasoningEffort: string | null;
};

export function getWorkspaceAgentPrefs(
  db: Db,
  workspaceRoot: string,
): WorkspaceAgentPrefs | null {
  const row = db
    .prepare(
      `
      SELECT
        workspace_root as workspaceRoot,
        model,
        reasoning_effort as reasoningEffort
      FROM workspace_agent_prefs
      WHERE workspace_root = ?
      `,
    )
    .get(workspaceRoot) as WorkspaceAgentPrefs | undefined;

  return row ?? null;
}

export function updateWorkspaceAgentPrefs(
  db: Db,
  workspaceRoot: string,
  patch: {
    model?: string | null;
    reasoningEffort?: string | null;
  },
): WorkspaceAgentPrefs | null {
  const current = getWorkspaceAgentPrefs(db, workspaceRoot);
  const next: WorkspaceAgentPrefs = {
    workspaceRoot,
    model:
      patch.model === undefined
        ? current?.model ?? null
        : normalizeNullableString(patch.model),
    reasoningEffort:
      patch.reasoningEffort === undefined
        ? current?.reasoningEffort ?? null
        : normalizeNullableString(patch.reasoningEffort),
  };

  if (!next.model && !next.reasoningEffort) {
    db.prepare('DELETE FROM workspace_agent_prefs WHERE workspace_root = ?').run(
      workspaceRoot,
    );
    return null;
  }

  const now = Date.now();
  db.prepare(
    `
    INSERT INTO workspace_agent_prefs(
      workspace_root,
      model,
      reasoning_effort,
      created_at,
      updated_at
    )
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(workspace_root) DO UPDATE SET
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      updated_at = excluded.updated_at
    `,
  ).run(workspaceRoot, next.model, next.reasoningEffort, now, now);

  return next;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

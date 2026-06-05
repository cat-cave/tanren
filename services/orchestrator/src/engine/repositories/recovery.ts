// Failure-recovery data-access repository: the tenant-table reads/writes the
// recovery engine (engine/recovery/index.ts) issues against `runs`, `events`,
// and `specs`. The recovery ORCHESTRATION (org-scoped txn boundaries, the
// PgEventStore lineage appends, the createQueuedRunFromSpec replan) stays in the
// engine; this repository owns ONLY the raw query sites:
//
//   - the halted-run row read (`runs`),
//   - the captured-commit lineage reads (`events`, the most-recent + all
//     `workspace.git_captured` payloads, ordered ts DESC, id DESC),
//   - the spec-steering append + the spec reopen-for-replan writes (`specs`).
//
// Every method runs on the client the caller hands in (the org-scope carrier),
// so under RLS an org-scoped client sees only that org's rows — byte-identical
// to the inline `.query` sites this replaces; no scope is widened here.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The mutable run fields the recovery surface reads. */
export interface RecoveryRunRow {
  specId: string;
  projectId: string;
  status: string;
  outcome: string | null;
}

export const RecoveryStore = {
  /**
   * Load a run's recovery-relevant fields. Returns undefined when the run does
   * not exist (or is not visible on this client); the route turns that into 404.
   */
  async getRun(client: QueryClient, runId: string, _actor: ActorRef): Promise<RecoveryRunRow | undefined> {
    const run = await client.query<{
      spec_id: string;
      project_id: string;
      status: string;
      outcome: string | null;
    }>("SELECT spec_id, project_id, status, outcome FROM runs WHERE run_id = $1", [runId]);
    const row = run.rows[0];
    if (row === undefined) return undefined;
    return { specId: row.spec_id, projectId: row.project_id, status: row.status, outcome: row.outcome };
  },

  /**
   * The most recent `workspace.git_captured` event payload for the run (or
   * undefined when none exists) — the source for the last-good commit SHA.
   * Ordered ts DESC, id DESC, LIMIT 1, exactly as the inline read.
   */
  async getLastCapturedEventPayload(
    client: QueryClient,
    runId: string,
    _actor: ActorRef,
  ): Promise<unknown | undefined> {
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
       WHERE run_id = $1 AND event_type = 'workspace.git_captured'
       ORDER BY ts DESC, id DESC
       LIMIT 1`,
      [runId],
    );
    return result.rows[0]?.payload;
  },

  /**
   * Every `workspace.git_captured` event payload for the run, ordered ts DESC,
   * id DESC — the rollback-target candidate set. Returns the raw payloads; the
   * engine extracts the commit SHAs.
   */
  async listCapturedEventPayloads(client: QueryClient, runId: string, _actor: ActorRef): Promise<unknown[]> {
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
       WHERE run_id = $1 AND event_type = 'workspace.git_captured'
       ORDER BY ts DESC, id DESC`,
      [runId],
    );
    return result.rows.map((r) => r.payload);
  },

  /** Append the operator's steering note to the spec description. */
  async appendSteeringToSpec(
    client: QueryClient,
    specId: string,
    steeringNote: string,
    _actor: ActorRef,
  ): Promise<void> {
    await client.query(
      `UPDATE specs
          SET description = description || E'\n\n[operator steering] ' || $2
        WHERE spec_id = $1`,
      [specId, steeringNote],
    );
  },

  /**
   * Reopen the spec (status → 'open') so the recovery replan can re-claim it,
   * leaving the terminal `merged` spec untouched.
   */
  async reopenSpecForReplan(client: QueryClient, specId: string, _actor: ActorRef): Promise<void> {
    await client.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1 AND status <> 'merged'`, [specId]);
  },
} as const;

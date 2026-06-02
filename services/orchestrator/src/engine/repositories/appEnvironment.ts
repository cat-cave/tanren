// Plane B data-access: the `project_app_env` store (migration 0051) — the built
// PRODUCT's own env vars + secrets, per project, DISTINCT from `org_integrations`
// (Tanren's own integrations). upsert/list/get/delete in the Repositories seam
// shape: every method takes the caller's `QueryClient` (the org-scope carrier) +
// `ActorRef`, so under RLS (project→org chain) an off-scope client sees ZERO rows.
//
// Each entry sets EXACTLY ONE of `valueRef` (secret-manager ref) / `plainValue`
// (non-secret inline) — the DB CHECK enforces it; the upsert asserts it too so a
// caller gets a clear error before hitting the DB. Secret VALUES live only in the
// secret manager; this store holds the REF, never the value.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The phases an entry can reach (subset stored per entry on `scopes`). */
export type AppEnvScope = "build" | "test" | "runtime" | "dev";

/** How the entry's value was supplied. */
export type AppEnvSource = "byo" | "provisioned";

/** A `project_app_env` row, in domain shape. Exactly one of valueRef/plainValue set. */
export interface AppEnvEntry {
  id: string;
  projectId: string;
  key: string;
  valueRef: string | null;
  plainValue: string | null;
  scopes: AppEnvScope[];
  source: AppEnvSource;
  description: string;
}

/** The fields an upsert supplies; `id`/timestamps are managed by the store/DB. */
export interface UpsertAppEnvInput {
  projectId: string;
  key: string;
  valueRef?: string;
  plainValue?: string;
  scopes: AppEnvScope[];
  source?: AppEnvSource;
  description?: string;
}

interface AppEnvRow {
  id: string;
  project_id: string;
  key: string;
  value_ref: string | null;
  plain_value: string | null;
  scopes: string[] | null;
  source: string;
  description: string;
}

function mapRow(row: AppEnvRow): AppEnvEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    valueRef: row.value_ref,
    plainValue: row.plain_value,
    scopes: (row.scopes ?? []) as AppEnvScope[],
    source: row.source as AppEnvSource,
    description: row.description,
  };
}

const COLUMNS = "id, project_id, key, value_ref, plain_value, scopes, source, description";

/**
 * Reject an entry that does not set EXACTLY ONE of valueRef/plainValue before it
 * reaches the DB CHECK — a clear application-level error rather than a constraint
 * violation. (The DB CHECK is the load-bearing guarantee; this is ergonomics.)
 */
function assertValueXor(input: UpsertAppEnvInput): void {
  const hasRef = input.valueRef !== undefined;
  const hasPlain = input.plainValue !== undefined;
  if (hasRef === hasPlain) {
    throw new Error(
      `project_app_env entry '${input.key}' must set exactly one of valueRef (secret) / plainValue (non-secret)`,
    );
  }
}

export const AppEnvironmentStore = {
  /**
   * Upsert an app-env entry keyed on (project_id, key) — re-adding a key updates
   * the existing row rather than duplicating (the unique index backs ON CONFLICT).
   * Asserts the value XOR before the write. Returns the persisted row.
   */
  async upsert(client: QueryClient, input: UpsertAppEnvInput, _actor: ActorRef): Promise<AppEnvEntry> {
    assertValueXor(input);
    const result = await client.query<AppEnvRow>(
      `INSERT INTO project_app_env (id, project_id, key, value_ref, plain_value, scopes, source, description, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, now())
       ON CONFLICT (project_id, key) DO UPDATE SET
         value_ref = EXCLUDED.value_ref,
         plain_value = EXCLUDED.plain_value,
         scopes = EXCLUDED.scopes,
         source = EXCLUDED.source,
         description = EXCLUDED.description,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.projectId,
        input.key,
        input.valueRef ?? null,
        input.plainValue ?? null,
        input.scopes,
        input.source ?? "byo",
        input.description ?? "",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`project_app_env upsert returned no row for (${input.projectId}, ${input.key})`);
    }
    return mapRow(row);
  },

  /** List a project's app-env entries, ordered by key. */
  async list(client: QueryClient, projectId: string, _actor: ActorRef): Promise<AppEnvEntry[]> {
    const result = await client.query<AppEnvRow>(
      `SELECT ${COLUMNS} FROM project_app_env WHERE project_id = $1 ORDER BY key`,
      [projectId],
    );
    return result.rows.map(mapRow);
  },

  /** Read one entry by (project_id, key), or undefined when absent/off-scope. */
  async get(client: QueryClient, projectId: string, key: string, _actor: ActorRef): Promise<AppEnvEntry | undefined> {
    const result = await client.query<AppEnvRow>(
      `SELECT ${COLUMNS} FROM project_app_env WHERE project_id = $1 AND key = $2`,
      [projectId, key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /** Delete an entry by (project_id, key). Returns true when a row matched. */
  async delete(client: QueryClient, projectId: string, key: string, _actor: ActorRef): Promise<boolean> {
    const result = await client.query("DELETE FROM project_app_env WHERE project_id = $1 AND key = $2 RETURNING id", [
      projectId,
      key,
    ]);
    return (result.rowCount ?? 0) > 0;
  },
} as const;

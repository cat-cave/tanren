import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The product-facing spec CRUD store backing the HTTP `routes/specs` surface.
// This is DISTINCT from the workflow `SpecStore` (engine/repositories/specs.ts):
// the workflow store reads the `org_id` column and the `SpecStatus` enum for the
// run lifecycle, while the route surface reads the exact 7-column contract shape
// (spec_id..status, no org_id) the dashboard CRUD uses, returns `status` as an
// opaque string, and patches an arbitrary subset of fields with a `RETURNING
// spec_id`-only contract. The SQL the methods emit is BYTE-IDENTICAL to the raw
// queries `routes/specs/index.ts` issued before the move — this is a mechanical
// relocation behind the `Repositories` seam, not a rewrite. The caller hands in
// the org-scoped client (a `runWithOrgScope` transaction); the store never opens
// a transaction or widens scope, so under RLS an off-scope client sees ZERO rows.

// The route-shaped spec row: the literal columns the spec list/detail SELECT
// returns. `acceptance_criteria`/`depends_on`/`status` stay opaque (`unknown`/
// `string`) because the route layer (`toSpecContract`) interprets them — the
// store does not decode them.
export interface ProjectSpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
}

// The exact column list the spec list/detail routes used (7 columns, no org_id).
const SELECT_SPEC_COLUMNS = "spec_id, project_id, title, description, acceptance_criteria, depends_on, status";

/**
 * The pre-rendered dynamic PATCH payload. The route inspects the parsed body,
 * pushes one `param` per present field, and renders the matching `$N` `SET`
 * fragment as it goes (e.g. `title = $1`, `acceptance_criteria = $3::jsonb`) —
 * exactly as it did inline before the move. `fragments` and `params` are
 * positionally aligned; the store appends the spec id and renders the final
 * `WHERE spec_id = $<params.length+1>` itself.
 */
export interface SpecPatch {
  fragments: readonly string[];
  params: readonly unknown[];
}

export const ProjectSpecStore = {
  /** All specs for a project, ordered by title (the spec-list route). */
  async listForProject(client: QueryClient, projectId: string, _actor: ActorRef): Promise<ProjectSpecRow[]> {
    const result = await client.query<ProjectSpecRow>(
      `SELECT ${SELECT_SPEC_COLUMNS}
           FROM specs
          WHERE project_id = $1
          ORDER BY title`,
      [projectId],
    );
    return result.rows;
  },

  /**
   * A single spec by id (the spec-detail route). `undefined` when no row is
   * visible to the caller's client. No org filter; the org-scoped client the
   * caller hands in carries the row-visibility gate.
   */
  async get(client: QueryClient, specId: string, _actor: ActorRef): Promise<ProjectSpecRow | undefined> {
    const result = await client.query<ProjectSpecRow>(
      `SELECT ${SELECT_SPEC_COLUMNS}
           FROM specs WHERE spec_id = $1`,
      [specId],
    );
    return result.rows[0];
  },

  /**
   * Apply a dynamic, partial PATCH to a spec. The route pre-renders the present
   * fields as positionally-aligned `fragments` + `params` so the byte-identical
   * `UPDATE specs SET <fragments> WHERE spec_id = $N RETURNING spec_id` contract
   * is preserved — the spec id binds last. Returns `true` when a row was updated
   * (visible to the caller's client), `false` when none matched (missing or
   * off-scope). Callers must supply at least one fragment.
   */
  async patch(client: QueryClient, specId: string, patch: SpecPatch, _actor: ActorRef): Promise<boolean> {
    const params: unknown[] = [...patch.params, specId];
    const updated = await client.query(
      `UPDATE specs SET ${patch.fragments.join(", ")} WHERE spec_id = $${params.length} RETURNING spec_id`,
      params,
    );
    return (updated.rowCount ?? 0) > 0;
  },
} as const;

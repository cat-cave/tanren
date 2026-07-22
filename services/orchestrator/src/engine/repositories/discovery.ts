// Forge discovery data-access repository: the spec-row touch-points the Forge
// discovery + intake paths read/write. Two concerns live here, both on the
// `specs` table:
//
//   1. Discovery PROVENANCE — the lineage blob stored under `specs.metadata`'s
//      `discovery` key (1:1 with a spec; no bespoke table). The provenance
//      schema + merge/parse helpers stay in `engine/forge/discovery/provenance.ts`
//      (pure transforms, no DB); this repository owns only the metadata read +
//      the metadata write the discovery path issues.
//   2. The grounding spec LIST — `(spec_id, title, status)` for a project, that
//      the discovery/intake answerers read to ground a classification against the
//      project's existing DAG. BOUNDED: active specs first,
//      then the most-recent terminal ones, capped — never the unbounded full list.
//
// Both read/write the same client the caller hands in (the org-scope carrier),
// so under RLS an org-scoped client sees only that org's specs and an off-scope
// client sees zero — byte-identical to the inline `.query` sites this replaces.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** A grounding spec summary the discovery/intake answerers read. */
export interface ExistingSpecSummary {
  specId: string;
  title: string;
  status: string;
}

export const DiscoveryStore = {
  /**
   * Read a spec's raw `metadata` JSONB. Returns `{ found: false }` when the spec
   * does not exist (so the provenance writer can distinguish "absent spec" from
   * "spec with empty metadata"); `{ found: true, metadata }` otherwise.
   */
  async getSpecMetadata(
    client: QueryClient,
    specId: string,
    _actor: ActorRef,
  ): Promise<{ found: false } | { found: true; metadata: unknown }> {
    const result = await client.query<{ metadata: unknown }>("SELECT metadata FROM specs WHERE spec_id = $1", [specId]);
    if ((result.rowCount ?? 0) === 0) {
      return { found: false };
    }
    return { found: true, metadata: result.rows[0]?.metadata };
  },

  /**
   * Overwrite a spec's `metadata` JSONB with the caller-built blob. Returns true
   * when a row matched (the spec exists / is visible on this client), false
   * otherwise. The caller serializes `metadata` to JSON; the cast is `::jsonb`.
   */
  async setSpecMetadata(client: QueryClient, specId: string, metadataJson: string, _actor: ActorRef): Promise<boolean> {
    const updated = await client.query("UPDATE specs SET metadata = $2::jsonb WHERE spec_id = $1 RETURNING spec_id", [
      specId,
      metadataJson,
    ]);
    return (updated.rowCount ?? 0) > 0;
  },

  /**
   * The project's existing specs (id/title/status) — the grounding list the
   * discovery/intake/triage answerers read for dedupe + placement.
   *
   * BOUNDED: a long-lived project accumulates hundreds of merged
   * specs; rendering EVERY one (title-ordered, no LIMIT) bloats every grounding prompt
   * unboundedly. So we surface the specs that matter for dedupe/placement — the
   * ACTIVE (non-terminal) specs FIRST, then the most-recent terminal ones — capped at
   * `GROUNDING_SPEC_LIMIT`, recency-ordered. Active specs are never dropped (their
   * count is bounded by in-flight work); only the long tail of old merged/cancelled
   * specs is truncated.
   */
  async listExistingSpecs(client: QueryClient, projectId: string, _actor: ActorRef): Promise<ExistingSpecSummary[]> {
    const result = await client.query<{ spec_id: string; title: string; status: string }>(
      `SELECT spec_id, title, status
         FROM specs
        WHERE project_id = $1
        ORDER BY (status IN ('open','in_flight','review','needs_attention')) DESC, created_at DESC
        LIMIT $2`,
      [projectId, GROUNDING_SPEC_LIMIT],
    );
    return result.rows.map((row) => ({ specId: row.spec_id, title: row.title, status: row.status }));
  },
} as const;

// The cap on specs fed into a grounding prompt (active-first, then recent terminal).
// Generous enough that a healthy project's active set + recent history all fit, while
// bounding the token spend a long-lived project's merged tail would otherwise add.
const GROUNDING_SPEC_LIMIT = 100;

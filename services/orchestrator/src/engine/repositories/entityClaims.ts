// Entity-anchored issue CLAIMS — the `entity_claims` store (migration 0035) on
// the `Repositories` seam. The Tanren-native defect ledger
// (docs/roadmap/entity-analysis-layer.md §3.3, the surviving lodestar thread).
//
// A Claim is a DURABLE assertion that a defect (an issue/finding) lives in a
// specific ENTITY, keyed on the entity's STRUCTURAL-HASH IDENTITY (not a
// file:line). The triage one-shot (§2.3) becomes a standing Claim here; the
// self-validating oracle (oracle/claimSelfValidation.ts) re-checks the anchor and
// SELF-RESOLVES it when the entity is gone.
//
// Pure SQL + row mapping, in the seam shape: every method takes the caller's
// `QueryClient` (the org-scope carrier) + `ActorRef`, so under RLS an org-scoped
// client sees only that org's rows and an OFF-SCOPE client sees ZERO — byte-
// identical to the inline `.query` sites the seam standardizes. NO empty-on-
// missing-org fallback (fail-closed RLS doctrine).

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { ActorRef } from "../state/actor.js";
import type { ClaimDecidability } from "../oracle/claimSelfValidation.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The Claim lifecycle (entity_claims_status_check). */
export type EntityClaimStatus = "open" | "self_resolved" | "agent_resolved" | "dismissed";

/** An `entity_claims` row in domain shape. */
export interface EntityClaim {
  id: string;
  orgId: string;
  projectId: string;
  candidateId: string | null;
  // The entity anchor (structural-hash IDENTITY — survives a rename/move).
  entityId: string;
  entityKind: string;
  entityName: string;
  entityPath: string;
  status: EntityClaimStatus;
  decidability: ClaimDecidability;
  // The last self-validation read-out (the oracle verdict), persisted verbatim.
  lastValidation: Record<string, unknown>;
}

/** Anchor a Claim. `id`/timestamps are managed; status/decidability default at anchor. */
export interface AnchorClaimInput {
  orgId: string;
  projectId: string;
  // The candidate (issue/finding) this Claim was anchored from during triage.
  candidateId: string | null;
  entityId: string;
  entityKind?: string;
  entityName?: string;
  entityPath?: string;
}

interface ClaimRow {
  id: string;
  org_id: string;
  project_id: string;
  candidate_id: string | null;
  entity_id: string;
  entity_kind: string;
  entity_name: string;
  entity_path: string;
  status: string;
  decidability: string;
  last_validation: unknown;
}

function mapRow(row: ClaimRow): EntityClaim {
  const lastValidation =
    row.last_validation !== null && typeof row.last_validation === "object"
      ? (row.last_validation as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    candidateId: row.candidate_id,
    entityId: row.entity_id,
    entityKind: row.entity_kind,
    entityName: row.entity_name,
    entityPath: row.entity_path,
    status: row.status as EntityClaimStatus,
    decidability: row.decidability as ClaimDecidability,
    lastValidation,
  };
}

const COLUMNS =
  "id, org_id, project_id, candidate_id, entity_id, entity_kind, entity_name, entity_path, status, decidability, last_validation";

// The self-validation read-out the driver persists alongside a status/decidability
// transition (the oracle verdict + the time it ran), so the wiring layer threads
// it through one store call. `lastValidation` is the verbatim jsonb read-out.
export interface ClaimValidationUpdate {
  status: EntityClaimStatus;
  decidability: ClaimDecidability;
  lastValidation: Record<string, unknown>;
  // When true (the Claim left `open`), `resolved_at` is stamped; otherwise it is
  // cleared (a re-open is possible if a later check changes the verdict).
  resolved: boolean;
  // On a `renamed` follow, the new display name/path the oracle re-anchors to.
  entityName?: string;
  entityPath?: string;
}

export const EntityClaimStore = {
  /**
   * Anchor a Claim to an entity's structural identity. Idempotent on
   * (project, entity_id, candidate_id): a re-triage of the same candidate against
   * the same entity UPDATES the anchor (name/path) and RE-OPENS it rather than
   * duplicating — so a re-filed-then-refactored issue keeps one Claim. Returns the
   * persisted row.
   */
  async anchor(client: QueryClient, input: AnchorClaimInput, _actor: ActorRef): Promise<EntityClaim> {
    const id = `claim_${randomUUID()}`;
    const result = await client.query<ClaimRow>(
      `INSERT INTO entity_claims
         (id, org_id, project_id, candidate_id, entity_id, entity_kind, entity_name, entity_path, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (project_id, entity_id, candidate_id) DO UPDATE SET
         entity_kind = EXCLUDED.entity_kind,
         entity_name = EXCLUDED.entity_name,
         entity_path = EXCLUDED.entity_path,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        id,
        input.orgId,
        input.projectId,
        input.candidateId,
        input.entityId,
        input.entityKind ?? "unknown",
        input.entityName ?? "",
        input.entityPath ?? "",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`entity_claims anchor returned no row for ${input.orgId}/${input.entityId}`);
    }
    return mapRow(row);
  },

  /** Read one Claim by id, or undefined when absent/off-scope under RLS. */
  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<EntityClaim | undefined> {
    const result = await client.query<ClaimRow>(`SELECT ${COLUMNS} FROM entity_claims WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * The Claims anchored from a candidate (the triage consult: "did this issue's
   * Claim already self-resolve?"). Under RLS bounded to the caller's org. Newest
   * first.
   */
  async listForCandidate(client: QueryClient, candidateId: string, _actor: ActorRef): Promise<EntityClaim[]> {
    const result = await client.query<ClaimRow>(
      `SELECT ${COLUMNS} FROM entity_claims WHERE candidate_id = $1 ORDER BY created_at DESC`,
      [candidateId],
    );
    return result.rows.map(mapRow);
  },

  /**
   * The OPEN Claims for a project — the self-validation sweep's work list. Oldest-
   * validated first (re-check the most stale anchors first; a never-validated row
   * sorts first via NULLS FIRST). Under RLS bounded to the caller's org.
   */
  async listOpenForProject(
    client: QueryClient,
    projectId: string,
    limit: number,
    _actor: ActorRef,
  ): Promise<EntityClaim[]> {
    const result = await client.query<ClaimRow>(
      `SELECT ${COLUMNS} FROM entity_claims
       WHERE project_id = $1 AND status = 'open'
       ORDER BY last_validated_at ASC NULLS FIRST LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(mapRow);
  },

  /**
   * Persist a self-validation read-out: the status/decidability transition + the
   * verbatim verdict jsonb + the validated-at stamp. `resolved` stamps/clears
   * `resolved_at`. An optional name/path RE-ANCHORS the display on a rename follow.
   * Returns the updated row, or undefined when the id is absent/off-scope.
   */
  async recordValidation(
    client: QueryClient,
    id: string,
    update: ClaimValidationUpdate,
    _actor: ActorRef,
  ): Promise<EntityClaim | undefined> {
    const result = await client.query<ClaimRow>(
      `UPDATE entity_claims SET
         status = $2,
         decidability = $3,
         last_validation = $4::jsonb,
         entity_name = COALESCE($5, entity_name),
         entity_path = COALESCE($6, entity_path),
         last_validated_at = now(),
         resolved_at = CASE WHEN $7 THEN now() ELSE NULL END,
         updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        update.status,
        update.decidability,
        JSON.stringify(update.lastValidation),
        update.entityName ?? null,
        update.entityPath ?? null,
        update.resolved,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Mark a Claim `agent_resolved` (an agent fixed the defect while the entity is
   * still present) or `dismissed` (an agent/operator judged the Claim invalid).
   * These are AGENT decisions, not structural ones — the self-validation oracle
   * never reaches them. Returns the updated row, or undefined when absent/off-scope.
   */
  async resolveByAgent(
    client: QueryClient,
    id: string,
    status: Extract<EntityClaimStatus, "agent_resolved" | "dismissed">,
    _actor: ActorRef,
  ): Promise<EntityClaim | undefined> {
    const result = await client.query<ClaimRow>(
      `UPDATE entity_claims SET status = $2, resolved_at = now(), updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Every org that owns an entity Claim — the system-scoped fan-out the cross-org
   * self-validation sweep reads before listing each org's open Claims (mirrors
   * `TemplateStore.listDistinctOrgIds` / `AuditsStore.listDistinctAuditJobOrgIds`).
   * DISTINCT, no predicate. Under system scope it spans all orgs; the sweep then
   * org-scopes each org's list.
   */
  async listDistinctOrgIds(client: QueryClient): Promise<string[]> {
    const result = await client.query<{ org_id: string }>("SELECT DISTINCT org_id FROM entity_claims");
    return result.rows.map((r) => r.org_id);
  },
} as const;

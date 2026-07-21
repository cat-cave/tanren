// in-5: the integration-requirement persistence seam. Compiles the validated
// `IntegrationRequirementV1` set the requirement-compiler actor produces into the
// `integration_requirements` table (migration 0043, in-1's table — already
// ENABLED + FORCE RLS, org-scoped). The table is the authoritative store the
// integration provisioner (in-8..12) reads from.
//
// ORG-SCOPED (RLS): every method runs on the caller's org-scoped `QueryClient`.
// Under the `tanren_app` role + the per-request `app.current_org_id` GUC, an
// off-scope client sees ZERO rows (deny-by-default). The caller (the route) opens
// the org scope; the store does NOT self-scope (it trusts the caller's client).
//
// SOURCE CONTRACT: the requirement-compiler compiles from the project's HEAD
// DesignContract, so the persisted `source_kind` is `'design_contract'` and the
// `source_revision_id` is the contract row id (the stable per-version identifier).
// The `source_digest` is the canonical `integrationRequirementDigest(req)` — the
// SAME digest the actor computed (proof = effect coordinate), so the unique index
// `integration_requirements_active_source_unique (org_id, project_id, source_kind,
// source_revision_id, source_digest) WHERE status='active'` makes a re-compile of
// the SAME contract a per-requirement no-op (idempotent insert).
//
// NO NEW MIGRATION: the table already exists (0043) with the exact shape this
// store needs (`source_kind IN ('behavior_revision','design_contract')` already
// admits the design-contract source). The `policy_version` carries the integration
// catalog revision (`INTEGRATION_POLICY_CATALOG_REVISION`).

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import {
  INTEGRATION_REQUIREMENT_DOMAIN_TAG,
  integrationRequirementDigest,
  parseIntegrationRequirement,
  type IntegrationRequirementV1,
} from "../contracts/integrationRequirement.js";
import { INTEGRATION_POLICY_CATALOG_REVISION } from "../contracts/integrationCatalog.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** A persisted `integration_requirements` row, in domain shape. */
export interface CompiledRequirementRecord {
  readonly id: string;
  readonly projectId: string;
  readonly capability: string;
  readonly plane: string;
  readonly direction: string;
  readonly criticality: string;
  readonly sourceKind: "behavior_revision" | "design_contract";
  readonly sourceRevisionId: string;
  readonly sourceDigest: string;
  readonly policyVersion: string;
  readonly status: string;
  readonly desiredState: IntegrationRequirementV1;
  readonly createdAt: string;
}

/** The compile-store input — the validated requirements + the source identifier. */
export interface CompileIntegrationRequirementsInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly requirements: readonly IntegrationRequirementV1[];
}

interface CompiledRequirementRow {
  id: string;
  project_id: string;
  capability: string;
  plane: string;
  direction: string;
  criticality: string;
  source_kind: string;
  source_revision_id: string;
  source_digest: string;
  policy_version: string;
  status: string;
  desired_state: unknown;
  created_at: Date | string;
}

const COMPILE_COLUMNS = `
  id, project_id, capability, plane, direction, criticality,
  source_kind, source_revision_id, source_digest, policy_version,
  status, desired_state, created_at
`;

function decodeRow(row: CompiledRequirementRow): CompiledRequirementRecord {
  // Trap #10 (unchecked cast): the `desired_state` jsonb is re-validated through
  // the contract schema on read so a corrupt/malformed persisted row fails LOUD
  // (never an unchecked `as IntegrationRequirementV1` that silently passes a gate).
  const parsed = parseIntegrationRequirement(row.desired_state);
  if (!parsed.ok) {
    throw new Error(
      `integration_requirements row '${row.id}' has a corrupt desired_state (failed schema parse: ${parsed.issues
        .map((i) => `${i.path}[${i.code}]`)
        .join("; ")})`,
    );
  }
  if (row.source_kind !== "behavior_revision" && row.source_kind !== "design_contract") {
    throw new Error(`integration_requirements row '${row.id}' has unexpected source_kind '${row.source_kind}'`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    capability: row.capability,
    plane: row.plane,
    direction: row.direction,
    criticality: row.criticality,
    sourceKind: row.source_kind,
    sourceRevisionId: row.source_revision_id,
    sourceDigest: row.source_digest,
    policyVersion: row.policy_version,
    status: row.status,
    desiredState: parsed.requirement,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * The integration-requirement store. Every method takes the caller's org-scoped
 * `QueryClient` + `ActorRef` — under RLS an org-scoped client sees only that org's
 * requirements and an off-scope client sees ZERO rows.
 */
export const IntegrationRequirementStore = {
  /**
   * Persist the validated compile result. Each requirement is inserted with
   * `source_kind='design_contract'` + the contract row id as `source_revision_id`
   * + the canonical digest as `source_digest`. The partial unique index
   * `integration_requirements_active_source_unique` makes a re-compile of the
   * SAME contract idempotent per-requirement: a duplicate `(source_kind,
   * source_revision_id, source_digest)` INSERT conflicts to DO NOTHING, so a
   * retry / re-derive does not double-insert. Returns the ACTUALLY-persisted rows
   * (including pre-existing ones the conflict absorbed) so the caller sees the
   * full active set for the source.
   */
  async compile(
    client: QueryClient,
    input: CompileIntegrationRequirementsInput,
    _actor: ActorRef,
  ): Promise<CompiledRequirementRecord[]> {
    if (input.requirements.length === 0) {
      return [];
    }
    const persistedRows: CompiledRequirementRow[] = [];
    for (const requirement of input.requirements) {
      const digest = integrationRequirementDigest(requirement);
      // PROOF = EFFECT: the digest computed here is the SAME canonical digest the
      // actor computed (the contract's `integrationRequirementDigest`). The
      // persisted `source_digest` column matches the canonical body, so a consumer
      // reading the row can re-derive the digest and verify it.
      const id = randomUUID();
      const result = await client.query<CompiledRequirementRow>(
        `INSERT INTO integration_requirements (
            org_id, id, project_id, capability, plane, direction, desired_state,
            source_kind, source_revision_id, source_digest, policy_version, criticality,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'design_contract', $8, $9, $10, $11, 'active')
          ON CONFLICT (org_id, project_id, source_kind, source_revision_id, source_digest)
            WHERE status = 'active'
          DO NOTHING
          RETURNING ${COMPILE_COLUMNS}`,
        [
          input.orgId,
          id,
          input.projectId,
          requirement.capability,
          requirement.plane,
          requirement.direction,
          JSON.stringify(requirement),
          input.sourceRevisionId,
          digest,
          INTEGRATION_POLICY_CATALOG_REVISION,
          requirement.criticality,
        ],
      );
      if (result.rows[0] !== undefined) {
        persistedRows.push(result.rows[0]);
      }
    }
    return persistedRows.map((row) => decodeRow(row));
  },

  /**
   * List the ACTIVE requirements for a project (the full set the provisioner
   * reads from). Returns rows newest-first by `created_at`. The caller's
   * org-scoped client carries the RLS GUC; an off-scope client returns `[]`
   * (deny-by-default) — the CALLER must guard against the off-scope-empty shape
   * upstream (the route checks `actor.orgId !== null` before calling).
   */
  async listActive(
    client: QueryClient,
    args: { orgId: string; projectId: string },
    _actor: ActorRef,
  ): Promise<CompiledRequirementRecord[]> {
    const result = await client.query<CompiledRequirementRow>(
      `SELECT ${COMPILE_COLUMNS} FROM integration_requirements
        WHERE project_id = $1 AND status = 'active'
        ORDER BY created_at DESC, id`,
      [args.projectId],
    );
    return result.rows.map((row) => decodeRow(row));
  },
} as const;

export { INTEGRATION_REQUIREMENT_DOMAIN_TAG };

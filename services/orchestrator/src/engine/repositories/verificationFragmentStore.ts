// rv-3 — the org-scoped VERIFICATION-FRAGMENT registry store (0037 tables).
//
// Pure SQL + row mapping over `verification_fragments` (stable capability identity),
// `verification_fragment_versions` (immutable content-addressed versions), and
// `verification_plan_fragments` (the durable plan↔fragment binding). Every method
// opens its own short `runWithOrgScope` transaction so the deny-by-default RLS policy
// (+ FORCE) applies: a write stamps the caller's org; a read under org B (or with no
// org GUC) sees ZERO of org A's rows. `createValidated` is the ATOMIC persist the F2
// kernel binding depends on (fragment identity upserted, a new version inserted with
// `conformance_status='passed'`); `deleteById` is the retract the batch-reject drives.
//
// The F2-authored fragment is content-addressed IN-PROCESS (no live jj workspace at
// plan-compile time), so `content_hash` is its real identity and `jj_change_id` /
// `jj_tree_id` carry that same content-tree digest as the authored provenance — a
// later VCS materialization (out of scope for rv-3) supersedes with real workspace
// refs. No value here is fabricated: each is a deterministic function of the body.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  CapabilityFragmentRef,
  SourceSpan,
  VerificationFragmentId,
  VerificationFragmentVersionId,
} from "../contracts/runtimeVerificationPlan.js";
import type {
  ValidatedVerificationFragment,
  VerificationFragmentKind,
} from "../verification/acceptance/fragments/verificationFragment.js";
import type { PresentVerificationCapability } from "../verification/acceptance/fragments/verificationFragmentValidation.js";

/** Input to atomically persist a validated verification fragment. */
export interface CreateVerificationFragmentInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly fragment: ValidatedVerificationFragment;
}

/** A cited capability the registry resolves. */
export interface ResolveCapabilityInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly capabilityKey: string;
  readonly fragmentKind: VerificationFragmentKind;
}

/** One durable plan↔fragment binding row. */
export interface PlanFragmentBinding {
  readonly stepId: string;
  readonly fragmentVersionId: string;
  readonly sourceSpan: SourceSpan;
}

/** The minimal compiled-plan row the plan-fragment bindings FK-depend on. */
export interface BindPlanInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly behaviorRevisionId: string;
  readonly compilerVersion: string;
  readonly planHash: string;
  readonly status: "compiled" | "missing_fragments";
  readonly planJson: unknown;
  readonly unresolvedCapabilities: unknown;
  readonly provenance: unknown;
  readonly bindings: readonly PlanFragmentBinding[];
}

/** The seam the rv-3 plan resolver + F2 kernel binding depend on. `PgVerificationFragmentStore`
 * is the live impl; tests inject an in-memory conformant fake. */
export interface VerificationFragmentStore {
  resolveByCapability(input: ResolveCapabilityInput): Promise<CapabilityFragmentRef | undefined>;
  listPresent(orgId: string, projectId: string): Promise<PresentVerificationCapability[]>;
  createValidated(input: CreateVerificationFragmentInput): Promise<{ persistedId: string }>;
  deleteById(orgId: string, fragmentVersionId: string): Promise<void>;
  bindPlan(input: BindPlanInput): Promise<void>;
}

export class PgVerificationFragmentStore implements VerificationFragmentStore {
  public constructor(private readonly pool: pg.Pool) {}

  /** Resolve the latest conformance-passed, non-superseded version for a capability. */
  public async resolveByCapability(input: ResolveCapabilityInput): Promise<CapabilityFragmentRef | undefined> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        version_id: string;
        fragment_id: string;
        capability_key: string;
        fragment_kind: string;
      }>(
        `SELECT v.id AS version_id, f.id AS fragment_id, f.capability_key, f.fragment_kind
           FROM verification_fragment_versions v
           JOIN verification_fragments f ON f.org_id = v.org_id AND f.id = v.fragment_id
          WHERE v.org_id = $1 AND v.project_id = $2
            AND f.capability_key = $3 AND f.fragment_kind = $4
            AND v.conformance_status = 'passed' AND v.superseded_by IS NULL
          ORDER BY v.created_at DESC, v.id DESC
          LIMIT 1`,
        [input.orgId, input.projectId, input.capabilityKey, input.fragmentKind],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            fragmentId: row.fragment_id as VerificationFragmentId,
            fragmentVersionId: row.version_id as VerificationFragmentVersionId,
            capabilityKey: row.capability_key,
            fragmentKind: row.fragment_kind,
          };
    });
  }

  /** The org/project's PRESENT capability identities — the batch gate's input. */
  public async listPresent(orgId: string, projectId: string): Promise<PresentVerificationCapability[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ capability_key: string; fragment_kind: string }>(
        `SELECT DISTINCT capability_key, fragment_kind FROM verification_fragments
          WHERE org_id = $1 AND project_id = $2
          ORDER BY capability_key, fragment_kind`,
        [orgId, projectId],
      );
      return result.rows.map((row) => ({
        capabilityKey: row.capability_key,
        fragmentKind: row.fragment_kind as VerificationFragmentKind,
      }));
    });
  }

  /** ATOMIC persist — the fragment identity (upsert, stable across versions) + a new
   * immutable content-addressed version (`conformance_status='passed'`). One
   * transaction: both rows land or neither. Returns the version id (the retract key). */
  public async createValidated(input: CreateVerificationFragmentInput): Promise<{ persistedId: string }> {
    const f = input.fragment;
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      await client.query(
        `INSERT INTO verification_fragments (org_id, id, project_id, capability_key, fragment_kind)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, id) DO NOTHING`,
        [input.orgId, f.fragmentId, input.projectId, f.capabilityKey, f.fragmentKind],
      );
      const contentTree = f.contentHash.slice("sha256:".length);
      const result = await client.query<{ id: string }>(
        `INSERT INTO verification_fragment_versions
           (org_id, id, project_id, fragment_id, source_path, jj_change_id, jj_tree_id,
            content_hash, contract_version, conformance_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'passed')
         ON CONFLICT (org_id, id) DO UPDATE SET conformance_status = 'passed'
         RETURNING id`,
        [
          input.orgId,
          f.fragmentVersionId,
          input.projectId,
          f.fragmentId,
          f.sourcePath,
          contentTree,
          contentTree,
          f.contentHash,
          f.contractVersion,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error(
          `PgVerificationFragmentStore.createValidated: insert returned no row for ${f.fragmentVersionId}`,
        );
      return { persistedId: row.id };
    });
  }

  /** Retract a version row (the batch-reject RETRACT). Deleting an absent id succeeds
   * with 0 rows — the caller's retract loop is resilient to a missing row. */
  public async deleteById(orgId: string, fragmentVersionId: string): Promise<void> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(`DELETE FROM verification_fragment_versions WHERE org_id = $1 AND id = $2`, [
        orgId,
        fragmentVersionId,
      ]);
    });
  }

  /** Persist the compiled plan (idempotent) + its durable fragment bindings — the
   * "binds them into the plan" record. One transaction; ON CONFLICT DO NOTHING keeps
   * a re-compile (identical deterministic plan) a no-op. */
  public async bindPlan(input: BindPlanInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await client.query(
        `INSERT INTO behavior_verification_plans
           (org_id, id, project_id, behavior_revision_id, compiler_version, plan_hash, status,
            plan_json, unresolved_capabilities, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
         ON CONFLICT (org_id, id) DO NOTHING`,
        [
          input.orgId,
          input.planId,
          input.projectId,
          input.behaviorRevisionId,
          input.compilerVersion,
          input.planHash,
          input.status,
          JSON.stringify(input.planJson),
          JSON.stringify(input.unresolvedCapabilities),
          JSON.stringify(input.provenance),
        ],
      );
      for (const binding of input.bindings) {
        await client.query(
          `INSERT INTO verification_plan_fragments (org_id, plan_id, step_id, fragment_version_id, project_id, source_span)
             VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, plan_id, step_id, fragment_version_id) DO NOTHING`,
          [
            input.orgId,
            input.planId,
            binding.stepId,
            binding.fragmentVersionId,
            input.projectId,
            JSON.stringify(binding.sourceSpan),
          ],
        );
      }
    });
  }
}

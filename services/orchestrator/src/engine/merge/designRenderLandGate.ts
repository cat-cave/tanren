// ds-4 sub-node #3 — bind the DESIGN-RENDER (a11y) verdict into the MergeAuthority land.
//
// THE GAP THIS CLOSES: the design-composition producer renders + judges the composed
// system's catalog a11y and persists ONE run-level `design_render_verdicts` row per
// release, but nothing consulted it at land time — a fix could merge even though the
// project's design system fails its declared accessibility posture. This reader derives,
// at LAND time, the run's design-render outcome and hands it to `authorizeAndLand` as a
// fail-closed pre-authorize signal (mirroring the behavior→land / gate→land guards).
//
// APPLIES-ONLY-WHEN-REQUIRED (never blocks non-design runs): the design_render section
// gates ONLY when the run's project HAS a composed design system with a REAL (non-"none")
// accessibility posture. A project with no design system, or a posture of "none", resolves
// `not_applicable` → the land is decided on CI alone, exactly as before.
//
// FAIL-CLOSED (§0) when it DOES apply: only a persisted `passed` outcome clears. A
// `failed_visual` (a real axe violation at/above the posture bar) BLOCKS; an
// `inconclusive_infrastructure` outcome — OR a published design system with NO verdict at
// all (required-but-absent) — BLOCKS (inconclusive ≠ passed; absence never authorizes).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  designAdapterConformanceReceiptDigest,
  parseDesignAdapterConformanceReceipt,
  receiptPasses,
} from "../design/system/adapterConformanceReceipt.js";
import { migrateDesignContractV1ToV2, withDerivedDesiredSurfaces } from "../design/system/designContractV2.js";
import { resolveProjectWebDesignSystem } from "../design/system/designSystemStore.js";
import {
  readLatestDesignRenderVerdict,
  type DesignRenderVerdictRow,
} from "../design/render/designRenderVerdictStore.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

/**
 * The run's design-render acceptance outcome at land time.
 *   - `not_applicable` — the run's project has no composed design system, or its posture is
 *     advisory ("none"). The land decides on the other signals alone; NEVER blocks.
 *   - `passed`         — the composed system's render/a11y verification passed the posture bar.
 *   - `failed`         — a real axe violation at/above the bar. Fail-closed: NOT authorized.
 *   - `inconclusive`   — verification was required but did NOT reach a decisive pass (the
 *     verification was inconclusive, OR a published design system carries no verdict at all).
 *     Fail-closed: NOT authorized (inconclusive ≠ passed).
 */
export type DesignRenderGate =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "passed"; readonly passedCheckpointCount: number }
  | { readonly kind: "failed"; readonly failingScenarioKey: string; readonly failingRuleIds: readonly string[] }
  | { readonly kind: "inconclusive_infrastructure"; readonly reason: string };

interface RequiredTargetProfile {
  readonly target: string;
  readonly capabilities: readonly string[];
}

interface ConformanceDbRow {
  readonly target: string;
  readonly artifact_digest: string;
  readonly persisted_artifact_digest: string;
  readonly receipt_digest: string;
  readonly receipt: unknown;
  readonly outcome: string;
}

export type TargetConformanceGate =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "passed"; readonly hasPublishedRelease: true }
  | { readonly kind: "inconclusive"; readonly reason: string };

/**
 * PURE: judge the run's design-render outcome from the persisted verdict (+ whether the
 * project has a published web design system without a verdict). DB-free so the fail-closed
 * decision table is unit-tested without Postgres.
 *
 * `verdict === undefined && !hasPublishedSystemWithoutVerdict` ⇒ the project never composed a
 * design system ⇒ `not_applicable`. `verdict === undefined && hasPublishedSystemWithoutVerdict`
 * ⇒ a published system with no verdict ⇒ required-but-absent ⇒ fail closed (`inconclusive`).
 */
export function evaluateDesignRenderLandGate(input: {
  readonly verdict: DesignRenderVerdictRow | undefined;
  readonly hasPublishedSystemWithoutVerdict: boolean;
}): DesignRenderGate {
  const { verdict } = input;
  if (verdict === undefined) {
    if (input.hasPublishedSystemWithoutVerdict) {
      return {
        kind: "inconclusive_infrastructure",
        reason: "the project has a published design system but no design-render verdict (required-but-absent)",
      };
    }
    return { kind: "not_applicable" };
  }
  if (verdict.outcome === "not_applicable") {
    return { kind: "not_applicable" };
  }
  if (verdict.outcome === "passed") {
    return { kind: "passed", passedCheckpointCount: verdict.checkpoints.filter((c) => c.verdict === "passed").length };
  }
  if (verdict.outcome === "failed_visual") {
    return {
      kind: "failed",
      failingScenarioKey: verdict.failingScenarioKey ?? "unknown",
      failingRuleIds: verdict.failingRuleIds,
    };
  }
  // inconclusive_infrastructure — fail closed (inconclusive ≠ passed).
  return {
    kind: "inconclusive_infrastructure",
    reason:
      `design-render verification for the '${verdict.accessibilityStandard}' posture was ` +
      `inconclusive (no surface verified clean; not a decisive pass)`,
  };
}

/**
 * Re-read the run's design-render outcome FRESH at land time, org-scoped (RLS). Resolves the
 * run's project, reads the LATEST persisted verdict for that project, and evaluates it via
 * {@link evaluateDesignRenderLandGate}. When no verdict exists, checks whether the project
 * nonetheless has a published web design system (required-but-absent → fail closed).
 *
 * FAIL-CLOSED reads: a query error propagates (the caller's land already fails closed on a
 * throw). A run with no resolvable project ⇒ `not_applicable` (design was not required).
 */
export async function resolveDesignRenderGate(
  pool: pg.Pool,
  orgId: string,
  runId: string,
  withOrgScope?: OrgScope,
): Promise<DesignRenderGate> {
  const scope: OrgScope = withOrgScope ?? ((org, operation) => runWithOrgScope(pool, org, operation));
  return scope(orgId, async (client) => {
    const projectId = (
      await client.query<{ project_id: string }>(`SELECT project_id FROM runs WHERE org_id = $1 AND run_id = $2`, [
        orgId,
        runId,
      ])
    ).rows[0]?.project_id;
    if (projectId === undefined) {
      return { kind: "not_applicable" };
    }
    const targetConformance = await resolveRequiredTargetConformance(client, orgId, projectId);
    if (targetConformance.kind === "inconclusive") {
      return { kind: "inconclusive_infrastructure", reason: targetConformance.reason };
    }
    const verdict = await readLatestDesignRenderVerdict(client, orgId, projectId);
    if (verdict !== undefined) {
      return evaluateDesignRenderLandGate({ verdict, hasPublishedSystemWithoutVerdict: false });
    }
    // No verdict — but is a design system nonetheless published for the project? A published
    // system with no verdict is required-but-absent (fail closed), never a silent pass.
    const publishedSystem =
      targetConformance.kind === "passed"
        ? true
        : (await resolveProjectWebDesignSystem(client, { orgId, projectId })) !== undefined;
    return evaluateDesignRenderLandGate({
      verdict: undefined,
      hasPublishedSystemWithoutVerdict: publishedSystem,
    });
  });
}

/**
 * Read a published release's required V2 targets and prove that each has a
 * passed receipt on its exact persisted artifact coordinate. This runs inside
 * the caller's RLS scope so land-time authorization consumes the durable
 * `design_adapter_conformance_runs` rows rather than trusting compose-time
 * process memory. Any missing, corrupt, non-passed, or stale row is a typed
 * inconclusive block.
 */
async function resolveRequiredTargetConformance(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<TargetConformanceGate> {
  const release = await client.query<{ readonly release_id: string; readonly contract: unknown }>(
    `WITH head_contract AS (
       SELECT id, org_id, version
         FROM design_contracts
        WHERE org_id = $1 AND project_id = $2
        ORDER BY version DESC
        LIMIT 1
     ),
     own_release AS (
       SELECT release.id AS release_id, release.contract_id
         FROM head_contract
         JOIN design_system_releases release
           ON release.org_id = head_contract.org_id
          AND release.contract_id = head_contract.id
          AND release.contract_version = head_contract.version
          AND release.state = 'published'
        ORDER BY release.version DESC
        LIMIT 1
     ),
     bound_release AS (
       SELECT release.id AS release_id, release.contract_id
         FROM project_design_bindings binding
         JOIN design_system_releases release
           ON release.org_id = binding.org_id
          AND release.design_system_id = binding.design_system_id
          AND release.state = 'published'
          AND (
            (binding.pin_mode = 'release' AND release.id = binding.pinned_release_id)
            OR (binding.pin_mode = 'channel'
                AND release.id = (
                  SELECT channel.release_id FROM design_release_channels channel
                   WHERE channel.org_id = binding.org_id
                     AND channel.design_system_id = binding.design_system_id
                     AND channel.channel = binding.channel
                ))
          )
        WHERE binding.org_id = $1 AND binding.project_id = $2
        LIMIT 1
     ),
     selected_release AS (
       SELECT release_id, contract_id FROM own_release
       UNION ALL
       SELECT release_id, contract_id FROM bound_release
        WHERE NOT EXISTS (SELECT 1 FROM own_release)
     )
     SELECT selected_release.release_id, source_contract.contract
       FROM selected_release
       JOIN design_contracts source_contract
         ON source_contract.org_id = $1 AND source_contract.id = selected_release.contract_id`,
    [orgId, projectId],
  );
  const published = release.rows[0];
  if (published === undefined) return { kind: "not_applicable" };

  let requiredTargets: readonly RequiredTargetProfile[];
  try {
    requiredTargets = withDerivedDesiredSurfaces(migrateDesignContractV1ToV2(published.contract))
      .targetProfiles.filter((profile) => profile.required)
      .map((profile) => ({ target: profile.target, capabilities: profile.capabilities }));
  } catch (error) {
    return {
      kind: "inconclusive",
      reason: `published design release has an unreadable required-target contract: ${errorMessage(error)}`,
    };
  }
  const rows = await client.query<ConformanceDbRow>(
    `SELECT DISTINCT ON (run.target)
            run.target, run.artifact_digest, artifact.digest AS persisted_artifact_digest,
            run.receipt_digest, run.receipt, run.outcome
       FROM design_adapter_conformance_runs run
       JOIN design_artifacts artifact
         ON artifact.org_id = run.org_id AND artifact.id = run.artifact_id
      WHERE run.org_id = $1 AND run.release_id = $2
      ORDER BY run.target, run.created_at DESC, run.id DESC`,
    [orgId, published.release_id],
  );
  return evaluateRequiredTargetConformance(requiredTargets, rows.rows);
}

/**
 * PURE receipt classifier for the land gate. The database reader above supplies
 * rows from the current release; this function makes the fail-closed handling
 * of absent, failed, corrupt, stale, and capability-mismatched evidence
 * DB-free and directly testable.
 */
export function evaluateRequiredTargetConformance(
  requiredTargets: readonly RequiredTargetProfile[],
  rows: readonly ConformanceDbRow[],
): TargetConformanceGate {
  if (requiredTargets.length === 0 || requiredTargets.some((target) => target.capabilities.length === 0)) {
    return {
      kind: "inconclusive",
      reason: "published design release has an empty required target/capability set",
    };
  }
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  for (const required of requiredTargets) {
    const row = byTarget.get(required.target);
    const issue = conformanceIssue(required, row);
    if (issue !== undefined) {
      return { kind: "inconclusive", reason: `required target '${required.target}' ${issue}` };
    }
  }
  return { kind: "passed", hasPublishedRelease: true };
}

function conformanceIssue(required: RequiredTargetProfile, row: ConformanceDbRow | undefined): string | undefined {
  if (row === undefined) return "has no design-adapter conformance receipt";
  if (row.outcome !== "passed") return `recorded '${row.outcome}' instead of a decisive pass`;
  if (row.artifact_digest !== row.persisted_artifact_digest)
    return "receipt artifact digest is stale versus the persisted artifact";
  try {
    const receipt = parseDesignAdapterConformanceReceipt(row.receipt);
    if (receipt.target !== required.target) return "receipt target does not match the required target";
    if (receipt.artifactDigest !== row.artifact_digest) return "receipt body artifact digest is stale";
    if (designAdapterConformanceReceiptDigest(receipt) !== row.receipt_digest) return "receipt body digest is corrupt";
    if (!sameMultiset(receipt.requiredCapabilities, required.capabilities)) {
      return "receipt capability set does not match the V2 contract";
    }
    if (!receiptPasses(receipt)) return "receipt body is not a decisive pass";
  } catch (error) {
    return `receipt is corrupt: ${errorMessage(error)}`;
  }
  return undefined;
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown receipt validation error";
}

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
        kind: "inconclusive",
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
    kind: "inconclusive",
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
    const verdict = await readLatestDesignRenderVerdict(client, orgId, projectId);
    if (verdict !== undefined) {
      return evaluateDesignRenderLandGate({ verdict, hasPublishedSystemWithoutVerdict: false });
    }
    // No verdict — but is a design system nonetheless published for the project? A published
    // system with no verdict is required-but-absent (fail closed), never a silent pass.
    const publishedSystem = await resolveProjectWebDesignSystem(client, { orgId, projectId });
    return evaluateDesignRenderLandGate({
      verdict: undefined,
      hasPublishedSystemWithoutVerdict: publishedSystem !== undefined,
    });
  });
}

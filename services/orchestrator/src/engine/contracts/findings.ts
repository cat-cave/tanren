// First-class FINDINGS — the shared currency of the "tanren owns the engine"
// refactor (tanren-owns-the-engine.md §4). The auditor EMITS findings and makes
// NO pass/fail/halt judgment; the per-project `auditPosture` policy
// (`./auditPosture.js`) turns findings into the gate verdict, and
// `MergeAuthority` (`./mergeAuthority.js`) consumes the posture decision as one
// fail-closed input among gate/conflict/budget/demo/hitl.
//
// WHY a first-class type (not an inferred severity threaded through control flow):
// §4 + §7 — the design DELETES "inferred severity" as a concept. Severity is an
// explicit field on an explicit object, so the policy is the SOLE place a finding
// becomes a block/route/fix decision. This is the durable currency Wave-1
// auditors emit and Wave-2 `auditPosture` decides over.
//
// This type is purpose-distinct from `OpenFindingSeverity` in `./dagLifecycle.js`
// (which carries the `none`/`unaudited` PROJECTION states the speculation
// threshold reasons over). A Finding always HAS a severity — an absent finding is
// the absence of an element in the list, never a `none`-valued finding.

/**
 * The severity of a single audit finding, P0 (most severe) → P3 (least). This is
 * the ordered scale `auditPosture.blockReviewAt` compares against. Unlike
 * `OpenFindingSeverity` there is no `none`/`unaudited`: a Finding is a concrete
 * defect; "no findings" is an empty list.
 */
export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

/**
 * One audit finding. `id` is stable (so the same defect is dedupable across
 * re-audits); `severity` is the explicit P0–P3 scale; `title`/`body` are the
 * human-facing summary + detail; `fixHint` is an optional machine/agent hint the
 * `fix-in-place` path (or a routed DAG spec) can act on. The auditor populates
 * these and STOPS — it renders no verdict (that is the posture's job).
 */
export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  fixHint?: string;
}

/**
 * The P0–P3 scale as an ordered ladder, most-severe first. `severityRank` maps a
 * severity to its rank so `>=`/`<=` comparisons against a threshold are total +
 * unambiguous. P0 has the LOWEST rank (0) so "max severity" is the MINIMUM rank —
 * the most severe finding present.
 */
export const FINDING_SEVERITY_ORDER: readonly FindingSeverity[] = ["P0", "P1", "P2", "P3"];

/** Rank of a severity (P0 = 0 … P3 = 3); lower rank = more severe. Pure + total. */
export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITY_ORDER.indexOf(severity);
}

/**
 * The most-severe (lowest-rank) severity present in a findings list, or
 * `undefined` when the list is empty. PURE — the building block the posture's
 * `block` decision is computed from.
 */
export function maxSeverity(findings: ReadonlyArray<Finding>): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const f of findings) {
    if (worst === undefined || severityRank(f.severity) < severityRank(worst)) {
      worst = f.severity;
    }
  }
  return worst;
}

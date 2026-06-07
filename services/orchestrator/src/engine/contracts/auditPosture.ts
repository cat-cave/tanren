// The `auditPosture` policy (tanren-owns-the-engine.md §4) — the REAL DORA knob.
// The auditor emits findings (`./findings.js`) and renders NO verdict; THIS policy
// turns a findings list into the gate decision. It is the single place "one engine,
// every strategy" lives: a zero-defect shop blocks on even P3; a demo-stage startup
// blocks on nothing and routes everything into the DAG. DORA metrics + bug-report
// rates then let a user MEASURE which posture fits, instead of being forced into one.
//
// WHY this is its own pure seam: §7 deletes "inferred severity" and the scattered
// gate/governance judgments. `decideFromFindings` is PURE + total so the
// block/route/fix decision is reproducible, conformance-tested with no DB, and the
// SOLE authority over what findings mean. `MergeAuthority.authorizeLand`
// (`./mergeAuthority.js`) consumes `{ block }` as ONE fail-closed input; the
// `route`/`fixInPlace` split feeds Wave-2's fix-in-place vs route-to-DAG handling.

import { type Finding, type FindingSeverity, FINDING_SEVERITY_ORDER, severityRank } from "./findings.js";

/**
 * How the project handles the residual P2/P3 findings that do NOT block reaching
 * review/merge (those below `blockReviewAt`):
 *   - `fix-if-idle`   — fix them in place IF the spec idles awaiting review (don't
 *                       spawn new work while the run is still live), else carry on.
 *   - `route-to-dag`  — auto-route each as a NEW DAG spec (velocity posture: never
 *                       block on polish, fold it back into the planner).
 */
export type P2P3Handling = "fix-if-idle" | "route-to-dag";

/**
 * The per-project audit posture — the DORA tuning knob. `blockReviewAt` is the
 * severity at-or-above which findings BLOCK reaching review/merge: a finding whose
 * severity is at least as severe as `blockReviewAt` blocks. Strict ("zero-defect")
 * is `blockReviewAt: 'P3'` (block on anything, even P3); velocity is
 * `blockReviewAt: 'P1'` (only P0/P1 block) with `p2p3Handling: 'route-to-dag'`.
 */
export interface AuditPosture {
  blockReviewAt: FindingSeverity;
  p2p3Handling: P2P3Handling;
}

/**
 * The decision the posture renders over a findings list:
 *   - `block`      — true when ANY finding is at-or-above `blockReviewAt`
 *                    (max severity is at least as severe as the threshold).
 *   - `route`      — the residual (below-threshold) findings to auto-route as new
 *                    DAG specs (non-empty only under `p2p3Handling: 'route-to-dag'`).
 *   - `fixInPlace` — the residual findings to fix in place when the spec idles
 *                    (non-empty only under `p2p3Handling: 'fix-if-idle'`).
 * `route` and `fixInPlace` are mutually exclusive per `p2p3Handling`; together they
 * always account for exactly the below-threshold findings.
 */
export interface AuditPostureDecision {
  block: boolean;
  route: Finding[];
  fixInPlace: Finding[];
}

/** True when `severity` is at-or-above (at least as severe as) `threshold`. */
function atOrAbove(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

/**
 * PURE: turn a findings list into the posture decision. WHY pure + total: §4 makes
 * this the SOLE authority that interprets findings; keeping it free of I/O lets the
 * same input deterministically yield the same gate verdict, conformance-tested with
 * no DB. The same findings BLOCK under strict (`blockReviewAt:'P3'`) and ROUTE under
 * velocity (`blockReviewAt:'P1', p2p3Handling:'route-to-dag'`) — the DORA knob.
 */
export function decideFromFindings(findings: ReadonlyArray<Finding>, posture: AuditPosture): AuditPostureDecision {
  const blocking: Finding[] = [];
  const residual: Finding[] = [];
  for (const f of findings) {
    if (atOrAbove(f.severity, posture.blockReviewAt)) {
      blocking.push(f);
    } else {
      residual.push(f);
    }
  }
  const route = posture.p2p3Handling === "route-to-dag" ? residual : [];
  const fixInPlace = posture.p2p3Handling === "fix-if-idle" ? residual : [];
  return { block: blocking.length > 0, route, fixInPlace };
}

// Referenced so the ordered ladder is part of the posture module's public surface
// (the contract barrel exports it for Wave-1/2 consumers reasoning over thresholds).
export const POSTURE_SEVERITY_LADDER = FINDING_SEVERITY_ORDER;

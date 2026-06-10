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
 *
 * `autonomousRemediation` is the AUTONOMOUS-RUN knob (apex doctrine): when true, a
 * BLOCKING finding (≥ `blockReviewAt`) does NOT merely PARK at needs_attention — it
 * ALSO becomes a REMEDIATION DAG spec, so the scheduled-audit loop CLOSES as
 * "audit → finding → fix → merge" with no operator. The block still holds for the
 * CURRENT spec (the merge authority stays fail-closed); the remediation spec is the
 * fix-it work that re-enters the DAG. When false (the balanced default), a blocking
 * finding parks for a human (today's behavior). Human-escalation discipline is
 * preserved: a genuinely-ambiguous product decision is surfaced via the finding's
 * own escalation, not auto-routed — `autonomousRemediation` turns a CONCRETE defect
 * (a security hole, a broken contract) into fix-it work, not a product judgment.
 */
export interface AuditPosture {
  blockReviewAt: FindingSeverity;
  p2p3Handling: P2P3Handling;
  autonomousRemediation?: boolean;
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
  /**
   * The BLOCKING findings (≥ `blockReviewAt`) to ALSO turn into remediation DAG
   * specs. Non-empty ONLY under `autonomousRemediation: true` — an autonomous/apex
   * run remediates a blocking defect by re-entering it as fix-it work rather than
   * leaving it parked. Empty under the balanced default (a blocking finding parks
   * for a human). The block boolean is UNCHANGED either way (the current spec still
   * fails closed); `remediate` is the additional fix-it work.
   */
  remediate: Finding[];
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
  // AUTONOMOUS REMEDIATION: a blocking finding also becomes a remediation DAG spec
  // (so an autonomous/apex run fixes it, not parks it). The block stays true — the
  // current spec is still fail-closed; the remediation is the additional fix-it work.
  const remediate = posture.autonomousRemediation === true ? blocking : [];
  return { block: blocking.length > 0, route, fixInPlace, remediate };
}

/**
 * PURE preflight predicate: would findings produced under this posture RE-ENTER the
 * DAG (become specs) or get ACTUATED, rather than silently strand? True when:
 *   - residual (below-threshold) findings route to the DAG (`route-to-dag`) OR are
 *     fixed in place (`fix-if-idle`), AND
 *   - blocking findings either become remediation specs (`autonomousRemediation`) or
 *     are an EXPLICIT human-stop policy (a posture that blocks on nothing —
 *     `blockReviewAt` strictly below P0 is impossible, so "blocks on nothing" is not
 *     representable; the human-stop is the DEFAULT non-autonomous posture).
 *
 * The scheduled-audit proof is "audit → finding → fix → merge"; an AUTONOMOUS run
 * MUST re-enter findings. This predicate is what the run preflight asserts so a
 * misconfigured posture cannot silently no-op the proof. For a NON-autonomous run a
 * parked blocking finding is the intended human-stop, so the predicate is consulted
 * ONLY for autonomous runs (the caller passes `requireRemediation`).
 */
export function postureReentersFindings(posture: AuditPosture, requireRemediation: boolean): boolean {
  // Residual findings must have a home: route-to-dag re-enters them; fix-if-idle
  // actuates them when idle. Both count as "not stranded".
  const residualHandled = posture.p2p3Handling === "route-to-dag" || posture.p2p3Handling === "fix-if-idle";
  if (!residualHandled) return false;
  // An autonomous run additionally requires blocking findings to become remediation
  // specs (else a P0/P1 silently parks and the audit→fix→merge loop never closes).
  if (requireRemediation && posture.autonomousRemediation !== true) return false;
  return true;
}

// Referenced so the ordered ladder is part of the posture module's public surface
// (the contract barrel exports it for Wave-1/2 consumers reasoning over thresholds).
export const POSTURE_SEVERITY_LADDER = FINDING_SEVERITY_ORDER;

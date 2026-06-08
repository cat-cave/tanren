// WAVE-2 / SLICE P-A — the POSTURE GATE (tanren-owns-the-engine.md §4 + §5).
//
// The auditor emits findings; THIS module turns a findings list + the project's
// `auditPosture` into the gate ACTION. It is the seam between the pure policy
// (`contracts/auditPosture.ts:decideFromFindings`) and the engine's three
// dispositions:
//
//   - `block`       — P0/P1 by default (`blockReviewAt`) BLOCK the spec from
//                     reaching review/merge. This becomes one fail-closed input to
//                     `MergeAuthority` (a later wave); a blocked spec never lands.
//   - `route`       — under `p2p3Handling: 'route-to-dag'`, the residual (below
//                     threshold) findings are emitted as NEW DAG specs, reusing the
//                     intake auto-route path (`forge/intake/systemActor.ts` +
//                     `forge/inbox` `autoRouteCandidate`) — the SAME accept path an
//                     ingested issue takes, so the finding becomes a real,
//                     prioritized, dependency-aware spec with no operator click.
//   - `fixInPlace`  — under `p2p3Handling: 'fix-if-idle'`, the residual findings are
//                     fixed IN PLACE only when the spec IDLES awaiting review (we do
//                     not spawn fix-work while the run is still live); otherwise they
//                     carry forward untouched.
//
// This slice is ADDITIVE: `evaluatePostureGate` is PURE (decision + the routable
// spec shapes + the fix-in-place set) and is NOT yet wired into the live merge
// path — S1 reads it. Keeping the disposition logic pure lets the DORA-knob
// behavior be conformance-tested with no DB, exactly like `decideFromFindings`.

import { type AuditPosture, type AuditPostureDecision, decideFromFindings } from "../../contracts/auditPosture.js";
import type { Finding } from "../../contracts/findings.js";
import { type TriageRoutableSpec } from "../inbox/types.js";

/**
 * Whether the spec is IDLE awaiting review — the precondition the `fix-if-idle`
 * disposition checks. When the run is still live (not idle), `fix-if-idle`
 * findings are carried forward, NOT fixed (we never spawn fix-work mid-run).
 */
export interface PostureGateContext {
  /** True when the spec idles awaiting review (the run reached review + is waiting). */
  idleAwaitingReview: boolean;
}

/**
 * One residual finding mapped to its disposition. `fix` findings are acted on
 * only when the spec is idle (else `carryForward`); `route` findings always
 * become DAG specs. The `routableSpec` is populated for `route` findings (the
 * exact shape the intake auto-route accept path commits).
 */
export interface PostureFindingDisposition {
  finding: Finding;
  action: "route" | "fix" | "carryForward";
  routableSpec?: TriageRoutableSpec;
}

/**
 * The full posture-gate evaluation. `block` is the fail-closed merge input (P0/P1
 * by default); `routeSpecs` are the new DAG specs to commit via the intake
 * auto-route path; `fixInPlace` are the findings to fix now (idle only);
 * `dispositions` is the per-finding breakdown for narration/tests.
 */
export interface PostureGateResult {
  decision: AuditPostureDecision;
  routeSpecs: TriageRoutableSpec[];
  fixInPlace: Finding[];
  dispositions: PostureFindingDisposition[];
}

/**
 * Map ONE residual finding to a `TriageRoutableSpec` — the exact shape
 * `acceptProposals` (the intake auto-route path) commits into the DAG. The
 * finding's `title`/`body` become the spec's title/description; `fixHint` (when
 * present) seeds the acceptance criterion so the routed work has a concrete bar,
 * else a generic "resolve the finding" criterion. New audit-routed work slots
 * onto the backlog with no dependency edges; the planner orders it.
 */
export function findingToRoutableSpec(finding: Finding): TriageRoutableSpec {
  const criterion = finding.fixHint ?? `Resolve the audit finding: ${finding.title}`;
  return {
    title: finding.title,
    description: finding.body,
    acceptanceCriteria: [criterion],
    dependsOn: [],
    priority: "tbd",
  };
}

/**
 * PURE: evaluate the posture gate over a findings list. Runs the policy
 * (`decideFromFindings`) then maps the residual findings to their dispositions:
 *   - `route-to-dag`  ⇒ every residual finding becomes a routable spec.
 *   - `fix-if-idle`   ⇒ residual findings are fixed in place WHEN idle, else
 *                       carried forward.
 * `block` is passed through unchanged (the fail-closed merge input). This is the
 * SOLE place the posture decision becomes an engine action — one engine, every
 * strategy, selected by the per-project `auditPosture` DORA knob.
 */
export function evaluatePostureGate(
  findings: ReadonlyArray<Finding>,
  posture: AuditPosture,
  context: PostureGateContext,
): PostureGateResult {
  const decision = decideFromFindings(findings, posture);

  const dispositions: PostureFindingDisposition[] = [];
  const routeSpecs: TriageRoutableSpec[] = [];
  const fixInPlace: Finding[] = [];

  for (const finding of decision.route) {
    const routableSpec = findingToRoutableSpec(finding);
    routeSpecs.push(routableSpec);
    dispositions.push({ finding, action: "route", routableSpec });
  }

  for (const finding of decision.fixInPlace) {
    if (context.idleAwaitingReview) {
      fixInPlace.push(finding);
      dispositions.push({ finding, action: "fix" });
    } else {
      // Not idle: do not spawn fix-work while the run is still live.
      dispositions.push({ finding, action: "carryForward" });
    }
  }

  return { decision, routeSpecs, fixInPlace, dispositions };
}

// AUDIT-POSTURE PREFLIGHT (Loop 3 — the scheduled-audit proof guard). The
// scheduled-audit proof is "audit → finding → fix → merge": an audit finding must
// RE-ENTER the DAG as a spec, not silently strand. Under the BALANCED default
// posture (`blockReviewAt: 'P1'`, `p2p3Handling: 'fix-if-idle'`, no autonomous
// remediation) a blocking P0/P1 finding PARKS at needs_attention and a residual
// P2/P3 is fixed only when idle — for a NON-autonomous run that human-stop is the
// intended policy. But for an AUTONOMOUS run there is no operator to act on a
// parked finding, so a posture that strands findings would silently NO-OP the proof.
//
// This preflight is the LOUD guard: for an autonomous run it asserts the resolved
// `auditPosture` RE-ENTERS findings (residual routes/fixes AND blocking findings
// become remediation specs — `AUTONOMOUS_AUDIT_POSTURE`), and FAILS CLOSED at setup
// (a `audit.posture_strands_findings` event + a throw) when it would not. No silent
// degrade — a misconfigured autonomous posture cannot quietly skip the proof. (A
// non-autonomous run never runs this assert: a parked blocking finding is its
// intended human-stop.)

import { type AuditPosture, postureReentersFindings } from "../contracts/auditPosture.js";
import type { AppendEvent } from "./subtaskLoop.js";

/**
 * Raised when an AUTONOMOUS run is configured with an `auditPosture` that would NOT
 * re-enter scheduled-audit findings into the DAG (residual findings stranded, or
 * blocking findings parked with no `autonomousRemediation`). The run FAILS CLOSED at
 * setup rather than spend under a posture that silently no-ops the audit→fix→merge
 * proof. Carries the non-secret posture fields only.
 */
export class AuditPostureStrandsFindingsError extends Error {
  readonly blockReviewAt: string;
  readonly p2p3Handling: string;
  readonly autonomousRemediation: boolean;
  constructor(posture: AuditPosture) {
    super(
      `autonomous run configured with an auditPosture that strands findings ` +
        `(blockReviewAt=${posture.blockReviewAt}, p2p3Handling=${posture.p2p3Handling}, ` +
        `autonomousRemediation=${posture.autonomousRemediation === true}): a scheduled-audit finding would ` +
        `neither route to the DAG nor become a remediation spec, silently no-op'ing the audit→fix→merge proof — ` +
        `set autonomousRemediation:true (and p2p3Handling:'route-to-dag') or use AUTONOMOUS_AUDIT_POSTURE`,
    );
    this.name = "AuditPostureStrandsFindingsError";
    this.blockReviewAt = posture.blockReviewAt;
    this.p2p3Handling = posture.p2p3Handling;
    this.autonomousRemediation = posture.autonomousRemediation === true;
  }
}

/**
 * Assert that an AUTONOMOUS run's resolved `auditPosture` re-enters findings into the
 * DAG. A no-op for a non-autonomous run (a parked blocking finding is the intended
 * human-stop there). For an autonomous run, when the posture would strand findings
 * (`postureReentersFindings(posture, true)` is false) it emits the loud
 * `audit.posture_strands_findings` event and throws
 * {@link AuditPostureStrandsFindingsError} so the run fails closed at setup.
 */
export async function assertAuditPostureReentersFindings(
  input: { autonomous: boolean; posture: AuditPosture },
  appendEvent: AppendEvent,
): Promise<void> {
  // A non-autonomous run intends a human-stop on a blocking finding — never assert.
  if (!input.autonomous) return;
  if (postureReentersFindings(input.posture, true)) return;
  await appendEvent("audit.posture_strands_findings", {
    blockReviewAt: input.posture.blockReviewAt,
    p2p3Handling: input.posture.p2p3Handling,
    autonomousRemediation: input.posture.autonomousRemediation === true,
    reason:
      "an autonomous run's auditPosture would neither route a residual finding to the DAG nor remediate a " +
      "blocking finding — the scheduled-audit proof (audit → finding → fix → merge) would silently no-op",
  });
  throw new AuditPostureStrandsFindingsError(input.posture);
}

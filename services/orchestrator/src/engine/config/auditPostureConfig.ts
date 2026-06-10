// Audit posture (the DORA knob — tanren-owns-the-engine.md §4). Split out of
// shared.ts to keep that file under the 500-line architecture cap. The auditor
// emits findings; this posture turns them into the gate verdict. Re-exported from
// shared.ts + config/index.ts so the import surface is unchanged.

import { z } from "zod";
import { isApexMode } from "./apexMode.js";

// The explicit P0–P3 severity ladder (mirrors `contracts/findings.ts` +
// `contracts/auditPosture.ts`). Zod here so the per-project `auditPosture` config
// persists + validates with the rest of the project blob.
export const FindingSeverityConfig = z.enum(["P0", "P1", "P2", "P3"]);
export type FindingSeverityConfig = z.infer<typeof FindingSeverityConfig>;

// How the project handles the residual P2/P3 findings that do NOT block reaching
// review/merge (mirrors `contracts/auditPosture.ts:P2P3Handling`):
//   - `fix-if-idle`  — fix them in place IF the spec idles awaiting review.
//   - `route-to-dag` — auto-route each as a NEW DAG spec (velocity posture).
export const P2P3HandlingConfig = z.enum(["fix-if-idle", "route-to-dag"]);
export type P2P3HandlingConfig = z.infer<typeof P2P3HandlingConfig>;

// The per-project AUDIT POSTURE — the REAL DORA knob (tanren-owns-the-engine.md §4).
// The auditor emits findings; this posture turns them into the gate verdict.
// `blockReviewAt` is the severity at-or-above which a finding BLOCKS reaching
// review/merge; `p2p3Handling` decides what happens to the below-threshold residual.
// A GOVERNED SETTING (like `governancePosture` / `reviewPolicy`), persisted in the
// project config jsonb — never an env var.
//
// The default is the BALANCED posture: `blockReviewAt: 'P1'` (P0/P1 block; P2/P3 do
// not) with `p2p3Handling: 'fix-if-idle'`. A zero-defect shop sets `blockReviewAt:
// 'P3'`; a velocity shop sets `p2p3Handling: 'route-to-dag'`. One engine, every
// strategy — DORA metrics let a user MEASURE which fits.
//
// `autonomousRemediation` is the AUTONOMOUS-RUN knob (apex doctrine): when true a
// BLOCKING finding becomes a REMEDIATION DAG spec (fix-it work re-enters the DAG)
// rather than parking at needs_attention — so the audit loop CLOSES as
// "audit → finding → fix → merge" with no operator (the block still holds for the
// CURRENT spec). Default false (a blocking finding parks for a human — today's behavior).
export const AuditPostureConfig = z
  .object({
    blockReviewAt: FindingSeverityConfig.default("P1"),
    p2p3Handling: P2P3HandlingConfig.default("fix-if-idle"),
    autonomousRemediation: z.boolean().default(false),
  })
  .strict();
export type AuditPostureConfig = z.infer<typeof AuditPostureConfig>;

// The balanced default (P0/P1 block + park for a human, residual fixed in place when
// idle) — the posture an absent project `auditPosture` resolves to.
export const DEFAULT_AUDIT_POSTURE: AuditPostureConfig = {
  blockReviewAt: "P1",
  p2p3Handling: "fix-if-idle",
  autonomousRemediation: false,
};

// The AUTONOMOUS / APEX posture: P0/P1 still block the current spec, but residual
// P2/P3 ROUTE to the DAG and a blocking finding becomes a REMEDIATION spec — so a
// scheduled-audit finding ALWAYS re-enters the DAG as fix-it work. The run preflight
// (`assertAuditPostureReentersFindings`) FAILS LOUD if an autonomous run uses a
// posture that would strand findings instead, so the proof can never silently no-op.
export const AUTONOMOUS_AUDIT_POSTURE: AuditPostureConfig = {
  blockReviewAt: "P1",
  p2p3Handling: "route-to-dag",
  autonomousRemediation: true,
};

// The DEFAULT posture an ABSENT project `auditPosture` resolves to — APEX-MODE-AWARE
// (Loop 3 self-config). An apex / autonomous run has NO operator to act on a parked
// finding, so a posture that strands findings would FAIL the audit-posture preflight
// (`assertAuditPostureReentersFindings`) and silently no-op the audit→fix→merge proof.
// Under apex mode a project that did NOT explicitly set a posture therefore resolves
// to the AUTONOMOUS posture (residual P2/P3 route to the DAG + a blocking finding
// becomes a remediation spec — the preflight PASSES and scheduled-audit findings
// re-enter the DAG). A NON-autonomous run keeps the conservative BALANCED default (a
// blocking finding parks for a human — the intended human-stop). This is a DEFAULT
// only: a project that PRESENTLY sets its own `auditPosture` always wins (no override).
export function resolveDefaultAuditPosture(): AuditPostureConfig {
  return isApexMode() ? AUTONOMOUS_AUDIT_POSTURE : DEFAULT_AUDIT_POSTURE;
}

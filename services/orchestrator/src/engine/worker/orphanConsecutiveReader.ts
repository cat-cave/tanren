// The orphan/crash path's consecutive-same-failure reader — extracted from `runFinalize.ts`
// (file-size cap) so the audit-C2-#1 discriminated-union read result + its helper live
// alongside the reader without inflating the finalize applier past 500 lines. The
// planner-path sibling (`workflow/redriveHistoryReader.ts`) mirrors this shape for the
// workflow re-drive path — see audit-C2-#3.

import type pg from "pg";
import type { ClassifiedRunFailure } from "./runFailureClassifier.js";
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "../workflow/convergenceDetector.js";
import { isNonStructuralRedriveSource, redriveFailureSignature } from "../workflow/redriveConvergenceSignature.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("run-finalize-orphan-reader");

/** The orphan reader's read outcome — a discriminated union that DISTINGUISHES a successful
 * read from a DB read FAILURE (audit C2 #1 — silent-fallback hardening). Before this fix
 * the reader's bare `catch { return 0 }` silently returned "no prior same-failure fixed
 * point", CONFLATING a genuinely-empty history with a broken read; under a repeated DB blip
 * a genuinely-stuck spec re-drove FOREVER (persistent-failure escalation silently disabled).
 * `ok` ⇒ proceed with the authority's disposition; `read_failed` ⇒ caller LOGS LOUDLY +
 * FORCES a RE-DRIVE for this tick (never a genuine-halt on unknown facts). */
export type OrphanConsecutiveReadResult = { kind: "ok"; consecutive: number } | { kind: "read_failed"; error: unknown };

/**
 * Read the fixed-point disposition for the orphan/crash path (this failure included), over
 * an already-org-scoped client, and route it through the SHARED `decideConvergence` judge —
 * NOT a raw `=== "fixed_point"` boolean (the disguised-K=2 the audit flagged). Returns the
 * authority's `priorSameFixedPoint`: 1 ⇒ a PROVEN dead-end ⇒ genuine-halt; 0 ⇒ progress ⇒
 * re-drive, UNBOUNDED. The crash/orphan signature is ENRICHED with the failure STAGE
 * (`code@stage`) so `internal@bootstrap` and `internal@run` are DIFFERENT failures
 * (progress), and a 2nd identical transient crash with no observable work is NOT an instant
 * fixed point (the cycle-aware detector requires a recurrence beyond the immediate
 * neighbor).
 *
 * READ FAILURE ≠ NO HISTORY (audit C2 #1): the reader NEVER throws — a DB read failure is
 * surfaced via the `read_failed` discriminant of {@link OrphanConsecutiveReadResult}. The
 * caller (`parkStrandedSpec*`) LOGS LOUDLY (via {@link resolveOrphanConsecutive}) and
 * forces a RE-DRIVE this tick, so a transient DB hiccup does NOT silently disable the
 * persistent-failure escalation.
 */
export async function readOrphanConsecutive(
  client: pg.PoolClient,
  specId: string,
  failure: ClassifiedRunFailure,
): Promise<OrphanConsecutiveReadResult> {
  try {
    const result = await client.query<{
      payload: { failureCode?: string; cause?: string; stage?: string; workSignature?: string; source?: string };
    }>(`SELECT payload FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.redriven' ORDER BY ts ASC, id ASC`, [
      specId,
    ]);
    // Audit finding D1 (mirrors `redriveHistoryReader.ts`'s prober-resume filter — finding
    // #13): `dag.spec.redriven` rows whose `payload.source === "prober_resume"` are the
    // window-pause prober's atomic spec flip from `in_flight` → `open`; they carry a
    // synthetic `failureCode: "usage_limit"` only because the spec pair-schema requires a
    // code for an `open` flip. Folding them into THIS convergence history defeats cycle
    // detection the same way the planner reader was vulnerable to. Filter them out at
    // assembly time so a paused-resumed spec whose runner crashes is still escalated when
    // the structural crashes repeat. `precondition_block` rows are excluded by the SAME
    // shared rule (see `workflow/redriveConvergenceSignature.ts`) — a run waiting on an
    // absent credential or an unreachable runner is not evidence of non-convergence, and
    // counting the wait would let it manufacture the very fixed point that parks the spec.
    //
    // The signature itself now prefers the FINE-GRAINED `cause` over the broad
    // `failureCode` (falling back to the code for rows written before `cause` existed), so
    // the orphan path stops aliasing categorically different crashes together exactly as
    // the planner path does. The stage qualifier is retained on top of it.
    const history: AttemptSignature[] = result.rows
      .filter((row) => !isNonStructuralRedriveSource(row.payload.source))
      .map((row) => ({
        failureSignature: orphanFailureSignature(redriveFailureSignature(row.payload), row.payload.stage),
        ...(row.payload.workSignature !== undefined && { workSignature: row.payload.workSignature }),
      }));
    history.push({ failureSignature: orphanFailureSignature(failure.cause ?? failure.code, failure.stage) });
    const decision = await decideConvergence(history, (h) =>
      fixedPointRuleJudgment(
        h,
        () =>
          `the run reached a FIXED POINT (${failure.code} @ ${failure.stage}) — it crashed the identical way ` +
          `with no new information across re-drives; the spec is genuinely stuck (a bug or mis-spec, not a flake)`,
      ),
    );
    return { kind: "ok", consecutive: decision.decision === "escalate" ? 1 : 0 };
  } catch (error) {
    // Audit C2 #1: NEVER silently return `0` — that conflates a broken read with a
    // genuinely-empty history and silently disables persistent-failure escalation.
    // Surface the failure so the caller (`parkStrandedSpec*`) can DEFER escalation
    // and log LOUDLY (see `resolveOrphanConsecutive`).
    return { kind: "read_failed", error };
  }
}

/** Narrow the orphan-consecutive read result to a plain `number` — a `read_failed` becomes
 * `0` with a LOUD `log.warn` so the caller can safely thread the value into
 * `decideOrphan`/`orphanRedrivenPayload` (audit C2 #1/#2). Extracted so both the remote and
 * in-process parkStranded* paths apply the SAME deferral policy without duplicating the log
 * surface. */
export function resolveOrphanConsecutive(
  result: OrphanConsecutiveReadResult,
  ids: { runId: string; specId: string; orgId?: string },
): number {
  if (result.kind === "ok") return result.consecutive;
  log.warn(
    "orphan-path convergence read failed — DEFERRING escalation this tick (forcing re-drive; retry on next tick)",
    { runId: ids.runId, specId: ids.specId, ...(ids.orgId !== undefined && { orgId: ids.orgId }) },
    result.error,
  );
  return 0;
}

/** The ENRICHED orphan/crash failure signature: the crash code QUALIFIED by the stage it
 * failed in, so the SAME code in a DIFFERENT stage reads as a different failure (progress). */
function orphanFailureSignature(code: string, stage: string | undefined): string {
  return stage === undefined || stage === "" ? code : `${code}@${stage}`;
}

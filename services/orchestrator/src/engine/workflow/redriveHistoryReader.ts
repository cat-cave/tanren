// THE Pg-backed re-drive convergence-facts reader. Split out of `plannerRunRedrive.ts`
// (file-size cap) so the applier file stays under 500 lines while the convergence-read
// logic grows independently (apex v67 #122 added the wandering-halt second signal). The
// reader returns BOTH verdicts (fixed-point streak + wandering-halt) in ONE org-scoped
// pass over the durable event log so the authority has the complete picture per call.
//
// READ FAILURE ≠ NO HISTORY (audit C2 #3 — silent-fallback hardening). Before this fix
// the reader's `catch` returned facts equivalent to "first attempt of its kind"
// (priorSameFixedPoint: 0, wandering: false), CONFLATING a genuinely-empty history with a
// broken read. Under a repeated DB blip a genuinely-stuck spec re-drove FOREVER because
// the persistent-failure + wandering-halt escalation branches were silently disabled.
//
// The fix: the reader surfaces the failure via a `read_failed` discriminant of
// {@link RedriveHistoryReadResult}. The caller (`readConvergenceFacts`) logs LOUDLY and
// applies an EXPLICIT deferral policy — force a RE-DRIVE this tick (never a genuine-halt
// on unknown facts), retry on the next tick. Fail-closed toward re-driving, never
// silently disable the escalation semantics.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { createLogger } from "../observability/logger.js";
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "./convergenceDetector.js";
import { isNonStructuralRedriveSource, redriveFailureSignature } from "./redriveConvergenceSignature.js";
import { assessWanderingHalt } from "./wanderingHaltDetector.js";
import type { RedriveHistoryReader } from "./plannerRunRedriveTypes.js";

const log = createLogger("run-redrive-reader");

/**
 * Build the Pg-backed {@link RedriveHistoryReader} the run worker wires. Issues TWO
 * org-scoped queries per call: the spec's `dag.spec.redriven` history (oldest → newest)
 * and the spec-level `github.pr.created` / `merge.completed` first-timestamps. Computes
 * both the fixed-point streak (PR #710 detector — same failure recurring) and the
 * wandering-halt verdict (apex v67 #122 — N re-drives with different failures but no
 * deliverable progress) from the SAME row set, with the audit-finding-#13 prober_resume
 * filter applied uniformly to both.
 */
export function buildRedriveHistoryReader(pool: pg.Pool): RedriveHistoryReader {
  return async (facts) => {
    try {
      return await runWithOrgScope(pool, facts.orgId, async (client) => {
        const redriveRows = await client.query<{
          payload: {
            failureCode?: string;
            cause?: string;
            stage?: string;
            workSignature?: string;
            source?: string;
          };
          ts: string;
        }>(
          `SELECT payload, ts FROM events
             WHERE spec_id = $1 AND event_type = 'dag.spec.redriven'
             ORDER BY ts ASC, id ASC`,
          [facts.specId],
        );
        // apex v67 #122 — read the spec-level PR / merge markers (their earliest timestamps,
        // so we can determine which re-drives in the history had them in place). ONE round-trip
        // covers both events; an absent event row yields a null timestamp.
        const progressRows = await client.query<{ event_type: string; first_ts: string | null }>(
          `SELECT event_type, MIN(ts) AS first_ts FROM events
             WHERE spec_id = $1 AND event_type IN ('github.pr.created', 'merge.completed')
             GROUP BY event_type`,
          [facts.specId],
        );
        const firstPrTs = progressRows.rows.find((r) => r.event_type === "github.pr.created")?.first_ts ?? null;
        const firstMergeTs = progressRows.rows.find((r) => r.event_type === "merge.completed")?.first_ts ?? null;
        // Audit finding #13: `dag.spec.redriven` rows whose `payload.source === "prober_resume"`
        // are the window-pause prober's atomic spec flip from `in_flight` → `open`; they carry
        // a synthetic `failureCode: "usage_limit"` only because the spec pair-schema requires
        // a code for an `open` flip. Folding them into the convergence history reads as "a new
        // state appeared between two structural re-drives" — exactly the `internal, usage_limit,
        // internal` sequence that defeats cycle detection. Filter them out at assembly time so
        // a genuinely stuck spec is escalated regardless of intervening pause/resume churn. The
        // SAME filter applies to the wandering-halt history assembly below for the same reason.
        //
        // `precondition_block` rows are excluded for the SAME reason and by the same rule:
        // they are a run WAITING on a named external condition (an unseeded credential, an
        // unreachable runner), re-driven on a cadence because the next attempt IS the probe.
        // A wait is not evidence of non-convergence — and if it were counted, waiting for a
        // credential would itself manufacture the fixed point that parks the spec, which is
        // exactly the live defect. Both exempt sources are listed in ONE set so the two
        // history readers cannot drift apart.
        const structuralRows = redriveRows.rows.filter((row) => !isNonStructuralRedriveSource(row.payload.source));
        // Assemble the oldest→newest attempt history (each prior re-drive's failure
        // signature + work signature) and append the CURRENT attempt, then route the
        // escalation decision through the shared convergence judge. 1 ⇒ a proven fixed point
        // (the authority escalates); 0 ⇒ progress (a changing failure / work, or a
        // not-yet-cyclic repeat).
        const history: AttemptSignature[] = structuralRows.map((row) => ({
          failureSignature: redriveFailureSignature(row.payload),
          ...(row.payload.workSignature !== undefined && { workSignature: row.payload.workSignature }),
        }));
        history.push({
          failureSignature: facts.cause ?? facts.code,
          ...(facts.workSignature !== undefined && { workSignature: facts.workSignature }),
        });
        // Route the escalation decision through the SHARED `decideConvergence` judge — NOT a raw
        // `=== "fixed_point"` boolean (the disguised-K=2 the audit flagged). There is no answerer
        // at the durable re-drive point (it is a bare DB-driven decision), so `fixedPointRuleJudgment`
        // is the principled stand-in: it escalates ONLY at a PROVEN dead-end (a byte-identical
        // reproduced head, or a cycle with no progress). `priorSameFixedPoint` = 1 when the judge
        // escalates, 0 while progressing — the authority escalates only when this is >= 1.
        const decision = await decideConvergence(history, (h) =>
          fixedPointRuleJudgment(
            h,
            () =>
              `the run reached a FIXED POINT (${facts.code}) — it produced the identical failure and ` +
              `identical work with no new information across re-drives; the spec is genuinely stuck`,
          ),
        );
        const priorSameFixedPoint = decision.decision === "escalate" ? 1 : 0;
        // apex v67 #122 — assemble the wandering-halt history (the same `dag.spec.redriven`
        // events with prober_resume filtered out, stage carried, and each re-drive's monotonic
        // PR/merge markers computed against the first-seen timestamps). The CURRENT attempt
        // rides the tail with the live progress markers.
        const wanderingHistory = structuralRows.map((row) => ({
          failureCode: row.payload.failureCode ?? "",
          stage: row.payload.stage ?? "",
          prCreatedSoFar: firstPrTs !== null && firstPrTs <= row.ts,
          mergeCompletedSoFar: firstMergeTs !== null && firstMergeTs <= row.ts,
        }));
        wanderingHistory.push({
          failureCode: facts.code,
          stage: facts.stage,
          prCreatedSoFar: firstPrTs !== null,
          mergeCompletedSoFar: firstMergeTs !== null,
        });
        const wandering = assessWanderingHalt(wanderingHistory);
        return { kind: "ok" as const, priorSameFixedPoint, wandering };
      });
    } catch (error) {
      // Audit C2 #3: NEVER silently return zero-history semantics on a read
      // failure — that conflates a broken read with a genuinely-empty history
      // and silently disables persistent-failure + wandering-halt escalation.
      // Surface the failure via the `read_failed` discriminant + log LOUDLY so
      // the caller can DEFER escalation this tick (retry on next tick) instead
      // of falsely reporting progress.
      log.warn(
        "convergence-facts read failed — surfacing read_failed sentinel " +
          "(persistent-failure + wandering-halt DEFERRED to next tick, NOT silently disabled)",
        { specId: facts.specId, orgId: facts.orgId },
        error,
      );
      return { kind: "read_failed", error };
    }
  };
}

export type {
  RedriveHistoryFacts,
  RedriveHistoryReader,
  RedriveConvergenceFacts,
  RedriveHistoryReadResult,
} from "./plannerRunRedriveTypes.js";

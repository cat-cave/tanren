// Re-read the LAND-TIME gate + review signals from the DURABLE event record
// (tanren-owns-the-engine.md §5) — the SINGLE source both land paths (the in-loop
// direct_merge AND the native_queue coordinator DRIVE) build the `MergeAuthority`
// bundle from. The bundle is built LAZILY inside `driveLand`/`landViaAuthority`, AFTER
// any conflict resolver ran (a resolver can take real time + RE-GATE), so reading the
// LATEST `pre_merge` `gate.verdict` + the latest review verdict HERE reflects the
// post-resolution state — never the pre-conflict values captured before `mergeForRun`.
//
// FAIL-CLOSED (§5): a NOT-FOUND / unreadable verdict resolves to `undefined`, which
// the authority's input mapping turns into its blocking enum (gate `unknown` / review
// `unread`). A stale/now-failing gate or a review that flipped to `changes_requested`
// during resolution therefore BLOCKS — neither path can authorize against stale state.
//
// The read is ORG-SCOPED (RLS) — the caller passes the org the run belongs to. The
// `gate.verdict` roll-up is the headSha-anchored native gate verdict
// (`workflow/gate/runGateForWhen.ts`); the review verdict is the latest
// `review.approved`/`review.auto_approved`/`review.changes_requested` event.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";

/** The fresh land-time signals, as the durable record reflects them right now. */
export interface LandTimeSignals {
  /** A synthesized passed `GateOutcome` for the latest passed `pre_merge` gate, else
   * `undefined` (a failed gate OR no recorded verdict) — which the authority blocks on. */
  gateOutcome: GateOutcome | undefined;
  /** The latest review verdict, or `undefined` (no recorded verdict) — which blocks. */
  reviewVerdict: ReviewVerdict | undefined;
}

/**
 * Re-read the LATEST `pre_merge` gate verdict + review verdict for a run, org-scoped,
 * at LAND TIME. ONLY a recorded PASSED gate clears (anything else — failed, or absent
 * — stays `undefined` → the authority's gate input is `unknown`, which BLOCKS). The
 * review verdict maps `approved`/`auto_approved` → `approved`, `changes_requested` →
 * `changes_requested`, absent → `undefined` (→ `unread`, BLOCKS). This is what makes a
 * conflict-resolved retry judge on FRESH state: a re-gate that now fails, or a review
 * that flipped to changes_requested during resolution, is reflected here.
 */
export async function resolveLandTimeSignals(pool: pg.Pool, orgId: string, runId: string): Promise<LandTimeSignals> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const gate = await client.query<{ payload: { passed?: boolean } }>(
      `SELECT payload FROM events
        WHERE run_id = $1 AND event_type = 'gate.verdict' AND payload->>'when' = 'pre_merge'
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    const gatePassed = gate.rows[0]?.payload?.passed;
    const review = await client.query<{ event_type: string }>(
      `SELECT event_type FROM events
        WHERE run_id = $1 AND event_type IN ('review.approved','review.auto_approved','review.changes_requested')
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    const reviewType = review.rows[0]?.event_type;
    const reviewVerdict: ReviewVerdict | undefined =
      reviewType === "review.approved" || reviewType === "review.auto_approved"
        ? "approved"
        : reviewType === "review.changes_requested"
          ? "changes_requested"
          : undefined;
    // Only a recorded PASSED pre_merge gate clears; anything else (failed / absent)
    // stays undefined → the authority blocks (gate `unknown`). The post-rebase re-gate
    // emits a fresh `pre_merge` gate.verdict, so the LATEST read reflects the re-gate.
    const gateOutcome: GateOutcome | undefined = gatePassed === true ? { passed: true, results: [] } : undefined;
    return { gateOutcome, reviewVerdict };
  });
}

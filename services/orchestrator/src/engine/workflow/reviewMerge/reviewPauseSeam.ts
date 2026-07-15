// Codex H3 #11 — human-review durable parked state. The two-arm seam that
// flips a run to the NEW non-terminal `paused` status (outcome
// `awaiting_review`) paired with the `run.paused` event carrying
// `reason: "awaiting_human_review"`. Mirrors the SHAPE of
// `plannerRunPauseSeam.ts` (task #82 window-pause auto-resume) — only the
// OUTCOME + REASON differ. The SPEC is intentionally untouched (no flip, no
// `dag.spec.*` event) — the walker reads it as still `in_flight` and does NOT
// enqueue a successor; the awaiting-review prober owns the resume once the
// operator's verdict lands.
//
// UNLIKE `finalizeGenuineHaltAtomic`, the pause path does NOT route through
// `applyFinalizeRunWithEvent` — that applier calls `PgEventStore.appendIfAbsent`
// which admits only TERMINAL run events (`run.completed`/`run.failed`/
// `run.cancelled`). `run.paused` is non-terminal (the run is still alive), so
// the seam issues the row UPDATE + the plain event append inside ONE
// org-scoped transaction. The `orgId` guard keeps `WHERE org_id = ...` scoping
// intact via `runWithOrgScope`.
//
// The prior polling loop in `reviewPolling.ts` (Codex H3 Surface 4 finding #11)
// blocked the worker thread indefinitely — a restart discarded the state and
// pinned a fresh worker on the same run. This seam is the durable park that
// releases the worker; the prober's atomic resume brings the successor run
// back through the walker for the ACTUAL verdict read.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { isPool, type QueryClient } from "../../data/orgScopedDb.js";
import type { AppendEventInput, EventStore } from "../../eventStore.js";
import { PgEventStore } from "../../eventStore.js";
import type { EventName, EventPayload } from "../../events/index.js";

/**
 * A slim pool shape — the tenant-scoped write client the seam runs SQL through
 * when neither the writer nor a real pg.Pool is wired (the legacy unit-test
 * split path). Matches `RunStateClient` / `QueryClient`.
 */
export type ReviewPauseSeamPool = QueryClient;

/** The seam input — everything `pollReviewForRun` already holds. */
export interface ReviewPauseSeamCtx {
  pool: ReviewPauseSeamPool;
  runId: string;
  orgId?: string;
  /**
   * Test-inject seam: when supplied, the pause's event append routes through
   * this store instead of the transactional `PgEventStore(client)` append.
   * Production omits it → the seam constructs a `PgEventStore(client)` that
   * shares the same in-transaction client as the row UPDATE (atomicity
   * intact). Tests pass a `FakeEventStore` so assertions on the emitted
   * `run.paused` event see it — the fake pool's SQL handler doesn't recognize
   * the raw `INSERT INTO events` shape, so the pass-through avoids a silent
   * drop.
   */
  eventStore?: EventStore;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
}

/** The `runs.status='running' | 'queued' → 'paused'` UPDATE + non-terminal
 * event append inside ONE tenant-scoped client. Idempotent under the
 * `fromStatuses` guard: a retry against a run already `paused` moves no row +
 * skips the event append. When the caller wired an `eventStore` seam (tests),
 * the append routes through it; production uses a `PgEventStore(client)` so
 * the append shares the row UPDATE's transaction (atomicity). */
async function applyPauseRunForReview(
  client: pg.Pool | pg.PoolClient,
  runId: string,
  event: AppendEventInput,
  eventStore: EventStore | undefined,
): Promise<void> {
  const updated = await client.query(
    `UPDATE runs SET status = 'paused', outcome = 'awaiting_review', ended_at = now()
       WHERE run_id = $1 AND status = ANY($2::text[])`,
    [runId, ["running", "queued"]],
  );
  if ((updated.rowCount ?? 0) === 0) {
    // Already paused (or terminal) — the pause happened on a prior tick; the
    // walker's successor will re-drive off the same durable state.
    return;
  }
  const store = eventStore ?? new PgEventStore(client);
  await store.append(event);
}

/**
 * Two-arm dispatch: orgId → in-process direct atomic via `runWithOrgScope`'s
 * BEGIN/COMMIT around the row UPDATE + event append; no orgId → unit-test
 * legacy split (bare pool query + append). NEVER routes through
 * `RunStateWriter.finalizeRunWithEvent` — that applier's `appendIfAbsent` only
 * accepts terminal `run.*` events (`run.completed`/`run.failed`/
 * `run.cancelled`), and `run.paused` is non-terminal (the run is still alive).
 */
export async function finalizePauseForReviewAtomic(ctx: ReviewPauseSeamCtx, event: AppendEventInput): Promise<void> {
  const { pool, runId, orgId, appendEvent, eventStore } = ctx;
  if (orgId !== undefined && isPool(pool)) {
    await runWithOrgScope(pool, orgId, async (client) => {
      await applyPauseRunForReview(client, runId, event, eventStore);
    });
    return;
  }
  // Unit-test legacy split (no orgId): raw SQL UPDATE + append.
  await pool.query(
    "UPDATE runs SET status = 'paused', outcome = 'awaiting_review', ended_at = now() WHERE run_id = $1",
    [runId],
  );
  await appendEvent(event.eventType, event.payload, event.taskId);
}

// Task #48 (run/spec atomicity sweep) — the ATOMIC TERMINAL RUN finalize +
// matching `run.*` event applier, AND the ATOMIC spec-status flip +
// matching `dag.spec.*` event applier. Split from `runStateLifecycleSql.ts`
// to keep that file under the 500-line architecture cap; both appliers
// share the same `TaskLifecycleClient` (a pg-pool/PoolClient `.query` shape)
// so the row UPDATE + the event INSERT share the SAME caller-supplied
// in-transaction client and COMMIT atomically.
//
// The RUN-LEVEL applier is the mirror of `applyUpdateTaskWithEvent` (task #39):
// row UPDATE first (guarded `WHERE status = ANY(...)` for exactly-once) → on
// a row moved, append the terminal event via `PgEventStore.appendIfAbsent`
// (the partial unique index `events_run_terminal_unique` dedupes a
// dropped-HTTP-response retry). When no row moved, return `{ updated: false }`
// and skip the event. The UPDATE's RETURNING surfaces the spec_id /
// project_id so callers (Site C/D in `runFinalize.ts`) that don't know them
// ahead of the finalize can defer to the row.
//
// The SPEC-LEVEL applier admits NON-TERMINAL events (`dag.spec.redriven`
// recurs per attempt; `dag.spec.needs_attention` re-fires per incident —
// Plan §3), so there is NO partial unique index + no `appendIfAbsent`
// dedupe; the seam uses plain `.append`. The `flipped` outcome tells the
// caller whether the guarded UPDATE moved a row so a no-op flip suppresses
// the event emit (the strand-reconciler guard against a concurrent settle).

import type pg from "pg";
import { z } from "zod";
import type {
  FinalizeRunWithEventInput,
  FinalizeRunWithEventOutcome,
  UpdateSpecWithEventInput,
  UpdateSpecWithEventOutcome,
} from "../contracts/runStateAtomicSeam.js";
import { PgEventStore } from "../eventStore.js";
import { scalarTextOr } from "../data/scalarText.js";

/** Anything that can run a parameterized query — pool or checked-out client. */
type TaskLifecycleClient = Pick<pg.Pool | pg.PoolClient, "query">;

// --- ATOMIC TERMINAL RUN + EVENT applier (task #48) --------------------------

/** Terminal `runs.outcome` values the atomic seam admits (byte-identical to
 * the existing finalize writes: worker `halted`, workflow
 * `halted`/`window_exhausted`/`convergence_stalled`, genuine-halt `failed`,
 * merge-pass `ok`, operator cancel `cancelled`). */
const TERMINAL_RUN_OUTCOMES = [
  "halted",
  "window_exhausted",
  "convergence_stalled",
  "failed",
  "ok",
  "cancelled",
] as const;
type TerminalRunOutcome = (typeof TERMINAL_RUN_OUTCOMES)[number];

/** Terminal `run.*` events covered by `events_run_terminal_unique`. */
const TERMINAL_RUN_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;
type TerminalRunEventType = (typeof TERMINAL_RUN_EVENT_TYPES)[number];

/** Map a terminal run outcome to the matching event type. */
function expectedRunEventTypeFor(outcome: TerminalRunOutcome): TerminalRunEventType {
  if (outcome === "ok") return "run.completed";
  if (outcome === "cancelled") return "run.cancelled";
  return "run.failed";
}

/**
 * ATOMIC terminal run-finalize + terminal `run.*` event applier (task #48 —
 * the RUN-LEVEL mirror of `applyUpdateTaskWithEvent`). The pairing constraint
 * is enforced by `runPairSchema`; the event INSERT routes through
 * `appendIfAbsent` so a dropped-HTTP-response retry returns
 * `alreadyTerminal: true` instead of contradicting the timeline.
 */
export async function applyFinalizeRunWithEvent(
  client: TaskLifecycleClient,
  input: FinalizeRunWithEventInput,
): Promise<FinalizeRunWithEventOutcome> {
  // Row UPDATE first, with the `fromStatuses` guard (exactly-once). Shape is
  // byte-identical to `DirectRunStateWriter.finalizeRun`.
  const updated = await client.query(
    `UPDATE runs SET status = $2, outcome = $3, ended_at = now()
       WHERE run_id = $1 AND status = ANY($4::text[])
       RETURNING spec_id, project_id`,
    [input.finalize.runId, input.finalize.status, input.finalize.outcome, input.finalize.fromStatuses],
  );
  const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
  if (row === undefined) {
    // No row moved (already terminal / not in `fromStatuses`). Event suppressed.
    return { updated: false, alreadyTerminal: false };
  }
  const rowSpecId = scalarTextOr(row.spec_id, "");
  const rowProjectId = scalarTextOr(row.project_id, "");
  // SOURCE event.specId/projectId from the row when the caller passed empty
  // strings (worker failure-path defers to the row).
  const eventSpecId = input.event.specId === undefined || input.event.specId === "" ? rowSpecId : input.event.specId;
  const eventProjectId =
    input.event.projectId === undefined || input.event.projectId === "" ? rowProjectId : input.event.projectId;
  const inserted = await new PgEventStore(client).appendIfAbsent({
    ...input.event,
    specId: eventSpecId,
    projectId: eventProjectId,
  });
  return { updated: true, alreadyTerminal: !inserted, specId: rowSpecId, projectId: rowProjectId };
}

/** Zod refinement for {@link FinalizeRunWithEventInput}: only terminal run
 * outcomes + matching terminal event types pass; a misuse is rejected at the
 * seam before any DB I/O. */
export const runPairSchema = z
  .object({
    finalize: z
      .object({
        runId: z.string().min(1),
        orgId: z.string().min(1),
        status: z.string().min(1),
        outcome: z.enum(TERMINAL_RUN_OUTCOMES),
        fromStatuses: z.array(z.string().min(1)),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        // specId / projectId may be empty (Site C/D deferral to RETURNING).
        specId: z.string().optional(),
        projectId: z.string(),
        eventType: z.enum(TERMINAL_RUN_EVENT_TYPES),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict()
  .refine((value) => expectedRunEventTypeFor(value.finalize.outcome) === value.event.eventType, {
    error:
      "run-pair mismatch: outcome must pair with the matching run event type (ok → run.completed; cancelled → run.cancelled; halted/window_exhausted/convergence_stalled/failed → run.failed)",
    path: ["event", "eventType"],
  });

// --- ATOMIC SPEC-STATUS + EVENT applier (task #48) ---------------------------

/** Spec-status transitions the atomic seam admits. */
const SPEC_STATUS_TRANSITIONS = ["open", "in_flight", "review", "needs_attention", "merged"] as const;
type SpecStatusTransition = (typeof SPEC_STATUS_TRANSITIONS)[number];

/** Spec-disposition events the atomic seam admits. */
const SPEC_DISPOSITION_EVENT_TYPES = ["dag.spec.redriven", "dag.spec.needs_attention"] as const;
type SpecDispositionEventType = (typeof SPEC_DISPOSITION_EVENT_TYPES)[number];

/** Map a spec-status transition to the matching event type. `open` →
 * `dag.spec.redriven` (re-drive); `needs_attention` → `dag.spec.needs_attention`
 * (genuine-halt park). Other transitions don't pair with a recurring/escalation
 * event and are rejected at the schema. */
function expectedSpecEventTypeFor(status: SpecStatusTransition): SpecDispositionEventType | undefined {
  if (status === "open") return "dag.spec.redriven";
  if (status === "needs_attention") return "dag.spec.needs_attention";
  return undefined;
}

/**
 * ATOMIC spec-status flip + spec-disposition event applier (task #48). Reuses
 * `applySetSpecStatus`'s row-UPDATE shape (the guarded `notFromStatuses` variant
 * when set) with `RETURNING spec_id`, then on a row moved appends the event via
 * `PgEventStore.append` (NOT `appendIfAbsent` — the spec-side events recur).
 * A no-row-moved outcome suppresses the event (the strand-reconciler guard).
 */
export async function applyUpdateSpecWithEvent(
  client: TaskLifecycleClient,
  input: UpdateSpecWithEventInput,
): Promise<UpdateSpecWithEventOutcome> {
  let updated: { rowCount?: number | null };
  if (input.spec.notFromStatuses !== undefined && input.spec.notFromStatuses.length > 0) {
    updated = await client.query(
      "UPDATE specs SET status = $2 WHERE spec_id = $1 AND status <> ALL($3::text[]) RETURNING spec_id",
      [input.spec.specId, input.spec.status, input.spec.notFromStatuses],
    );
  } else {
    updated = await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1 RETURNING spec_id", [
      input.spec.specId,
      input.spec.status,
    ]);
  }
  if ((updated.rowCount ?? 0) === 0) {
    return { flipped: false, alreadyTerminal: false };
  }
  await new PgEventStore(client).append(input.event);
  return { flipped: true, alreadyTerminal: false };
}

/** Zod refinement for {@link UpdateSpecWithEventInput}: only paired
 * spec-status transitions (`open` ↔ `dag.spec.redriven`, `needs_attention` ↔
 * `dag.spec.needs_attention`) pass; a misuse is rejected at the seam before
 * any DB I/O. */
export const specPairSchema = z
  .object({
    spec: z
      .object({
        specId: z.string().min(1),
        orgId: z.string().min(1),
        status: z.enum(SPEC_STATUS_TRANSITIONS),
        notFromStatuses: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().min(1).optional(),
        projectId: z.string().min(1),
        eventType: z.enum(SPEC_DISPOSITION_EVENT_TYPES),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict()
  .refine((value) => expectedSpecEventTypeFor(value.spec.status) === value.event.eventType, {
    error:
      "spec-pair mismatch: status must pair with the matching spec-disposition event type (open → dag.spec.redriven; needs_attention → dag.spec.needs_attention)",
    path: ["event", "eventType"],
  });

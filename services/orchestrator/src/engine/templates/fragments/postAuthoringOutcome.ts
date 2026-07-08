// POST-AUTHORING BATCH-OUTCOME HANDLER (docs/roadmap/templating-system.md — F2
// Round-III restructure).
//
// The sequential per-spec authoring loop in `buildFragmentAuthoring` produces
// a list of AUTHORED-BUT-NOT-YET-COMMITTED fragments (each authored + validated
// + persisted-as-validated by `authorOneFragment`). Before we EMIT
// `fragment.authoring.succeeded` for any of them, we run the
// `runPostAuthoringBatchCompose` gate — a final cross-fragment compose against
// the captured runtime + the augmented library. Only if THAT passes are the
// authored fragments actually "successful". If it fails (or skips), we must
// retract each authored row from the persistence store AND emit `failed` with
// the REAL per-fragment attempt count.
//
// WHY THIS LIVES IN ITS OWN FILE. Round-III restructure:
//   H1 — retract-with-delete (was: bare event emit, row survived)
//   H4 — no more succeeded-then-failed for the same id (was: emit succeeded
//        inside authorOneFragment then failed here)
//   H7 — the failed event carries the real per-fragment attempts count (was:
//        hardcoded `attempts: 1`)
//   M6 — the `skipped` arm is EXPLICITLY handled as a failure (was: fell
//        through silently)
//
// Extracting the handler keeps `fragmentAuthoringRun.ts` under the 500-line
// architecture cap while making the batch-vs-emit-vs-retract flow readable in
// isolation. `buildFragmentAuthoring` calls this ONCE at the end of the loop.

import { runPostAuthoringBatchCompose, type BatchComposeResult } from "./batchComposeAfterAuthoring.js";
import type { FragmentAuthoringEvents, FragmentPersistence } from "./fragmentAuthoringRun.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import type { OrgFragmentSource } from "./unifiedLibrary.js";
import type { FragmentLibrary } from "./types.js";
import type { CaptureLifecycle } from "../../forge/interview/types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("fragment-authoring-outcome");

/** One authored-but-not-yet-committed fragment carried through the batch gate.
 *
 * Fields:
 *   - `spec`: the input FragmentSpec — used for failedIds/failureReasons.
 *   - `source`: the OrgFragmentSource used to (re-)assemble the library.
 *   - `attempts`: the REAL per-fragment attempt count (Round-III H7 fix — the
 *     retract-emit no longer hardcodes `attempts: 1`).
 *   - `persistedFragmentId`: the id `FragmentPersistence.createValidated`
 *     returned — used to `deleteById(persistedFragmentId)` on a batch retract
 *     (Round-III H1 fix). */
export interface AuthoredForBatch {
  readonly spec: FragmentSpec;
  readonly source: OrgFragmentSource;
  readonly attempts: number;
  readonly persistedFragmentId: string;
}

/** Aggregated result the caller merges back into the run-level failedIds /
 * failureReasons accumulators. Kept explicit rather than mutating a passed-in
 * accumulator so the flow is easier to read. */
export interface PostAuthoringOutcome {
  readonly retractedIds: readonly string[];
  readonly retractedReasons: Readonly<Record<string, string>>;
}

const EMPTY_OUTCOME: PostAuthoringOutcome = Object.freeze({
  retractedIds: Object.freeze([]) as readonly string[],
  retractedReasons: Object.freeze({}) as Readonly<Record<string, string>>,
});

/** Run the post-authoring batch compose + drive the emit/retract handling.
 *
 * INVARIANTS (Round-III restructure):
 *   - EVERY `authored` entry ends up with EITHER a `succeeded` event OR a
 *     `failed` event — never both, never neither.
 *   - On batch `ok`: emit `succeeded(id, attempts)` per authored — the rows
 *     stay committed.
 *   - On batch `failed`: DELETE each persisted row (H1) + emit
 *     `failed(id, batchReason, attempts)` — the retract makes the failed emit
 *     truthful (attempts is the real per-fragment count, H7).
 *   - On batch `skipped`: SAME as `failed` — no silent commit (M6).
 *   - Emit + delete failures do NOT throw upward. Emit failures log-warn
 *     (M2 — the DB-down case no longer propagates); delete failures log-warn
 *     (the row may be stuck but the observability contract still holds). */
export async function drivePostAuthoringOutcome(args: {
  orgId: string;
  lifecycle: CaptureLifecycle;
  library: FragmentLibrary;
  authored: readonly AuthoredForBatch[];
  persistence: FragmentPersistence;
  events: FragmentAuthoringEvents;
}): Promise<PostAuthoringOutcome> {
  const { orgId, lifecycle, library, authored, persistence, events } = args;
  if (authored.length === 0) return EMPTY_OUTCOME;

  const batch: BatchComposeResult = await runPostAuthoringBatchCompose({
    lifecycle,
    library,
    authoredSpecIds: authored.map((a) => a.spec.id),
  });

  switch (batch.kind) {
    case "ok": {
      for (const item of authored) {
        await safeEmit(events, {
          kind: "fragment.authoring.succeeded",
          orgId,
          fragmentId: item.spec.id,
          attempts: item.attempts,
        });
      }
      return EMPTY_OUTCOME;
    }
    case "failed": {
      return retractAndEmitFailed(orgId, authored, batch.reason, persistence, events);
    }
    case "skipped": {
      // M6 — no silent commit. A `skipped` result from `runPostAuthoringBatchCompose`
      // (today: only on `UnresolvableLifecycleError`) means we could not confirm the
      // augmented library composes against the captured stack. Rather than commit +
      // hope, we treat it the same as a failed gate: retract every authored row and
      // emit `failed` so the operator sees the halt loud.
      const skipReason = `batch_compose_skipped: ${batch.reason}`;
      log.warn("post-authoring batch compose skipped — treating as failure (M6 — no-silent-branch doctrine)", {
        orgId,
        reason: batch.reason,
        authoredIds: authored.map((a) => a.spec.id),
      });
      return retractAndEmitFailed(orgId, authored, skipReason, persistence, events);
    }
    default: {
      // Exhaustiveness — if `BatchComposeResult` ever gains a new arm this
      // fails typecheck instead of silently falling through.
      const exhaustive: never = batch;
      throw new Error(`unhandled batch compose result: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function retractAndEmitFailed(
  orgId: string,
  authored: readonly AuthoredForBatch[],
  reason: string,
  persistence: FragmentPersistence,
  events: FragmentAuthoringEvents,
): Promise<PostAuthoringOutcome> {
  const retractedIds: string[] = [];
  const retractedReasons: Record<string, string> = {};
  for (const item of authored) {
    // Retract the persisted row (H1). A delete failure is log-warn'd — the row
    // may be stuck but the observability contract still holds; the next authoring
    // run's `createValidated` will collide on the unique index, surface as a
    // `persistence_failed:` reason, and the operator sees the real cause.
    try {
      await persistence.deleteById(item.persistedFragmentId);
    } catch (err) {
      log.warn("retract deleteById threw — persisted row may be stuck; continuing", {
        orgId,
        fragmentId: item.spec.id,
        persistedFragmentId: item.persistedFragmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    retractedIds.push(item.spec.id);
    retractedReasons[item.spec.id] = reason;
    await safeEmit(events, {
      kind: "fragment.authoring.failed",
      orgId,
      fragmentId: item.spec.id,
      reason,
      attempts: item.attempts,
    });
  }
  return { retractedIds, retractedReasons };
}

/** Emit an event, swallowing (log-warn) any throw. Round-III M2 fix — a DB-down
 * `deps.events.emit` (which writes to the same pool as persistence) used to
 * propagate upward and defeat Fix-4's stated "do not throw upward — continue
 * authoring remaining specs" contract. Wrapped here so every emit call site in
 * the outcome handler is emit-throw-safe. */
async function safeEmit(
  events: FragmentAuthoringEvents,
  event: Parameters<FragmentAuthoringEvents["emit"]>[0],
): Promise<void> {
  try {
    await events.emit(event);
  } catch (err) {
    log.warn("fragment authoring event emit failed — swallowing (Round-III M2)", {
      kind: event.kind,
      orgId: "orgId" in event ? event.orgId : undefined,
      fragmentId: "fragmentId" in event ? event.fragmentId : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Wrap a `FragmentAuthoringEvents` seam so every `emit` call is throw-safe
 * (Round-III M2). Used by `buildFragmentAuthoring` at construction to make emit
 * safety a property of the whole runner (the per-spec `authorOneFragment` loop
 * emits many events; wrapping once is cleaner than per-call try/catch). */
export function wrapEventsWithLogging(events: FragmentAuthoringEvents): FragmentAuthoringEvents {
  return {
    async emit(event) {
      await safeEmit(events, event);
    },
  };
}

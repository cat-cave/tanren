// SHARED stage-throw classifier for the per-stage `task.failed` emit-on-throw
// (timeout-eradication.md §1 disguised-survivor family — apex v51 finding).
//
// Every stage in the subtask loop (planner, writer, checker, auditor, triage,
// convergence, demo-run, design-oracle) wraps its answerer/writer call in a
// try/catch that emits a TERMINAL `task.failed` event against the stage's
// `task_id` BEFORE re-throwing into the workflow's run-level catch
// (`plannerRun.ts`'s `finalizeWorkflowThrow`). The run/spec/runner events
// already ride loud at the RUN granularity; without this emit the per-task
// row stays `running` forever with no `task.failed` event — loud at one
// granularity, silent at another (the #640 family).
//
// `classifyStageFailureKind` maps the caught error CLASS into the closed
// `task.failed.failureKind` vocabulary the writer-stage already uses
// (`window_exhausted` / `timeout` / `crashed`), plus the auditor's
// `answerer_schema_invalid` for a parse miss. An unrecognized error falls
// CLOSED to `crashed` (the writer-stage's existing default).

import { MalformedAncestorStackError } from "../dag/ancestorStack.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { AnswererSchemaValidationError, AnswererStalledError } from "../providers/answererSchemaError.js";
import { CodexUsageLimitError } from "../providers/codex.js";
import { ClaudeUsageLimitError } from "../providers/claude.js";
import { DesignContractCorruptError } from "../repositories/designContracts.js";
import { DesignOracleActorConfigError, MalformedDesignOracleResultError } from "./designOracle/designOracle.js";
import { StageStallEscalationError } from "./loopStageRecovery.js";
import { PersistentlyInvalidSpecError } from "../forge/specQuality/index.js";
import { markTaskFailedIfRunningWithEvent, type TerminalTaskEventEnvelope } from "./subtaskTasks.js";

/** The closed vocabulary the per-stage `task.failed.failureKind` carries. */
export type StageFailureKind =
  | "window_exhausted"
  | "timeout"
  | "answerer_schema_invalid"
  | "cost_record_failed"
  | "event_append_failed"
  // Data-corruption family: a persisted JSONB payload failed its schema parse
  // and the resolver threw fail-closed rather than silently degrading. Distinct
  // from `crashed` so the operator sees WHAT was corrupt on the timeline (task
  // #21-style disguised-survivor prevention). See `MalformedAncestorStackError`
  // (runs.ancestor_stack), `DesignContractCorruptError` (design_contracts row).
  | "malformed_ancestor_stack"
  | "design_contract_corrupt"
  // Design-oracle stage families (PR #745). Actor-config faults (a null-org
  // actor) throw BEFORE any store read; malformed oracle results (a
  // `hasContract:true` answer missing required timeline-observable fields)
  // throw AFTER the answerer returns. Both were opaque-`crashed` before — the
  // typed arms preserve the diagnosis on `task.failed.failureKind`.
  | "design_oracle_actor_config"
  | "malformed_design_oracle_result"
  // A spec (typically a triage-proposed new spec) the spec-quality gate could not
  // make valid within its convergence budget. Under autonomy:auto the triage stage
  // now DROPS + PARKS such a proposal rather than throwing (loopFindings
  // `gateTriagedSpecs`), so this arm should NOT fire on that path — it is the
  // defense-in-depth surface for a genuinely-unfixable spec that reaches a stage
  // guard by another route (a BUILD-spec re-author dead-end), so the operator sees a
  // SPECIFIC needs_attention class instead of opaque `crashed`.
  | "spec_persistently_invalid"
  | "crashed";

/**
 * The cost-recorder THROW wrapper (task #35 — critic-arc R1 #6 / R2). When
 * `recordWriterCost` / `recordAnswererCost` re-throws an error surfacing from the
 * underlying `CostRecorder.record(...)` INSERT (DB transport / RLS / schema), the
 * subtaskCost helpers RE-RAISE it as this typed wrapper class so the finalize
 * guard's classifier maps it deterministically to `failureKind: "cost_record_failed"`
 * — rather than landing in the fail-closed `crashed` default that swallows the
 * mid-stage cost-recorder family in the autonomous tier.
 */
export class CostRecordError extends Error {
  override readonly cause?: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "cost record write failed");
    this.name = "CostRecordError";
    this.cause = cause;
  }
}

/**
 * The event-append THROW wrapper (task #35 — critic-arc R1 #6 / R2). When the
 * finalize guard catches an unclassified throw from a stage's PRE-TERMINAL event
 * append (e.g. `checker.verdict`, `writer.subtask.completed`), it would otherwise
 * be classified as `crashed`. Stages that wrap their pre-terminal appends in
 * `wrapEventAppend` re-throw as this wrapper so the guard surfaces
 * `failureKind: "event_append_failed"` — distinct + searchable on the timeline.
 */
export class EventAppendError extends Error {
  override readonly cause?: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "event append failed");
    this.name = "EventAppendError";
    this.cause = cause;
  }
}

/**
 * Classify a caught stage error into the `task.failed.failureKind` vocabulary
 * the writer-stage's existing branches already use. Keys off the error CLASS
 * (`instanceof`), NEVER the error message — a novel secret shape in the message
 * can never widen what's published on the timeline. An unrecognized error falls
 * CLOSED to `crashed`.
 *
 * - `CodexUsageLimitError` / `ClaudeUsageLimitError` → `window_exhausted`
 *   (the §4.3 authenticated-but-out-of-quota window pressure)
 * - `AnswererStalledError` / `StageStallEscalationError` → `timeout`
 *   (a transient or proven-wedged sign-of-life stall)
 * - `AnswererSchemaValidationError` → `answerer_schema_invalid`
 *   (mirrors the auditor's `auditor_schema_invalid` naming)
 * - `CostRecordError` → `cost_record_failed`
 *   (task #35 — the recorder's DB INSERT failed mid-stage; without this it
 *   would land as `crashed` and the row would strand `running`)
 * - `EventAppendError` → `event_append_failed`
 *   (task #35 — a pre-terminal event append failed mid-stage)
 * - `MalformedAncestorStackError` → `malformed_ancestor_stack`
 *   (PR #740 — the `runs.ancestor_stack` jsonb failed its schema parse; the
 *   resolver fails closed rather than silently downgrading a speculative run to
 *   non-speculative and merging it against the wrong base. Preserves the typed
 *   diagnosis so `task.failed` carries WHAT was corrupt, not `crashed`.)
 * - `DesignContractCorruptError` → `design_contract_corrupt`
 *   (PR #740 — the `design_contracts` row failed `parseDesignContract`;
 *   distinct from ABSENT so a caller can tell "no design phase yet" apart from
 *   "the persisted contract is malformed and must not be used".)
 * - `DesignOracleActorConfigError` → `design_oracle_actor_config`
 *   (PR #745 — the design oracle was invoked with a null-org actor that cannot
 *   enumerate behaviors; thrown BEFORE any store read so the finalize guard
 *   emits a specific class rather than aliasing under `crashed`.)
 * - `MalformedDesignOracleResultError` → `malformed_design_oracle_result`
 *   (PR #745 — the oracle answerer returned `hasContract:true` but a required
 *   field was missing/empty; distinct from the silent-fallback shape that
 *   coerced these to `0`/`""` and hid the regression on the timeline.)
 * - `PersistentlyInvalidSpecError` → `spec_persistently_invalid`
 *   (defense-in-depth: a spec the spec-quality gate could not make valid at a genuine
 *   fixed point. The triage stage now degrades gracefully for a triage-PROPOSED spec
 *   — dropped + parked, never thrown — so this should not fire there; the arm keeps a
 *   genuinely-unfixable spec reaching a stage guard by another route SPECIFIC instead
 *   of opaque `crashed`.)
 * - default → `crashed` (the writer-stage's existing default for an unclassified throw)
 */
export function classifyStageFailureKind(error: unknown): StageFailureKind {
  if (error instanceof CodexUsageLimitError || error instanceof ClaudeUsageLimitError) {
    return "window_exhausted";
  }
  if (error instanceof AnswererStalledError || error instanceof StageStallEscalationError) {
    return "timeout";
  }
  if (error instanceof AnswererSchemaValidationError) {
    return "answerer_schema_invalid";
  }
  if (error instanceof CostRecordError) {
    return "cost_record_failed";
  }
  if (error instanceof EventAppendError) {
    return "event_append_failed";
  }
  if (error instanceof MalformedAncestorStackError) {
    return "malformed_ancestor_stack";
  }
  if (error instanceof DesignContractCorruptError) {
    return "design_contract_corrupt";
  }
  if (error instanceof DesignOracleActorConfigError) {
    return "design_oracle_actor_config";
  }
  if (error instanceof MalformedDesignOracleResultError) {
    return "malformed_design_oracle_result";
  }
  if (error instanceof PersistentlyInvalidSpecError) {
    return "spec_persistently_invalid";
  }
  return "crashed";
}

/**
 * Safe message extraction for the `task.failed.message` payload field. Always
 * returns a non-empty string — an unknown / non-Error throw yields a fixed
 * fallback so the payload is well-formed even on a pathological throw.
 */
export function stageFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "stage threw a non-Error / empty-message failure";
}

/**
 * The WIDER finalize guard (task #35 — critic-arc R1 #6 / R2). Wraps the WHOLE
 * post-insert stage body — provider call + cost record + terminal row update + the
 * terminal `task.*` event — so a throw ANYWHERE in that chain closes the task row
 * loud + emits exactly one `task.failed` event. The PR #665 apex v51 helper
 * `runStageWithEmitOnThrow` only covered the provider body; a recorder throw
 * mid-stage still stranded the row in `status='running'` forever with no
 * `task.failed` event. This helper SUPERSEDES the v51 wrapper and is now the
 * sole call site for the per-stage finalize-on-throw contract. The classifier
 * distinguishes the new mid-stage failure shapes:
 *
 *   - `CostRecordError` → `failureKind: "cost_record_failed"` (the recorder's
 *     DB INSERT failed AFTER a successful provider call)
 *   - `EventAppendError` → `failureKind: "event_append_failed"` (a pre-terminal
 *     event append failed)
 *
 * IDEMPOTENCY (the single-finalize invariant — `autonomy-engine.md` §1c): the row
 * UPDATE is `markTaskFailedIfRunningWithEvent`, a guarded `WHERE status='running'`
 * paired with the `task.failed` event in ONE org-scoped transaction (task #39 —
 * the atomic terminal-pair seam). A clean branch that already moved the row to
 * `done` (via `markTaskDoneWithEvent`) cannot be partially terminal anymore: the
 * row + the `task.completed` event committed together, so the guard's catch on
 * a subsequent throw sees a fully-terminal row, the guarded UPDATE is a no-op,
 * and the `task.failed` event lands as the loud signal (the timeline carries
 * the outage even when the row was already terminal). The prior split that
 * could strand the row terminal-`done` with no `task.completed` is gone.
 */
export async function runStageBodyWithFinalizeGuard<T>(opts: {
  /**
   * REQUIRED (audit finding H3 sweep — no fallback arm). The guarded row
   * UPDATE + the `task.failed` event commit in ONE org-scoped transaction
   * through `writer.updateTaskWithEvent`; there is no longer an
   * appendEvent-only test fallback that defeated the atomic seam.
   */
  writer: RunStateWriter;
  taskId: string;
  taskKind: string;
  // Lineage for the ATOMIC terminal-row + `task.failed` pair (task #39): the
  // event's tenant key (orgId) + project/run/spec ids ride together on the
  // envelope so adding new fields to the atomic terminal pair only touches ONE
  // place. v68 fix: orgId is now required — the prior derive-from-project
  // subquery dropped NULLs into events.org_id and tripped RLS (see
  // {@link AppendEventInput.orgId}).
  eventLineage: { runId: string; specId: string; projectId: string; orgId: string };
  body: () => Promise<T>;
}): Promise<T> {
  try {
    return await opts.body();
  } catch (error) {
    const failureKind = classifyStageFailureKind(error);
    const envelope: TerminalTaskEventEnvelope = {
      runId: opts.eventLineage.runId,
      specId: opts.eventLineage.specId,
      projectId: opts.eventLineage.projectId,
      orgId: opts.eventLineage.orgId,
      taskKind: opts.taskKind,
    };
    // ATOMIC terminal-row + terminal-event pair (task #39): the
    // markTaskFailedIfRunning UPDATE + the `task.failed` event INSERT ride ONE
    // org-scoped transaction so the loud `task.failed` lands iff the row does.
    // The guard's IDEMPOTENCY contract is unchanged — the `WHERE status='running'`
    // on the row UPDATE leaves an already-`done` row alone (the `task.failed`
    // event still lands EVERY time as the loud signal — that semantics is
    // preserved here because the event INSERT runs unconditionally after the
    // guarded UPDATE on the SAME transaction).
    await markTaskFailedIfRunningWithEvent({
      writer: opts.writer,
      taskId: opts.taskId,
      envelope,
      failureKind,
      message: stageFailureMessage(error),
    });
    throw error;
  }
}

/**
 * Wrap a pre-terminal event-append in `EventAppendError` so a throw lands as the
 * deterministic `failureKind: "event_append_failed"` rather than the fail-closed
 * `crashed` default. Use INSIDE a `runStageBodyWithFinalizeGuard` body for any
 * pre-terminal append (e.g. `checker.verdict`, `writer.subtask.completed`,
 * `auditor.verdict`); the matching post-terminal append (`task.completed`) is the
 * guard's responsibility to surface, not a wrapped pre-terminal step.
 */
export async function wrapEventAppend(append: () => Promise<void>): Promise<void> {
  try {
    await append();
  } catch (error) {
    throw new EventAppendError(error);
  }
}

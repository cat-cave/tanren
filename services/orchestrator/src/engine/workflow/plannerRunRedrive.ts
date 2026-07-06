// APPLY a {@link RunDisposition} to a run's lifecycle (apex v35 — the unified
// run-finalize authority). The DECISION (the 3-bucket mapping: RE-DRIVE | GENUINE-HALT |
// CONVERGE) lives in `runFinalizeAuthority.ts` — a pure, DB-free core. THIS module is the
// APPLIER: given a decided disposition + the run/spec write seams, it performs the
// lifecycle writes + emits the ONE observable event for that bucket, consistently, from
// whichever path produced the outcome (the workflow error catch, a non-pass exit, the
// merge stage, or the worker orphan reconciler). It also owns the consecutive-same-failure
// READER (the durable-event-log count the authority's bound keys off).
//
// The product doctrine it embodies: a spec failing due to a RANDOM / TRANSIENT fault must
// NEVER be tolerated as terminal — it RE-DRIVES (run halts recoverable, spec → `open`, the
// walker re-enqueues), emitting an OBSERVABLE `dag.spec.redriven` (never a strand). The
// re-drive is BOUNDED ONLY by a CONSECUTIVE-same-failure counter (a DIFFERENT failure / any
// progress resets it) — never a wall-clock deadline. `needs_attention` is RESERVED for the
// three GENUINE-HALT classes (misconfiguration / persistent-same-failure / human-decision),
// each with a SPECIFIC, actionable diagnostic (never a bare "internal error").

import type { EventName, EventPayload } from "../events/index.js";
import type { AppendEventInput } from "../eventStore.js";
import {
  type ConvergenceFacts,
  decideRunDisposition,
  redriveBackoffSeconds,
  type RunDisposition,
  type TerminalOutcome,
} from "./runFinalizeAuthority.js";

// Re-exported so the historical import sites (tests, the worker wiring) keep their imports
// pointed at this module while the backoff helper lives in the authority core.
export { redriveBackoffSeconds };
// Re-export the apex v67 #119/#120 atomic seam from its own module so
// `plannerRunFinalize.ts`'s dispositionSeams wiring stays under its import cap.
export { finalizeRedriveAtomicSeam } from "./plannerRunRedriveSeam.js";
// The Pg-backed convergence-facts reader + its types live in their own modules
// (file-size cap) — re-exported here so existing import sites keep working.
export { buildRedriveHistoryReader } from "./redriveHistoryReader.js";
export type {
  RedriveConvergenceFacts,
  RedriveHistoryFacts,
  RedriveHistoryReader,
  RedriveHistoryReadResult,
} from "./plannerRunRedriveTypes.js";
import type { RedriveHistoryReader } from "./plannerRunRedriveTypes.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("run-redrive-applier");

/** The append-event seam the applier emits its observable timeline events through. */
type AppendEvent = <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;

/**
 * The run/spec write seams + facts the applier needs, handed in by `finalizeWorkflowError`
 * (so this module never imports back into `plannerRunFinalize.ts` — the file-size cap holds
 * without a circular import). All route through the SAME lifecycle-writer seams the rest of
 * the finalize path uses.
 *
 * Task #48 (run/spec atomicity sweep): the disposition appliers below now route the
 * spec-status flip + its dag event through ONE atomic seam (`updateSpecWithEvent`)
 * and the genuine-halt run-finalize + `run.failed` event through ONE atomic seam
 * (`finalizeRunWithEvent`) — so the split row-write/event-append strand the prior
 * code was vulnerable to is now closed. The legacy seams (`finalizeNonPass`,
 * `setSpecStatus`, `finalizeRunState`) are retained because the merge/non-pass
 * finalize paths in `plannerRunFinalize.ts` still call them for the
 * RUN-LEVEL finalize on the RE-DRIVE path (no `run.failed` paired today —
 * re-drive is a recoverable halt + a spec re-open, the event is `dag.spec.redriven`,
 * not `run.failed`).
 */
export interface DispositionSeams {
  /** Halt the run RECOVERABLE (work not discarded) — the re-drive's run finalize. The
   * distinct `convergence_stalled` outcome preserves WHY for recovery. */
  finalizeNonPass: (outcome: "halted" | "convergence_stalled") => Promise<void>;
  /** Set the spec status (→ `open` to re-drive, → `needs_attention` to genuine-halt). */
  setSpecStatus: (status: string) => Promise<void>;
  /** The remote/in-process terminal-run finalizer (the genuine-halt `failed` write). */
  finalizeRunState: (
    status: string,
    outcome: string,
    fromStatuses: string[],
    directSql: string,
    directParams: unknown[],
  ) => Promise<void>;
  /**
   * ATOMIC spec-status flip + spec-disposition event (task #48 Site A/B): flips
   * the spec status AND appends the matching `dag.spec.*` event in ONE org-scoped
   * transaction so the flip + event live or die together. Replaces the prior
   * `setSpecStatus(...)` + `appendEvent(...)` split. Returns whether the
   * guarded UPDATE moved a row — `false` ⇒ the caller already suppressed
   * the event (the applier handled the no-op).
   */
  updateSpecAtomic: (spec: { status: string; notFromStatuses?: string[] }, event: AppendEventInput) => Promise<void>;
  /**
   * ATOMIC genuine-halt RUN finalize + `run.failed` event (task #48 Site B):
   * runs the row UPDATE + the `run.failed` event INSERT in ONE org-scoped
   * transaction. Carries the run-id internally; the caller supplies the
   * pairing data. Suppresses the event on a no-row-moved outcome.
   */
  finalizeGenuineHaltAtomic: (event: AppendEventInput) => Promise<void>;
  /**
   * task #82 — window-pause auto-resume. Flip the run to the NEW non-terminal
   * `paused` status (outcome `window_paused`) — distinct from `halted` — so
   * the SPEC stays `in_flight` (no successor enqueue from the walker) and the
   * background prober owns the resume. Carries the `run.paused` event payload
   * so the row UPDATE + the event INSERT land or fail together (same
   * atomicity invariant as `finalizeGenuineHaltAtomic`).
   */
  finalizePauseForCapacityAtomic: (event: AppendEventInput) => Promise<void>;
  /**
   * apex v67 fixes #119 + #120 — RE-DRIVE halt observability. The re-drive halt
   * is RECOVERABLE, but watchers/observers/UI that key on the canonical
   * `run.failed` halt event were BLIND to it (only `dag.spec.redriven` was
   * emitted) and the raw error string was LOST (the `job_queue.failure_message`
   * capture in `runExecutor.ts` only fires on the WORKER catch). v67 ran 1h47m
   * through three wandering failure codes with ZERO actionable detail.
   *
   * Runs THREE writes in ONE org-scoped transaction: (1) UPDATE runs to
   * `halted` (guarded for exactly-once); (2) `run.failed` event (paired via
   * `events_run_terminal_unique`); (3) UPDATE job_queue.failure_message
   * (internal-only — same split as `runExecutor.ts`). A throw rolls back all
   * three. Suppresses on no-row-moved (the workflow's earlier finalize already
   * landed this run). See `plannerRunRedriveSeam.ts`.
   */
  finalizeRedriveAtomic: (input: {
    runOutcome: "halted" | "convergence_stalled";
    runFailedEvent: AppendEventInput;
    rawErrorMessage: string;
  }) => Promise<void>;
}

/** The run/spec facts the applier reads (the subset of the workflow error context it uses). */
export interface DispositionContext {
  appendEvent: AppendEvent;
  input: { redriveHistoryReader?: RedriveHistoryReader };
  context: { runId: string; specId: string; orgId?: unknown };
}

/** The bucket a terminal outcome was disposed into (the workflow `catch` keys off this). */
export type DispositionBucket = RunDisposition["bucket"];

/**
 * DECIDE + APPLY a terminal outcome's disposition. Reads the consecutive-same-failure count
 * (the durable bound), asks the authority for the bucket, then performs the lifecycle writes:
 *
 *   • RE-DRIVE — run halts RECOVERABLE, spec → `open`, an OBSERVABLE `dag.spec.redriven`
 *     event (carrying the failure code + the consecutive-same-failure counter + the backoff).
 *     The attempt is terminally disposed of; the walker's successor run is the continuation.
 *   • GENUINE-HALT — run → `failed`, spec → `needs_attention`, a `dag.spec.needs_attention`
 *     event with a SPECIFIC reason (`misconfiguration` / `persistent_failure` / `human_decision`).
 *   • CONVERGE — the caller owns the merged-run write; never reached on the error path.
 *
 * Returns the bucket so the workflow `catch` knows whether the attempt was terminally disposed
 * of (re-drive ⇒ return normally, NEVER re-throw into the worker's strand path — the #580
 * double-finalize) or still fails the job (genuine-halt ⇒ re-throw wrapped).
 */
export async function applyTerminalOutcome(
  outcome: TerminalOutcome,
  ctx: DispositionContext,
  seams: DispositionSeams,
): Promise<DispositionBucket> {
  const facts = await readConvergenceFacts(ctx, outcome);
  const disposition = decideRunDisposition(outcome, facts);
  if (disposition.bucket === "re_drive") {
    await applyRedrive(ctx, seams, disposition, rawErrorMessageOf(outcome));
    return "re_drive";
  }
  if (disposition.bucket === "pause_for_capacity") {
    await applyPauseForCapacity(ctx, seams, disposition, outcome);
    return "pause_for_capacity";
  }
  if (disposition.bucket === "genuine_halt") {
    await applyGenuineHalt(ctx, seams, disposition);
    return "genuine_halt";
  }
  return "converge";
}

/** Resolve the run's projectId from `ctx.context` (the planner-run context carries it). */
function resolveProjectId(ctx: DispositionContext): string {
  const projectId = (ctx.context as { projectId?: unknown }).projectId;
  return typeof projectId === "string" ? projectId : "";
}

/**
 * Resolve the run's `orgId` from `ctx.context` for the spec/run-disposition events
 * (v68 fix: AppendEventInput requires explicit `orgId` rather than the prior
 * derive-from-project subquery; runs.org_id is NOT NULL on the table, propagated
 * through the workflow's `PlannerRunContext.orgId`). Fail loud on absence — the
 * applier is reached only on a real workflow throw where the run row exists, so a
 * missing org is a wiring bug that must NEVER silently drop org_id (the apex v68
 * RLS-deny mode the fix exists to close).
 */
function resolveOrgId(ctx: DispositionContext): string {
  return typeof ctx.context.orgId === "string" ? ctx.context.orgId : "";
}

/** Apply a RE-DRIVE: halt the run recoverable, return the spec to `open`, emit `dag.spec.redriven`.
 *
 * Task #48 Site A: the spec flip + `dag.spec.redriven` event are atomic
 * (`updateSpecAtomic` — `applyUpdateSpecWithEvent`), so a crash/DB failure
 * between the row UPDATE and the event INSERT no longer strands the spec
 * `open` with no `dag.spec.redriven` event (or vice versa).
 *
 * apex v67 fixes #119 + #120: the RUN-LEVEL halt is now ALSO observable —
 * `finalizeRedriveAtomic` emits the canonical `run.failed` event AND captures
 * the raw error string to `job_queue.failure_message`, both atomic with the
 * runs UPDATE. v67 halted 1h47m through three wandering failure codes with
 * ZERO actionable detail; this restores the operator triage surface. See
 * `plannerRunRedriveSeam.ts` for the three-arm dispatch. */
async function applyRedrive(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "re_drive" }>,
  rawErrorMessage: string | undefined,
): Promise<void> {
  // A re-drive WITH a classified failure emits BOTH the observable `run.failed`
  // (atomic via #119/#120's seam) AND `dag.spec.redriven` (atomic via #48's spec
  // seam). A NO-FAULT re-drive (ancestor-wait / merge hold) re-opens silently —
  // emitting `run.failed` there would mis-imply a fault.
  if (disposition.failure === undefined) {
    await seams.finalizeNonPass(disposition.runOutcome);
    await seams.setSpecStatus("open");
    return;
  }
  // The raw message defaults to the classified safe summary when the outcome
  // carries no raw error (the non-pass detail path); the public payload always
  // uses the classified summary, never the raw caught string (public-leak hardening).
  await seams.finalizeRedriveAtomic({
    runOutcome: disposition.runOutcome,
    runFailedEvent: {
      runId: ctx.context.runId,
      specId: ctx.context.specId,
      projectId: resolveProjectId(ctx),
      orgId: resolveOrgId(ctx),
      eventType: "run.failed",
      payload: {
        // Mirrors `runFinalize.ts`'s worker-orphan `run.failed` shape so a
        // single reader handles both paths uniformly: `status: "halted"`
        // (recoverable, the re-drive class) with the classified
        // failureCode/stage/summary.
        status: "halted",
        failureCode: disposition.failure.code,
        stage: disposition.failure.stage,
        message: disposition.failure.summary,
      },
    },
    rawErrorMessage: rawErrorMessage ?? disposition.failure.summary,
  });
  await seams.updateSpecAtomic(
    { status: "open" },
    {
      runId: ctx.context.runId,
      specId: ctx.context.specId,
      projectId: resolveProjectId(ctx),
      orgId: resolveOrgId(ctx),
      eventType: "dag.spec.redriven",
      payload: {
        specId: ctx.context.specId,
        runId: ctx.context.runId,
        failureCode: disposition.failure.code,
        stage: disposition.failure.stage,
        consecutiveSameFailure: disposition.consecutiveSameFailure,
        backoffSeconds: disposition.backoffSeconds,
      },
    },
  );
}

/**
 * Extract the raw caught-error message from a {@link TerminalOutcome} for the
 * INTERNAL `job_queue.failure_message` capture (fix #120). Returns `undefined`
 * for non-error outcomes (non_pass / merge / ancestor_wait) — those carry a
 * public-safe sub-reason but no thrown error; the applier defaults to the
 * classified summary in that case. NEVER walks beyond `error.message`; the
 * shape doctrine matches `runExecutor.ts`'s `messageOf` helper.
 */
function rawErrorMessageOf(outcome: TerminalOutcome): string | undefined {
  if (outcome.kind !== "error") return undefined;
  if (outcome.error instanceof Error) return outcome.error.message;
  return String(outcome.error);
}

/** Apply a GENUINE-HALT: land the run `failed`, park the spec `needs_attention` with a specific reason.
 *
 * Task #48 Site B: BOTH the run-level (`run.failed` paired with the row finalize)
 * AND the spec-level (`dag.spec.needs_attention` paired with the
 * `needs_attention` flip) are now ATOMIC pairs. Plan §8 risk: today
 * `applyGenuineHalt` does NOT emit a `run.failed` event — only
 * `dag.spec.needs_attention`. The plan recommends ADDING the `run.failed`
 * emit (paired with the row finalize). The worker-orphan path in
 * `runFinalize.ts` DOES emit `run.failed` (status `halted`), but only for
 * runs the workflow's own finalizer never reached; the partial unique index
 * `events_run_terminal_unique` + `appendIfAbsent` dedup any race. Adding
 * `run.failed` here is the natural close — the timeline now carries
 * `run.failed` for EVERY terminal-`failed` run, not just orphaned ones.
 * The reads that key off `run.failed` (`sensitivityRules`, the notification
 * `eventDefaultSeverity` matrix, the run-progress subscriber) all treat it
 * as a PUBLIC fail signal — none key off its ABSENCE, so adding the emit
 * cannot regress an existing reader. */
async function applyGenuineHalt(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "genuine_halt" }>,
): Promise<void> {
  const orgId = resolveOrgId(ctx);
  await seams.finalizeGenuineHaltAtomic({
    runId: ctx.context.runId,
    specId: ctx.context.specId,
    projectId: resolveProjectId(ctx),
    orgId,
    eventType: "run.failed",
    payload: {
      status: "failed",
      // The disposition's failure carries the public-safe classified code +
      // stage + message (the same shape `runFinalize.ts` emits for the
      // worker-orphan path). A FAULTLESS genuine-halt (e.g. the merge-stage
      // `needs_attention` outcome — a real human-decision) carries no
      // failure; pad with a safe `genuine_halt` code so the registry-typed
      // payload still parses.
      failureCode: disposition.failure?.code ?? "genuine_halt",
      stage: disposition.failure?.stage ?? "finalize",
      message: disposition.message,
    },
  });
  // apex v67 #122 — branch on the disposition's source: the new `wandering_halt` source
  // carries its own diagnostics (total re-drives + distinct failure codes + the no-progress
  // streak), distinct from the strand source's `terminalRuns` + `attempts`. The schema's
  // discriminated union keys off `source` so the two payload shapes co-exist; consumers
  // (timeline, dashboards) read the source first and switch.
  const needsAttentionPayload =
    disposition.source === "wandering_halt" && disposition.wanderingDiagnostics !== undefined
      ? {
          source: "wandering_halt" as const,
          specId: ctx.context.specId,
          reason: "persistent_failure" as const,
          totalRedrives: disposition.wanderingDiagnostics.totalRedrives,
          noProgressStreak: disposition.wanderingDiagnostics.noProgressStreak,
          distinctFailureCodes: disposition.wanderingDiagnostics.distinctFailureCodes,
          message: disposition.message,
        }
      : {
          source: "strand" as const,
          specId: ctx.context.specId,
          reason: disposition.reason,
          terminalRuns: [{ runId: ctx.context.runId, status: "failed" }],
          attempts: disposition.consecutiveSameFailure,
          message: disposition.message,
        };
  await seams.updateSpecAtomic(
    { status: "needs_attention" },
    {
      runId: ctx.context.runId,
      specId: ctx.context.specId,
      projectId: resolveProjectId(ctx),
      orgId,
      eventType: "dag.spec.needs_attention",
      payload: needsAttentionPayload,
    },
  );
}

/**
 * task #82 — apply a `pause_for_capacity` disposition. The run hit a provider
 * usage-window exhaustion (writer's `window_exhausted` exit / answerer's
 * `CodexUsageLimitError` / preflight pressure escalation). The applier flips
 * the run to the NEW non-terminal `paused` status (outcome `window_paused`)
 * via the atomic seam, paired with a `run.paused` event carrying the snapshot
 * the background prober reads to schedule its capacity re-probe. The SPEC
 * stays `in_flight` (no spec-status flip, no `dag.spec.redriven` event) so
 * the walker does NOT enqueue a successor run — the same paused run is the
 * spec's continuation; the prober owns the resume.
 *
 * Extracting `provider` / `slot` / `usedPercent` / `resetsAt` from the
 * upstream outcome: the non-pass `window_exhausted` carries these directly
 * (the subtask loop builds them from the writer's `window_exhausted` exit or
 * the preflight pressure). The error path's `CodexUsageLimitError` does NOT
 * (the answerer throw carries only a schema name + message), so the pause
 * event falls back to a generic snapshot — the prober's cadence-based probe
 * resumes regardless; the diagnostic detail is degraded, not the function.
 */
async function applyPauseForCapacity(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "pause_for_capacity" }>,
  outcome: TerminalOutcome,
): Promise<void> {
  const snapshot = extractPauseSnapshot(outcome);
  await seams.finalizePauseForCapacityAtomic({
    runId: ctx.context.runId,
    specId: ctx.context.specId,
    projectId: resolveProjectId(ctx),
    orgId: resolveOrgId(ctx),
    eventType: "run.paused",
    payload: {
      provider: snapshot.provider,
      slot: snapshot.slot,
      usedPercent: snapshot.usedPercent,
      resetsAt: snapshot.resetsAt,
      reason: disposition.summary,
    },
  });
}

/**
 * Pull the pause snapshot (provider / slot / usedPercent / resetsAt) out of
 * the upstream {@link TerminalOutcome}. A `non_pass` `window_exhausted`
 * carries the rich snapshot on its detail (the subtask loop's preflight or
 * mid-call detection); an `error` path's `CodexUsageLimitError` carries only
 * an opaque message — the snapshot degrades to a generic now-timestamp with
 * `usedPercent: 100`. Either way the prober's cadence-based probe resumes
 * when capacity returns; the snapshot is diagnostic, not load-bearing.
 */
interface PauseSnapshot {
  provider: string;
  slot: string;
  usedPercent: number;
  resetsAt: string;
}

function extractPauseSnapshot(outcome: TerminalOutcome): PauseSnapshot {
  if (outcome.kind === "non_pass" && outcome.detail === "window_exhausted") {
    const w = (outcome as { window?: PauseSnapshot }).window;
    if (w !== undefined) return w;
  }
  return { provider: "agent", slot: "primary", usedPercent: 100, resetsAt: new Date().toISOString() };
}

/**
 * Read the CONVERGENCE FACTS (the fixed-point streak + the wandering-halt verdict) via
 * the wired reader. `priorSameFixedPoint: 0` ⇒ progress / first of its kind / no reader
 * / no fault (⇒ ALWAYS re-drive). The reader returns 1 only at a proven fixed point (the
 * prior attempt was structurally identical), which is when the authority escalates — no
 * hardcoded count.
 *
 * READ FAILURE ≠ NO HISTORY (audit C2 #3 — silent-fallback hardening). The reader's
 * `read_failed` discriminant is treated EXPLICITLY here: we DEFER escalation for this
 * tick (return facts that force a RE-DRIVE — priorSameFixedPoint: 0 + no wandering),
 * log LOUDLY with the runId/specId/orgId + the caught error, and let the NEXT tick's
 * read retry. A genuinely-stuck spec still escalates once the read recovers; a
 * transient DB blip does NOT silently disable persistent-failure OR wandering-halt.
 */
async function readConvergenceFacts(ctx: DispositionContext, outcome: TerminalOutcome): Promise<ConvergenceFacts> {
  // Only an error / non-pass outcome carries a counted failure code; probe a disposition at
  // progress (0) to recover the code. A merge / ancestor-wait / pause_for_capacity (task
  // #82 — window pressure is UNBOUNDED, never escalates) outcome never reaches the
  // fixed-point rule, so the facts are immaterial (return progress).
  const probe = decideRunDisposition(outcome, { priorSameFixedPoint: 0 });
  const code = probe.bucket === "re_drive" || probe.bucket === "genuine_halt" ? probe.failure?.code : undefined;
  const stage = probe.bucket === "re_drive" || probe.bucket === "genuine_halt" ? probe.failure?.stage : undefined;
  const reader = ctx.input.redriveHistoryReader;
  const orgId = typeof ctx.context.orgId === "string" ? ctx.context.orgId : undefined;
  if (reader === undefined || orgId === undefined || code === undefined || stage === undefined) {
    return { priorSameFixedPoint: 0 };
  }
  const result = await reader({ orgId, specId: ctx.context.specId, code, stage });
  if (result.kind === "read_failed") {
    // Audit C2 #3: DEFER escalation on a broken read. The reader has already logged
    // the raw error at its layer; log again HERE with the disposition context
    // (runId/specId/orgId) so the operator can trace which run's escalation was
    // deferred. Return facts that force a RE-DRIVE (never a genuine-halt on unknown
    // facts) — the next tick's read will retry the escalation decision.
    log.warn(
      "convergence-facts read failed at disposition site — DEFERRING escalation this tick " +
        "(forcing re-drive; retry on next tick)",
      { runId: ctx.context.runId, specId: ctx.context.specId, orgId },
      result.error,
    );
    return { priorSameFixedPoint: 0, wandering: { wandering: false } };
  }
  return { priorSameFixedPoint: result.priorSameFixedPoint, wandering: result.wandering };
}

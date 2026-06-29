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

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import type { RunFailureCode } from "../worker/runFailureClassifier.js";
import { createLogger } from "../observability/logger.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { AppendEventInput } from "../eventStore.js";
import {
  type ConvergenceFacts,
  decideRunDisposition,
  redriveBackoffSeconds,
  type RunDisposition,
  type TerminalOutcome,
} from "./runFinalizeAuthority.js";
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "./convergenceDetector.js";
import { assessWanderingHalt, type WanderingHaltVerdict } from "./wanderingHaltDetector.js";

const log = createLogger("run-redrive");

// Re-exported so the historical import sites (tests, the worker wiring) keep their imports
// pointed at this module while the backoff helper lives in the authority core.
export { redriveBackoffSeconds };
// Re-export the apex v67 #119/#120 atomic seam from its own module so
// `plannerRunFinalize.ts`'s dispositionSeams wiring stays under its import cap.
export { finalizeRedriveAtomicSeam } from "./plannerRunRedriveSeam.js";

/** Facts a fixed-point read needs: the spec + its org + the failure code + the work signature now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure (one fixed-point axis). */
  code: RunFailureCode;
  /** The run STAGE the CURRENT failure is attributed to. Used by the wandering-halt
   * detector (apex v67 #122) as one progress axis — a later-stage failure than every
   * prior re-drive is deliverable progress. The fixed-point detector ignores this. */
  stage: string;
  /** The produced-work signature of the CURRENT run (the head/commit sha), when observable. */
  workSignature?: string;
}

/** The full convergence facts the authority reasons over: the fixed-point streak (PR #710 —
 * same failure recurring) + the wandering-halt verdict (apex v67 #122 — N re-drives with
 * different failures but no deliverable progress). Coalesced into ONE org-scoped read. */
export interface RedriveConvergenceFacts {
  priorSameFixedPoint: number;
  wandering: WanderingHaltVerdict;
}

/**
 * Read the FIXED-POINT streak for a spec — the count of CONSECUTIVE prior re-drives that are
 * structurally INDISTINGUISHABLE from the current one (same failure code AND, when both
 * observed, the same produced-work signature). Computed via the shared `convergenceDetector`
 * over the spec's `dag.spec.redriven` history. A DIFFERENT failure code OR DIFFERENT produced
 * work (PROGRESS) breaks the streak, so the loop is UNBOUNDED while it keeps changing; the
 * authority escalates ONLY once the streak shows a proven fixed point (the prior attempt was
 * already identical). ALSO computes the WANDERING-HALT verdict (apex v67 #122) over the
 * full re-drive history + the spec-level PR/merge markers — the second convergence signal
 * that catches the changing-failure-no-progress trap the fixed-point judge cannot see.
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<RedriveConvergenceFacts>;

/**
 * The Pg-backed {@link RedriveHistoryReader} the run worker wires: an org-scoped read of the
 * spec's prior `dag.spec.redriven` events (newest first), assembled into the shared
 * convergence-detector history (failure code + work signature per attempt) with the CURRENT
 * attempt appended — then `decideConvergence` (routed through the principled fixed-point judge)
 * decides progress vs a proven fixed point.
 *
 * FAIL-CLOSED toward RE-DRIVING (not toward stranding): a read failure logs loudly and
 * returns 0 (treat as progress / first of its kind) — a transient DB hiccup must NOT cause a
 * spurious escalation to `needs_attention`; the fixed-point detection still bites once the
 * read recovers.
 */
export function buildRedriveHistoryReader(pool: pg.Pool): RedriveHistoryReader {
  return async (facts) => {
    try {
      return await runWithOrgScope(pool, facts.orgId, async (client) => {
        const redriveRows = await client.query<{
          payload: { failureCode?: string; stage?: string; workSignature?: string; source?: string };
          ts: string;
        }>(
          `SELECT payload, ts FROM events
             WHERE spec_id = $1 AND event_type = 'dag.spec.redriven'
             ORDER BY ts ASC, id ASC`,
          [facts.specId],
        );
        // apex v67 #122 — read the spec-level PR / merge markers (their earliest timestamps,
        // so we can determine which re-drives in the history had them in place). ONE round-trip
        // covers both events; an absent event row yields a null timestamp (treated as
        // "never happened" by the assembly below).
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
        const structuralRows = redriveRows.rows.filter((row) => row.payload.source !== "prober_resume");
        // Assemble the oldest→newest attempt history (each prior re-drive's failure code +
        // work signature) and append the CURRENT attempt, then route the escalation decision
        // through the shared convergence judge (below). 1 ⇒ a proven fixed point (the authority
        // escalates); 0 ⇒ progress (a changing failure / work, or a not-yet-cyclic repeat).
        const history: AttemptSignature[] = structuralRows.map((row) => ({
          failureSignature: row.payload.failureCode ?? "",
          ...(row.payload.workSignature !== undefined && { workSignature: row.payload.workSignature }),
        }));
        history.push({
          failureSignature: facts.code,
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
        return { priorSameFixedPoint, wandering };
      });
    } catch (error) {
      log.warn(
        "convergence-facts read failed (fail-closed toward re-drive: treat as progress / first of its kind)",
        { specId: facts.specId },
        error,
      );
      return { priorSameFixedPoint: 0, wandering: { wandering: false } };
    }
  };
}

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
  await seams.finalizeGenuineHaltAtomic({
    runId: ctx.context.runId,
    specId: ctx.context.specId,
    projectId: resolveProjectId(ctx),
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
 * Read the CONVERGENCE FACTS (the fixed-point streak) via the wired reader. `0` ⇒ progress /
 * first of its kind / no reader / no fault (⇒ ALWAYS re-drive). The reader returns 1 only at
 * a proven fixed point (the prior attempt was structurally identical), which is when the
 * authority escalates — no hardcoded count.
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
  const facts = await reader({ orgId, specId: ctx.context.specId, code, stage });
  return { priorSameFixedPoint: facts.priorSameFixedPoint, wandering: facts.wandering };
}

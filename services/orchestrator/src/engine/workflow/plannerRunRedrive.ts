// RE-DRIVE a random/transient/internal spec-run failure instead of terminally
// stranding it (apex v35 — "robustness over recovery"). The product doctrine: a spec
// failing due to a RANDOM / TRANSIENT failure must NEVER be tolerated as terminal — it
// must be RE-DRIVEN. `needs_attention` is RESERVED for genuine human-decisions; it must
// NEVER be the resting place for a random/transient/internal failure. A build runs until
// it CONVERGES, retrying random failures, and only HALTS for a STRUCTURAL reason: budget
// exhaustion, mis-spec, misconfiguration, or a real human-decision.
//
// This module owns the failure-classification at the workflow's run-failure boundary
// (`finalizeWorkflowError`'s catch path). It splits a thrown error into:
//
//   • RETRIABLE — transient/random/internal/flaky/codex-hiccup/writer-mistake: the spec
//     is RE-DRIVEN (run halts RECOVERABLE, spec returns to `open`, the walker re-enqueues
//     it), with an OBSERVABLE `dag.spec.redriven` event (never a strand). The re-drive is
//     BOUNDED by a CONSECUTIVE-same-failure counter (mirrors the progress-aware recovery
//     bound in templates/creation/recovery.ts): a DIFFERENT classified failure resets the
//     count, so a flapping-but-eventually-different spec keeps retrying; the SAME failure
//     K consecutive times escalates LOUDLY (it is genuinely STUCK, not a flake).
//
//   • GENUINE-TERMINAL — a misconfiguration / credential fault (a structural cause a human
//     must fix), or the persistent-same-failure escalation above: the spec parks at
//     `needs_attention` with a SPECIFIC diagnostic (never a bare "internal error"). Budget
//     exhaustion and the named recoverable faults (workspace/usage-limit/ancestor-wait)
//     are handled by their OWN branches in `finalizeWorkflowError`, not here.
//
// The classification keys off the SAME closed run-failure vocabulary the worker's
// `classifyRunFailure` produces (error CLASS name → `{ code, stage }`), so the public
// `dag.spec.redriven` / `dag.spec.needs_attention` payloads never carry the raw error
// string. The consecutive-same-failure count is read from the durable event log (prior
// `dag.spec.redriven` events for THIS spec), so the bound survives restarts.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { classifyRunFailure, type RunFailureCode } from "../worker/runFailureClassifier.js";
import { createLogger } from "../observability/logger.js";
import type { EventName, EventPayload } from "../events/index.js";

const log = createLogger("run-redrive");

// The DEFAULT cap K on CONSECUTIVE SAME-classified-failure re-drives before a spec
// escalates loudly to `needs_attention`. Generous (a random failure resolves on retry;
// the per-spec/per-step timeouts remain the hang-detector), but BOUNDED so a genuinely
// STUCK spec (same bug/mis-spec every time) surfaces as a human-decision rather than
// hot-looping forever. A DIFFERENT failure code (any progress) resets the count, so a
// spec that is flapping-but-advancing keeps retrying past this flat K.
export const DEFAULT_REDRIVE_ESCALATE_AT = 4;

// The base backoff (seconds) between re-drives + the per-attempt growth, so the
// re-enqueue does not hot-loop. The walker honors `backoffSeconds` (the cooldown before
// it re-picks the `open` spec). Grows linearly with the consecutive-same-failure count,
// capped, so an early flake retries promptly while a repeatedly-failing spec backs off.
const REDRIVE_BACKOFF_BASE_SECONDS = 30;
const REDRIVE_BACKOFF_MAX_SECONDS = 600;

// A GENUINE-TERMINAL failure code: a STRUCTURAL cause a human must fix (a misconfiguration
// / missing-or-unscoped credential / unresolvable provider mode). These never self-heal on
// retry, so they escalate to `needs_attention` IMMEDIATELY with a specific diagnostic —
// they are NOT random/transient. `usage_limit` is NOT here (it is the recoverable
// window-exhausted halt, handled by its own branch); `workspace` is NOT here (its named
// error has its own recoverable branch). Everything ELSE (`internal`, `merge`, `deploy`,
// and any unrecognized error → the `internal` default) is RETRIABLE — a random failure.
const GENUINE_TERMINAL_CODES: ReadonlySet<RunFailureCode> = new Set<RunFailureCode>(["credential"]);

/** A classified run failure routed to a re-drive (retriable) or a genuine-terminal escalation. */
export interface RedriveClassification {
  /** RETRIABLE (a random/transient/internal fault) → re-drive; else a genuine-terminal escalation. */
  retriable: boolean;
  /** The public-safe closed-vocabulary failure code (never the raw error string). */
  code: RunFailureCode;
  /** The public-safe run stage the failure is attributed to. */
  stage: "bootstrap" | "credentials" | "workspace" | "agent" | "merge" | "deploy" | "run";
  /** The FIXED, public-safe summary (never the raw error string). */
  summary: string;
}

/**
 * Classify a thrown run-error into a re-drive (retriable random/transient fault) vs a
 * genuine-terminal escalation (a misconfiguration a human must fix). Keys off the SAME
 * closed run-failure vocabulary as the worker's `classifyRunFailure` — an unrecognized
 * error falls into the `internal` code, which is RETRIABLE (the bare "internal error"
 * that used to terminally strand). The returned strings are all public-safe.
 */
export function classifyRedrive(error: unknown): RedriveClassification {
  const classified = classifyRunFailure(error);
  return {
    retriable: !GENUINE_TERMINAL_CODES.has(classified.code),
    code: classified.code,
    stage: classified.stage,
    summary: classified.summary,
  };
}

/** The walker-honored re-drive backoff (seconds) for the Nth consecutive same-failure re-drive. */
export function redriveBackoffSeconds(consecutiveSameFailure: number): number {
  const grown = REDRIVE_BACKOFF_BASE_SECONDS * Math.max(1, consecutiveSameFailure);
  return Math.min(grown, REDRIVE_BACKOFF_MAX_SECONDS);
}

/** Facts a consecutive-same-failure read needs: the spec + its org + the failure code now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure (the one being counted). */
  code: RunFailureCode;
}

/**
 * Read the CONSECUTIVE-same-failure count for a spec (this failure included). Mirrors the
 * progress-aware recovery bound: it walks the spec's prior `dag.spec.redriven` events
 * NEWEST→OLDEST and counts the trailing run of re-drives whose `failureCode` MATCHES the
 * current one — stopping at the first DIFFERENT code (a different failure = progress, which
 * resets the streak). A `dag.spec.attention_resolved` / `dag.spec.merged`-style advance also
 * stops the walk (the operator resolved it, or it advanced) — but the simplest durable signal
 * is the trailing same-code run, which is what we read here.
 *
 * Returns the count INCLUDING the current failure (so the first failure of its kind returns 1).
 * At >= K (`escalateAtAttempts`) the caller escalates instead of re-driving.
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<number>;

/**
 * The Pg-backed {@link RedriveHistoryReader} the run worker wires: an org-scoped read of the
 * spec's prior `dag.spec.redriven` events (newest first), counting the trailing run whose
 * `failureCode` matches the current one. A DIFFERENT code breaks the run (progress reset).
 *
 * FAIL-CLOSED toward RE-DRIVING (not toward stranding): a read failure logs loudly and
 * returns 1 (treat as the first failure of its kind) — a transient DB hiccup must NOT cause a
 * spurious escalation to `needs_attention`; the bound still bites once the read recovers.
 */
export function buildRedriveHistoryReader(pool: pg.Pool): RedriveHistoryReader {
  return async (facts) => {
    try {
      return await runWithOrgScope(pool, facts.orgId, async (client) => {
        const result = await client.query<{ payload: { failureCode?: string } }>(
          `SELECT payload FROM events
             WHERE spec_id = $1 AND event_type = 'dag.spec.redriven'
             ORDER BY ts DESC, id DESC`,
          [facts.specId],
        );
        // Count the trailing run of SAME-code prior re-drives, then +1 for the current
        // failure. A different prior code breaks the run (a different failure = progress).
        let priorSameRun = 0;
        for (const row of result.rows) {
          if (row.payload.failureCode !== facts.code) break;
          priorSameRun += 1;
        }
        return priorSameRun + 1;
      });
    } catch (error) {
      log.warn(
        "consecutive-same-failure read failed (fail-closed toward re-drive: treat as first of its kind)",
        { specId: facts.specId },
        error,
      );
      return 1;
    }
  };
}

/** The append-event seam the re-drive/escalate emits its observable timeline events through. */
type AppendEvent = <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;

/**
 * The run/spec write seams + facts the re-drive/escalate body needs, handed in by
 * `finalizeWorkflowError` (so this module never imports back into `plannerRunFinalize.ts` —
 * the file-size cap holds without a circular import). `finalizeNonPass`/`setSpecStatus` route
 * through the SAME lifecycle-writer seams the rest of the finalize path uses.
 */
export interface RedriveSeams {
  /** Halt the run RECOVERABLE (work not discarded) — the re-drive's run finalize. */
  finalizeNonPass: (outcome: "halted") => Promise<void>;
  /** Set the spec status (→ `open` to re-drive, → `needs_attention` to escalate). */
  setSpecStatus: (status: string) => Promise<void>;
  /** The remote/in-process terminal-run finalizer (the genuine-terminal `failed` write). */
  finalizeRunState: (
    status: string,
    outcome: string,
    fromStatuses: string[],
    directSql: string,
    directParams: unknown[],
  ) => Promise<void>;
}

/** The run/spec facts the re-drive/escalate reads (the subset of the workflow error context it uses). */
export interface RedriveErrorContext {
  appendEvent: AppendEvent;
  input: { redriveHistoryReader?: RedriveHistoryReader };
  context: { runId: string; specId: string; orgId?: unknown };
}

/**
 * The previously-stranding generic-error tail, now CLASSIFIED (apex v35). A RETRIABLE
 * random/transient fault under the consecutive-same-failure cap is RE-DRIVEN: the run halts
 * RECOVERABLE, the spec returns to `open` (the walker's re-drive bucket), and an OBSERVABLE
 * `dag.spec.redriven` event is emitted (never a strand). A GENUINE-TERMINAL fault (a
 * misconfiguration) — OR the SAME classified failure reaching the cap K — escalates LOUDLY to
 * `needs_attention` with a SPECIFIC diagnostic (never a bare "internal error"), once, not in a
 * hot-loop. Backoff grows with the consecutive-same-failure count so a re-drive never hot-loops.
 */
export async function redriveOrEscalateWorkflowError(
  error: unknown,
  ctx: RedriveErrorContext,
  seams: RedriveSeams,
): Promise<void> {
  const classification = classifyRedrive(error);
  // The consecutive-same-failure count (this failure included). Without a wired reader (a
  // no-DB unit path) treat it as the first failure of its kind ⇒ re-drive, never a spurious
  // escalation. FAIL-CLOSED toward re-driving is the reader's own contract.
  const consecutiveSameFailure = await readConsecutiveSameFailure(ctx, classification.code);
  const escalateAt = DEFAULT_REDRIVE_ESCALATE_AT;

  // RETRIABLE + under the cap ⇒ RE-DRIVE. A genuine-terminal fault (a misconfiguration) is
  // NOT retriable; the SAME failure reaching the cap is a genuinely stuck spec — both escalate.
  if (classification.retriable && consecutiveSameFailure < escalateAt) {
    // The run halts RECOVERABLE (work not discarded), the spec returns to `open` so the walker
    // RE-DRIVES it — the same never-discard re-drive a benign ancestor-wait gets.
    await seams.finalizeNonPass("halted");
    await seams.setSpecStatus("open");
    await ctx.appendEvent("dag.spec.redriven", {
      specId: ctx.context.specId,
      runId: ctx.context.runId,
      failureCode: classification.code,
      stage: classification.stage,
      consecutiveSameFailure,
      escalateAtAttempts: escalateAt,
      backoffSeconds: redriveBackoffSeconds(consecutiveSameFailure),
    });
    return;
  }

  // GENUINE-TERMINAL: a misconfiguration a human must fix, OR the SAME failure K consecutive
  // times (a genuinely stuck spec). Land the run `failed` (a hard, non-recoverable terminal)
  // and escalate LOUDLY to `needs_attention` with a SPECIFIC diagnostic — never a bare
  // "internal error" strand.
  await seams.finalizeRunState(
    "failed",
    "failed",
    ["running", "queued"],
    "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
    [ctx.context.runId],
  );
  await escalateGenuineTerminal(ctx, seams, classification, consecutiveSameFailure, escalateAt);
}

/** Read the consecutive-same-failure count via the wired reader (1 ⇒ first of its kind / no reader). */
async function readConsecutiveSameFailure(ctx: RedriveErrorContext, code: RunFailureCode): Promise<number> {
  const reader = ctx.input.redriveHistoryReader;
  const orgId = typeof ctx.context.orgId === "string" ? ctx.context.orgId : undefined;
  if (reader === undefined || orgId === undefined) return 1;
  return reader({ orgId, specId: ctx.context.specId, code });
}

/**
 * Escalate a GENUINE-TERMINAL run failure to `needs_attention` with a SPECIFIC, actionable
 * diagnostic (never a bare "internal error"). A misconfiguration is framed as "fix the
 * configured cause + requeue"; a persistent same-failure is framed as the repeated-failure
 * diagnostic + the retry count. Both carry the classified (public-safe) failure code/stage.
 */
async function escalateGenuineTerminal(
  ctx: RedriveErrorContext,
  seams: RedriveSeams,
  classification: RedriveClassification,
  consecutiveSameFailure: number,
  escalateAt: number,
): Promise<void> {
  // The DECISION ask (escalation discipline): a SPECIFIC, actionable reason — the classified
  // failure + (for a persistent failure) the repeated-failure count — never "an error occurred".
  const persistent = classification.retriable && consecutiveSameFailure >= escalateAt;
  const reason = persistent ? "persistent_failure" : "halted_reexec";
  const message = persistent
    ? `the run failed the same way (${classification.code} @ ${classification.stage}: ${classification.summary}) ` +
      `${consecutiveSameFailure} times in a row — the spec is genuinely stuck (a bug or mis-spec, not a flake); ` +
      `requeue after addressing the cause`
    : `${classification.summary} (${classification.code} @ ${classification.stage}) — a structural cause a human ` +
      `must fix; requeue after addressing it`;
  await seams.setSpecStatus("needs_attention");
  await ctx.appendEvent("dag.spec.needs_attention", {
    source: "strand",
    specId: ctx.context.specId,
    reason,
    terminalRuns: [{ runId: ctx.context.runId, status: "failed" }],
    attempts: consecutiveSameFailure,
    message,
  });
}

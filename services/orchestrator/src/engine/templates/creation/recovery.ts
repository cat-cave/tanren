// Template-creation SELF-RECOVERY (templating-system.md §2 + the autonomy thesis).
//
// A template-build is itself an agent-driven Tanren project, so its specs WILL
// sometimes terminally strand (`needs_attention`/halted/cancelled) or the build
// fails to converge. The build project is bound to a DETERMINISTIC slug, so the
// NEXT derive for the same stack RESUMES the SAME failed project — sees the
// terminally-blocked spec — and re-strands forever (`template build STRANDED — N
// spec(s) terminally blocked`). One failed build used to PERMANENTLY block ALL
// future derives for that stack, recoverable only by a human deleting the project's
// DB rows. THAT manual step is the bug this module kills.
//
// On the resume path, BEFORE the build driver re-drives, `recoverStrandedTemplateBuild`:
//   1. DETECTS the recoverable state — the bound build has terminally-blocked
//      spec(s) AND has NOT published a validated template (a succeeded build is
//      never re-driven — the fast existing-match path short-circuits before here,
//      and `hasPublishedValidatedTemplate` is the belt-and-braces guard).
//   2. REQUEUES the stranded work (the preferred, lightest recovery) — resets the
//      terminally-blocked specs back to `open` so the DagWalker re-drives them from
//      SCRATCH with the CURRENT code (the writer re-authors; the self-healing
//      bootstrap loop handles deps; etc.). This automates EXACTLY the
//      `dag.spec.needs_attention` payload's own "requeue after addressing the cause".
//   3. BOUNDS the recovery — by INTELLIGENT NON-CONVERGENCE DETECTION, NOT a count
//      (apex v35; the shared `convergenceDetector`). A build that is genuinely
//      ADVANCING between recoveries (more specs merged, or the set of
//      terminally-stranded specs changed) keeps recovering UNBOUNDED — it is
//      converging, however slowly. A build STUCK at the EXACT same failure (same
//      merged count, same stranded set) — a FIXED POINT — STOPS and throws a LOUD
//      `TemplateBuildRecoveryExhaustedError` (a genuine "this stack's template
//      cannot be built autonomously" signal). There is NO `maxAttempts` cap: the
//      fixed-point detection IS the loop-breaker, so slow convergence is forgiven
//      forever while a frozen build terminates the moment it stops changing.
//   4. EMITS durable events — `template.build.recovered` per requeue (carrying the
//      PROGRESS SIGNAL: `mergedCount` + `strandedSpecIds`, so the converged-vs-stuck
//      judgement is reconstructible from the durable log across restarts),
//      `template.build.recovery_exhausted` at the cap — so the recovery is
//      OBSERVABLE (Tanren recovered, it did not silently retry).
//
// Generic + bounded: Tanren names NO stack here — this is plain project/spec
// recovery logic. Every live touch (the DAG read, the spec reset, the prior-attempt
// count, the published-template check) is a SEAM so the orchestration is unit-tested
// without a database; `buildLiveTemplateBuildRecovery` wires the real infra.

import type { EventStore } from "../../eventStore.js";
import type { DagSnapshot } from "../../contracts/dagWalker.js";
import { createLogger } from "../../observability/logger.js";
import {
  type AttemptSignature,
  decideConvergence,
  fixedPointRuleJudgment,
} from "../../workflow/convergenceDetector.js";

const log = createLogger("template-recovery");

// The forward-progress signal a recovery records (and reads back) to decide whether
// the build ADVANCED since the last recovery. Progress = MORE specs merged, OR the
// set of terminally-stranded specs CHANGED (a different spec is now blocked, or
// fewer/more are). Either makes the recovery "made progress" and forgives the cap;
// neither (same merged count AND same stranded set) is a NO-PROGRESS recovery that
// counts toward exhaustion. Recorded on `template.build.recovered` so the
// judgement survives restarts (reconstructed from the durable event log).
export interface RecoveryProgressSignal {
  /** Count of specs MERGED (`done` phase) at the time of the recovery. */
  mergedCount: number;
  /** The terminally-stranded spec ids at the time of the recovery (sorted, deduped). */
  strandedSpecIds: ReadonlyArray<string>;
}

// Normalize an id list to a sorted, deduped array (a stable canonical set for both
// equality and the durable record).
function normalizeSpecIds(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

// Map a recovery progress signal onto the shared convergence detector's `AttemptSignature`:
//   - `failureSignature` = the stranded-spec SET (a changed stranded set is progress — a
//     different spec is now the blocker), and
//   - `magnitude` = the count of NOT-yet-merged specs, which SHRINKS as the build converges
//     (more merged ⇒ smaller magnitude ⇒ progress, even at an unchanged stranded set).
// So a build merging more specs OR shifting which specs are stranded reads as PROGRESS; only
// an identical stranded set AND no more merged is a fixed point.
function toAttemptSignature(signal: RecoveryProgressSignal): AttemptSignature {
  return {
    failureSignature: signal.strandedSpecIds.join(","),
    // Magnitude shrinks as more specs merge. mergedCount grows, so negate it for a
    // monotonically-shrinking remaining-work proxy (the detector's `<` magnitude rule).
    magnitude: -signal.mergedCount,
  };
}

// Is the recovery loop at a FIXED POINT? Assemble the prior recovery signals (oldest→newest)
// + the current snapshot into the shared convergence detector and ask whether the latest
// advanced. A build that merged more specs OR changed its stranded set is PROGRESS (keep
// recovering, UNBOUNDED); an identical stranded set with no new merges is a fixed point
// (this stack's template cannot be built autonomously). NO count — the structural fixed
// point itself is the stop condition.
export async function atRecoveryFixedPoint(
  priorRecoveries: ReadonlyArray<RecoveryProgressSignal>,
  current: RecoveryProgressSignal,
): Promise<boolean> {
  const history: AttemptSignature[] = [...priorRecoveries, current].map((signal) => toAttemptSignature(signal));
  // Route through the SHARED `decideConvergence` judge — NOT a raw `=== "fixed_point"` boolean
  // (the disguised-K=2 the audit flagged). There is no answerer at the build-recovery point (it
  // is a snapshot-driven decision), so `fixedPointRuleJudgment` is the principled stand-in: it
  // escalates ONLY at a PROVEN dead-end (the identical stranded set with no new merges, recurring
  // — a cycle, not slow convergence). A build merging more specs OR shifting its stranded set is
  // progress (the magnitude shrinks / the failure signature changes) ⇒ keep recovering, UNBOUNDED.
  const decision = await decideConvergence(history, (h) =>
    fixedPointRuleJudgment(
      h,
      () =>
        `the build reached a FIXED POINT — the identical specs strand with no new progress across ` +
        `recoveries; this stack's template cannot be built autonomously`,
    ),
  );
  return decision.decision === "escalate";
}

// Thrown when the auto-recovery reaches a FIXED POINT — the build strands with the IDENTICAL
// stranded set and no new merges (the shared `convergenceDetector`'s fixed point). A LOUD,
// durable terminal failure (paired with the `template.build.recovery_exhausted` event): a
// genuine "this stack's template cannot be built autonomously", never a silent infinite loop
// AND never a hardcoded attempt cap. Surfaced by the creation flow exactly like
// `TemplateBuildFailedError` — the build aborts WITHOUT publishing.
export class TemplateBuildRecoveryExhaustedError extends Error {
  readonly projectId: string;
  readonly attempts: number;
  readonly strandedSpecIds: ReadonlyArray<string>;
  constructor(projectId: string, attempts: number, strandedSpecIds: ReadonlyArray<string>) {
    super(
      `template build ${projectId} reached a FIXED POINT after ${String(attempts)} auto-recovery attempt(s) — ` +
        `the same specs strand with no new progress, so this stack's template cannot be built autonomously ` +
        `(stranded specs: ${strandedSpecIds.join(", ")})`,
    );
    this.name = "TemplateBuildRecoveryExhaustedError";
    this.projectId = projectId;
    this.attempts = attempts;
    this.strandedSpecIds = [...strandedSpecIds];
  }
}

// The live touches the recovery composes — each a SEAM (a fake in tests; the real
// infra in `buildLiveTemplateBuildRecovery`).
export interface TemplateBuildRecoveryDeps {
  // Load the build project's DAG snapshot — the terminally-blocked specs are read
  // off it (the SAME read model the build driver polls convergence with).
  loadSnapshot: (projectId: string) => Promise<DagSnapshot>;
  // Reset a terminally-blocked spec (`halted`/`cancelled`/`needs_attention`) back to
  // `open` so the DagWalker re-drives it from scratch, clearing the strand that pins
  // it, and wake the walker. Returns true when a row was actually reset (false when
  // the spec was no longer blocked — a concurrent recovery / a race).
  resetStrandedSpec: (input: { projectId: string; specId: string }) => Promise<boolean>;
  // The PROGRESS SIGNAL of each prior `template.build.recovered` event for this build
  // project, in chronological order — the durable record the shared convergence detector
  // reasons over (read from the event log, not an in-memory counter, so it survives across
  // derives/restarts). The build recovers UNBOUNDED while these show progress (more merged,
  // or a changed stranded set vs the current snapshot); it escalates at a fixed point.
  priorRecoveries: (projectId: string) => Promise<RecoveryProgressSignal[]>;
  // Whether this build already PUBLISHED a validated template — the belt-and-braces
  // "a succeeded build is NEVER re-driven" guard (the fast existing-match path
  // already short-circuits before here, but a resumed build is double-checked).
  hasPublishedValidatedTemplate: (projectId: string) => Promise<boolean>;
  // The durable event sink (`template.build.recovered` / `recovery_exhausted`).
  events: EventStore;
}

// The recovery outcome the creation flow reacts to:
//   - `not_stranded`: the build has no terminally-blocked spec (a fresh derive, or a
//     resume of an in-flight/converged build) — nothing to recover, proceed.
//   - `already_published`: the build already published a validated template — never
//     re-driven (the succeeded-build short-circuit).
//   - `requeued`: the stranded specs were reset to `open` (re-drivable) and the
//     recovery event emitted — proceed to re-drive the build.
// Exhaustion is NOT an outcome — it THROWS `TemplateBuildRecoveryExhaustedError`.
export type TemplateBuildRecoveryOutcome =
  | { kind: "not_stranded" }
  | { kind: "already_published" }
  | { kind: "requeued"; requeuedSpecIds: string[]; attempt: number };

// DETECT → REQUEUE → BOUND the recovery of a bound, resumed template-build project.
// Called on the resume path before the build driver re-drives. Throws
// `TemplateBuildRecoveryExhaustedError` (LOUD) at an intelligently-detected FIXED POINT
// (no hardcoded cap) — the build recovers UNBOUNDED while it converges.
export async function recoverStrandedTemplateBuild(
  deps: TemplateBuildRecoveryDeps,
  input: { orgId: string; projectId: string; stack: string },
): Promise<TemplateBuildRecoveryOutcome> {
  const { orgId, projectId, stack } = input;

  // A build that already PUBLISHED a validated template is DONE — never re-driven.
  // (The fast existing-match path short-circuits before creation runs; this is the
  // belt-and-braces guard for a resumed build whose published template did not match
  // the live capability query for some reason.)
  if (await deps.hasPublishedValidatedTemplate(projectId)) {
    return { kind: "already_published" };
  }

  // DETECT the stranded state: the build's DAG has terminally-blocked spec(s).
  const snapshot = await deps.loadSnapshot(projectId);
  const strandedSpecIds = normalizeSpecIds(
    snapshot.nodes.filter((n) => n.phase === "terminal_blocked").map((n) => n.specId),
  );
  if (strandedSpecIds.length === 0) {
    return { kind: "not_stranded" };
  }

  // The CURRENT forward-progress signal — count of MERGED (`done`) specs + the
  // stranded set. Compared against the prior recoveries to judge convergence.
  const mergedCount = snapshot.nodes.filter((n) => n.phase === "done").length;
  const current: RecoveryProgressSignal = { mergedCount, strandedSpecIds };

  // BOUND the recovery by INTELLIGENT NON-CONVERGENCE DETECTION (no count): the shared
  // detector decides progress (more merged, or a changed stranded set vs the last recovery →
  // keep recovering, UNBOUNDED) vs a FIXED POINT (the identical stranded set with no new
  // merges → STOP and surface the loud terminal failure). A genuinely-advancing build
  // recovers forever, however slowly; only a frozen build terminates.
  const priorRecoveries = await deps.priorRecoveries(projectId);
  const totalRecoveries = priorRecoveries.length;
  if (await atRecoveryFixedPoint(priorRecoveries, current)) {
    await emitRecoveryExhausted(deps.events, { orgId, projectId, stack, strandedSpecIds, mergedCount });
    throw new TemplateBuildRecoveryExhaustedError(projectId, totalRecoveries + 1, strandedSpecIds);
  }
  // The visible attempt number is this recovery's 1-based position in the durable history.
  const attempt = totalRecoveries + 1;

  // REQUEUE: reset every terminally-blocked spec back to `open` so the DagWalker
  // re-drives them from scratch with the current code. A spec that was no longer
  // blocked (a concurrent recovery) is skipped — only the genuinely-reset ids are
  // recorded.
  const requeuedSpecIds: string[] = [];
  for (const specId of strandedSpecIds) {
    if (await deps.resetStrandedSpec({ projectId, specId })) {
      requeuedSpecIds.push(specId);
    }
  }

  // If NOTHING reset (every blocked spec flipped out from under us), there is no
  // recovery to record — treat it as not-stranded (the next walk re-evaluates).
  if (requeuedSpecIds.length === 0) {
    return { kind: "not_stranded" };
  }

  await emitRecovered(deps.events, {
    orgId,
    projectId,
    stack,
    requeuedSpecIds,
    attempt,
    mergedCount,
    strandedSpecIds,
  });
  return { kind: "requeued", requeuedSpecIds, attempt };
}

async function emitRecovered(
  events: EventStore,
  input: {
    orgId: string;
    projectId: string;
    stack: string;
    requeuedSpecIds: string[];
    attempt: number;
    // The PROGRESS SIGNAL — durably recorded so the converged-vs-stuck judgement is
    // reconstructible from the event log across restarts.
    mergedCount: number;
    strandedSpecIds: ReadonlyArray<string>;
  },
): Promise<void> {
  try {
    await events.append({
      projectId: input.projectId,
      eventType: "template.build.recovered",
      payload: {
        orgId: input.orgId,
        stack: input.stack,
        requeuedSpecIds: input.requeuedSpecIds,
        attempt: input.attempt,
        mergedCount: input.mergedCount,
        strandedSpecIds: [...input.strandedSpecIds],
      },
    });
  } catch (error) {
    // The recovery already happened (the specs are reset); a missing observability
    // event must not undo it. Log loud, swallow — never mask the requeue.
    log.warn("failed to emit template.build.recovered (the requeue stands)", { projectId: input.projectId }, error);
  }
}

async function emitRecoveryExhausted(
  events: EventStore,
  input: {
    orgId: string;
    projectId: string;
    stack: string;
    strandedSpecIds: string[];
    mergedCount: number;
  },
): Promise<void> {
  try {
    await events.append({
      projectId: input.projectId,
      eventType: "template.build.recovery_exhausted",
      payload: {
        orgId: input.orgId,
        stack: input.stack,
        requeuedSpecIds: input.strandedSpecIds,
        mergedCount: input.mergedCount,
        strandedSpecIds: input.strandedSpecIds,
      },
    });
  } catch (error) {
    // The loud throw is the primary record; the durable event is the inspectable
    // counterpart. A sink failure must not swallow the terminal failure (the caller
    // re-throws), so log + continue to the throw.
    log.warn(
      "failed to emit template.build.recovery_exhausted (the terminal throw stands)",
      { projectId: input.projectId },
      error,
    );
  }
}

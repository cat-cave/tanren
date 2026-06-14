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
//   3. BOUNDS the recovery — PROGRESS-AWARE. The cap (`maxAttempts`) is NOT a flat
//      count of all recoveries: it counts only the CONSECUTIVE trailing recoveries
//      that made NO new forward progress. A build that is genuinely ADVANCING
//      between recoveries (more specs merged, or the set of terminally-stranded
//      specs changed) keeps recovering even past a flat K — it is converging, just
//      slowly. A build STUCK at the EXACT same failure (same merged count, same
//      stranded set) K consecutive times STILL exhausts: it STOPS and throws a LOUD
//      `TemplateBuildRecoveryExhaustedError` (a genuine "this stack's template
//      cannot be built autonomously" signal). The bound is preserved (a stuck build
//      MUST still terminate — never an infinite retry), it just forgives slow
//      convergence instead of killing it at a blind count.
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

const log = createLogger("template-recovery");

// The DEFAULT cap on CONSECUTIVE NO-PROGRESS auto-recoveries per template-build
// before a loud terminal failure. Bounded so a TRANSIENT/fixable failure self-heals
// (and a slowly-CONVERGING build keeps recovering — see the progress-aware bound
// below) while a PERMANENTLY-broken stack stuck at the SAME failure surfaces loudly
// instead of looping forever.
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

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

// Did the build make forward progress BETWEEN two recovery snapshots? True when more
// specs merged OR the set of terminally-stranded specs changed. (`prior` is the
// earlier signal; `current` the later.)
function madeProgress(prior: RecoveryProgressSignal, current: RecoveryProgressSignal): boolean {
  if (current.mergedCount !== prior.mergedCount) return true;
  return !sameSpecSet(prior.strandedSpecIds, current.strandedSpecIds);
}

// Set equality over two already-sorted-and-deduped id lists.
function sameSpecSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

// Normalize an id list to a sorted, deduped array (a stable canonical set for both
// equality and the durable record).
function normalizeSpecIds(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

// The COUNT toward the cap: the number of CONSECUTIVE TRAILING prior recoveries that
// made NO new progress, measured against the CURRENT snapshot. Walk the prior signals
// newest→oldest: the current snapshot is compared to the most-recent prior recovery;
// if it advanced, the streak is 0 (the build is converging — forgive). Otherwise it
// counts, and we keep walking back while each older recovery ALSO made no progress
// relative to its successor. The first progressing step stops the count. This is what
// `maxAttempts` bounds, so a slowly-advancing build keeps recovering while a build
// frozen at the same failure K consecutive times exhausts.
export function consecutiveNoProgressCount(
  priorRecoveries: ReadonlyArray<RecoveryProgressSignal>,
  current: RecoveryProgressSignal,
): number {
  let streak = 0;
  let next = current;
  for (let i = priorRecoveries.length - 1; i >= 0; i--) {
    const prior = priorRecoveries[i];
    if (prior === undefined) break;
    if (madeProgress(prior, next)) break;
    streak += 1;
    next = prior;
  }
  return streak;
}

// Thrown when the bounded auto-recovery hit its cap — the build STILL strands after
// `maxAttempts` recoveries. A LOUD, durable terminal failure (paired with the
// `template.build.recovery_exhausted` event): a genuine "this stack's template
// cannot be built autonomously", never a silent infinite loop. Surfaced by the
// creation flow exactly like `TemplateBuildFailedError` — the build aborts WITHOUT
// publishing.
export class TemplateBuildRecoveryExhaustedError extends Error {
  readonly projectId: string;
  readonly attempts: number;
  readonly strandedSpecIds: ReadonlyArray<string>;
  constructor(projectId: string, attempts: number, strandedSpecIds: ReadonlyArray<string>) {
    super(
      `template build ${projectId} STILL stranded after ${String(attempts)} auto-recovery attempt(s) — ` +
        `this stack's template cannot be built autonomously (stranded specs: ${strandedSpecIds.join(", ")})`,
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
  // project, in chronological order — the durable record that BOUNDS the recovery
  // in a PROGRESS-AWARE way (read from the event log, not an in-memory counter, so the bound
  // survives across derives/restarts). The consecutive-no-progress streak among these
  // (vs the current snapshot) is what `maxAttempts` caps; a flat count is NOT used.
  priorRecoveries: (projectId: string) => Promise<RecoveryProgressSignal[]>;
  // Whether this build already PUBLISHED a validated template — the belt-and-braces
  // "a succeeded build is NEVER re-driven" guard (the fast existing-match path
  // already short-circuits before here, but a resumed build is double-checked).
  hasPublishedValidatedTemplate: (projectId: string) => Promise<boolean>;
  // The durable event sink (`template.build.recovered` / `recovery_exhausted`).
  events: EventStore;
  // The cap on auto-recoveries before the loud terminal failure.
  maxAttempts?: number;
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
// `TemplateBuildRecoveryExhaustedError` (LOUD, bounded) when the cap is exceeded.
export async function recoverStrandedTemplateBuild(
  deps: TemplateBuildRecoveryDeps,
  input: { orgId: string; projectId: string; stack: string },
): Promise<TemplateBuildRecoveryOutcome> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
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

  // BOUND the recovery in a PROGRESS-AWARE way: count only the CONSECUTIVE prior recoveries
  // that made NO new progress (vs this snapshot). A genuinely-advancing build (more
  // merged, or a changed stranded set) resets the streak toward 0 and keeps
  // recovering; a build frozen at the SAME failure K consecutive times exhausts. If
  // the no-progress streak already MEETS the cap, STOP and surface the loud terminal
  // failure instead of requeuing again.
  const priorRecoveries = await deps.priorRecoveries(projectId);
  const noProgress = consecutiveNoProgressCount(priorRecoveries, current);
  if (noProgress >= maxAttempts) {
    await emitRecoveryExhausted(deps.events, { orgId, projectId, stack, strandedSpecIds, mergedCount, maxAttempts });
    throw new TemplateBuildRecoveryExhaustedError(projectId, noProgress, strandedSpecIds);
  }
  // The visible attempt number is the 1-based position in the consecutive no-progress
  // streak THIS recovery occupies (so a converging build keeps showing low attempts
  // even after many total recoveries — the bound it actually races).
  const attempt = noProgress + 1;

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
    maxAttempts,
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
    maxAttempts: number;
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
        maxAttempts: input.maxAttempts,
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
    maxAttempts: number;
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
        maxAttempts: input.maxAttempts,
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

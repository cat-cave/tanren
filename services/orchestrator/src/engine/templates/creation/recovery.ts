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
//   3. BOUNDS the recovery — caps the number of auto-recoveries per build
//      (`maxAttempts`). After K recoveries that STILL strand, it STOPS and throws a
//      LOUD `TemplateBuildRecoveryExhaustedError` (a genuine "this stack's template
//      cannot be built autonomously" signal) — never an infinite retry, never
//      papering over a permanently-broken stack.
//   4. EMITS durable events — `template.build.recovered` per requeue,
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

// The DEFAULT cap on auto-recoveries per template-build before a loud terminal
// failure. Bounded so a TRANSIENT/fixable failure self-heals while a PERMANENTLY-
// broken stack surfaces loudly instead of looping forever.
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

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
  // Count prior `template.build.recovered` events for this build project — the
  // attempt counter that BOUNDS the recovery (read from the durable event log, not
  // an in-memory counter, so the bound survives across derives/restarts).
  priorRecoveryCount: (projectId: string) => Promise<number>;
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
  const strandedSpecIds = snapshot.nodes.filter((n) => n.phase === "terminal_blocked").map((n) => n.specId);
  if (strandedSpecIds.length === 0) {
    return { kind: "not_stranded" };
  }

  // BOUND the recovery: count prior recoveries that did NOT converge. The 1-based
  // attempt THIS recovery would be is `prior + 1`; if that would EXCEED the cap, STOP
  // and surface the loud terminal failure instead of requeuing again.
  const prior = await deps.priorRecoveryCount(projectId);
  if (prior >= maxAttempts) {
    await emitRecoveryExhausted(deps.events, { orgId, projectId, stack, strandedSpecIds, maxAttempts });
    throw new TemplateBuildRecoveryExhaustedError(projectId, prior, strandedSpecIds);
  }
  const attempt = prior + 1;

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

  await emitRecovered(deps.events, { orgId, projectId, stack, requeuedSpecIds, attempt, maxAttempts });
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
  input: { orgId: string; projectId: string; stack: string; strandedSpecIds: string[]; maxAttempts: number },
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

// The intent-preserving conflict-resolution seam (autonomy-engine.md §2b;
// PROJECT_BRIEF §2.2). This is the project's DIFFERENTIATED capability: when the
// merging spec's PR conflicts with what is now on the base branch, a conflict is
// treated as a RE-PLANNING problem, not a text-picking problem. The resolver has
// BOTH conflicting specs' intent + acceptance criteria and the DAG edge between
// them, so it resolves to satisfy BOTH intents, then RE-GATES (gate + checker +
// auditor over the resolved tree) before any merge. A mechanical resolver (git
// rerere) that only picks text is exactly what this is NOT.
//
// This contract carries the SEAMS the resolver composes (provenance read · the
// workspace conflict applier · the conflict Answerer · the re-gate · the replan
// router) plus the PURE decision core (`decideConflictResolution`) so the
// resolve-vs-route-back decision is conformance-tested independent of any
// database, runner, or model. The production wirings live in
// `engine/workflow/reviewMerge/conflictResolver/**`; the noop default moves to
// `tests/fixtures/` (P8a §8a — the lint forbids it in src/).

import type { ConflictAnswer } from "../answerers/schemas/conflict.js";

// ---- Provenance (which other spec, and the DAG edge) ----------------------

/**
 * The other side of a conflict, identified from the DAG + the conflicting files'
 * recent merge provenance. `conflictingSpecId` is the spec whose most-recently-
 * merged run last touched the conflicting files on the base branch (the change
 * the merging spec collided with); `dagEdge` is whether a persisted dependency
 * edge connects the two specs (either direction) — the signal that this is a
 * known ancestor/dependent collision the resolver reasons over. When no other
 * spec can be attributed (the conflict is against un-attributed base history),
 * `conflictingSpecId` is undefined and the resolver still proceeds with the
 * merging spec's intent alone — never silently dropping the merge.
 */
export interface ConflictProvenance {
  conflictingSpecId?: string;
  /** The conflicting spec's title/description/acceptance-criteria, when resolvable. */
  conflictingSpecIntent?: SpecIntent;
  /** True when a persisted spec-dependency edge connects the two specs. */
  dagEdge: boolean;
}

/** A spec's intent surface the Answerer reasons over (both sides carry one). */
export interface SpecIntent {
  specId: string;
  title: string;
  description: string;
  acceptanceCriteria: ReadonlyArray<string>;
}

/**
 * Reads the conflict's DAG/provenance context under RLS: given the merging spec
 * and the conflicting file paths, find the OTHER spec whose merged run last
 * touched those files and whether a DAG edge connects them. DAG state is the
 * source of truth (read fresh, org-scoped).
 */
export interface ConflictProvenanceReader {
  read(input: {
    projectId: string;
    mergingSpecId: string;
    conflictedFiles: ReadonlyArray<string>;
  }): Promise<ConflictProvenance>;
}

// ---- The workspace conflict applier (over the runner) ---------------------

/** One conflicted file: its path + the raw conflicted content (markers intact). */
export interface ConflictedFile {
  path: string;
  /** The file content WITH `<<<<<<< / ======= / >>>>>>>` markers, for the Answerer. */
  conflictedContent: string;
}

/** The hunks gathered by attempting the merge/rebase over the runner workspace. */
export interface GatheredConflict {
  files: ConflictedFile[];
}

/**
 * Performs the merge/rebase of the PR branch onto the current base OVER THE
 * RUNNER WORKSPACE and reads back the conflicted files + their hunks (the markers
 * the Answerer reasons over) — the VcsProvider's `updateBranch` only tells us a
 * conflict EXISTS; here we actually need the hunks. After the Answerer resolves,
 * `applyResolution` writes the resolved file contents into the SAME workspace
 * tree (markers removed) so the re-gate runs against the resolved tree. Neither
 * step pushes — the resolver re-gates first; only a clean re-gate proceeds to the
 * merge path.
 */
export interface WorkspaceConflictApplier {
  /** Attempt the merge/rebase in the workspace; return the conflicted files. */
  gather(): Promise<GatheredConflict>;
  /** Write the resolved file contents into the workspace tree (markers removed). */
  applyResolution(resolved: ReadonlyArray<{ path: string; content: string }>): Promise<void>;
  /** Commit + push the resolved tree onto the PR branch (only after a clean re-gate). */
  publishResolved(): Promise<void>;
  /** Abandon the in-progress merge/rebase (irreconcilable / failed re-gate path). */
  abort(): Promise<void>;
}

// ---- The product vision (the resolution must honor + judge against it) -----

/** A persona the resolution must honor: who they are + their delivery surface. */
export interface ProductVisionPersona {
  name: string;
  description: string;
  /** The delivery surface (handheld / ops dashboard / …), when captured. */
  surface?: string;
}

/** A persona-behavior the resolution must keep true (BDD Given/When/Then). */
export interface ProductVisionBehavior {
  /** The persona this behavior belongs to (so a contradiction is attributable). */
  persona: string;
  title: string;
  given: string;
  when: string;
  /** The BDD `then` (the observable outcome the persona expects). */
  thenOutcome: string;
}

/**
 * The product-vision context the resolver frames a resolution against AND uses to
 * judge whether the two specs' intents genuinely clash. `personas` are the
 * project's personas; `behaviors` are the persona-behaviors linked to the two
 * conflicting specs (the surface where a genuine persona-behavior CONTRADICTION
 * would show up); `designDna` is the captured identity/design note. Every field
 * may be empty — a genuinely empty product (no personas/behaviors yet) yields an
 * empty vision, which the prompt OMITS (a real empty state, never a stub).
 */
export interface ProductVision {
  personas: ReadonlyArray<ProductVisionPersona>;
  behaviors: ReadonlyArray<ProductVisionBehavior>;
  /** The captured product identity pitch + design-DNA (one short note), when present. */
  designDna?: string;
}

/** True when the vision carries NO signal at all (the prompt omits the section). */
export function isProductVisionEmpty(vision: ProductVision): boolean {
  return (
    vision.personas.length === 0 &&
    vision.behaviors.length === 0 &&
    (vision.designDna === undefined || vision.designDna.trim() === "")
  );
}

/**
 * Loads the product vision for a project + the two conflicting specs, RLS-scoped
 * read-only: the project's personas, the behaviors linked to the two specs, and
 * the captured design-DNA/identity. A genuinely empty product (no personas /
 * behaviors / design-DNA) returns an empty vision — never an error, never a stub.
 */
export interface ProductVisionReader {
  read(input: { projectId: string; mergingSpecId: string; conflictingSpecId?: string }): Promise<ProductVision>;
}

// ---- The conflict Answerer invocation -------------------------------------

/**
 * autonomy-engine.md §2c change-percolation: the UPSTREAM-CHANGE framing.
 * When an ANCESTOR A changes after a dependent B started speculatively, the SAME
 * intent-preserving resolver runs — but the model is told the conflict it sees is
 * A's INTENTIONAL upstream change flowing INTO B (not a symmetric two-spec
 * collision). The resolver must apply A's change into B WHILE KEEPING B's work
 * intact (the `resolve` outcome), or — if that is impossible — route B back to the
 * planner with A's change as context (the `irreconcilable` outcome, mapped to the
 * `merging` side = B). The decision core (`decideConflictResolution`) is unchanged;
 * only the prompt framing differs, so the answer schema + invariants are reused.
 */
export interface UpstreamChangeContext {
  /** The ancestor whose intentional change must flow down into the dependent. */
  ancestorSpecId: string;
  /** A summary of what changed upstream (new commits / new finding / changes-requested). */
  changeSummary: string;
}

/** Invokes the conflict-resolution Answerer with both intents + hunks + the edge. */
export interface ConflictAnswererInvoker {
  resolve(input: {
    mergingSpecIntent: SpecIntent;
    conflictingSpecIntent?: SpecIntent;
    dagEdge: boolean;
    conflictedFiles: ReadonlyArray<ConflictedFile>;
    /**
     * present iff this is an UPSTREAM-CHANGE percolation (not a symmetric
     * merge conflict). It reframes the prompt — apply the ancestor's change into
     * the dependent while keeping the dependent's work intact — without changing
     * the answer schema or the `decideConflictResolution` invariants.
     */
    upstreamChange?: UpstreamChangeContext;
    /**
     * The product vision (personas / persona-behaviors / design-DNA) the
     * resolution must honor AND judge the clash against. Additive + OPTIONAL: it
     * enriches the SIGNAL the resolver classifies on (a real persona-behavior
     * contradiction is the legitimate `irreconcilable` product decision; a
     * mechanical clash with compatible intents stays auto-resolvable) WITHOUT
     * changing the answer schema or the `decideConflictResolution` invariants.
     * Absent / empty (a genuinely empty product) ⇒ the prompt omits the section.
     */
    productVision?: ProductVision;
  }): Promise<ConflictAnswer>;
}

// ---- The re-gate over the resolved tree -----------------------------------

/** The terminal verdict of re-running gate + checker + auditor on the resolved tree. */
export interface ReGateVerdict {
  passed: boolean;
  /** Which stage failed (for the irreconcilable diagnosis), when !passed. */
  failedStage?: "gate" | "checker" | "auditor";
  reason: string;
}

/**
 * Re-runs the in-loop gate + checker + auditor against the RESOLVED workspace
 * tree (NOT the speculative one). Reuses the existing gate/checker/auditor run
 * path — the resolver NEVER merges an unverified resolution. Only a clean
 * re-gate lets the merge proceed.
 */
export interface ResolvedTreeReGate {
  reGate(input: { resolvedFiles: ReadonlyArray<string> }): Promise<ReGateVerdict>;
}

// ---- Recovery ownership receipts (conflict / gate-rework settlement) -------

/**
 * Durable evidence that a recovery run exists. `already_running` MUST name an
 * independently verified live run id — SpecNotRunnableError alone is never ownership.
 */
export type RecoveryRunReceipt =
  | { kind: "enqueued"; replanRunId: string; plannerTaskId: string }
  | { kind: "already_running"; runId: string };

/** Planner owns the unresolved conflict through a confirmed live re-plan run. */
export interface PlannerRecoveryReceipt {
  kind: "planner_replan";
  specId: string;
  run: RecoveryRunReceipt;
}

/** Writer owns a failed fresh gate through a confirmed live re-author run. */
export interface WriterRecoveryReceipt {
  kind: "writer_rework";
  specId: string;
  run: RecoveryRunReceipt;
}

export type ConflictRecoveryReceipt = PlannerRecoveryReceipt | WriterRecoveryReceipt;

/** Concurrent terminal statuses the needs_attention park must never clobber. */
export type TerminalParkNoopStatus = "merged" | "cancelled" | "halted";

/**
 * Router dispositions — routers do not mutate needs-attention separately from
 * queue retirement. Settlement owns RecoveryParkWriter when parking is required.
 *   owned            — durable planner/writer owner receipt
 *   parking_required — no durable owner; settlement must park atomically
 *   terminal_noop    — concurrent merged|cancelled|halted; no park event
 *   parking_failed   — sole park attempt failed (when a caller delegated park)
 */
export type ReplanRouteResult =
  | { kind: "owned"; receipt: PlannerRecoveryReceipt }
  | { kind: "parking_required"; message: string }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | { kind: "parking_failed"; message: string; observedStatus?: string };

export type GateReworkRouteResult =
  | { kind: "owned"; receipt: WriterRecoveryReceipt }
  | { kind: "parking_required"; message: string }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | { kind: "parking_failed"; message: string; observedStatus?: string };

export type ConflictRecoveryDisposition =
  | { kind: "owned"; receipt: ConflictRecoveryReceipt }
  | { kind: "parking_required"; message: string }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | { kind: "parking_failed"; message: string; observedStatus?: string };

/**
 * Settlement result after the sole atomic recovery authority has consumed a
 * router disposition. `parking_required` can never escape this boundary: it is
 * either durably `parked`, or becomes a paced `parking_failed` while the exact
 * queue owner remains retained or unknown. Only these settled results may drive a
 * base-shift/percolation terminal decision.
 */
export type ConflictRecoverySettlement =
  | { kind: "owned"; receipt: ConflictRecoveryReceipt }
  | { kind: "parked"; newlyParked: boolean }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | {
      kind: "parking_failed";
      message: string;
      queueDisposition: "retained" | "unknown";
      retryAfterMs: number;
    };

export type DurableConflictRecoverySettlement = Exclude<ConflictRecoverySettlement, { kind: "parking_failed" }>;

// ---- The replan router (intent stays alive) -------------------------------

/**
 * Routes ONE spec back to the planner with the OTHER spec's change as new
 * context, so the intent stays ALIVE rather than being silently dropped or
 * merged. Wired to the existing planner/replan path (the spec returns to a
 * status that can be re-planned, carrying the other's change as steering context).
 * Returns a typed ownership disposition — never fabricates replanned without a receipt.
 */
export interface ReplanRouter {
  routeBackToPlanner(input: {
    specId: string;
    newContext: string;
    /** The other spec whose change the re-planned spec must build on. */
    otherSpecId?: string;
  }): Promise<ReplanRouteResult>;
}

// ---- The gate-rework router (a re-gate GATE-tier failure → writer rework) ----

/**
 * Routes the merging spec to WRITER REWORK when a pre-merge / base-shift re-gate fails
 * because a GATE TIER failed (lint/test/build) on a cleanly-rebased-or-resolved tree —
 * NOT because the intents are irreconcilable. The rebase/resolution succeeded; the code
 * just fails a deterministic gate on the new base, which the writer can fix. This is the
 * SAME never-discard re-author the batch path (`BatchGateReworkRouter`) and a conflict
 * replan use, carrying the re-gate's failing tier/step/output as steering so the writer
 * fixes the RIGHT thing (no_silent_fallback — never rework blind).
 *
 * DISTINCT from {@link ReplanRouter}: a genuine merge conflict (irreconcilable intents, OR
 * a checker/auditor rejection of the resolved tree) routes to replan; a GATE-tier re-gate
 * failure routes HERE. It must NOT be conflated with `merge.conflict.irreconcilable` and
 * must NOT directly escalate — escalation is owned by the convergence detector (a genuine
 * dead-end fixed point, never a count).
 */
export interface GateReworkRouter {
  routeGateFailToRework(input: {
    /** The merging spec whose rebased/resolved tree failed a GATE tier — to re-author. */
    specId: string;
    /** The re-gate's failing tier/step/output — the steering the writer re-authors against. */
    gateError: string;
  }): Promise<GateReworkRouteResult>;
}

// ---- The pure decision core -----------------------------------------------

/** Which spec the irreconcilable verdict routes back to the planner. */
export interface ReplanTarget {
  specId: string;
  which: "merging" | "base";
  newContext: string;
  otherSpecId?: string;
}

/** The pure decision the resolver acts on (no I/O): how to dispatch an Answer. */
export type ConflictDecision =
  | { kind: "apply"; resolvedFiles: ReadonlyArray<{ path: string; content: string }> }
  | { kind: "irreconcilable"; reason: string; replan?: ReplanTarget };

export class ConflictAnswerInvalidError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(`conflict answer invalid: ${message}`);
    this.name = "ConflictAnswerInvalidError";
  }
}

/**
 * The PURE decision core: map a schema-validated {@link ConflictAnswer} + the two
 * specs' ids onto the action the resolver takes, enforcing the cross-field
 * invariants the Answerer schema cannot express alone. This is the behavior the
 * conformance suite pins independent of any model/DB/runner.
 *
 *   - decision 'resolve'         requires a NON-EMPTY resolvedFiles list AND a
 *                                null replanSpec → `{ kind: 'apply', resolvedFiles }`.
 *                                An empty resolvedFiles is a non-conforming answer
 *                                (a `resolve` that resolves nothing), rejected so
 *                                an empty resolution can never silently merge.
 *   - decision 'irreconcilable'  requires a replanSpec (which + newContext) →
 *                                `{ kind: 'irreconcilable', replan }`, mapping
 *                                `which` to the concrete spec id from the two the
 *                                resolver presented. A missing replanSpec is also
 *                                rejected — an irreconcilable answer MUST name the
 *                                spec to keep alive, never drop one silently.
 *
 * `mergingSpecId` / `conflictingSpecId` are the two specs the resolver presented;
 * `which: 'base'` with no `conflictingSpecId` resolved is rejected (cannot route
 * a spec we could not attribute), surfacing as a `merging`-side replan fallback
 * is NOT done silently — the caller decides. Here we throw so the resolver emits
 * the irreconcilable event WITHOUT a phantom replan target.
 */
export function decideConflictResolution(
  answer: ConflictAnswer,
  specs: { mergingSpecId: string; conflictingSpecId?: string },
): ConflictDecision {
  if (answer.decision === "resolve") {
    if (answer.resolvedFiles.length === 0) {
      throw new ConflictAnswerInvalidError("decision 'resolve' must carry at least one resolved file");
    }
    if (answer.replanSpec !== null) {
      throw new ConflictAnswerInvalidError("decision 'resolve' must not carry a replanSpec");
    }
    return {
      kind: "apply",
      resolvedFiles: answer.resolvedFiles.map((f) => ({ path: f.path, content: f.content })),
    };
  }
  // decision === 'irreconcilable'
  if (answer.resolvedFiles.length > 0) {
    throw new ConflictAnswerInvalidError("decision 'irreconcilable' must not carry resolved files");
  }
  const replanSpec = answer.replanSpec;
  if (replanSpec === null) {
    throw new ConflictAnswerInvalidError("decision 'irreconcilable' must name the spec to re-plan (replanSpec)");
  }
  const target = resolveReplanTarget(replanSpec.which, replanSpec.newContext, specs);
  return { kind: "irreconcilable", reason: answer.reasoning, replan: target };
}

function resolveReplanTarget(
  which: "merging" | "base",
  newContext: string,
  specs: { mergingSpecId: string; conflictingSpecId?: string },
): ReplanTarget {
  if (which === "merging") {
    return {
      which,
      specId: specs.mergingSpecId,
      newContext,
      otherSpecId: specs.conflictingSpecId,
    };
  }
  // which === 'base': re-plan the OTHER spec. It must have been attributed.
  if (specs.conflictingSpecId === undefined) {
    throw new ConflictAnswerInvalidError(
      "decision 'irreconcilable' routed the 'base' spec but no conflicting spec was attributed",
    );
  }
  return {
    which,
    specId: specs.conflictingSpecId,
    newContext,
    otherSpecId: specs.mergingSpecId,
  };
}

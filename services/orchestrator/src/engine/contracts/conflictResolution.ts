// The intent-preserving conflict-resolution seam (autonomy-engine.md §2b;
// PROJECT_BRIEF §2.2). This is the project's DIFFERENTIATED capability: when the
// merging spec's PR conflicts with what is now on the base branch, a conflict is
// treated as a RE-PLANNING problem, not a text-picking problem. The resolver has
// BOTH conflicting specs' intent + acceptance criteria and the DAG edge between
// them, so it resolves to satisfy BOTH intents, then RE-GATES (gate + checker +
// auditor over the resolved tree) before any merge. A mechanical resolver (git
// rerere / Mergify) that only picks text is exactly what this is NOT.
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
 * P2a merge path.
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

// ---- The conflict Answerer invocation -------------------------------------

/** Invokes the conflict-resolution Answerer with both intents + hunks + the edge. */
export interface ConflictAnswererInvoker {
  resolve(input: {
    mergingSpecIntent: SpecIntent;
    conflictingSpecIntent?: SpecIntent;
    dagEdge: boolean;
    conflictedFiles: ReadonlyArray<ConflictedFile>;
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

// ---- The replan router (intent stays alive) -------------------------------

/**
 * Routes ONE spec back to the planner with the OTHER spec's change as new
 * context, so the intent stays ALIVE rather than being silently dropped or
 * merged. Wired to the existing planner/replan path (the spec returns to a
 * status that can be re-planned, carrying the other's change as steering context).
 */
export interface ReplanRouter {
  routeBackToPlanner(input: {
    specId: string;
    newContext: string;
    /** The other spec whose change the re-planned spec must build on. */
    otherSpecId?: string;
  }): Promise<void>;
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

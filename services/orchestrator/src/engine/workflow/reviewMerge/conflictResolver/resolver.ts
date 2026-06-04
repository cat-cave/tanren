// The intent-preserving conflict resolver (autonomy-engine.md §2b) — the
// production replacement for `noopConflictResolver`. It composes the
// conflict-resolution seams (engine/contracts/conflictResolution.ts) into the
// `ConflictResolverHook` the merge dispatcher invokes on a detected conflict:
//
//   1. Gather the conflict hunks over the runner workspace (merge/rebase the PR
//      branch onto base; read the conflicted files + markers).
//   2. Identify the OTHER conflicting spec + the DAG edge via the provenance
//      reader (DAG + the conflicting files' recent merge provenance).
//   3. Invoke the conflict-resolution Answerer with BOTH specs' intent +
//      acceptance criteria + the hunks + the DAG edge → a schema-validated
//      ConflictAnswer (`resolve` with a both-intents tree, or `irreconcilable`).
//   4. On `resolve`: apply the resolution to the tree, RE-RUN gate + checker +
//      auditor against the RESOLVED tree; only on a clean re-gate publish the
//      resolved branch and return `{ resolved: true }` so the dispatcher retries
//      the merge through the P2a path. An unverified resolution NEVER merges.
//   5. On `irreconcilable` (or a FAILED re-gate): route ONE spec back to the
//      planner with the other's change as new context (intent stays ALIVE),
//      abort the in-progress merge, and return `{ resolved: false }` so the
//      dispatcher emits the recoverable merge.conflict outcome — NOT a merge.
//
// Every step emits an inspectable event (merge.conflict.resolving / .resolved /
// .irreconcilable) and the resolution diff is the set of rewritten files. The
// resolver is read/write-split-clean: the Answerer is read-only (it only judges
// + returns the structured plan); the WorkspaceConflictApplier owns producing
// the diff over the runner; the resolver never blurs the two.

import type { EventStore } from "../../../eventStore.js";
import {
  decideConflictResolution,
  isProductVisionEmpty,
  type ConflictAnswererInvoker,
  type ConflictProvenanceReader,
  type ProductVisionReader,
  type ReplanRouter,
  type ResolvedTreeReGate,
  type SpecIntent,
  type WorkspaceConflictApplier,
} from "../../../contracts/conflictResolution.js";
import type { ConflictContext, ConflictResolverHook } from "../mergeDispatchTypes.js";

export interface IntentPreservingResolverDeps {
  /** The run's project + the merging spec + its intent (captured per-run). */
  projectId: string;
  mergingSpecIntent: SpecIntent;
  eventStore: EventStore;
  /** Identify the other conflicting spec + the DAG edge (DAG provenance). */
  provenance: ConflictProvenanceReader;
  /**
   * Loads the PRODUCT VISION (personas / persona-behaviors / design-DNA) for this
   * project + the two conflicting specs, so the Answerer frames the resolution
   * against the product AND judges whether the two intents genuinely clash. A
   * genuinely empty product (no personas/behaviors) yields an empty vision the
   * prompt omits. OPTIONAL: omitted ⇒ the resolver reasons on spec intents alone
   * (the pre-vision behavior, unchanged), never a stub.
   */
  productVision?: ProductVisionReader;
  /** Gather hunks + apply/publish/abort the resolution over the runner workspace. */
  applier: WorkspaceConflictApplier;
  /** The conflict-resolution Answerer (read-only; both intents + hunks + edge). */
  answerer: ConflictAnswererInvoker;
  /** Re-run gate + checker + auditor against the resolved tree (never merge unverified). */
  reGate: ResolvedTreeReGate;
  /** Route one spec back to the planner with the other's change (intent stays alive). */
  replan: ReplanRouter;
  /**
   * P2c-2 (change-percolation): present when THIS run is a percolation re-execution
   * — the ancestor whose intentional upstream change must flow IN. It reframes the
   * Answerer into UPSTREAM-CHANGE mode (apply the ancestor's change INTO the
   * dependent, keeping its work intact). Absent for a normal symmetric conflict.
   */
  upstreamChange?: { ancestorSpecId: string; changeSummary: string };
}

/**
 * Build the production `intentPreservingConflictResolver` for a run. The returned
 * hook is what the merge dispatcher's `resolveConflict` slot receives in place of
 * `noopConflictResolver`. It returns `{ resolved: true }` ONLY after a clean
 * re-gate of an applied resolution; every other path (no resolution, failed
 * re-gate, irreconcilable) returns `{ resolved: false }` and keeps the merging
 * spec's intent alive (the dispatcher then emits the recoverable conflict).
 */
export function buildIntentPreservingConflictResolver(deps: IntentPreservingResolverDeps): ConflictResolverHook {
  return async (context: ConflictContext): Promise<{ resolved: boolean }> => {
    const gathered = await deps.applier.gather();
    const conflictedPaths = gathered.files.map((f) => f.path);
    const provenance = await deps.provenance.read({
      projectId: deps.projectId,
      mergingSpecId: deps.mergingSpecIntent.specId,
      conflictedFiles: conflictedPaths,
    });

    await deps.eventStore.append({
      runId: context.runId,
      specId: deps.mergingSpecIntent.specId,
      projectId: deps.projectId,
      eventType: "merge.conflict.resolving",
      payload: {
        prUrl: context.prUrl,
        prNumber: context.prNumber,
        integration: "direct_merge",
        baseBranch: context.baseBranch,
        mergingSpecId: deps.mergingSpecIntent.specId,
        ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
        dagEdge: provenance.dagEdge,
        conflictedFiles: conflictedPaths,
      },
    });

    // Load the product vision (personas / persona-behaviors / design-DNA) for the
    // two conflicting specs so the Answerer frames the resolution against the
    // product AND judges whether the intents genuinely clash. An empty product
    // (no personas/behaviors) yields an empty vision the prompt omits (a real
    // empty state). The reader is optional: omitted ⇒ judge on intents alone.
    const productVision =
      deps.productVision === undefined
        ? undefined
        : await deps.productVision.read({
            projectId: deps.projectId,
            mergingSpecId: deps.mergingSpecIntent.specId,
            ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
          });

    const answer = await deps.answerer.resolve({
      mergingSpecIntent: deps.mergingSpecIntent,
      ...(provenance.conflictingSpecIntent !== undefined && {
        conflictingSpecIntent: provenance.conflictingSpecIntent,
      }),
      dagEdge: provenance.dagEdge,
      conflictedFiles: gathered.files,
      // The product-vision section is included only when it carries signal — an
      // empty vision is omitted (the prompt builder also guards this).
      ...(productVision !== undefined && !isProductVisionEmpty(productVision) && { productVision }),
      // P2c-2: in a percolation re-execution, reframe into upstream-change mode so
      // the ancestor's intentional change flows INTO this dependent (keeping its
      // work intact), and an irreconcilable answer re-plans THIS spec (the merging
      // side) WITH the ancestor's change — the now-reachable replan path.
      ...(deps.upstreamChange !== undefined && { upstreamChange: deps.upstreamChange }),
    });

    const decision = decideConflictResolution(answer, {
      mergingSpecId: deps.mergingSpecIntent.specId,
      ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
    });

    if (decision.kind === "irreconcilable") {
      return routeIrreconcilable(deps, context, provenance, decision.reason, decision.replan, false);
    }

    // decision.kind === "apply": write the resolved tree, then RE-GATE it.
    await deps.applier.applyResolution(decision.resolvedFiles);
    const resolvedPaths = decision.resolvedFiles.map((f) => f.path);
    const verdict = await deps.reGate.reGate({ resolvedFiles: resolvedPaths });

    if (!verdict.passed) {
      // A resolution that does not survive the re-gate is NOT a resolution — it
      // is an irreconcilable outcome surfaced by reality (the gate/checker/auditor
      // judged the resolved tree). Route the merging spec back to the planner with
      // the conflicting change as context; NEVER merge an unverified tree.
      const reason = `re-gate failed (${verdict.failedStage ?? "unknown"}): ${verdict.reason}`;
      const replan = {
        which: "merging" as const,
        specId: deps.mergingSpecIntent.specId,
        newContext: replanContextFromConflict(provenance.conflictingSpecIntent, reason),
        ...(provenance.conflictingSpecId !== undefined && { otherSpecId: provenance.conflictingSpecId }),
      };
      return routeIrreconcilable(deps, context, provenance, reason, replan, true);
    }

    // Clean re-gate: publish the resolved branch; the dispatcher retries the
    // merge through the P2a path. The resolution diff is the rewritten files.
    await deps.applier.publishResolved();
    await deps.eventStore.append({
      runId: context.runId,
      specId: deps.mergingSpecIntent.specId,
      projectId: deps.projectId,
      eventType: "merge.conflict.resolved",
      payload: {
        prUrl: context.prUrl,
        prNumber: context.prNumber,
        integration: "direct_merge",
        baseBranch: context.baseBranch,
        mergingSpecId: deps.mergingSpecIntent.specId,
        ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
        resolvedFiles: resolvedPaths,
        reGated: true,
      },
    });
    return { resolved: true };
  };
}

/**
 * The irreconcilable / failed-re-gate tail: route the chosen spec back to the
 * planner (intent stays alive), abort the in-progress merge, emit the inspectable
 * event, and signal the dispatcher to emit the recoverable conflict (NOT a merge).
 * `fromFailedReGate` distinguishes the Answerer's diagnosis from a re-gate failure.
 */
async function routeIrreconcilable(
  deps: IntentPreservingResolverDeps,
  context: ConflictContext,
  provenance: { conflictingSpecId?: string },
  reason: string,
  replan: { which: "merging" | "base"; specId: string; newContext: string; otherSpecId?: string } | undefined,
  fromFailedReGate: boolean,
): Promise<{ resolved: false }> {
  if (replan !== undefined) {
    await deps.replan.routeBackToPlanner({
      specId: replan.specId,
      newContext: replan.newContext,
      ...(replan.otherSpecId !== undefined && { otherSpecId: replan.otherSpecId }),
    });
  }
  await deps.applier.abort();
  await deps.eventStore.append({
    runId: context.runId,
    specId: deps.mergingSpecIntent.specId,
    projectId: deps.projectId,
    eventType: "merge.conflict.irreconcilable",
    payload: {
      prUrl: context.prUrl,
      prNumber: context.prNumber,
      integration: "direct_merge",
      baseBranch: context.baseBranch,
      mergingSpecId: deps.mergingSpecIntent.specId,
      ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
      ...(replan !== undefined && { replanned: replan.which, replannedSpecId: replan.specId }),
      reason,
      fromFailedReGate,
    },
  });
  return { resolved: false };
}

/** Build the new planning context for a spec routed back after a conflict. */
function replanContextFromConflict(conflictingIntent: SpecIntent | undefined, reason: string): string {
  const other =
    conflictingIntent === undefined
      ? "the change already on the base branch"
      : `the change from spec "${conflictingIntent.title}" (${conflictingIntent.specId}): ${conflictingIntent.description}`;
  return [
    "A merge conflict could not be auto-resolved while preserving both intents.",
    `Re-plan this spec ON TOP OF ${other}.`,
    `Diagnosis: ${reason}`,
  ].join("\n");
}

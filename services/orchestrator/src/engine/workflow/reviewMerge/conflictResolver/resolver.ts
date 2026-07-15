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
//      the merge through the up-to-date path. An unverified resolution NEVER merges.
//   5. On `irreconcilable` (or a FAILED re-gate): route ONE spec back to the
//      planner with the other's change as new context (intent stays ALIVE),
//      abort the in-progress merge, and return its durable ownership/parking
//      receipt with `{ resolved: false }` — NOT a merge.
//
// Every step emits an inspectable event (merge.conflict.resolving / .resolved /
// .irreconcilable) and the resolution diff is the set of rewritten files. The
// resolver is read/write-split-clean: the Answerer is read-only (it only judges
// + returns the structured plan); the WorkspaceConflictApplier owns producing
// the diff over the runner; the resolver never blurs the two.

import type { EventStore } from "../../../eventStore.js";
import {
  ConflictAnswerInvalidError,
  type ConflictRecoveryDisposition,
  decideConflictResolution,
  isProductVisionEmpty,
  type ConflictAnswererInvoker,
  type ConflictProvenance,
  type ConflictProvenanceReader,
  type GateReworkRouter,
  type ProductVisionReader,
  type ReGateVerdict,
  type ReplanRouter,
  type ResolvedTreeReGate,
  type SpecIntent,
  type WorkspaceConflictApplier,
} from "../../../contracts/conflictResolution.js";
import type { ConflictContext, ConflictResolverHook, ConflictResolverResult } from "../mergeDispatchTypes.js";
import { createLogger } from "../../../observability/logger.js";
import type { EntityMergeOutcome } from "./entityMergeFirstPass.js";

const log = createLogger("conflict-resolver");

/**
 * §3.2 the DETERMINISTIC ENTITY-MERGE FIRST-PASS. Given the conflicted paths, attempt a
 * `weave`-inspired entity-level resolution (two edits to DIFFERENT entities of the same file
 * are not a real conflict): on success the merged file contents are returned and the agent
 * resolver is SKIPPED; on a defer (same-entity edit, `sem` absent/errored, unprovable
 * disjointness) the agent resolver runs exactly as today. NEVER throws.
 */
export interface EntityMergeFirstPassHook {
  attempt(input: { conflictedPaths: ReadonlyArray<string> }): Promise<EntityMergeOutcome>;
}

export interface IntentPreservingResolverDeps {
  /** The run's project + the merging spec + its intent (captured per-run). */
  projectId: string;
  /** The run's REQUIRED tenant key (v68 fix). Stamped on every eventStore.append
   * directly rather than re-derived via a SELECT-join — a null org_id row trips RLS. */
  orgId: string;
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
  /**
   * §3.2 the deterministic entity-merge FIRST-PASS (optional). When present, it runs AFTER
   * `gather()` and BEFORE the agent Answerer: a different-entity-same-file conflict is
   * spliced deterministically (the agent is skipped, but the spliced tree still re-gates);
   * anything not provably entity-disjoint defers to the agent path below, unchanged. Absent
   * ⇒ the resolver behaves exactly as before this PR (the agent resolves every conflict).
   */
  entityFirstPass?: EntityMergeFirstPassHook;
  /** The conflict-resolution Answerer (read-only; both intents + hunks + edge). */
  answerer: ConflictAnswererInvoker;
  /** Re-run gate + checker + auditor against the resolved tree (never merge unverified). */
  reGate: ResolvedTreeReGate;
  /** Route one spec back to the planner with the other's change (intent stays alive). */
  replan: ReplanRouter;
  /**
   * Route the merging spec to WRITER REWORK when the re-gate fails because a GATE TIER
   * failed (lint/test/build) on a cleanly-rebased-or-resolved tree — NOT because the
   * intents are irreconcilable. A clean rebase + a failed gate is the WRITER's to fix on
   * the new base; it must NOT be conflated with `merge.conflict.irreconcilable` / escalate.
   * OPTIONAL: when absent, a GATE-tier failure uses the planner path rather than claiming
   * writer ownership. Production always wires it. A checker/auditor re-gate rejection (a genuine
   * resolved-tree-doesn't-fit verdict) stays on the replan path regardless.
   */
  gateRework?: GateReworkRouter;
  /**
   * change-percolation: present when THIS run is a percolation re-execution
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
 * re-gate, irreconcilable) returns `{ resolved: false }` with an explicit durable
 * recovery disposition; the dispatcher never infers ownership from a boolean.
 */
export function buildIntentPreservingConflictResolver(deps: IntentPreservingResolverDeps): ConflictResolverHook {
  return async (context: ConflictContext): Promise<ConflictResolverResult> => {
    const gathered = await deps.applier.gather();
    // §4 empty-gather short-circuit: the applier surfaced NO conflicted files. There
    // is nothing for the model to resolve, so invoking the conflict Answerer with an
    // empty `conflictedFiles` would burn a model call (and the bounded re-plan budget)
    // on a question with no right answer. Short-circuit BEFORE the model call: keep the
    // merging spec's intent alive and surface the missing owner loudly.
    if (gathered.files.length === 0) {
      log.error("gather() surfaced NO conflicted files; refusing an ownerless recoverable-conflict dequeue", {
        specId: deps.mergingSpecIntent.specId,
      });
      return {
        resolved: false,
        recovery: {
          kind: "parking_required",
          message: "conflict resolver gathered no files and established no recovery owner",
        },
      };
    }
    const conflictedPaths = gathered.files.map((f) => f.path);

    // §3.2 DETERMINISTIC ENTITY-MERGE FIRST-PASS (before the agent + before provenance):
    // a `weave`-inspired library first-pass. If every conflicted file's two sides edit
    // DIFFERENT entities, splice both edits onto the base deterministically — apply +
    // RE-GATE the spliced tree, and on a clean re-gate publish + skip the agent entirely.
    // A defer (same-entity edit, sem absent/errored, unprovable disjointness) OR a failed
    // re-gate of the splice falls THROUGH to the agent resolver below, exactly as today —
    // the first-pass NEVER changes a verdict it cannot make safely (the binding never-brick
    // / never-silently-mis-resolve principle; the agent path remains authoritative).
    if (deps.entityFirstPass !== undefined) {
      const firstPass = await deps.entityFirstPass.attempt({ conflictedPaths });
      if (firstPass.resolved) {
        await deps.applier.applyResolution(firstPass.files);
        const resolvedPaths = firstPass.files.map((f) => f.path);
        const verdict = await deps.reGate.reGate({ resolvedFiles: resolvedPaths });
        if (verdict.passed) {
          await deps.applier.publishResolved();
          await deps.eventStore.append({
            runId: context.runId,
            specId: deps.mergingSpecIntent.specId,
            projectId: deps.projectId,
            orgId: deps.orgId,
            eventType: "merge.conflict.entity_merged",
            payload: {
              prUrl: context.prUrl,
              prNumber: context.prNumber,
              integration: "direct_merge",
              baseBranch: context.baseBranch,
              mergingSpecId: deps.mergingSpecIntent.specId,
              resolvedFiles: resolvedPaths,
              entityIds: [...firstPass.entityIds],
              reGated: true,
            },
          });
          return { resolved: true };
        }
        // The deterministic splice did NOT survive the re-gate — it was not a safe resolution
        // after all. DON'T merge it; fall through to the agent resolver (which gathers the
        // conflict afresh). Observed loudly so a wrong-splice→re-gate-fail is visible.
        log.warn("entity-merge first-pass re-gate FAILED; deferring to the agent resolver", {
          specId: deps.mergingSpecIntent.specId,
          failedStage: verdict.failedStage,
        });
      } else {
        log.info("entity-merge first-pass deferred to the agent resolver", {
          specId: deps.mergingSpecIntent.specId,
          reason: firstPass.reason,
        });
      }
    }

    const provenance = await deps.provenance.read({
      projectId: deps.projectId,
      mergingSpecId: deps.mergingSpecIntent.specId,
      conflictedFiles: conflictedPaths,
    });

    await deps.eventStore.append({
      runId: context.runId,
      specId: deps.mergingSpecIntent.specId,
      projectId: deps.projectId,
      orgId: deps.orgId,
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
      // in a percolation re-execution, reframe into upstream-change mode so
      // the ancestor's intentional change flows INTO this dependent (keeping its
      // work intact), and an irreconcilable answer re-plans THIS spec (the merging
      // side) WITH the ancestor's change — the now-reachable replan path.
      ...(deps.upstreamChange !== undefined && { upstreamChange: deps.upstreamChange }),
    });

    let decision: ReturnType<typeof decideConflictResolution>;
    try {
      decision = decideConflictResolution(answer, {
        mergingSpecId: deps.mergingSpecIntent.specId,
        ...(provenance.conflictingSpecId !== undefined && { conflictingSpecId: provenance.conflictingSpecId }),
      });
    } catch (error) {
      if (!(error instanceof ConflictAnswerInvalidError)) {
        throw error;
      }
      const reason = error.message;
      const replan = {
        which: "merging" as const,
        specId: deps.mergingSpecIntent.specId,
        newContext: replanContextFromConflict(provenance.conflictingSpecIntent, reason),
        ...(provenance.conflictingSpecId !== undefined && { otherSpecId: provenance.conflictingSpecId }),
      };
      return routeIrreconcilable(deps, context, provenance, reason, replan, false);
    }

    if (decision.kind === "irreconcilable") {
      return routeIrreconcilable(deps, context, provenance, decision.reason, decision.replan, false);
    }

    // decision.kind === "apply": write the resolved tree, then RE-GATE it.
    await deps.applier.applyResolution(decision.resolvedFiles);
    const resolvedPaths = decision.resolvedFiles.map((f) => f.path);
    const verdict = await deps.reGate.reGate({ resolvedFiles: resolvedPaths });

    if (!verdict.passed) {
      return handleFailedReGate(deps, context, provenance, verdict);
    }

    // Clean re-gate: publish the resolved branch; the dispatcher retries the
    // merge through the up-to-date path. The resolution diff is the rewritten files.
    await deps.applier.publishResolved();
    await deps.eventStore.append({
      runId: context.runId,
      specId: deps.mergingSpecIntent.specId,
      projectId: deps.projectId,
      orgId: deps.orgId,
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
 * The failed-re-gate tail: split a GATE-TIER failure (the resolved tree is byte-clean — it just
 * fails lint/test/build on the new base, the WRITER's to fix) from a genuine checker/auditor
 * does-not-fit verdict. A GATE-tier failure with a rework router wired routes to WRITER REWORK
 * carrying the gate error (the SAME never-discard re-author the batch path uses), NEVER
 * `merge.conflict.irreconcilable` / escalate (the convergence detector owns escalation, no count),
 * and returns the router's durable ownership receipt so a caller with its own replan path does
 * not double-route. Everything else (a checker/auditor rejection, or a degenerate wiring with
 * no rework router) stays on the replan / irreconcilable path — never merge an unverified tree.
 */
async function handleFailedReGate(
  deps: IntentPreservingResolverDeps,
  context: ConflictContext,
  provenance: ConflictProvenance,
  verdict: ReGateVerdict,
): Promise<Extract<ConflictResolverResult, { resolved: false }>> {
  const reason = `re-gate failed (${verdict.failedStage ?? "unknown"}): ${verdict.reason}`;
  if (verdict.failedStage === "gate" && deps.gateRework !== undefined) {
    await deps.applier.abort();
    const recovery = await deps.gateRework.routeGateFailToRework({
      specId: deps.mergingSpecIntent.specId,
      gateError: reason,
    });
    return { resolved: false, recovery };
  }
  const replan = {
    which: "merging" as const,
    specId: deps.mergingSpecIntent.specId,
    newContext: replanContextFromConflict(provenance.conflictingSpecIntent, reason),
    ...(provenance.conflictingSpecId !== undefined && { otherSpecId: provenance.conflictingSpecId }),
  };
  return routeIrreconcilable(deps, context, provenance, reason, replan, true);
}

/**
 * The irreconcilable / failed-re-gate tail: route the chosen spec back to the
 * planner (intent stays alive), abort the in-progress merge, emit the inspectable
 * event, and return the router's durable recovery disposition (NOT a merge).
 * `fromFailedReGate` distinguishes the Answerer's diagnosis from a re-gate failure.
 */
async function routeIrreconcilable(
  deps: IntentPreservingResolverDeps,
  context: ConflictContext,
  provenance: { conflictingSpecId?: string },
  reason: string,
  replan: { which: "merging" | "base"; specId: string; newContext: string; otherSpecId?: string } | undefined,
  fromFailedReGate: boolean,
): Promise<Extract<ConflictResolverResult, { resolved: false }>> {
  let recovery: ConflictRecoveryDisposition;
  if (replan === undefined) {
    recovery = { kind: "parking_required", message: `resolver returned no replan target: ${reason}` };
  } else {
    recovery = await deps.replan.routeBackToPlanner({
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
    orgId: deps.orgId,
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
  return { resolved: false, recovery };
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

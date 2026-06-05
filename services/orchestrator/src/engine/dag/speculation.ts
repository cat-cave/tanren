// Speculative readiness — the PURE core of speculative readiness (autonomy-engine.md §2c). Given
// the DAG snapshot, the per-spec lifecycle projection, the configured speculation
// threshold, and the max integration depth, decide for each pending spec:
//
//   - is it READY (every dependency has crossed the threshold)?
//   - is it SPECULATIVE (ready, but at least one dependency is not yet MERGED)?
//   - which ancestors are UNMERGED (they become the speculative integration
//     branch the dependent's PR bases on)?
//   - is it HELD because the unmerged-ancestor DEPTH exceeds the cap (not
//     silently truncated — surfaced so the walker emits a held event)?
//
// This is the §2c readiness model expressed as a DB-free function the conformance
// suite pins. The planner (`engine/contracts/dagWalker.ts`) calls it to compute
// the ready set; the walker (`engine/dag/walker.ts`) wires the real lifecycle read
// model + config and emits the dag.spec.speculative / dag.spec.speculation_held
// events. Change-percolation is explicitly OUT of scope: this unit starts
// dependents early and re-gates against reality when ancestors really merge.

import type { DagSpecNode } from "../contracts/dagWalker.js";
import {
  type DagLifecycleSnapshot,
  isBlockingForModerate,
  lifecycleRank,
  type SpecLifecycle,
} from "../contracts/dagLifecycle.js";
import type { SpeculationThreshold } from "../config/shared.js";

/**
 * The readiness verdict for one pending spec under a threshold. `ready` is true
 * iff every dependency crossed the threshold. When `ready`, the spec is either a
 * NON-speculative start (all deps already merged — `unmergedAncestors` empty) or a
 * SPECULATIVE start (one or more deps threshold-crossed-but-unmerged — they form
 * the integration branch). `held` is true when the spec WOULD be ready but the
 * unmerged-ancestor depth exceeds the cap: it is NOT ready this tick (held until
 * ancestors merge), surfaced so the walker logs it rather than silently dropping.
 */
export interface SpecReadiness {
  specId: string;
  ready: boolean;
  speculative: boolean;
  /** The transitive unmerged ancestors (the integration-branch members), DAG-ordered. */
  unmergedAncestors: string[];
  /** The unmerged-ancestor depth (= unmergedAncestors.length). */
  depth: number;
  /** When `held`: the spec is over the depth cap and held until ancestors merge. */
  held: boolean;
  /** Depth cap in force (for the held event). */
  depthCap: number;
}

/**
 * Whether a single ancestor has crossed the configured threshold — the §2c
 * predicate, the heart of speculation:
 *   - conservative → the ancestor must be MERGED.
 *   - moderate     → CI-green + audited with NO open P0/P1 (P2/P3 OK), review may
 *                    still be pending. "Pending automated audits" is NOT crossed.
 *   - aggressive   → the ancestor's PR is OPEN (pre-CI is fine).
 * A `blocked` (halted/cancelled) ancestor NEVER crosses any threshold.
 */
export function ancestorCrossedThreshold(lifecycle: SpecLifecycle, threshold: SpeculationThreshold): boolean {
  if (lifecycle.state === "blocked") {
    return false;
  }
  switch (threshold) {
    case "conservative":
      return lifecycle.state === "merged";
    case "aggressive":
      // PR open or anything further along the ladder.
      return lifecycleRank(lifecycle.state) >= lifecycleRank("pr_open");
    case "moderate": {
      // Must be at LEAST audited (so CI is green and the auditor reached a
      // verdict — "technically complete but pending automated audits" is NOT
      // ready), AND carry no open P0/P1 finding (P2/P3/none are admitted). A
      // merged ancestor trivially satisfies this.
      if (lifecycleRank(lifecycle.state) < lifecycleRank("audited")) {
        return false;
      }
      return !isBlockingForModerate(lifecycle.openFindingMaxSeverity);
    }
  }
}

/**
 * Compute the readiness of every PENDING spec under the threshold + depth cap.
 * Returns a map keyed by spec id so the planner can build the ready set + classify
 * each enqueue as speculative-or-not and emit the right event.
 *
 * Depth is computed TRANSITIVELY: the integration branch a dependent bases on must
 * stack EVERY unmerged ancestor in its dependency closure (a dep D that is itself
 * speculative on an unmerged G means C's prospective world includes G too). So the
 * depth is the count of DISTINCT unmerged specs in the transitive `dependsOn`
 * closure, and the cap bounds the WHOLE stack — not just direct edges.
 */
export function computeReadiness(
  pendingSpecs: ReadonlyArray<DagSpecNode>,
  allNodes: ReadonlyArray<DagSpecNode>,
  lifecycle: DagLifecycleSnapshot,
  threshold: SpeculationThreshold,
  depthCap: number,
): Map<string, SpecReadiness> {
  if (!Number.isInteger(depthCap) || depthCap < 1) {
    throw new RangeError(`speculativeIntegrationDepth must be a positive integer, got ${depthCap}`);
  }
  const depsById = new Map(allNodes.map((n) => [n.specId, n.dependsOn] as const));
  const orderById = new Map(allNodes.map((n) => [n.specId, n.orderKey] as const));
  const out = new Map<string, SpecReadiness>();

  for (const spec of pendingSpecs) {
    out.set(spec.specId, evaluateSpec(spec, depsById, orderById, lifecycle, threshold, depthCap));
  }
  return out;
}

function evaluateSpec(
  spec: DagSpecNode,
  depsById: Map<string, string[]>,
  orderById: Map<string, number>,
  lifecycle: DagLifecycleSnapshot,
  threshold: SpeculationThreshold,
  depthCap: number,
): SpecReadiness {
  // Every DIRECT dependency must have crossed the threshold for the spec to be
  // ready at all. A missing dependency (an edge to an id absent from the
  // projection) is treated as not-crossed — the spec is held, never run on a
  // phantom ancestor.
  for (const depId of spec.dependsOn) {
    const depLifecycle = lifecycle.bySpecId.get(depId);
    if (depLifecycle === undefined || !ancestorCrossedThreshold(depLifecycle, threshold)) {
      return notReady(spec.specId, depthCap);
    }
  }

  // The spec's direct deps all crossed the threshold. Compute the transitive set
  // of UNMERGED ancestors (the integration-branch stack). Conservative can never
  // be speculative (a crossed ancestor IS merged), so this set is empty there.
  const unmerged = transitiveUnmergedAncestors(spec, depsById, lifecycle, orderById);

  if (unmerged.length > depthCap) {
    // OVER the cap. Do NOT silently truncate (§2c "no silent caps"): hold the
    // spec until enough ancestors merge, surfaced via the held event.
    return {
      specId: spec.specId,
      ready: false,
      speculative: false,
      unmergedAncestors: unmerged,
      depth: unmerged.length,
      held: true,
      depthCap,
    };
  }

  return {
    specId: spec.specId,
    ready: true,
    speculative: unmerged.length > 0,
    unmergedAncestors: unmerged,
    depth: unmerged.length,
    held: false,
    depthCap,
  };
}

function notReady(specId: string, depthCap: number): SpecReadiness {
  return { specId, ready: false, speculative: false, unmergedAncestors: [], depth: 0, held: false, depthCap };
}

/**
 * The transitive set of UNMERGED ancestors of a spec, in DAG order (ancestors
 * before dependents, ties by creation order then id). These are exactly the specs
 * the speculative integration branch must stack on `main` — every unmerged spec in
 * the dependency closure, because the dependent's prospective merged world
 * includes them all. A merged ancestor is already on `main`, so it is excluded.
 */
export function transitiveUnmergedAncestors(
  spec: DagSpecNode,
  depsById: Map<string, string[]>,
  lifecycle: DagLifecycleSnapshot,
  orderById: Map<string, number>,
): string[] {
  const unmerged = new Set<string>();
  const seen = new Set<string>([spec.specId]);
  const stack = [...spec.dependsOn];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const life = lifecycle.bySpecId.get(id);
    // A merged ancestor is on `main` already; do not stack it, and do not walk
    // PAST it — its own ancestors are merged too (merged is terminal on the
    // ladder). An unmerged ancestor is stacked AND we recurse into ITS deps.
    if (life !== undefined && life.state === "merged") {
      continue;
    }
    unmerged.add(id);
    for (const parent of depsById.get(id) ?? []) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return [...unmerged].sort((a, b) => {
    const ao = orderById.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bo = orderById.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ao === bo ? (a < b ? -1 : a > b ? 1 : 0) : ao - bo;
  });
}

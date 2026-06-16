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
    default: {
      const exhaustive: never = threshold;
      throw new Error(`ancestorCrossedThreshold: unhandled threshold ${String(exhaustive)}`);
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
 * CHEAP ANCESTOR-READY PRE-CHECK (apex v35, the `ancestor_not_ready` hot-loop fix).
 *
 * A speculative dependent jj-assembles its base from its unmerged ancestors' REAL PR-head
 * branches at bootstrap (the expensive runner-allocation + clone). When an ancestor has not
 * actually PUBLISHED its head yet — it ran ahead of the ancestor's `pr_open` (its
 * `<branch>@origin` is gone-but-not-merged) — the assembly throws `AncestorNotReadyError`
 * (`jjLocalIntegration.ts`), a BENIGN wait the run finalizer re-drives. The live cost was a
 * hot-loop: a dependent on ~all specs re-drove ~516× over one build, each attempt allocating
 * a runner + minting a token + cloning, just to re-discover the ancestor still is not ready.
 *
 * This is the cheap signal that AVOIDS that provisioning entirely: an ancestor has a
 * PUBLISHED HEAD iff its projected lifecycle reached `pr_open` (rank ≥ 2) — i.e. a real PR
 * head branch exists for the dependent to stack on. A `merged` ancestor is already on the
 * base (not in the unmerged set) and trivially satisfies this. The walker checks this from
 * the ALREADY-LOADED lifecycle projection BEFORE enqueuing — no runner, no clone — and defers
 * a dependent whose ancestors lack a published head (it benign-waits, spaced by the backoff).
 *
 * Returns the FIRST unmerged ancestor that lacks a published head (`{ ancestorSpecId, phase }`,
 * `phase` mirroring the `AncestorNotReadyError` non-terminal phase) when one does — else
 * `undefined` (every unmerged ancestor has a published head; the dependent may proceed).
 */
export function firstAncestorWithoutPublishedHead(
  unmergedAncestorSpecIds: ReadonlyArray<string>,
  lifecycle: DagLifecycleSnapshot,
): { ancestorSpecId: string; phase: "pending" | "in_flight" } | undefined {
  for (const ancestorSpecId of unmergedAncestorSpecIds) {
    const life = lifecycle.bySpecId.get(ancestorSpecId);
    // A published head means a real PR-head branch exists to stack on — the ancestor's
    // lifecycle reached `pr_open` (rank ≥ 2). `merged` is excluded from the unmerged set
    // upstream, but ranks above pr_open anyway, so it never trips this. An absent/`pending`/
    // `building`/`blocked` ancestor has NO published head yet (or never will) — defer.
    if (life !== undefined && lifecycleRank(life.state) >= lifecycleRank("pr_open")) {
      continue;
    }
    // Mirror the `AncestorNotReadyError` non-terminal phase vocabulary: a `building` ancestor
    // is `in_flight` (a run is live, the head is coming); everything else (no run / `pending`)
    // is `pending`. A `blocked` ancestor never publishes — but that is the walker's existing
    // threshold gate's concern (a blocked ancestor never crosses any threshold), so a
    // speculative dependent is only ever resolved over non-blocked ancestors; we still defer
    // it here (cheaply) rather than provision against a missing head.
    const phase = life?.state === "building" ? "in_flight" : "pending";
    return { ancestorSpecId, phase };
  }
  return undefined;
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

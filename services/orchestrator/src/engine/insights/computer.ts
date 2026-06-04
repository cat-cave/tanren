// P2A-0020 insight dispatcher. `computeInsight(kind, context, db)` calls
// the per-kind pure compute function. `loadInsightsForProject` is the
// read-through entry point used by the HTTP route and by the Forge
// narration generator (P2A-0019); it walks every kind, reading the cache
// first and recomputing if stale.
//
// P2e-1 note: `ci_flaky` is NOT a pure read-through compute — detecting a flaky
// check also RECORDS it on the quarantine surface and EMITS operator-visible
// events. It therefore lives outside the cache-backed `computeInsight` switch
// and runs through `detectAndQuarantineFlaky` only when an `eventStore` is
// supplied (so a read-only caller never triggers a write).

import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { computeModelMismatch } from "./modelMismatch.js";
import { computePaceAnomaly } from "./paceAnomaly.js";
import { computeRetryHotspot } from "./retryHotspot.js";
import { computeReviewStall } from "./reviewStall.js";
import { computeStuck } from "./stuck.js";
import { detectAndQuarantineFlaky, loadCiObservations } from "./ciFlaky.js";
import { readFreshOrCompute } from "./cache.js";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type Insight, type InsightKind } from "./types.js";

export interface ComputeInsightContext {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
}

// The cache-backed, side-effect-free insight kinds. `ci_flaky` is intentionally
// excluded — see the module header.
export type ReadThroughInsightKind = Exclude<InsightKind, "ci_flaky">;

export async function computeInsight(
  kind: ReadThroughInsightKind,
  context: ComputeInsightContext,
  pool: Pick<pg.Pool, "query">,
): Promise<Insight[]> {
  switch (kind) {
    case "retry_hotspot":
      return computeRetryHotspot(pool, context);
    case "model_mismatch":
      return computeModelMismatch(pool, context);
    case "pace_anomaly":
      return computePaceAnomaly(pool, context);
    case "stuck":
      return computeStuck(pool, context);
    case "review_stall":
      return computeReviewStall(pool, context);
  }
}

export const INSIGHT_KINDS: ReadonlyArray<ReadThroughInsightKind> = [
  "retry_hotspot",
  "model_mismatch",
  "pace_anomaly",
  "stuck",
  "review_stall",
];

export interface LoadInsightsOptions {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
  cacheFreshnessMs?: number;
  // When supplied, flaky-test detection runs: a newly-proven-flaky check is
  // recorded on the quarantine surface + the ci.flaky.* events are emitted, and
  // every active quarantine is surfaced as a `ci_flaky` insight. Omitted by
  // read-only callers, who then see no flaky insights and trigger no writes.
  eventStore?: EventStore;
}

export async function loadInsightsForProject(
  pool: Pick<pg.Pool, "query">,
  options: LoadInsightsOptions,
): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const out: Insight[] = [];
  for (const kind of INSIGHT_KINDS) {
    const result = await readFreshOrCompute(pool, {
      projectId: options.projectId,
      kind,
      now: options.now,
      cacheFreshnessMs: options.cacheFreshnessMs ?? t.cacheFreshnessMs,
      compute: () =>
        computeInsight(kind, { projectId: options.projectId, now: options.now, thresholds: options.thresholds }, pool),
    });
    out.push(...result.insights);
  }
  if (options.eventStore !== undefined) {
    const flaky = await detectAndQuarantineFlaky(pool, {
      projectId: options.projectId,
      now: options.now,
      thresholds: options.thresholds,
      eventStore: options.eventStore,
      // App-role route: this `pool` already reads `events` under the request's org scope.
      loadChecks: (since) => loadCiObservations(pool, { projectId: options.projectId, since }),
    });
    out.push(...flaky);
  }
  return out;
}

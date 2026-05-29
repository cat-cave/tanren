// P2A-0020 insight dispatcher. `computeInsight(kind, context, db)` calls
// the per-kind pure compute function. `loadInsightsForProject` is the
// read-through entry point used by the HTTP route and by the Forge
// narration generator (P2A-0019); it walks every kind, reading the cache
// first and recomputing if stale.

import type pg from "pg";
import { computeModelMismatch } from "./modelMismatch.js";
import { computePaceAnomaly } from "./paceAnomaly.js";
import { computeRetryHotspot } from "./retryHotspot.js";
import { computeReviewStall } from "./reviewStall.js";
import { computeStuck } from "./stuck.js";
import { readFreshOrCompute } from "./cache.js";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type Insight, type InsightKind } from "./types.js";

export interface ComputeInsightContext {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
}

export async function computeInsight(
  kind: InsightKind,
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

export const INSIGHT_KINDS: ReadonlyArray<InsightKind> = [
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
  return out;
}

// `model_mismatch` compute. Groups cost records by spec class
// (milestone label) and writer model over the configured comparison window,
// then emits one insight per spec class where the most-recently-used model
// costs at least `modelMismatchCostRatio`× the cheapest model with enough
// merged samples.
//
// Inputs derive from cost records joined with the merged outcome
// from `runs` and the spec→milestone link from. v0 uses the
// milestone *label* as the spec class because it is the stable, operator-
// readable grouping; specs without a milestone bucket into "unclassified"
// and are skipped (no comparable peers).
//
// The action surface re-uses `tanren.acknowledge_insight` for snooze/dismiss
// and `tanren.create_spec` for the operator to draft a routing-change spec.
// A dedicated `tanren.switch_writer_for_spec_class` tool can swap in once the
// routing layer carries spec-class config (the runtime allocator hookup is a
// later surface).

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type ComputeContext } from "./retryHotspot.js";
import { type Insight, type ModelMismatchPayload } from "./types.js";

// Hard row cap on the GROUPED result. The query is server-side aggregated
// (GROUP BY spec_class × cli × model, so the row count is the number of distinct
// model routings in the window — already naturally small), but the cap bounds a
// pathological project with a runaway model-routing cardinality. Aggregation is
// the preferred bounding here (a COUNT/SUM query, not raw rows); the LIMIT is the
// belt-and-suspenders ceiling and would only ever trip on absurd cardinality.
const CLASS_MODEL_STAT_LIMIT = 10_000;

interface ClassModelStatRow {
  spec_class: string;
  cli: string;
  model: string;
  merged_specs: string;
  total_cost: string;
  last_used_at: Date;
}

export async function computeModelMismatch(pool: Pick<pg.Pool, "query">, context: ComputeContext): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };
  const now = context.now ?? new Date();
  const since = new Date(now.getTime() - t.modelMismatchWindowDays * 24 * 60 * 60 * 1000);

  // Aggregate cost-per-merged-spec per (spec_class, cli, model). A "merged
  // spec" for this class is a unique spec_id whose run ended with
  // outcome='merged' inside the window. Cost is the sum of cost_records for
  // tasks that belong to those merged runs.
  const stats = await pool.query<ClassModelStatRow>(
    `WITH merged_runs AS (
       SELECT r.run_id, r.spec_id, sm.milestone_id
         FROM runs r
         INNER JOIN spec_milestones sm ON sm.spec_id = r.spec_id
         WHERE r.project_id = $1
           AND r.outcome = 'merged'
           AND r.ended_at >= $2
     ),
     class_lookup AS (
       SELECT mr.run_id, m.label AS spec_class, mr.spec_id
         FROM merged_runs mr
         INNER JOIN milestones m ON m.id = mr.milestone_id
     ),
     joined AS (
       SELECT cl.spec_class,
              cl.spec_id,
              cr.cli,
              cr.model,
              cr.cost_usd::numeric AS cost,
              cr.recorded_at
         FROM class_lookup cl
         INNER JOIN cost_records cr ON cr.run_id = cl.run_id
         INNER JOIN tasks tk ON tk.task_id = cr.task_id
         WHERE tk.agent_kind = 'writer'
     )
     SELECT spec_class,
            cli,
            model,
            COUNT(DISTINCT spec_id)::text AS merged_specs,
            SUM(cost)::text AS total_cost,
            MAX(recorded_at) AS last_used_at
       FROM joined
       GROUP BY spec_class, cli, model
       HAVING COUNT(DISTINCT spec_id) >= $3
       LIMIT ${CLASS_MODEL_STAT_LIMIT}`,
    [context.projectId, since, t.modelMismatchMinMergedPerModel],
  );

  const byClass = new Map<string, ClassModelStatRow[]>();
  for (const row of stats.rows) {
    const list = byClass.get(row.spec_class) ?? [];
    list.push(row);
    byClass.set(row.spec_class, list);
  }

  const insights: Insight[] = [];
  for (const [specClass, rows] of byClass) {
    if (rows.length < 2) continue;
    const enriched = rows.map((row) => {
      const mergedSpecs = Number(row.merged_specs);
      const totalCost = Number(row.total_cost);
      const costPerMerged = mergedSpecs === 0 ? Infinity : totalCost / mergedSpecs;
      return {
        cli: row.cli,
        model: row.model,
        mergedSpecs,
        totalCost,
        costPerMerged,
        lastUsedAt: new Date(row.last_used_at),
      };
    });
    const cheapest = enriched.reduce((best, row) => (row.costPerMerged < best.costPerMerged ? row : best));
    const mostRecent = enriched.reduce((latest, row) =>
      row.lastUsedAt.getTime() > latest.lastUsedAt.getTime() ? row : latest,
    );
    if (mostRecent.model === cheapest.model && mostRecent.cli === cheapest.cli) continue;
    if (cheapest.costPerMerged <= 0) continue;
    if (mostRecent.costPerMerged < cheapest.costPerMerged * t.modelMismatchCostRatio) continue;

    const monthlySavings = (mostRecent.costPerMerged - cheapest.costPerMerged) * Math.max(mostRecent.mergedSpecs, 1);
    const payload: ModelMismatchPayload = {
      kind: "model_mismatch",
      specClass,
      currentModel: mostRecent.model,
      currentCli: mostRecent.cli,
      currentCostPerMergedSpec: round6(mostRecent.costPerMerged),
      alternativeModel: cheapest.model,
      alternativeCli: cheapest.cli,
      alternativeCostPerMergedSpec: round6(cheapest.costPerMerged),
      monthlySavings: round6(monthlySavings),
      comparisonWindowDays: t.modelMismatchWindowDays,
    };
    const insightId = `insight_modelmismatch_${specClass}_${randomUUID()}`;
    insights.push({
      id: insightId,
      kind: "model_mismatch",
      projectId: context.projectId,
      severity: "warn",
      title: `${specClass}: ${mostRecent.model} costs ${(mostRecent.costPerMerged / cheapest.costPerMerged).toFixed(1)}× ${cheapest.model}`,
      body: `Specs in milestone "${specClass}" merged with ${mostRecent.cli} · ${mostRecent.model} cost $${mostRecent.costPerMerged.toFixed(4)} per spec, vs ${cheapest.cli} · ${cheapest.model} at $${cheapest.costPerMerged.toFixed(4)}. Estimated monthly savings: $${monthlySavings.toFixed(2)}.`,
      payload,
      actions: [
        {
          label: `Switch writer · ${cheapest.cli} · ${cheapest.model}`,
          toolCall: {
            tool: "tanren.create_spec",
            args: {
              projectId: context.projectId,
              title: `Routing: ${specClass} → ${cheapest.cli}/${cheapest.model}`,
              description: `Reroute writer for milestone "${specClass}" from ${mostRecent.cli}/${mostRecent.model} to ${cheapest.cli}/${cheapest.model}. Estimated savings $${monthlySavings.toFixed(2)} / window.`,
            },
          },
        },
        {
          label: "Dismiss · we want this model",
          toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
        },
      ],
      computedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  }
  return insights;
}

function round6(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

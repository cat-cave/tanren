# Workflow Insights (P2A-0020)

Workflow insights are typed, operator-facing callouts derived from the same
event / cost / task data Phase 2 already persists. The hi-fi surfaces them
inline in project view and run detail as "suboptimal callouts"; the Forge
narration generator (P2A-0019) consumes the same loader so the same insights
appear inside Forge turns.

Owner spec: `P2A-0020` in `docs/roadmap/phase-2a-specs.md`.

## v0 kinds

| kind             | source                                                 | severity rule                                     |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `retry_hotspot`  | tasks (writer) joined with planner.rerequested         | `warn` when ≥ `min+1` attempts; otherwise `info`  |
| `model_mismatch` | cost_records joined with merged runs + spec_milestones | `warn` whenever the ratio is exceeded             |
| `pace_anomaly`   | in-flight writer tasks vs class average                | `warn` at ≥ 1.5× the multiplier; otherwise `info` |

`stuck` and `review_stall` defer to Phase 3 — they depend on
spec-dependency-chain analysis and review polling.

## Computation model

Insights are computed **on read**. There is no scheduled job in v0; the
`workflow_insights` table is an optimization, not a source of truth.

```
GET /orgs/:orgId/projects/:projectId/insights
  → loadInsightsForProject
      → for each kind:
          readFreshInsights  ← cache (fresh = computed_at within 1h, not acked)
          if empty: computeInsight(kind, ...)
                    writeInsights(rows)
```

The compute functions are pure (well, they take a `pg.Pool` for queries but
contain no side-effects beyond the cache writer). They are individually
testable from synthetic fixture data.

## Thresholds

`services/orchestrator/src/engine/insights/thresholds.ts` defines:

| field                            | default | rationale                                            |
| -------------------------------- | ------- | ---------------------------------------------------- |
| `retryHotspotMinAttempts`        | 2       | matches spec; one retry is normal                    |
| `retryHotspotWindowDays`         | 7       | one sprint                                           |
| `modelMismatchWindowDays`        | 30      | one billing cycle                                    |
| `modelMismatchMinMergedPerModel` | 3       | minimum sample size for the average to mean anything |
| `modelMismatchCostRatio`         | 2       | the headline "materially higher" threshold from spec |
| `paceAnomalyMultiplier`          | 2.0     | the headline "materially slower" threshold from spec |
| `paceAnomalyWindowDays`          | 30      | window for class-average baseline                    |
| `paceAnomalyMinSamples`          | 3       | minimum sample size for the average to mean anything |
| `cacheFreshnessMs`               | 1 hour  | matches spec read-path                               |

Phase 3 will make these per-org configurable. The compute-function signature
already accepts an explicit `thresholds: Partial<InsightThresholds>` so the
future migration is purely "resolve from org config and pass into the call".

## Action routing

Each insight carries one or more `InsightAction` records. The action's
`toolCall` is shaped like a P2A-0008 `ForgeToolCall`. v0 reuses the existing
tool variants only — no new tool variant was needed for the three v0 kinds:

| insight kind     | actions                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `retry_hotspot`  | `tanren.create_spec` (open BDD · refine), `tanren.acknowledge_insight`    |
| `model_mismatch` | `tanren.create_spec` (routing-change draft), `tanren.acknowledge_insight` |
| `pace_anomaly`   | `tanren.read_run`, `tanren.acknowledge_insight`                           |

When the operator clicks the action button, the dashboard hits the existing
`POST /orgs/.../forge/tools` route (P2A-0019), which dispatches into the
matching tool implementation. Acknowledge actions land at the P2A-0020
`POST /orgs/.../projects/.../insights/:id/acknowledge` endpoint via the
shared `acknowledgeInsight` helper — both code paths write the same row.

## Cache table

`db/src/schemaInsights.ts` and migration `0012_cheerful_sleepwalker.sql`:

```sql
CREATE TABLE workflow_insights (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('retry_hotspot','model_mismatch','pace_anomaly')),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','fail')),
  payload JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT REFERENCES users(id)
);
CREATE INDEX workflow_insights_project_kind
  ON workflow_insights (project_id, kind, computed_at DESC);
```

Acknowledged rows stay in the table for audit. The read path filters them
out so they don't surface again until something else recomputes (which the
v0 read path doesn't do automatically — the operator must trigger a fresh
compute by hitting the route after the cache window expires).

## Forge surface integration

`services/orchestrator/src/engine/forge/narration/v0.ts` already accepts a
`NarrationInsight[]` in its input. The route layer in
`services/orchestrator/src/routes/forge/index.ts` populates that field
through `loadInsightsForProject`, mapping each `Insight` into the shape the
generator expects and dropping actions whose `toolCall` doesn't parse
against the current `ForgeToolCall` discriminated union (forward-compat
guard for future tool variants).

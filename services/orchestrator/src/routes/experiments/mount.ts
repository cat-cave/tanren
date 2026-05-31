// Mount the read/report route family — DORA delivery metrics + the benchmark
// experiment/cell CRUD + report/compare surface — under `/orgs`. Grouped behind
// one mount so `mountFeatureRoutes` carries a single dependency for the two
// related read surfaces (both are org-scoped insight/report views over the
// existing run/event/cost data plane), keeping that table's import count in
// check without changing wiring or behavior.

import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createDoraRoutes } from "../dora/index.js";
import { createExperimentRoutes } from "./index.js";

export function mountReportRoutes(app: Hono<ActorContextEnv>, deps: { pool: pg.Pool }): void {
  app.route("/orgs", createDoraRoutes({ pool: deps.pool }));
  // Benchmark report/CRUD surface (tanren-method-benchmark §4.2.4): author
  // experiments + cells, trigger the scheduler, read cell scorecards + compare.
  app.route("/orgs", createExperimentRoutes({ pool: deps.pool }));
}

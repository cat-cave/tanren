// Mount the read/report route family — DORA delivery metrics + the benchmark
// experiment/cell CRUD + report/compare surface — under `/orgs`. Grouped behind
// one mount so `mountFeatureRoutes` carries a single dependency for the two
// related read surfaces (both are org-scoped insight/report views over the
// existing run/event/cost data plane), keeping that table's import count in
// check without changing wiring or behavior.

import type { Hono } from "hono";
import type pg from "pg";
import { buildLiveBenchmarkScheduler, type LiveBenchmarkInfra } from "../../engine/benchmark/liveScheduler.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createDoraRoutes } from "../dora/index.js";
import { createCiInsightRoutes } from "../ciInsights/index.js";
import { createExperimentRoutes } from "./index.js";

export interface MountReportRoutesDeps {
  pool: pg.Pool;
  // The live benchmark infra (allocator + ssh + identity ref + the shared LISTEN
  // connection). Supplied by the API boot so the benchmark scheduler runs a real
  // trial: the post-merge accept tier (allocate→clone@mergedSHA→bootstrap→accept)
  // + a LISTEN/NOTIFY-driven terminal await. Omitted in tests — then the runner's
  // own defaults apply (no-op accept, poll-based await), so route tests need no
  // live runner.
  benchmark?: Omit<LiveBenchmarkInfra, "pool">;
}

export function mountReportRoutes(app: Hono<ActorContextEnv>, deps: MountReportRoutesDeps): void {
  app.route("/orgs", createDoraRoutes({ pool: deps.pool }));
  // P2e-1 Mergify-parity read-models: per-project CI analytics + native-queue
  // statistics, both pure reads over the existing event/run data plane.
  app.route("/orgs", createCiInsightRoutes({ pool: deps.pool }));
  // Benchmark report/CRUD surface (tanren-method-benchmark §4.2.4): author
  // experiments + cells, trigger the scheduler, read cell scorecards + compare.
  // With live infra wired, the scheduler runs real trials (real accept + await);
  // without it, the runner's defaults keep the route testable in isolation.
  const scheduler = deps.benchmark === undefined ? undefined : buildLiveBenchmarkScheduler(deps.benchmark);
  app.route(
    "/orgs",
    createExperimentRoutes({
      pool: deps.pool,
      ...(scheduler === undefined
        ? {}
        : { runExperiment: scheduler.runExperiment, runExperimentCell: scheduler.runExperimentCell }),
    }),
  );
}

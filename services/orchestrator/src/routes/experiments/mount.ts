// Mount the read/report route family — DORA delivery metrics + the benchmark
// experiment/cell CRUD + report/compare surface — under `/orgs`. Grouped behind
// one mount so `mountFeatureRoutes` carries a single dependency for the two
// related read surfaces (both are org-scoped insight/report views over the
// existing run/event/cost data plane), keeping that table's import count in
// check without changing wiring or behavior.

import type { Hono } from "hono";
import type pg from "pg";
import { buildLiveBenchmarkScheduler, type LiveBenchmarkInfra } from "../../engine/benchmark/liveScheduler.js";
import type { SecretStore } from "../../engine/contracts/index.js";
import { PgProofSubstrate } from "../../engine/cas/pgProofSubstrate.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createDoraRoutes } from "../dora/index.js";
import { createCiInsightRoutes } from "../ciInsights/index.js";
import { createIntegrationMetricsRoutes } from "../integrationMetrics/index.js";
import { createMergeQueueAuthorityEvaluationRoutes } from "../mergeQueue/authorityEvaluations.js";
import { createMergeQueueAuthoritySignalRoutes } from "../mergeQueue/authoritySignals.js";
import { createMergeQueueRepairRouteRoutes } from "../mergeQueue/repairRoutes.js";
import { createLandGroupDeliveryRoutes, createMergeTrainArtifactRoutes } from "../mergeQueue/trainArtifact.js";
import { createMergeQueueEvidenceContractRoutes } from "../mergeQueue/evidenceContracts.js";
import { mountMergeQueueReadRoutes } from "../mergeQueue/scheduleMount.js";
import { createExperimentRoutes } from "./index.js";

export interface MountReportRoutesDeps {
  pool: pg.Pool;
  // The platform secret store. Used to construct the sole production `PgProofSubstrate`
  // so the mq-15 merge-train export route RE-VERIFIES a served artifact's persisted
  // bundle cryptographically (SP-3 × mq-15 connect-up). Absent the platform signing key,
  // verify fails closed (a row never re-verifies ⇒ the route serves nothing), never a
  // silent green — the same fail-closed posture as the sealing worker.
  secrets: SecretStore;
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
  // Native CI-intelligence read-models: per-project CI analytics + native-queue
  // statistics, both pure reads over the existing event/run data plane.
  app.route("/orgs", createCiInsightRoutes({ pool: deps.pool }));
  // Integration `rebase_vs_rebuild` read-model (tanren-owns-the-engine.md §3/§7/§8):
  // per-`decision` rebase buckets with token/wall-clock cost joined at read time
  // (the `integration.rebase` event carries only the categorical decision) — proves
  // rebase < rebuild. A pure read over the existing event/cost/run data plane.
  app.route("/orgs", createIntegrationMetricsRoutes({ pool: deps.pool }));
  // mq-1 durable authority-signal projection (list + evaluation).
  app.route("/orgs", createMergeQueueAuthoritySignalRoutes({ pool: deps.pool }));
  // mq-2 durable seven-way evaluation projection (never process-memory state).
  app.route("/orgs", createMergeQueueAuthorityEvaluationRoutes({ pool: deps.pool }));
  // mq-10 autonomous-repair + respec lineage projection over `merge_repair_routes`.
  app.route("/orgs", createMergeQueueRepairRouteRoutes({ pool: deps.pool }));
  // mq-15 sealed merge-train delivery projection (train list + one land-group artifact).
  // SP-3 × mq-15 connect-up: inject the sole production `PgProofSubstrate` so the export
  // route re-verifies each served bundle's ed25519 signature (no longer permanently 404
  // for want of a substrate). verify() is pure crypto over the persisted bundle + the
  // platform key; the substrate's own pool/CAS are unused on this read path.
  app.route(
    "/orgs",
    createMergeTrainArtifactRoutes({
      pool: deps.pool,
      proofSubstrate: new PgProofSubstrate(deps.pool, deps.secrets),
    }),
  );
  // mq-12 read-only selected-F2 evidence projection. It exposes immutable
  // metadata and the proof-unit observation only; there is no run/control route.
  app.route("/orgs", createMergeQueueEvidenceContractRoutes({ pool: deps.pool }));
  // mq-8 advisory speculative-build evidence + mq-9's scoped semantic partition/lease
  // explanation, mounted together via the read-routes helper (the eager-beam route now
  // lives inside `mountMergeQueueReadRoutes`, so it is NOT mounted separately). Read-only
  // and org-scoped; the production coordinator always revalidates CodeHost facts.
  mountMergeQueueReadRoutes(app, deps.pool);
  // mq-13 read-only land-group DELIVERY timeline projection over `land_group_delivery_loops`
  // (artifact, preview/production/rollback release lineage, terminal disposition, receipt id).
  app.route("/orgs", createLandGroupDeliveryRoutes({ pool: deps.pool }));
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

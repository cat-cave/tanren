// Live BenchmarkRunner wiring (docs/roadmap/tanren-method-benchmark.md §4.2).
//
// Composes the PRODUCTION `BenchmarkRunnerDeps`: the same `pool` the route
// passes, PLUS the two real seams that were no-ops in the runner's defaults —
// `runAccept` (the post-merge hidden accept tier, `liveAccept.ts`) and
// `awaitTerminal` (the LISTEN/NOTIFY-driven terminal wait, `liveAwait.ts`). This
// is the single construction site the boot uses so `runExperiment` /
// `runExperimentCell` run a real trial end-to-end in production while tests keep
// injecting fakes into the runner directly.

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { PgNotifyListener } from "@tanren/db";
import { buildLiveRunAccept } from "./liveAccept.js";
import { buildLiveAwaitTerminal } from "./liveAwait.js";
import {
  runExperiment as runExperimentScheduler,
  runExperimentCell as runExperimentCellScheduler,
  type BenchmarkRunnerDeps,
  type CellRunResult,
  type ExperimentRunResult,
} from "./runner.js";

/** The infra the boot supplies so the benchmark scheduler runs real trials. */
export interface LiveBenchmarkInfra {
  pool: pg.Pool;
  /** The SAME allocator the run path uses (reused for the accept tier's runner). */
  allocator: Allocator;
  /** The SAME SSH substrate the run path drives the runner over. */
  ssh: CommandSubstrate;
  /** The runner identity key ref (mirrors the worker's `identitySecretRef`). */
  identitySecretRef: string;
  /** The shared LISTEN connection (the SAME one the SSE source uses) for awaits. */
  notifyListener: PgNotifyListener;
}

/**
 * Build the production `BenchmarkRunnerDeps` with the real accept + await seams
 * injected. The runner's other defaults (provision, scorecard, persist, spacing)
 * stay as-is — they were already real DB-backed defaults; only `runAccept` and
 * `awaitTerminal` were no-ops, and this wires both.
 */
export function buildLiveBenchmarkRunnerDeps(infra: LiveBenchmarkInfra): BenchmarkRunnerDeps {
  return {
    pool: infra.pool,
    runAccept: buildLiveRunAccept({
      pool: infra.pool,
      allocator: infra.allocator,
      ssh: infra.ssh,
      identitySecretRef: infra.identitySecretRef,
    }),
    awaitTerminal: buildLiveAwaitTerminal({
      pool: infra.pool,
      notifyListener: infra.notifyListener,
    }),
  };
}

/** The injectable scheduler closures the experiments route calls. */
export interface LiveBenchmarkScheduler {
  runExperiment: (pool: pg.Pool, experimentId: string) => Promise<ExperimentRunResult>;
  runExperimentCell: (pool: pg.Pool, cellId: string) => Promise<CellRunResult>;
}

/**
 * Build the `runExperiment` / `runExperimentCell` closures the experiments route
 * injects, each over the live deps. The route still passes the scoped pool per
 * call; the live seams' own infra (allocator/ssh/notify) is closed over here.
 */
export function buildLiveBenchmarkScheduler(infra: Omit<LiveBenchmarkInfra, "pool">): LiveBenchmarkScheduler {
  const seams = (pool: pg.Pool): BenchmarkRunnerDeps => buildLiveBenchmarkRunnerDeps({ ...infra, pool });
  return {
    runExperiment: (pool, experimentId) => runExperimentScheduler(seams(pool), experimentId),
    runExperimentCell: (pool, cellId) => runExperimentCellScheduler(seams(pool), cellId),
  };
}

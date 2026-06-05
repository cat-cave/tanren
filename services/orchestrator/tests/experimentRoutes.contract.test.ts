// Benchmark report/CRUD route contract tests (docs/roadmap/
// tanren-method-benchmark.md §4.2.4). Each endpoint:
//   - rejects cross-org access with 403 (the shared org gate);
//   - round-trips create → list → get for experiments + cells;
//   - is org-scoped: a cross-org read sees zero rows (the FakeClient models the
//     SET-LOCAL org GUC the same way deny-by-default RLS would);
//   - report renders a cell scorecard from the cached trial scorecards;
//   - compare renders the verdict AND refuses a >1-knob comparison (422), the
//     reducer's OneKnobViolationError surfaced.
// The runner seam is injected so `run` is asserted without a live worker.

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { setSystemPool } from "@tanren/db";
import type { ActorContext } from "../src/auth/schemas.js";
import { FrozenConfig } from "../src/engine/benchmark/entities.js";
import type { TrialScorecard } from "../src/engine/benchmark/scorecard.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createExperimentRoutes } from "../src/routes/experiments/index.js";
import { BenchmarkRoutesPool } from "./helpers/benchmarkRoutesPool.js";

const ORG = "org_acme";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function frozen(model: string, governance: "strict" | "open" | "audit_only" = "strict"): FrozenConfig {
  return FrozenConfig.parse({
    routing: { write: { chain: [{ cli: "codex", model, authRef: "credential/codex/org/x" }] } },
    escapeHatches: {},
    ciTiers: {
      tiers: { fast: [{ name: "lint", run: "pnpm lint" }], slow: [{ name: "test", run: "pnpm test" }] },
      when: { fast: ["per_iteration"], slow: ["pre_audit", "pre_merge"] },
    },
    governance,
    mergeIntegration: "not_configured",
  });
}

function scorecard(runId: string, leadTimeSeconds: number): TrialScorecard {
  return {
    runId,
    cellId: null,
    trialIndex: 0,
    reachedAcceptGreen: null,
    terminalStatus: "completed",
    haltReason: null,
    leadTimeSeconds,
    activeExecutionSeconds: leadTimeSeconds / 2,
    plannerReruns: 0,
    plannerRerunsByProducer: { gate: 0, auditor: 0 },
    writerIterations: 1,
    gateFailures: 0,
    reviewIterations: 0,
    auditedConcerns: 0,
    tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0 },
    costUsd: null,
    costBasisMix: { provider_response: 0, ccusage: 0, credits: 0, unknown: 0, unattributed: 0 },
  };
}

function buildHarness(
  opts: {
    actor?: ActorContext;
    runExperiment?: (pool: never, id: string) => Promise<never>;
    runExperimentCell?: (pool: never, id: string) => Promise<never>;
  } = {},
) {
  const actor = opts.actor ?? alice;
  const pool = new BenchmarkRoutesPool();
  setSystemPool(pool.asPgPool());
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route(
    "/orgs",
    createExperimentRoutes({
      pool: pool.asPgPool(),
      runExperiment: opts.runExperiment as never,
      runExperimentCell: opts.runExperimentCell as never,
    }),
  );
  return { app, pool };
}

afterEach(() => {
  setSystemPool(undefined);
});

async function post(app: Hono<ActorContextEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SEED = { repo: "cat-cave/seed", sha: "abc12345", acceptTierHash: "h1", corpusTier: 1 as const };

describe("benchmark experiment routes", () => {
  it("creates, lists, and gets an experiment round-trip", async () => {
    const { app } = buildHarness();
    const created = await post(app, `/orgs/${ORG}/experiments`, {
      title: "gate strictness",
      knob: "governance",
      hypothesis: "strict gate lowers CFR",
      seedTaskRef: SEED,
    });
    expect(created.status).toBe(201);
    const { experiment } = (await created.json()) as { experiment: { experimentId: string; title: string } };
    expect(experiment.title).toBe("gate strictness");

    const listed = await app.request(`/orgs/${ORG}/experiments`);
    const { experiments } = (await listed.json()) as { experiments: { experimentId: string }[] };
    expect(experiments.map((e) => e.experimentId)).toContain(experiment.experimentId);

    const got = await app.request(`/orgs/${ORG}/experiments/${experiment.experimentId}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { experiment: { knob: string } }).experiment.knob).toBe("governance");
  });

  it("rejects an invalid experiment body with 400", async () => {
    const { app } = buildHarness();
    const res = await post(app, `/orgs/${ORG}/experiments`, {
      title: "",
      knob: "k",
      hypothesis: "h",
      seedTaskRef: SEED,
    });
    expect(res.status).toBe(400);
  });

  it("denies cross-org access with 403", async () => {
    const { app } = buildHarness();
    const res = await app.request(`/orgs/org_other/experiments`);
    expect(res.status).toBe(403);
  });

  it("is org-scoped: another org's experiment is not visible (404)", async () => {
    const { app, pool } = buildHarness();
    pool.seedExperiment({ experiment_id: "experiment_x", org_id: "org_other" });
    // alice is org_acme; the route's org param matches her org, but the row
    // belongs to org_other → org-scoped read sees zero rows → 404.
    const res = await app.request(`/orgs/${ORG}/experiments/experiment_x`);
    expect(res.status).toBe(404);
  });

  it("creates + lists cells under an experiment", async () => {
    const { app, pool } = buildHarness();
    pool.seedExperiment({ experiment_id: "experiment_1", org_id: ORG });
    const created = await post(app, `/orgs/${ORG}/experiments/experiment_1/cells`, {
      label: "control",
      frozenConfig: frozen("premium"),
      trialsTarget: 5,
    });
    expect(created.status).toBe(201);
    const { cell } = (await created.json()) as { cell: { cellId: string; trialsTarget: number } };
    expect(cell.trialsTarget).toBe(5);

    const listed = await app.request(`/orgs/${ORG}/experiments/experiment_1/cells`);
    const { cells } = (await listed.json()) as { cells: { cellId: string }[] };
    expect(cells.map((c) => c.cellId)).toContain(cell.cellId);
  });

  it("creating a cell under an unknown experiment is 404", async () => {
    const { app } = buildHarness();
    const res = await post(app, `/orgs/${ORG}/experiments/nope/cells`, {
      label: "c",
      frozenConfig: frozen("premium"),
      trialsTarget: 1,
    });
    expect(res.status).toBe(404);
  });

  it("triggers an experiment run via the injected scheduler", async () => {
    let ranWith: string | undefined;
    const { app, pool } = buildHarness({
      runExperiment: (async (_p: never, id: string) => {
        ranWith = id;
        return { experimentId: id, cells: [] } as never;
      }) as never,
    });
    pool.seedExperiment({ experiment_id: "experiment_run", org_id: ORG });
    const res = await post(app, `/orgs/${ORG}/experiments/experiment_run/run`, {});
    expect(res.status).toBe(200);
    expect(ranWith).toBe("experiment_run");
  });

  it("renders a cell scorecard from its cached trial scorecards", async () => {
    const { app, pool } = buildHarness();
    pool.seedExperiment({ experiment_id: "experiment_1", org_id: ORG });
    pool.seedCell({
      cell_id: "cell_a",
      experiment_id: "experiment_1",
      label: "a",
      frozen_config: frozen("premium"),
      trials_target: 3,
    });
    for (const [i, lt] of [100, 200, 300].entries()) {
      pool.seedTrial({
        trial_id: `trial_${i}`,
        cell_id: "cell_a",
        run_id: `run_${i}`,
        trial_index: i,
        accept_result: null,
        scorecard: scorecard(`run_${i}`, lt),
      });
    }
    const res = await app.request(`/orgs/${ORG}/cells/cell_a/scorecard`);
    expect(res.status).toBe(200);
    const { scorecard: sc } = (await res.json()) as {
      scorecard: { trials: number; metrics: Record<string, { point: number | null }> };
    };
    expect(sc.trials).toBe(3);
    // median of 100/200/300
    expect(sc.metrics["leadTimeSeconds"]?.point).toBe(200);
  });

  it("compares two cells and returns a verdict", async () => {
    const { app, pool } = buildHarness();
    pool.seedExperiment({ experiment_id: "experiment_1", org_id: ORG });
    pool.seedCell({
      cell_id: "cell_a",
      experiment_id: "experiment_1",
      label: "a",
      frozen_config: frozen("premium", "strict"),
      trials_target: 3,
    });
    pool.seedCell({
      cell_id: "cell_b",
      experiment_id: "experiment_1",
      label: "b",
      // differs in exactly ONE knob (governance)
      frozen_config: frozen("premium", "open"),
      trials_target: 3,
    });
    for (const [i, lt] of [100, 110, 120].entries()) {
      pool.seedTrial({
        trial_id: `a${i}`,
        cell_id: "cell_a",
        run_id: `ra${i}`,
        trial_index: i,
        accept_result: null,
        scorecard: scorecard(`ra${i}`, lt),
      });
      pool.seedTrial({
        trial_id: `b${i}`,
        cell_id: "cell_b",
        run_id: `rb${i}`,
        trial_index: i,
        accept_result: null,
        scorecard: scorecard(`rb${i}`, lt + 500),
      });
    }
    const res = await app.request(`/orgs/${ORG}/experiments/experiment_1/compare?cellA=cell_a&cellB=cell_b`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comparison: { metrics: Record<string, { verdict: string }> } };
    expect(body.comparison.metrics["leadTimeSeconds"]?.verdict).toBeDefined();
  });

  it("refuses a >1-knob comparison with 422 (one-knob invariant)", async () => {
    const { app, pool } = buildHarness();
    pool.seedExperiment({ experiment_id: "experiment_1", org_id: ORG });
    // cell_b differs in BOTH model (routing) and governance → >1 knob.
    pool.seedCell({
      cell_id: "cell_a",
      experiment_id: "experiment_1",
      label: "a",
      frozen_config: frozen("premium", "strict"),
      trials_target: 1,
    });
    pool.seedCell({
      cell_id: "cell_b",
      experiment_id: "experiment_1",
      label: "b",
      frozen_config: frozen("budget", "open"),
      trials_target: 1,
    });
    const res = await app.request(`/orgs/${ORG}/experiments/experiment_1/compare?cellA=cell_a&cellB=cell_b`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; differingKeys: string[] };
    expect(body.error).toBe("one_knob_violation");
    expect(body.differingKeys.sort()).toEqual(["governance", "routing"]);
  });
});

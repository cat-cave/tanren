// Former-bug / invariant pins for PR #943 org-costs convergence:
// constrained project-list join + server-side token-bucket sum.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { RunCostRecord } from "../src/routes/runs/contract.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new RunRoutesPool();
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
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

function seedRunFixture(pool: RunRoutesPool): { runId: string; projectId: string } {
  const projectId = "project_phase1";
  const runId = "run_fixture";
  pool.seedProject({ project_id: projectId, org_id: "org_acme" });
  pool.seedSpec({ spec_id: "spec_fixture", project_id: projectId, title: "Add fixture marker" });
  pool.seedRun({
    run_id: runId,
    spec_id: "spec_fixture",
    project_id: projectId,
    status: "completed",
    outcome: "ok",
    pr_url: "https://github.com/acme/x/pull/1",
  });
  pool.projectMembers.add(`${projectId}:user_alice`);
  pool.seedCost({ id: 1, run_id: runId, task_id: "task_write_1", project_id: projectId, cost_usd: "0.005" });
  pool.seedCost({ id: 2, run_id: runId, task_id: "task_check_2", project_id: projectId, cost_usd: "0.002" });
  return { runId, projectId };
}

describe("PR #943 project-list constrained join", () => {
  it("does not surface a same-org, same-spec-id title from another project", async () => {
    // Former bug: LEFT JOIN specs ON s.spec_id = r.spec_id alone could attach
    // another project's title when ids collide within an org.
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_run_side", org_id: "org_acme" });
    pool.seedProject({ project_id: "project_spec_side", org_id: "org_acme" });
    pool.seedSpec({
      spec_id: "spec_shared_id",
      project_id: "project_spec_side",
      title: "Spec on another project",
    });
    pool.seedRun({
      run_id: "run_mismatched_binding",
      spec_id: "spec_shared_id",
      project_id: "project_run_side",
      status: "completed",
      outcome: "ok",
      started_at: new Date("2026-05-01T00:00:00.000Z"),
    });
    pool.projectMembers.add("project_run_side:user_alice");

    const response = await app.request("/orgs/org_acme/projects/project_run_side/runs");
    const bodyText = await response.text();
    expect(response.status).not.toBe(200);
    expect(bodyText).not.toContain("Spec on another project");
    expect(bodyText).not.toContain("run_mismatched_binding");

    const listSql =
      pool.queries.find(
        ({ sql }) =>
          /FROM runs r\s+LEFT JOIN specs s/u.test(sql) &&
          /r\.project_id = \$1/u.test(sql) &&
          /r\.org_id = \$2/u.test(sql),
      )?.sql ?? "";
    expect(listSql).toMatch(
      /LEFT JOIN specs s ON s\.spec_id = r\.spec_id AND s\.project_id = r\.project_id AND s\.org_id = \$2/u,
    );

    const canonical =
      "SELECT r.run_id, s.title FROM runs r LEFT JOIN specs s ON s.spec_id = r.spec_id " +
      "AND s.project_id = r.project_id AND s.org_id = $2 WHERE r.project_id = $1 AND r.org_id = $2";
    for (const mutated of [
      canonical.replace(" AND s.project_id = r.project_id", ""),
      canonical.replace(" AND s.org_id = $2", ""),
    ]) {
      await expect(pool.query(mutated, ["project_run_side", "org_acme"])).rejects.toThrow(
        /constrained-join predicates/u,
      );
    }
  });
});

describe("PR #943 server token-bucket invariant", () => {
  it("fails closed when token buckets do not sum to totalTokens", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const row = pool.costs.find((c) => c.run_id === runId);
    if (row === undefined) throw new Error("fixture cost not seeded");
    row.input_tokens = 10;
    row.cached_input_tokens = 0;
    row.cache_creation_tokens = 0;
    row.output_tokens = 5;
    row.reasoning_output_tokens = 0;
    row.total_tokens = 99;

    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs/${runId}/costs`);
    expect(response.status).not.toBe(200);
    expect(() =>
      RunCostRecord.parse({
        id: 1,
        runId,
        taskId: "t",
        projectId,
        cli: "codex",
        provider: "openai",
        model: "gpt",
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 99,
        costUsd: "0.01",
        notionalCostUsd: "0.01",
        billingMode: "per_token",
        costBasis: "provider_response",
        recordedAt: new Date(),
      }),
    ).toThrow(/token buckets/u);
  });

  it("accepts a valid zero-token record and a large exact total", () => {
    expect(
      RunCostRecord.parse({
        id: "9007199254740993",
        runId: "run_x",
        taskId: "t",
        projectId: "p",
        cli: "codex",
        provider: "openai",
        model: "gpt",
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        costUsd: null,
        notionalCostUsd: null,
        billingMode: "subscription",
        costBasis: "unknown",
        recordedAt: new Date(),
      }).totalTokens,
    ).toBe(0);
    expect(
      RunCostRecord.parse({
        id: 1,
        runId: "run_x",
        taskId: "t",
        projectId: "p",
        cli: "codex",
        provider: "openai",
        model: "gpt",
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        cacheCreationTokens: 0,
        outputTokens: 500_000,
        reasoningOutputTokens: 250_000,
        totalTokens: 3_750_000,
        costUsd: "12.5",
        notionalCostUsd: "12.5",
        billingMode: "per_token",
        costBasis: "provider_response",
        recordedAt: new Date(),
      }).totalTokens,
    ).toBe(3_750_000);
  });
});

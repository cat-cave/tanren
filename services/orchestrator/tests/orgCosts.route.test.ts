import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { OrgCosts } from "../src/routes/runs/contract.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const SNAPSHOT_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";
type RecordedQuery = RunRoutesPool["queries"][number];

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function harness(actor: ActorContext | null = alice) {
  const resolvedActor = actor ?? undefined;
  const pool = new RunRoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return resolvedActor as ActorContext;
        },
      } as never,
      localDevActor: resolvedActor,
    }),
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

function seedRun(pool: RunRoutesPool, id: string, startedAt: Date): void {
  const projectId = `project_${id}`;
  const specId = `spec_${id}`;
  pool.seedProject({ project_id: projectId, org_id: "org_acme" });
  pool.seedSpec({ spec_id: specId, project_id: projectId, title: `Spec ${id}` });
  pool.seedRun({
    run_id: id,
    spec_id: specId,
    project_id: projectId,
    status: "completed",
    outcome: "ok",
    started_at: startedAt,
  });
}

function isOrgCostRead(sql: string): boolean {
  return (
    sql.includes("FROM cost_records") &&
    sql.includes("WHERE org_id = $1") &&
    sql.includes("ORDER BY recorded_at ASC, id ASC")
  );
}

function isOrgRunRead(sql: string): boolean {
  return (
    sql.includes("FROM runs r") &&
    sql.includes("WHERE r.org_id = $1") &&
    sql.includes("ORDER BY r.started_at DESC, r.run_id ASC")
  );
}

function expectPageReadPlan(
  queries: readonly RecordedQuery[],
  expected: { costReads: number; runReads: number },
): void {
  const costReads = queries.filter(({ sql }) => isOrgCostRead(sql));
  const runReads = queries.filter(({ sql }) => isOrgRunRead(sql));
  expect(costReads).toHaveLength(expected.costReads);
  expect(runReads).toHaveLength(expected.runReads);
  expect([...costReads, ...runReads].every(({ sql }) => /LIMIT \$\d+/u.test(sql))).toBe(true);

  // Promise.all starts both store operations, but they share the one PoolClient
  // checked out by runWithOrgScope. node-postgres queues that client's queries,
  // so the observable statement order is CostStore then RunStore, not DB-level
  // parallel execution. Matching the complete list also rejects duplicate,
  // fan-out, or alternate-authority reads.
  expect(queries.map(({ sql }) => classifyPageStatement(sql))).toEqual([
    "begin",
    "org-scope",
    "snapshot",
    ...Array.from({ length: expected.costReads }, () => "cost-store" as const),
    ...Array.from({ length: expected.runReads }, () => "run-store" as const),
    "commit",
  ]);
  expect(queries).toHaveLength(4 + expected.costReads + expected.runReads);
  expect(queries[0]).toEqual({ sql: "BEGIN", params: [] });
  expect(queries[1]).toEqual({ sql: "SET LOCAL app.current_org_id = 'org_acme'", params: [] });
  expect(queries[2]).toEqual({ sql: SNAPSHOT_SQL, params: [] });
  expect(queries.at(-1)).toEqual({ sql: "COMMIT", params: [] });
}

function classifyPageStatement(sql: string): string {
  if (sql === "BEGIN") return "begin";
  if (sql === "SET LOCAL app.current_org_id = 'org_acme'") return "org-scope";
  if (sql === SNAPSHOT_SQL) return "snapshot";
  if (isOrgCostRead(sql)) return "cost-store";
  if (isOrgRunRead(sql)) return "run-store";
  if (sql === "COMMIT") return "commit";
  if (sql === "ROLLBACK") return "rollback";
  return `unexpected: ${sql}`;
}

describe("org costs read model", () => {
  it("returns a domain-bound, genuinely empty terminal page", async () => {
    const { app } = harness();
    const response = await app.request("/orgs/org_acme/costs");
    expect(response.status).toBe(200);
    expect(OrgCosts.parse(await response.json())).toEqual({
      orgId: "org_acme",
      costs: [],
      runs: [],
      nextCursor: null,
    });
  });

  it("round-trips dual cursors and binds an int64 cost key exactly on page two", async () => {
    const { app, pool } = harness();
    const connect = vi.spyOn(pool, "connect");
    const release = vi.spyOn(pool, "release");
    const firstCostId = "9007199254740993";
    const secondCostId = "9007199254740994";
    const thirdCostId = "9007199254740995";
    const costIds = [firstCostId, secondCostId, thirdCostId];
    expect(BigInt(firstCostId)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const tiedRecordedAt = new Date("2026-05-01T00:01:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      const runId = `run_${index}`;
      seedRun(pool, runId, new Date(`2026-05-0${index + 1}T00:00:00.000Z`));
      pool.seedCost({
        id: costIds[index]!,
        run_id: runId,
        task_id: `task_${index}`,
        project_id: `project_${runId}`,
        recorded_at: tiedRecordedAt,
      });
    }

    let queryOffset = pool.queries.length;
    const firstResponse = await app.request("/orgs/org_acme/costs?pageSize=1");
    const firstQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(firstQueries, { costReads: 1, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).toBe(200);
    const first = OrgCosts.parse(await firstResponse.json());
    expect(first.costs.map(({ id }) => id)).toEqual([firstCostId]);
    expect(first.runs.map(({ runId }) => runId)).toEqual(["run_2"]);
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: { ts: tiedRecordedAt.toISOString(), id: firstCostId },
      run: { ts: "2026-05-03T00:00:00.000Z", id: "run_2" },
      costsDone: false,
      runsDone: false,
    });

    queryOffset = pool.queries.length;
    const secondResponse = await app.request(
      `/orgs/org_acme/costs?pageSize=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const secondQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(secondQueries, { costReads: 1, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(secondResponse.status).toBe(200);
    const second = OrgCosts.parse(await secondResponse.json());
    expect(second.costs.map(({ id }) => id)).toEqual([secondCostId]);
    expect(second.runs.map(({ runId }) => runId)).toEqual(["run_1"]);

    const secondCostRead = secondQueries.find(({ sql }) => isOrgCostRead(sql));
    expect(secondCostRead?.sql).toContain("(recorded_at, id) > ($2::timestamptz, $3::bigint)");
    expect(secondCostRead?.params).toEqual(["org_acme", tiedRecordedAt, firstCostId, 2]);
    expect(typeof secondCostRead?.params[2]).toBe("string");
    const secondRunRead = secondQueries.find(({ sql }) => isOrgRunRead(sql));
    expect(secondRunRead?.params).toEqual(["org_acme", new Date("2026-05-03T00:00:00.000Z"), "run_2", 2]);
    expect(second.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(second.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: { ts: tiedRecordedAt.toISOString(), id: secondCostId },
      run: { ts: "2026-05-02T00:00:00.000Z", id: "run_1" },
      costsDone: false,
      runsDone: false,
    });

    queryOffset = pool.queries.length;
    const thirdResponse = await app.request(
      `/orgs/org_acme/costs?pageSize=1&cursor=${encodeURIComponent(second.nextCursor!)}`,
    );
    const thirdQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(thirdQueries, { costReads: 1, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
    const third = OrgCosts.parse(await thirdResponse.json());
    expect(third.costs.map(({ id }) => id)).toEqual([thirdCostId]);
    expect(third.runs.map(({ runId }) => runId)).toEqual(["run_0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("stops reading a completed cost stream while the run stream advances", async () => {
    const { app, pool } = harness();
    const connect = vi.spyOn(pool, "connect");
    const release = vi.spyOn(pool, "release");
    for (let index = 0; index < 3; index += 1) {
      seedRun(pool, `run_${index}`, new Date(`2026-05-0${index + 1}T00:00:00.000Z`));
    }
    pool.seedCost({
      id: 1,
      run_id: "run_0",
      task_id: "task_0",
      project_id: "project_run_0",
      recorded_at: new Date("2026-05-01T00:01:00.000Z"),
    });

    let queryOffset = pool.queries.length;
    const firstResponse = await app.request("/orgs/org_acme/costs?pageSize=1");
    const firstQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(firstQueries, { costReads: 1, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const first = OrgCosts.parse(await firstResponse.json());
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: null,
      costsDone: true,
      run: { id: "run_2" },
      runsDone: false,
    });

    queryOffset = pool.queries.length;
    const secondResponse = await app.request(
      `/orgs/org_acme/costs?pageSize=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const secondQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(secondQueries, { costReads: 0, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    const second = OrgCosts.parse(await secondResponse.json());
    expect(second.costs).toEqual([]);
    expect(second.runs.map(({ runId }) => runId)).toEqual(["run_1"]);
    expect(second.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(second.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: null,
      costsDone: true,
      run: { id: "run_1" },
      runsDone: false,
    });
  });

  it("stops reading a completed run stream while the cost stream advances", async () => {
    const { app, pool } = harness();
    const connect = vi.spyOn(pool, "connect");
    const release = vi.spyOn(pool, "release");
    const recordedAt = new Date("2026-05-01T00:01:00.000Z");
    seedRun(pool, "run_only", new Date("2026-05-01T00:00:00.000Z"));
    for (const id of ["11", "12", "13"]) {
      pool.seedCost({
        id,
        run_id: "run_only",
        task_id: `task_${id}`,
        project_id: "project_run_only",
        recorded_at: recordedAt,
      });
    }

    let queryOffset = pool.queries.length;
    const firstResponse = await app.request("/orgs/org_acme/costs?pageSize=1");
    const firstQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(firstQueries, { costReads: 1, runReads: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const first = OrgCosts.parse(await firstResponse.json());
    expect(first.costs.map(({ id }) => id)).toEqual(["11"]);
    expect(first.runs.map(({ runId }) => runId)).toEqual(["run_only"]);
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: { ts: recordedAt.toISOString(), id: "11" },
      costsDone: false,
      run: null,
      runsDone: true,
    });

    queryOffset = pool.queries.length;
    const secondResponse = await app.request(
      `/orgs/org_acme/costs?pageSize=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const secondQueries = pool.queries.slice(queryOffset);
    expectPageReadPlan(secondQueries, { costReads: 1, runReads: 0 });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    const second = OrgCosts.parse(await secondResponse.json());
    expect(second.costs.map(({ id }) => id)).toEqual(["12"]);
    expect(second.runs).toEqual([]);
    expect(second.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(second.nextCursor!, "base64").toString("utf8")) as unknown).toMatchObject({
      cost: { ts: recordedAt.toISOString(), id: "12" },
      costsDone: false,
      run: null,
      runsDone: true,
    });
    const secondCostRead = secondQueries.find(({ sql }) => isOrgCostRead(sql));
    expect(secondCostRead?.params).toEqual(["org_acme", recordedAt, "11", 2]);
  });

  it("preserves unknown totals as null and genuine no-record totals as zero", async () => {
    const { app, pool } = harness();
    seedRun(pool, "run_unknown", new Date("2026-05-02T00:00:00.000Z"));
    seedRun(pool, "run_zero", new Date("2026-05-01T00:00:00.000Z"));
    pool.seedCost({
      id: 1,
      run_id: "run_unknown",
      task_id: "task_unknown",
      project_id: "project_run_unknown",
      cost_usd: null,
      notional_cost_usd: null,
      billing_mode: "subscription",
      cost_basis: "unknown",
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
    });
    const response = await app.request("/orgs/org_acme/costs");
    const page = OrgCosts.parse(await response.json());
    expect(page.runs.find((run) => run.runId === "run_unknown")?.costTotalUsd).toBeNull();
    expect(page.runs.find((run) => run.runId === "run_zero")?.costTotalUsd).toBe("0");
    expect(page.costs[0]).toMatchObject({ costUsd: null, notionalCostUsd: null, costBasis: "unknown" });

    const runsSql = pool.queries.find(({ sql }) => /FROM runs r/u.test(sql))?.sql ?? "";
    expect(runsSql).not.toContain("COALESCE");
    expect(runsSql).toContain("COUNT(cr.cost_usd) = COUNT(cr.id)");
  });

  it("authorizes before reads and excludes foreign-org rows", async () => {
    const { app, pool } = harness();
    seedRun(pool, "run_acme", new Date("2026-05-01T00:00:00.000Z"));
    pool.seedProject({ project_id: "project_other", org_id: "org_other" });
    pool.seedSpec({ spec_id: "spec_other", project_id: "project_other", title: "Foreign" });
    pool.seedRun({ run_id: "run_other", spec_id: "spec_other", project_id: "project_other" });
    pool.seedCost({ id: 99, run_id: "run_other", task_id: "task_other", project_id: "project_other" });

    const ok = OrgCosts.parse(await (await app.request("/orgs/org_acme/costs")).json());
    expect(ok.runs.map((run) => run.runId)).toEqual(["run_acme"]);
    expect(ok.costs).toEqual([]);
    const dataReads = pool.queries.filter(({ sql }) => /\bFROM\s+(runs|cost_records|events)\b/u.test(sql));
    expect(dataReads).toHaveLength(2);
    expect(dataReads.every(({ sql }) => sql.includes("org_id = $1"))).toBe(true);

    pool.queries.splice(0);
    const denied = await app.request("/orgs/org_other/costs");
    expect(denied.status).toBe(403);
    expect(pool.queries).toEqual([]);
  });

  it("rejects malformed cursors without reading either store", async () => {
    const { app, pool } = harness();
    const response = await app.request("/orgs/org_acme/costs?cursor=not-a-cursor");
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: "invalid_cursor" });
    expect(pool.queries.filter(({ sql }) => /\bFROM\s+(runs|cost_records)\b/u.test(sql))).toEqual([]);
  });

  it("binds an opaque cursor to the organization that issued it", async () => {
    const platformAdmin: ActorContext = { ...alice, orgId: null, scopes: ["platform:admin"] };
    const { app, pool } = harness(platformAdmin);
    seedRun(pool, "run_1", new Date("2026-05-01T00:00:00.000Z"));
    seedRun(pool, "run_2", new Date("2026-05-02T00:00:00.000Z"));
    const first = OrgCosts.parse(await (await app.request("/orgs/org_acme/costs?pageSize=1")).json());
    expect(first.nextCursor).not.toBeNull();
    const response = await app.request(
      `/orgs/org_other/costs?cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when no actor is resolved", async () => {
    const { app, pool } = harness(null);
    const response = await app.request("/orgs/org_acme/costs");
    expect(response.status).toBe(401);
    expect(pool.queries).toEqual([]);
  });

  it("surfaces malformed database cost rows as a 500", async () => {
    const { app, pool } = harness();
    seedRun(pool, "run_bad", new Date("2026-05-01T00:00:00.000Z"));
    const cost = pool.seedCost({
      id: 1,
      run_id: "run_bad",
      task_id: "task_bad",
      project_id: "project_run_bad",
    });
    cost.billing_mode = "invented";
    const response = await app.request("/orgs/org_acme/costs");
    expect(response.status).toBe(500);
  });

  it("fails closed on a mismatched run/spec binding without fabricating a row", async () => {
    const { app, pool } = harness();
    const connect = vi.spyOn(pool, "connect");
    const release = vi.spyOn(pool, "release");
    // Realistic constrained-join miss: run and a same-id spec exist, but the
    // org-costs LEFT JOIN also requires s.project_id = r.project_id AND
    // s.org_id = $1, so a cross-project binding yields null spec_title.
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

    const queryOffset = pool.queries.length;
    const response = await app.request("/orgs/org_acme/costs");
    const queries = pool.queries.slice(queryOffset);
    const bodyText = await response.text();

    // Non-200 / unavailable to the product — never a fabricated 200 row with
    // the old "(spec missing)" placeholder.
    expect(response.status).not.toBe(200);
    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("(spec missing)");
    expect(bodyText).not.toContain("run_mismatched_binding");
    expect(bodyText).not.toContain("Spec on another project");
    // Body must not validate as OrgCosts either (covers soft-errors that still
    // return a JSON shell without the placeholder string).
    const asOrgCosts = (() => {
      try {
        return OrgCosts.safeParse(JSON.parse(bodyText) as unknown);
      } catch {
        return { success: false as const };
      }
    })();
    expect(asOrgCosts.success).toBe(false);

    // One scoped client, stores then decoder throw → ROLLBACK (not COMMIT),
    // release exactly once, no parallel/alternate authority.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(queries.map(({ sql }) => classifyPageStatement(sql))).toEqual([
      "begin",
      "org-scope",
      "snapshot",
      "cost-store",
      "run-store",
      "rollback",
    ]);
    expect(queries).toHaveLength(6);
    expect(queries[0]).toEqual({ sql: "BEGIN", params: [] });
    expect(queries[1]).toEqual({ sql: "SET LOCAL app.current_org_id = 'org_acme'", params: [] });
    expect(queries[2]).toEqual({ sql: SNAPSHOT_SQL, params: [] });
    expect(queries.at(-1)).toEqual({ sql: "ROLLBACK", params: [] });
    expect(queries.some(({ sql }) => sql === "COMMIT")).toBe(false);
    const dataReads = queries.filter(({ sql }) => isOrgCostRead(sql) || isOrgRunRead(sql));
    expect(dataReads).toHaveLength(2);
    expect(dataReads.every(({ sql }) => sql.includes("org_id = $1"))).toBe(true);
  });
});

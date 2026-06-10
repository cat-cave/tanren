// Integration `rebase_vs_rebuild` route contract test. Mirrors the DORA route's
// authz shape: org membership (`actorCanAccessOrg`) + project access
// (`assertProjectAccess`) gate the read; the body is the schema-valid
// `IntegrationMetrics`. The pool is a tiny in-memory fake that pattern-matches the
// authz SELECTs plus the insight's read-time JOINs (events / cost_records / runs)
// — no live Postgres, the route reads straight off `pool.query`.

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationMetricsRoutes } from "../src/routes/integrationMetrics/index.js";

const ORG = "org_acme";
const PROJECT = "project_1";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface Result {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/**
 * A minimal fake `pg.Pool`: answers the project-org-id gate, the project-member
 * gate, and the three insight reads (rebase events, summed cost, run durations,
 * proof-reuse count). `projectOrg` controls the authz gate; the event/cost/run
 * fixtures drive the metric.
 */
function fakePool(opts: {
  projectOrg?: string | null;
  rebases?: { run_id: string; decision: string }[];
  costs?: { run_id: string; total_tokens: number; cost_usd: number | null }[];
  runs?: { run_id: string; started_at: Date; ended_at: Date | null }[];
  proofReuse?: number;
}): pg.Pool {
  const rebases = opts.rebases ?? [];
  const costs = opts.costs ?? [];
  const runs = opts.runs ?? [];
  const proofReuse = opts.proofReuse ?? 0;
  return {
    async query(sql: string, params: unknown[] = []): Promise<Result> {
      const text = sql.replaceAll(/\s+/gu, " ").trim();
      if (text.startsWith("SELECT org_id FROM projects")) {
        const org = opts.projectOrg === undefined ? ORG : opts.projectOrg;
        return org === null ? rows([]) : rows([{ org_id: org }]);
      }
      if (text.startsWith("SELECT role FROM project_members")) {
        // alice is gated by org membership, not a project_members row.
        return rows([]);
      }
      if (text.includes("FROM events e") && text.includes("'integration.rebase'")) {
        return rows(rebases);
      }
      if (text.includes("FROM cost_records c")) {
        const wanted = new Set((params[1] as string[]) ?? []);
        return rows(costs.filter((c) => wanted.has(c.run_id)));
      }
      if (text.includes("FROM runs r")) {
        const wanted = new Set((params[1] as string[]) ?? []);
        return rows(runs.filter((r) => wanted.has(r.run_id)));
      }
      if (text.includes("FROM events e") && text.includes("'integration.proof.reused'")) {
        return rows([{ reuse_count: proofReuse }]);
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as pg.Pool;
}

function rows(r: Record<string, unknown>[]): Result {
  return { rows: r, rowCount: r.length };
}

function buildApp(pool: pg.Pool, actor: ActorContext = alice) {
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
  app.route("/orgs", createIntegrationMetricsRoutes({ pool }));
  return app;
}

describe("integration-metrics route — authz", () => {
  it("denies a cross-org actor with 403", async () => {
    const app = buildApp(fakePool({}), { ...alice, orgId: "org_other" });
    const res = await app.request(`/orgs/${ORG}/projects/${PROJECT}/integration-metrics`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("org_access_denied");
  });

  it("denies when the project belongs to no accessible org with 403", async () => {
    const app = buildApp(fakePool({ projectOrg: null }));
    const res = await app.request(`/orgs/${ORG}/projects/${PROJECT}/integration-metrics`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("project_access_denied");
  });
});

describe("integration-metrics route — shape", () => {
  it("returns the rebase_vs_rebuild metrics for an authorized actor", async () => {
    const ended = new Date("2026-05-28T00:00:00.000Z");
    const app = buildApp(
      fakePool({
        rebases: [
          { run_id: "r1", decision: "rebased_clean" },
          { run_id: "r2", decision: "replanned" },
        ],
        costs: [
          { run_id: "r1", total_tokens: 100, cost_usd: 0.1 },
          { run_id: "r2", total_tokens: 1000, cost_usd: 1 },
        ],
        runs: [
          { run_id: "r1", started_at: new Date(ended.getTime() - 60_000), ended_at: ended },
          { run_id: "r2", started_at: new Date(ended.getTime() - 600_000), ended_at: ended },
        ],
        proofReuse: 3,
      }),
    );
    const res = await app.request(`/orgs/${ORG}/projects/${PROJECT}/integration-metrics?windowDays=30`);
    expect(res.status).toBe(200);
    const { metrics } = (await res.json()) as {
      metrics: {
        projectId: string;
        totalRebases: number;
        proofReuseCount: number;
        buckets: Record<string, { count: number; medianTokens: number | null }>;
        rebaseVsRebuild: { rebaseCheaper: boolean | null };
      };
    };
    expect(metrics.projectId).toBe(PROJECT);
    expect(metrics.totalRebases).toBe(2);
    expect(metrics.proofReuseCount).toBe(3);
    expect(metrics.buckets["rebased_clean"]?.count).toBe(1);
    expect(metrics.buckets["rebased_clean"]?.medianTokens).toBe(100);
    expect(metrics.buckets["replanned"]?.count).toBe(1);
    expect(metrics.rebaseVsRebuild.rebaseCheaper).toBe(true);
  });

  it("clamps an out-of-range windowDays and still returns 200", async () => {
    const app = buildApp(fakePool({}));
    const res = await app.request(`/orgs/${ORG}/projects/${PROJECT}/integration-metrics?windowDays=99999`);
    expect(res.status).toBe(200);
    const { metrics } = (await res.json()) as { metrics: { windowDays: number } };
    expect(metrics.windowDays).toBe(365);
  });
});

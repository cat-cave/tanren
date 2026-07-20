// cspell:ignore mqeval mqgrp
// mq-10 read-only projection over `merge_repair_routes`. Unit-level coverage of the HTTP
// surface's fail-closed authorization + limit parsing + row projection, with a mocked pool
// (the RLS-scoped end-to-end path is proven in mergeRepairRoutes.rls.integration.test.ts).
import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueRepairRouteRoutes } from "../src/routes/mergeQueue/repairRoutes.js";

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: "org-a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

interface RepairRow {
  route_id: string;
  source_spec_id: string;
  group_id: string;
  evaluation_id: string;
  disposition: "repair_in_place" | "respec" | "blocked_needs_attention";
  failure_class: string;
  failure_signature: string;
  magnitude: number;
  finding_ids: string[];
  reason_codes: string[];
  respec_generation: number;
  prior_agent_route: string | null;
  next_agent_route: string | null;
  packet_hash: string | null;
  replacement_spec_ids: string[];
  created_at: Date | string;
}

function repairRow(overrides: Partial<RepairRow> = {}): RepairRow {
  return {
    route_id: "route_1",
    source_spec_id: "spec_stuck",
    group_id: "mqgrp_x",
    evaluation_id: "mqeval_x",
    disposition: "respec",
    failure_class: "deterministic_policy",
    failure_signature: "rc:audit_policy|fi:f1",
    magnitude: 1,
    finding_ids: ["f1"],
    reason_codes: ["audit_policy"],
    respec_generation: 2,
    prior_agent_route: "writer.in_place",
    next_agent_route: "answerer.respec",
    packet_hash: "sha256:deadbeef",
    replacement_spec_ids: ["spec_a"],
    created_at: new Date("2026-07-16T12:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A mocked pool that answers the authz probes (projects org + member role) plus the
 * repair-routes SELECT. `projectOrgId === null` makes the project unresolvable (denied);
 * a differing org string simulates a cross-org project.
 */
function scopedPool(options: { projectOrgId: string | null; rows: RepairRow[] }): {
  pool: pg.Pool;
  seen: string[];
} {
  const seen: string[] = [];
  type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
  const client = {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(async (sql) => {
      seen.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT org_id FROM projects")) {
        return {
          rows: options.projectOrgId === null ? [] : [{ org_id: options.projectOrgId }],
          rowCount: options.projectOrgId === null ? 0 : 1,
        };
      }
      if (sql.includes("SELECT role FROM project_members")) return { rows: [{ role: "member" }], rowCount: 1 };
      if (sql.includes("FROM merge_repair_routes")) return { rows: options.rows, rowCount: options.rows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    release: vi.fn<() => void>(),
  };
  const pool = { connect: vi.fn<() => Promise<typeof client>>(async () => client) } as unknown as pg.Pool;
  return { pool, seen };
}

function buildApp(options: { projectOrgId: string | null; rows: RepairRow[]; actor?: ActorContext }) {
  const { pool, seen } = scopedPool({ projectOrgId: options.projectOrgId, rows: options.rows });
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", options.actor ?? ADMIN);
    await next();
  });
  app.route("/orgs", createMergeQueueRepairRouteRoutes({ pool }));
  return { app, seen };
}

describe("mq-10 merge_repair_routes HTTP read surface", () => {
  it("projects durable rows into the typed lineage response, newest-first", async () => {
    const { app } = buildApp({
      projectOrgId: "org-a",
      rows: [repairRow(), repairRow({ route_id: "route_2", disposition: "repair_in_place" })],
    });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repairRoutes: { routeId: string; disposition: string; observedAt: string }[] };
    expect(body.repairRoutes).toHaveLength(2);
    expect(body.repairRoutes[0]!.routeId).toBe("route_1");
    expect(body.repairRoutes[0]!.disposition).toBe("respec");
    // created_at (a Date) is normalized to an ISO offset string by the projection.
    expect(body.repairRoutes[0]!.observedAt).toBe("2026-07-16T12:00:00.000Z");
  });

  it("normalizes a string created_at into an ISO timestamp", async () => {
    const { app } = buildApp({
      projectOrgId: "org-a",
      rows: [repairRow({ created_at: "2026-07-16T09:30:00Z" })],
    });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes");
    const body = (await res.json()) as { repairRoutes: { observedAt: string }[] };
    expect(body.repairRoutes[0]!.observedAt).toBe("2026-07-16T09:30:00.000Z");
  });

  it("passes a spec filter through to the scoped SELECT", async () => {
    const { app, seen } = buildApp({ projectOrgId: "org-a", rows: [repairRow()] });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes?specId=spec_stuck");
    expect(res.status).toBe(200);
    const projectionSql = seen.find((s) => s.includes("FROM merge_repair_routes"));
    expect(projectionSql).toContain("AND source_spec_id = $4");
  });

  it("fails closed with 404 when the actor cannot access the path org", async () => {
    const outsider: ActorContext = { ...ADMIN, orgId: "org-other", scopes: ["org:member"] };
    const { app, seen } = buildApp({ projectOrgId: "org-a", rows: [repairRow()], actor: outsider });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "merge_queue_repair_routes_not_found" });
    // Denied before any DB round-trip.
    expect(seen).toHaveLength(0);
  });

  it("rejects an out-of-range limit with 400 without touching the database", async () => {
    const { app, seen } = buildApp({ projectOrgId: "org-a", rows: [repairRow()] });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes?limit=99999");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_limit" });
    expect(seen).toHaveLength(0);
  });

  it("returns 404 (never rows) when the resolved project belongs to a different org", async () => {
    const { app } = buildApp({ projectOrgId: "org-b", rows: [repairRow()] });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "merge_queue_repair_routes_not_found" });
  });

  it("returns 404 when the project is unresolvable (access denied)", async () => {
    const member: ActorContext = { ...ADMIN, orgId: "org-a", scopes: ["org:member"] };
    const { app } = buildApp({ projectOrgId: null, rows: [repairRow()], actor: member });
    const res = await app.request("/orgs/org-a/projects/project-a/merge-queue/repair-routes");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "merge_queue_repair_routes_not_found" });
  });
});

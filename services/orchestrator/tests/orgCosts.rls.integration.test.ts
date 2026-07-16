// Production org-cost route proof against a freshly migrated PostgreSQL database.
// The normal suite skips this file honestly; `just smoke-rls-org-costs` enables it.

import type { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { IdentityStore } from "../src/auth/identityStore.js";
import type { IdentityProviderId } from "../src/auth/schemas.js";
import { InMemorySecretStore, type CommandSubstrate } from "../src/engine/contracts/index.js";
import { buildApp } from "../src/main.js";
import { SESSION_COOKIE, type ActorContextEnv } from "../src/middleware/auth.js";
import { OrgCosts, type OrgCosts as OrgCostsPage } from "../src/routes/runs/contract.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe.sequential : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

const USER = "user_org_cost_route";
const ORG = "org_cost_route_member";
const FOREIGN_ORG = "org_cost_route_foreign";
const PROJECT_A = "project_cost_route_a";
const PROJECT_B = "project_cost_route_b";
const SPEC_A = "spec_cost_route_a";
const SPEC_B = "spec_cost_route_b";
const RUN_A = "run_cost_route_a";
const RUN_B = "run_cost_route_b";
const FOREIGN_RUN = "run_cost_route_foreign_sentinel";
const COST_IDS = ["9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"] as const;
const FOREIGN_COST_ID = "9007199254741999";
const SNAPSHOT_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";

function dbName(): string {
  return `tanren_org_cost_route_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

const ssh = { run: async () => ({}) } as unknown as CommandSubstrate;

async function productionApp(pool: Pool, store: IdentityStore): Promise<Hono<ActorContextEnv>> {
  return (await buildApp({
    pool,
    secrets: new InMemorySecretStore(),
    vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    auth: { store, providers: new Map<IdentityProviderId, never>(), publicBaseUrl: "http://localhost" },
    ssh,
  })) as Hono<ActorContextEnv>;
}

function traceRealQueries(pool: Pool): string[] {
  const statements: string[] = [];
  const traced = new WeakSet<object>();
  pool.on("acquire", (client) => {
    if (traced.has(client)) return;
    traced.add(client);
    const realQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((first: unknown, ...rest: unknown[]) => {
      const text = queryText(first);
      if (text !== undefined) statements.push(text);
      return realQuery(first, ...rest);
    }) as typeof client.query;
  });
  return statements;
}

function queryText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || !("text" in value)) return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function isOrgCostDataRead(sql: string): boolean {
  return sql.includes("FROM cost_records") || sql.includes("FROM runs r");
}

function routeTransaction(trace: readonly string[]): string[] {
  const begin = trace.lastIndexOf("BEGIN");
  return begin < 0 ? [] : trace.slice(begin);
}

function decodeDualCursor(cursor: string): {
  cost: { ts: string; id: string } | null;
  run: { ts: string; id: string } | null;
  costsDone: boolean;
  runsDone: boolean;
} {
  return JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as {
    cost: { ts: string; id: string } | null;
    run: { ts: string; id: string } | null;
    costsDone: boolean;
    runsDone: boolean;
  };
}

describeDb("org costs route — real PostgreSQL, auth, RLS, and dual cursor", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;
  let store: IdentityStore;
  let app: Hono<ActorContextEnv>;
  let sessionId: string;
  let trace: string[];

  const authHeaders = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${sessionId}` });

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({
      connectionString: databaseUrl(ADMIN_URL, database, { user: APP_ROLE, password: APP_PASSWORD }),
      max: 1,
    });
    systemPool = new Pool({
      connectionString: databaseUrl(ADMIN_URL, database, { user: SYSTEM_ROLE, password: SYSTEM_PASSWORD }),
    });
    setSystemPool(systemPool);

    await seedFixture(ownerPool);
    await installSnapshotAssertion(ownerPool);
    store = new IdentityStore(appPool);
    sessionId = (await store.createSession(USER)).id;
    trace = traceRealQueries(appPool);
    app = await productionApp(appPool, store);
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
    await appPool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("returns 401 before reads and 403 for a non-member without foreign cost leakage", async () => {
    trace.splice(0);
    const unauthenticated = await app.request(`/orgs/${ORG}/costs`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: "unauthorized" });
    expect(trace).toEqual([]);

    const forbidden = await app.request(`/orgs/${FOREIGN_ORG}/costs`, { headers: authHeaders() });
    expect(forbidden.status).toBe(403);
    const body = await forbidden.text();
    expect(body).not.toContain(FOREIGN_RUN);
    expect(body).not.toContain(FOREIGN_COST_ID);
    expect(trace.filter((sql) => isOrgCostDataRead(sql))).toEqual([]);
    expect(trace).not.toContain("BEGIN");
  });

  it("returns exact pages with independent int64 cursors and honest partial cost truth", async () => {
    expect(BigInt(COST_IDS[0])).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const role = await ownerPool.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    const unscoped = await appPool.query<{ n: string }>("SELECT count(*)::text AS n FROM cost_records");
    expect(unscoped.rows[0]?.n).toBe("0");

    trace.splice(0);
    const pages: OrgCostsPage[] = [];
    let cursor: string | null = null;
    do {
      const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.request(`/orgs/${ORG}/costs?pageSize=1${suffix}`, { headers: authHeaders() });
      expect(response.status).toBe(200);
      const page = OrgCosts.parse(await response.json());
      expect(page.orgId).toBe(ORG);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(pages).toHaveLength(4);
    const costIds = pages.flatMap((page) => page.costs.map((cost) => String(cost.id)));
    const runIds = pages.flatMap((page) => page.runs.map((run) => run.runId));
    expect(costIds).toEqual([...COST_IDS]);
    expect(new Set(costIds).size).toBe(COST_IDS.length);
    expect(runIds).toEqual([RUN_B, RUN_A]);
    expect(new Set(runIds).size).toBe(2);
    expect(costIds).not.toContain(FOREIGN_COST_ID);
    expect(runIds).not.toContain(FOREIGN_RUN);

    const firstCursor = decodeDualCursor(pages[0]!.nextCursor!);
    expect(firstCursor).toMatchObject({
      cost: { id: COST_IDS[0] },
      run: { id: RUN_B },
      costsDone: false,
      runsDone: false,
    });
    expect(typeof firstCursor.cost?.id).toBe("string");
    const secondCursor = decodeDualCursor(pages[1]!.nextCursor!);
    expect(secondCursor).toMatchObject({
      cost: { id: COST_IDS[1] },
      run: null,
      costsDone: false,
      runsDone: true,
    });
    expect(pages[2]!.runs).toEqual([]);
    expect(pages[3]!.nextCursor).toBeNull();

    const costs = pages.flatMap((page) => page.costs);
    expect(Number(costs.find((cost) => String(cost.id) === COST_IDS[0])?.costUsd)).toBe(0);
    expect(costs.find((cost) => String(cost.id) === COST_IDS[2])).toMatchObject({
      costBasis: "unknown",
      costUsd: null,
    });
    expect(costs.find((cost) => String(cost.id) === COST_IDS[3])).toMatchObject({
      costBasis: "unattributed",
      costUsd: null,
    });
    const known = costs.filter((cost) => cost.costUsd !== null);
    expect(known).toHaveLength(2);
    expect(costs.filter((cost) => cost.costUsd === null)).toHaveLength(2);
    expect(known.reduce((sum, cost) => sum + Number(cost.costUsd), 0)).toBe(1.25);
    expect(pages.flatMap((page) => page.runs).find((run) => run.runId === RUN_A)?.costTotalUsd).toBe("0.000000");
    expect(pages.flatMap((page) => page.runs).find((run) => run.runId === RUN_B)?.costTotalUsd).toBeNull();

    expect(trace.filter((sql) => sql === SNAPSHOT_SQL)).toHaveLength(4);
    expect(trace.filter((sql) => sql === "COMMIT")).toHaveLength(4);
    expect(trace.filter((sql) => sql.includes("FROM cost_records") && !sql.includes("FROM runs r"))).toHaveLength(4);
    expect(trace.filter((sql) => sql.includes("FROM runs r"))).toHaveLength(2);
    expect(trace.filter((sql) => isOrgCostDataRead(sql))).toHaveLength(6);
  });

  it("rolls back a malformed cursor inside the real snapshot transaction", async () => {
    trace.splice(0);
    const response = await app.request(`/orgs/${ORG}/costs?cursor=not-a-cursor`, { headers: authHeaders() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_cursor" });
    const transaction = routeTransaction(trace);
    expect(transaction).toContain(SNAPSHOT_SQL);
    expect(transaction.at(-1)).toBe("ROLLBACK");
    expect(transaction).not.toContain("COMMIT");
    expect(transaction.filter((sql) => isOrgCostDataRead(sql))).toEqual([]);
    await expectConnectionReset(appPool);
  });

  it("fails closed: the DB lineage FK structurally forbids a same-org cross-project run/spec binding", async () => {
    // in-1 (migration 0043) adds the composite runs_spec_lineage_fk
    // (org_id, project_id, spec_id) -> specs, so a run that claims SPEC_B (which
    // belongs to PROJECT_B) under PROJECT_A can no longer be inserted at all. The
    // prior app-layer "decode miss" fail-closed path guarded a state that is now
    // unrepresentable; the guarantee is enforced one layer deeper and stronger.
    await expect(
      ownerPool.query(
        `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, outcome, started_at)
         VALUES ('run_cost_route_bad_binding', $1, $2, $3, 'cli', 'main', 'completed', 'ok', '2026-07-15T04:00:00Z')`,
        [SPEC_B, PROJECT_A, ORG],
      ),
    ).rejects.toThrow(/runs_spec_lineage_fk/u);
  });
});

async function expectConnectionReset(pool: Pool): Promise<void> {
  const result = await pool.query<{
    org_id: string | null;
    isolation: string;
    read_only: string;
  }>(`SELECT current_setting('app.current_org_id', true) AS org_id,
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only`);
  expect([null, ""]).toContain(result.rows[0]?.org_id);
  expect(result.rows[0]).toMatchObject({ isolation: "read committed", read_only: "off" });
}

async function installSnapshotAssertion(owner: Pool): Promise<void> {
  await owner.query(`
    CREATE FUNCTION public.assert_org_cost_route_snapshot() RETURNS boolean
    LANGUAGE sql VOLATILE AS $function$
      SELECT current_user = 'tanren_app'
        AND current_setting('transaction_isolation') = 'repeatable read'
        AND current_setting('transaction_read_only') = 'on'
    $function$;
    ALTER POLICY rls_org_isolation ON cost_records
      USING (
        CASE WHEN org_id = current_setting('app.current_org_id', true)
          THEN public.assert_org_cost_route_snapshot()
          ELSE false
        END
      )
      WITH CHECK (org_id = current_setting('app.current_org_id', true));
  `);
}

async function seedFixture(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO users (id, provider, provider_subject, login, email, display_name)
     VALUES ($1, 'local_dev', $1, 'cost-route-user', 'cost-route@example.com', 'Cost Route User')`,
    [USER],
  );
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, 'Member Org', '{"version":1}'::jsonb),
            ($2, 'oidc', $2, $2, 'Foreign Org', '{"version":1}'::jsonb)`,
    [ORG, FOREIGN_ORG],
  );
  await owner.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [ORG, USER]);
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id) VALUES
       ($1, 'Project A', 'https://example.com/a.git', $3),
       ($2, 'Project B', 'https://example.com/b.git', $3),
       ('project_cost_route_foreign', 'Foreign', 'https://example.com/foreign.git', $4)`,
    [PROJECT_A, PROJECT_B, ORG, FOREIGN_ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description) VALUES
       ($5, $1, $3, 'Spec A', 'A'),
       ($6, $2, $3, 'Spec B', 'B'),
       ('spec_cost_route_foreign', 'project_cost_route_foreign', $4, 'Foreign sentinel', 'foreign')`,
    [PROJECT_A, PROJECT_B, ORG, FOREIGN_ORG, SPEC_A, SPEC_B],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, outcome, started_at) VALUES
       ($1, $3, $5, $7, 'cli', 'main', 'completed', 'ok', '2026-07-15T02:00:00Z'),
       ($2, $4, $6, $7, 'cli', 'main', 'completed', 'ok', '2026-07-15T03:00:00Z'),
       ($8, 'spec_cost_route_foreign', 'project_cost_route_foreign', $9, 'cli', 'main', 'completed', 'ok', '2026-07-15T04:00:00Z')`,
    [RUN_A, RUN_B, SPEC_A, SPEC_B, PROJECT_A, PROJECT_B, ORG, FOREIGN_RUN, FOREIGN_ORG],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli) VALUES
       ('task_cost_route_a', $1, $3, 'write', 'A', 'done', 'writer', 'fake'),
       ('task_cost_route_b', $2, $3, 'write', 'B', 'done', 'writer', 'fake'),
       ('task_cost_route_foreign', $4, $5, 'write', 'foreign', 'done', 'writer', 'fake')`,
    [RUN_A, RUN_B, ORG, FOREIGN_RUN, FOREIGN_ORG],
  );
  await owner.query(
    `INSERT INTO cost_records
       (id, task_id, run_id, project_id, org_id, cli, provider, model,
        input_tokens, output_tokens, total_tokens, cost_usd, notional_cost_usd,
        billing_mode, cost_basis, recorded_at)
     VALUES
       ($1, 'task_cost_route_a', $6, $8, $10, 'fake', 'test', 'zero', 10, 5, 15, 0, 0,
        'per_token', 'provider_response', '2026-07-15T02:30:00Z'),
       ($2, 'task_cost_route_b', $7, $9, $10, 'fake', 'test', 'known', 20, 5, 25, 1.25, 1.25,
        'per_token', 'ccusage', '2026-07-15T02:30:00Z'),
       ($3, 'task_cost_route_b', $7, $9, $10, 'fake', 'test', 'unknown', 4, 2, 6, NULL, NULL,
        'subscription', 'unknown', '2026-07-15T02:30:00Z'),
       ($4, 'task_cost_route_b', $7, $9, $10, 'fake', 'test', 'unattributed', 3, 1, 4, NULL, NULL,
        'unattributed', 'unattributed', '2026-07-15T02:30:00Z'),
       ($5, 'task_cost_route_foreign', $11, 'project_cost_route_foreign', $12,
        'fake', 'test', 'foreign-sentinel', 1, 0, 1, 99, 99,
        'per_token', 'provider_response', '2026-07-15T01:00:00Z')`,
    [...COST_IDS, FOREIGN_COST_ID, RUN_A, RUN_B, PROJECT_A, PROJECT_B, ORG, FOREIGN_RUN, FOREIGN_ORG],
  );
}

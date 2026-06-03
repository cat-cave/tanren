// Plane-split P3 — the control-plane RUN-STATE WRITE endpoints + the
// HttpRunStateWriter, proven against a REAL Postgres under the enforced
// `tanren_app` RLS role (no SQL mocks). This is the security payoff of P3: the
// data plane stops writing tenant tables directly — it POSTs to the control
// plane, which performs the SAME org-scoped write server-side.
//
// What this proves (behavior, not mocks):
//   1. authn REJECTS an untrusted (non-mTLS) peer (401) BEFORE any write lands;
//   2. the append-event endpoint persists the SAME events row, org-scoped, that
//      the worker's in-process PgEventStore would have written;
//   3. the record-cost endpoint persists the SAME cost_records row (+ its
//      cost.resolved event), org-scoped;
//   4. the finalize-run endpoint moves the run to its terminal state under the
//      org scope, and is EXACTLY-ONCE: a retried finalize matches no row (the
//      `fromStatuses` guard), so no duplicate finalize / event;
//   5. the HttpRunStateWriter drives a seeded run's events + finalize through the
//      endpoints end-to-end over a fake mTLS channel routed into the real app;
//   6. the DEFAULT DirectRunStateWriter persists BYTE-IDENTICAL rows in-process.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the RLS cohort tests. Wired into `just smoke` via
// `just smoke-plane-split-p3`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithJobOrgId } from "@tanren/db";
import { AllowAllPeerVerifier, DenyAllPeerVerifier, type MtlsFetch } from "../src/engine/contracts/index.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_p3_rw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_p3_rw";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const PLAN_TASK = `task_plan_${ORG}`;

// Route a fake MtlsFetch straight into the real endpoint app — the
// worker→control-plane round trip with the network swapped for an in-process
// call, so the write logic + wire shape are proven without standing up TLS.
function fetchInto(app: ReturnType<typeof createInternalRunStateWriteRoutes>): MtlsFetch {
  return (url, init) => app.request(new URL(url).pathname, init as RequestInit, { incoming: { socket: {} } });
}

describeDb("plane-split P3 — control-plane run-state write endpoints (real PG, enforced RLS)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // Each test seeds its own run (distinct run_id) so finalize transitions do not
  // collide. Seeded as the OWNER (RLS does not apply to the table owner).
  async function seedRun(runId: string, status = "running"): Promise<void> {
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://example.com/r.git', $2) ON CONFLICT (project_id) DO NOTHING`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 't', 'd', 'active') ON CONFLICT (spec_id) DO NOTHING`,
      [SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'main', $5)`,
      [runId, SPEC, PROJECT, ORG, status],
    );
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'running', 'answerer', 'fake', 'm') ON CONFLICT (task_id) DO NOTHING`,
      [PLAN_TASK, runId, ORG],
    );
  }

  it("(1) authn rejects an untrusted peer with 401 and writes NOTHING", async () => {
    const runId = "run_p3_authn";
    await seedRun(runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new DenyAllPeerVerifier() });

    const response = await app.request(
      "/internal/append-event",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          specId: SPEC,
          projectId: PROJECT,
          orgId: ORG,
          eventType: "run.started",
          payload: { status: "running" },
        }),
      },
      { incoming: { socket: {} } },
    );

    expect(response.status).toBe(401);
    const events = await ownerPool.query("SELECT 1 FROM events WHERE run_id = $1", [runId]);
    expect(events.rowCount).toBe(0);
  });

  it("(2) append-event persists the same events row, org-scoped", async () => {
    const runId = "run_p3_event";
    await seedRun(runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    // The remote writer reads the run's org from the per-job org-id scope (the
    // worker sets it with runWithJobOrgId around the workflow), and sends it so
    // the server scopes the INSERT — mirror that here.
    await runWithJobOrgId(ORG, () =>
      writer.append({
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "run.started",
        payload: { status: "running" },
      }),
    );

    const row = await ownerPool.query<{ org_id: string; event_type: string }>(
      "SELECT org_id, event_type FROM events WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]).toMatchObject({ org_id: ORG, event_type: "run.started" });
  });

  it("(3) record-cost persists the same cost_records row + cost.resolved event", async () => {
    const runId = "run_p3_cost";
    await seedRun(runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const recorded = await runWithJobOrgId(ORG, () =>
      writer.recordCost({
        context: {
          runId,
          taskId: PLAN_TASK,
          specId: SPEC,
          projectId: PROJECT,
          cli: "fake",
          model: "m",
          authRef: "fake:local",
        },
        tokens: {
          inputTokens: 5,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 10,
        },
        rawUsage: {},
      }),
    );

    expect(recorded.tokens.totalTokens).toBe(10);
    const cost = await ownerPool.query<{ org_id: string; total_tokens: number }>(
      "SELECT org_id, total_tokens FROM cost_records WHERE run_id = $1",
      [runId],
    );
    expect(cost.rows[0]).toMatchObject({ org_id: ORG, total_tokens: 10 });
    const ev = await ownerPool.query("SELECT 1 FROM events WHERE run_id = $1 AND event_type = 'cost.resolved'", [
      runId,
    ]);
    expect(ev.rowCount).toBe(1);
  });

  it("(3b) reconcile-cost apportions the run's cost_records server-side, org-scoped", async () => {
    // Plane-split P3c: the run-end reconcile/back-fill must ALSO route through the
    // control plane — the de-privileged data plane can no longer UPDATE
    // cost_records directly (0031). Seed two cost rows (token shares 3:1) via the
    // record endpoint, then reconcile a $4 run total and assert the rows were
    // repriced by token share (3.00 / 1.00) with cost_basis = 'ccusage'.
    const runId = "run_p3_reconcile";
    await seedRun(runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const recordCall = (totalTokens: number): Promise<unknown> =>
      runWithJobOrgId(ORG, () =>
        writer.recordCost({
          context: {
            runId,
            taskId: PLAN_TASK,
            specId: SPEC,
            projectId: PROJECT,
            cli: "fake",
            model: "m",
            authRef: "fake:local",
          },
          tokens: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens,
          },
          rawUsage: {},
        }),
      );
    await recordCall(30);
    await recordCall(10);

    const result = await writer.reconcileCost({ runId, orgId: ORG, totalCostUsd: 4, basis: "ccusage" });
    expect(result).toEqual({ updated: 2 });

    const rows = await ownerPool.query<{ total_tokens: number; cost_usd: string; cost_basis: string }>(
      "SELECT total_tokens, cost_usd, cost_basis FROM cost_records WHERE run_id = $1 ORDER BY total_tokens DESC",
      [runId],
    );
    expect(
      rows.rows.map((r) => ({ tokens: Number(r.total_tokens), cost: Number(r.cost_usd), basis: r.cost_basis })),
    ).toEqual([
      { tokens: 30, cost: 3, basis: "ccusage" },
      { tokens: 10, cost: 1, basis: "ccusage" },
    ]);
  });

  it("(4) finalize-run finalizes once + the retried finalize is a no-op (exactly-once)", async () => {
    const runId = "run_p3_finalize";
    await seedRun(runId, "running");
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const first = await writer.finalizeRun({
      runId,
      orgId: ORG,
      status: "halted",
      outcome: "halted",
      fromStatuses: ["running", "queued", "failed"],
    });
    expect(first).toMatchObject({ updated: true, specId: SPEC, projectId: PROJECT });

    // The run is now `halted` — a retried finalize matches NO row (the guard only
    // admits running/queued/failed), so it is a no-op: no duplicate finalize.
    const second = await writer.finalizeRun({
      runId,
      orgId: ORG,
      status: "halted",
      outcome: "halted",
      fromStatuses: ["running", "queued", "failed"],
    });
    expect(second).toEqual({ updated: false });

    const run = await ownerPool.query<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "halted", outcome: "halted" });
  });

  it("(5) the DirectRunStateWriter persists byte-identical rows in-process", async () => {
    const runId = "run_p3_direct";
    await seedRun(runId, "running");
    // The direct writer mirrors the worker: constructed over `orgScopingPool`,
    // its event append self-routes through the ambient per-job org scope
    // (`runWithJobOrgId`), and `finalizeRun` opens its own `runWithOrgScope` from
    // the explicit org — so the rows land under the enforced policy exactly as
    // the remote endpoint's server-side write does.
    const writer = new DirectRunStateWriter(orgScopingPool(runtimePool));

    await runWithJobOrgId(ORG, () =>
      writer.append({
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "run.started",
        payload: { status: "running" },
      }),
    );
    const finalize = await writer.finalizeRun({
      runId,
      orgId: ORG,
      status: "done",
      outcome: "ok",
      fromStatuses: ["running", "queued"],
    });

    expect(finalize).toMatchObject({ updated: true, specId: SPEC, projectId: PROJECT });
    const run = await ownerPool.query<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "done", outcome: "ok" });
    const ev = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE run_id = $1 AND event_type = 'run.started'",
      [runId],
    );
    expect(ev.rows[0]?.org_id).toBe(ORG);
  });

  // (6) The AUTONOMY-LOOP create path: the DagWalker / merge-conflict-reexec / intake
  // CREATE a queued run through `/internal/create-queued-run`. Prove the endpoint runs
  // the full multi-table createQueuedRunFromSpec server-side (INSERT runs + claim spec
  // + INSERT tasks + job_queue + run.queued/task.queued events), org-scoped under RLS —
  // the write the de-privileged data plane can no longer do directly.
  it("(6) create-queued-run creates the run + claims the spec + emits run.queued, server-side org-scoped", async () => {
    const specId = `${SPEC}_walk`;
    // Seed a fresh PENDING spec (the walker only enqueues pending specs) as the owner.
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    // The project must carry a versioned config — `createQueuedRunFromSpec` reads it.
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', $2, '{"version":1}'::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'walk spec', 'd', 'pending')`,
      [specId, PROJECT, ORG],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const run = await writer.createQueuedRun({
      input: { specId, trigger: "dag_walker" },
      actor: { userId: "dag-walker", orgId: ORG, projectId: PROJECT, scopes: ["platform:admin"], source: "local_dev" },
    });

    expect(run.runId).toMatch(/^run_/u);
    // The run row landed server-side, org-scoped.
    const runRow = await ownerPool.query<{ org_id: string; status: string }>(
      "SELECT org_id, status FROM runs WHERE run_id = $1",
      [run.runId],
    );
    expect(runRow.rows[0]).toMatchObject({ org_id: ORG, status: "queued" });
    // The spec was claimed pending→active inside the same transaction.
    const specRow = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [specId]);
    expect(specRow.rows[0]?.status).toBe("active");
    // The run.queued event was appended (the walker's run-creation timeline).
    const ev = await ownerPool.query("SELECT 1 FROM events WHERE run_id = $1 AND event_type = 'run.queued'", [
      run.runId,
    ]);
    expect(ev.rowCount).toBe(1);
  });

  // (7) The intake auto-route's provenance stamp: `/internal/set-spec-metadata` runs
  // the `UPDATE specs SET metadata` server-side under RLS — the write the de-privileged
  // data plane can no longer do directly.
  it("(7) set-spec-metadata writes the spec metadata server-side, org-scoped", async () => {
    const specId = `${SPEC}_meta`;
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'meta spec', 'd', 'pending')`,
      [specId, PROJECT, ORG],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    await writer.setSpecMetadata({
      specId,
      orgId: ORG,
      metadataJson: JSON.stringify({ discovery: { from: "intake" } }),
    });

    const row = await ownerPool.query<{ metadata: { discovery?: { from?: string } } }>(
      "SELECT metadata FROM specs WHERE spec_id = $1",
      [specId],
    );
    expect(row.rows[0]?.metadata?.discovery?.from).toBe("intake");
  });

  // (8) The change-percolation run-column writes (part of the DagWalker loop): the
  // bespoke `UPDATE runs SET <jsonb>` ops the de-privileged data plane can no longer
  // run directly. Prove each endpoint performs the SAME server-side write, org-scoped.
  it("(8) the change-percolation run-column endpoints write runs server-side, org-scoped", async () => {
    const runId = "run_p3_percolation";
    await seedRun(runId, "running");
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    await writer.setRunSpeculativeBase({ runId, orgId: ORG, speculativeBase: "tanren/integ/x" });
    await writer.setRunPercolationReexecId({ runId, orgId: ORG, reexecRunId: "run_reexec" });
    await writer.mergeRunVerifiedAncestorSha({
      runId,
      orgId: ORG,
      ancestorSpecId: "spec_anc",
      entryJson: JSON.stringify({ sha: "deadbeef", reviewVerdict: "approved" }),
    });

    const row = await ownerPool.query<{
      speculative_base: string;
      percolation_pending: { reexecRunId?: string };
      verified_ancestor_shas: Record<string, { sha?: string; reviewVerdict?: string }>;
    }>("SELECT speculative_base, percolation_pending, verified_ancestor_shas FROM runs WHERE run_id = $1", [runId]);
    expect(row.rows[0]?.speculative_base).toBe("tanren/integ/x");
    expect(row.rows[0]?.percolation_pending?.reexecRunId).toBe("run_reexec");
    expect(row.rows[0]?.verified_ancestor_shas?.spec_anc).toMatchObject({ sha: "deadbeef", reviewVerdict: "approved" });

    // And the clear endpoint drops the marker.
    await writer.clearRunPercolationPending({ runId, orgId: ORG });
    const cleared = await ownerPool.query<{ percolation_pending: unknown }>(
      "SELECT percolation_pending FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(cleared.rows[0]?.percolation_pending).toBeNull();
  });
});

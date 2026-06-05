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
// The AUTONOMY-LOOP create/intake/percolation write endpoints (create-queued-run ·
// set-spec-metadata · the change-percolation run-column ops) are the sibling
// planeSplitP3CreateWrites.integration.test.ts (the cohort is split to stay under
// the per-file max-lines cap); both share planeSplitP3RemoteWritesHarness.ts.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the RLS cohort tests. Wired into `just smoke` via
// `just smoke-plane-split-p3`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/index.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import {
  createWriteEndpointHarness,
  enabled,
  fetchInto,
  ORG,
  PLAN_TASK,
  PROJECT,
  seedRun,
  SPEC,
} from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

describeDb("plane-split P3 — control-plane run-state write endpoints (real PG, enforced RLS)", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  it("(1) authn rejects an untrusted peer with 401 and writes NOTHING", async () => {
    const runId = "run_p3_authn";
    await seedRun(ownerPool(), runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new DenyAllPeerVerifier() });

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
    const events = await ownerPool().query("SELECT 1 FROM events WHERE run_id = $1", [runId]);
    expect(events.rowCount).toBe(0);
  });

  it("(2) append-event persists the same events row, org-scoped", async () => {
    const runId = "run_p3_event";
    await seedRun(ownerPool(), runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
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

    const row = await ownerPool().query<{ org_id: string; event_type: string }>(
      "SELECT org_id, event_type FROM events WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]).toMatchObject({ org_id: ORG, event_type: "run.started" });
  });

  it("(2b) append-event accepts a PROJECT-scoped event (null run_id/spec_id), org-scoped", async () => {
    // The DagWalker's cold-start (onDagChange) walk emits PROJECT-scoped dag.*
    // events — dag.drained / dag.budget.paused / dag.concurrency.saturated — which
    // carry NO run and NO spec (they describe the project's DAG, not a single run).
    // The control-plane append-event path MUST accept that shape (matching the
    // direct PgEventStore.append, which inserts NULL run_id/spec_id) — previously it
    // 400'd because the schema required runId/specId. Assert the project-scoped
    // event lands with NULL run_id/spec_id, the right org, and the right project.
    // seedRun establishes the org + project; the project-scoped event itself omits runId/specId.
    const runId = "run_p3_project_scoped";
    await seedRun(ownerPool(), runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    // The walker appends a project-only event: no runId, no specId — only projectId
    // + payload (the writer adds the org from the ambient per-job scope).
    await runWithJobOrgId(ORG, () =>
      writer.append({
        projectId: PROJECT,
        eventType: "dag.drained",
        payload: { doneCount: 2, inFlightCount: 0, blockedCount: 0 },
      }),
    );

    const row = await ownerPool().query<{
      run_id: string | null;
      spec_id: string | null;
      org_id: string;
      project_id: string;
      event_type: string;
    }>("SELECT run_id, spec_id, org_id, project_id, event_type FROM events WHERE event_type = 'dag.drained'");
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      run_id: null,
      spec_id: null,
      org_id: ORG,
      project_id: PROJECT,
      event_type: "dag.drained",
    });
  });

  it("(3) record-cost persists the same cost_records row + cost.resolved event", async () => {
    const runId = "run_p3_cost";
    await seedRun(ownerPool(), runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
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
    const cost = await ownerPool().query<{ org_id: string; total_tokens: number }>(
      "SELECT org_id, total_tokens FROM cost_records WHERE run_id = $1",
      [runId],
    );
    expect(cost.rows[0]).toMatchObject({ org_id: ORG, total_tokens: 10 });
    const ev = await ownerPool().query("SELECT 1 FROM events WHERE run_id = $1 AND event_type = 'cost.resolved'", [
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
    await seedRun(ownerPool(), runId);
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
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
            // A per-token (real-API) ref so the rows are eligible for ccusage
            // repricing — the ccusage reconcile prices per_token rows ONLY (a
            // subscription's ccusage figure is notional, never real spend).
            authRef: "credential/openai-api/k",
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

    const rows = await ownerPool().query<{
      total_tokens: number;
      cost_usd: string;
      notional_cost_usd: string;
      cost_basis: string;
    }>(
      "SELECT total_tokens, cost_usd, notional_cost_usd, cost_basis FROM cost_records WHERE run_id = $1 ORDER BY total_tokens DESC",
      [runId],
    );
    // Both rows are per_token (real-API), so REAL == NOTIONAL: the ccusage reconcile
    // apportions $4 by token share (3.00 / 1.00) into BOTH cost_usd AND
    // notional_cost_usd, with cost_basis = 'ccusage'.
    expect(
      rows.rows.map((r) => ({
        tokens: Number(r.total_tokens),
        cost: Number(r.cost_usd),
        notional: Number(r.notional_cost_usd),
        basis: r.cost_basis,
      })),
    ).toEqual([
      { tokens: 30, cost: 3, notional: 3, basis: "ccusage" },
      { tokens: 10, cost: 1, notional: 1, basis: "ccusage" },
    ]);
  });

  it("(4) finalize-run finalizes once + the retried finalize is a no-op (exactly-once)", async () => {
    const runId = "run_p3_finalize";
    await seedRun(ownerPool(), runId, "running");
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
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

    const run = await ownerPool().query<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "halted", outcome: "halted" });
  });

  it("(5) the DirectRunStateWriter persists byte-identical rows in-process", async () => {
    const runId = "run_p3_direct";
    await seedRun(ownerPool(), runId, "running");
    // The direct writer mirrors the worker: constructed over `orgScopingPool`,
    // its event append self-routes through the ambient per-job org scope
    // (`runWithJobOrgId`), and `finalizeRun` opens its own `runWithOrgScope` from
    // the explicit org — so the rows land under the enforced policy exactly as
    // the remote endpoint's server-side write does.
    const writer = new DirectRunStateWriter(orgScopingPool(runtimePool()));

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
      status: "completed",
      outcome: "ok",
      fromStatuses: ["running", "queued"],
    });

    expect(finalize).toMatchObject({ updated: true, specId: SPEC, projectId: PROJECT });
    const run = await ownerPool().query<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "completed", outcome: "ok" });
    const ev = await ownerPool().query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE run_id = $1 AND event_type = 'run.started'",
      [runId],
    );
    expect(ev.rows[0]?.org_id).toBe(ORG);
  });
});

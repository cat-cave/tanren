// Plane-split — the control-plane AUTONOMY-LOOP write endpoints, proven against
// a REAL Postgres under the enforced `tanren_app` RLS role (no SQL mocks). These
// are the CREATE / intake / change-percolation writes the de-privileged data plane
// can no longer perform directly — the DagWalker, the merge-conflict re-exec, and
// the intake auto-route POST them to the control plane, which runs the SAME
// org-scoped write server-side:
//
//   6.  create-queued-run runs the full multi-table createQueuedRunFromSpec
//       (INSERT runs + claim spec + INSERT tasks + job_queue + run.queued/task.queued);
//   6b. create-queued-run accepts the §2c PRESENT-but-NULL speculative base (a
//       percolation re-exec whose ancestors all merged → a real run against main),
//       lands `speculative_base = NULL`, and still SKIPS the done-only dep gate;
//   7.  set-spec-metadata stamps the intake provenance (UPDATE specs SET metadata);
//   8.  the change-percolation run-column ops (set speculative_base / reexec-id /
//       merge a verified-ancestor sha / clear the pending marker).
//
// The run-state writes (append-event / record-cost / reconcile / finalize) +
// DirectRunStateWriter are the sibling planeSplitP3RemoteWrites.integration.test.ts
// (the cohort is split to stay under the per-file max-lines cap); both share
// planeSplitP3RemoteWritesHarness.ts.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the RLS cohort tests. Wired into `just smoke` via
// `just smoke-plane-split-p3`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AllowAllPeerVerifier } from "../src/engine/contracts/index.js";
import { HttpRunStateWriter } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import {
  createWriteEndpointHarness,
  enabled,
  fetchInto,
  ORG,
  PROJECT,
  seedRun,
  SPEC,
} from "./planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

describeDb("plane-split P3 — control-plane autonomy-loop create/intake writes (real PG, enforced RLS)", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  // (6) The AUTONOMY-LOOP create path: the DagWalker / merge-conflict-reexec / intake
  // CREATE a queued run through `/internal/create-queued-run`. Prove the endpoint runs
  // the full multi-table createQueuedRunFromSpec server-side (INSERT runs + claim spec
  // + INSERT tasks + job_queue + run.queued/task.queued events), org-scoped under RLS —
  // the write the de-privileged data plane can no longer do directly.
  it("(6) create-queued-run creates the run + claims the spec + emits run.queued, server-side org-scoped", async () => {
    const specId = `${SPEC}_walk`;
    // Seed a fresh PENDING spec (the walker only enqueues pending specs) as the owner.
    await ownerPool().query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    // The project must carry a versioned config — `createQueuedRunFromSpec` reads it.
    await ownerPool().query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', $2, '{"version":1}'::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config`,
      [PROJECT, ORG],
    );
    await ownerPool().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'walk spec', 'd', 'open')`,
      [specId, PROJECT, ORG],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const run = await writer.createQueuedRun({
      input: { specId, trigger: "dag_walker" },
      actor: { userId: "dag-walker", orgId: ORG, projectId: PROJECT, scopes: ["platform:admin"], source: "local_dev" },
    });

    expect(run.runId).toMatch(/^run_/u);
    // The run row landed server-side, org-scoped.
    const runRow = await ownerPool().query<{ org_id: string; status: string }>(
      "SELECT org_id, status FROM runs WHERE run_id = $1",
      [run.runId],
    );
    expect(runRow.rows[0]).toMatchObject({ org_id: ORG, status: "queued" });
    // The spec was claimed open→in_flight inside the same transaction.
    const specRow = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      specId,
    ]);
    expect(specRow.rows[0]?.status).toBe("in_flight");
    // The run.queued event was appended (the walker's run-creation timeline).
    const ev = await ownerPool().query("SELECT 1 FROM events WHERE run_id = $1 AND event_type = 'run.queued'", [
      run.runId,
    ]);
    expect(ev.rowCount).toBe(1);
  });

  // (6a) THE READY-NOT-ENQUEUED REGRESSION: a NON-speculative enqueue (no `speculative`
  // object → the full done-only dependency gate RUNS) of a spec whose dependency is
  // `merged` (NOT `done`) must SUCCEED. The walker's planner + classifier treat a
  // `merged` dep as satisfied (a merged PR ends the spec at `merged`, never `done`), so
  // it plans the dependent as READY and enqueues it non-speculatively — but the gate
  // formerly accepted ONLY `status='merged'`, so it threw SpecDependenciesBlockedError,
  // which the walker tolerates as benign-transient → a PERMANENT stall (a merged dep
  // never becomes `done`). The gate now admits `done` OR `merged`; this proves the
  // all-merged dep chain enqueues + claims the dependent instead of stalling.
  it("(6a) create-queued-run NON-speculatively enqueues a spec whose dependency is MERGED (the ready-not-enqueued fix)", async () => {
    const depSpecId = `${SPEC}_merged_dep`;
    const specId = `${SPEC}_ready_on_merged`;
    await ownerPool().query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool().query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', $2, '{"version":1}'::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config`,
      [PROJECT, ORG],
    );
    // The dependency is MERGED (the Phase-2 terminal status), NOT `done`.
    await ownerPool().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'merged dep', 'd', 'merged')
       ON CONFLICT (spec_id) DO UPDATE SET status = 'merged'`,
      [depSpecId, PROJECT, ORG],
    );
    // The dependent is PENDING, depends on the merged spec.
    await ownerPool().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status, depends_on)
       VALUES ($1, $2, $3, 'ready on merged dep', 'd', 'open', ARRAY[$4::text])`,
      [specId, PROJECT, ORG, depSpecId],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    // NON-speculative: no `speculative` object ⇒ the full done-only dependency gate RUNS.
    const run = await writer.createQueuedRun({
      input: { specId, trigger: "dag_walker" },
      actor: { userId: "dag-walker", orgId: ORG, projectId: PROJECT, scopes: ["platform:admin"], source: "local_dev" },
    });

    expect(run.runId).toMatch(/^run_/u);
    // The merged dependency satisfied the gate — the dependent was claimed open→in_flight
    // (formerly this threw SpecDependenciesBlockedError, stalling the DAG forever).
    const specRow = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      specId,
    ]);
    expect(specRow.rows[0]?.status).toBe("in_flight");
  });

  // (6b) §2c "ancestor-merged → non-speculative re-base": a percolation re-exec
  // whose every ancestor has merged onto plain default_branch CREATEs through
  // `/internal/create-queued-run` with the `speculative` object PRESENT but its
  // `speculativeBase` NULL. Two things are proven over the plane-split wire:
  //   1. the route schema ACCEPTS the null base (the in-process contract's
  //      `speculativeBase: string | null`) — the bug was `z.string().min(1)`
  //      rejecting null with a 400 the worker could never get past;
  //   2. null SURVIVES the HttpRunStateWriter JSON.stringify round-trip and the
  //      run lands with `speculative_base = NULL` — yet the `speculative` object's
  //      PRESENCE still skips the done-only dependency gate (the spec is claimed
  //      pending→active even though no real dependency-done check ran).
  it("(6b) create-queued-run accepts a PRESENT-but-null speculative base and creates a run with speculative_base = NULL", async () => {
    const specId = `${SPEC}_walk_null_base`;
    await ownerPool().query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool().query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', $2, '{"version":1}'::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config`,
      [PROJECT, ORG],
    );
    // Seed the re-exec spec as PENDING with a dependency that is NOT done — proving
    // the present (null-base) speculative object skips the done-only gate that would
    // otherwise block this enqueue.
    await ownerPool().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status, depends_on)
       VALUES ($1, $2, $3, 'null-base re-exec spec', 'd', 'open', ARRAY['spec_anc_not_done'])`,
      [specId, PROJECT, ORG],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const run = await writer.createQueuedRun({
      input: {
        specId,
        trigger: "percolation_reexec",
        // The §2c marker: speculative is PRESENT (skip the dep gate) with a NULL base.
        speculative: { speculativeBase: null, percolationPending: { reexecOf: "spec_anc_not_done" } },
      },
      actor: { userId: "dag-walker", orgId: ORG, projectId: PROJECT, scopes: ["platform:admin"], source: "local_dev" },
    });

    expect(run.runId).toMatch(/^run_/u);
    // The run landed with a NULL speculative_base (a real run against main), org-scoped,
    // AND the percolation marker round-tripped through the wire intact.
    const runRow = await ownerPool().query<{
      org_id: string;
      status: string;
      speculative_base: string | null;
      percolation_pending: { reexecOf?: string } | null;
    }>("SELECT org_id, status, speculative_base, percolation_pending FROM runs WHERE run_id = $1", [run.runId]);
    expect(runRow.rows[0]).toMatchObject({ org_id: ORG, status: "queued", speculative_base: null });
    expect(runRow.rows[0]?.percolation_pending?.reexecOf).toBe("spec_anc_not_done");
    // The done-only dependency gate was SKIPPED (present speculative object) — the spec
    // was still claimed open→in_flight despite its dependency being absent/not-done.
    const specRow = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      specId,
    ]);
    expect(specRow.rows[0]?.status).toBe("in_flight");
  });

  // (7) The intake auto-route's provenance stamp: `/internal/set-spec-metadata` runs
  // the `UPDATE specs SET metadata` server-side under RLS — the write the de-privileged
  // data plane can no longer do directly.
  it("(7) set-spec-metadata writes the spec metadata server-side, org-scoped", async () => {
    const specId = `${SPEC}_meta`;
    await ownerPool().query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'meta spec', 'd', 'open')`,
      [specId, PROJECT, ORG],
    );
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    await writer.setSpecMetadata({
      specId,
      orgId: ORG,
      metadataJson: JSON.stringify({ discovery: { from: "intake" } }),
    });

    const row = await ownerPool().query<{ metadata: { discovery?: { from?: string } } }>(
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
    await seedRun(ownerPool(), runId, "running");
    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    await writer.setRunSpeculativeBase({ runId, orgId: ORG, speculativeBase: "tanren/integ/x" });
    await writer.setRunPercolationReexecId({ runId, orgId: ORG, reexecRunId: "run_reexec" });
    await writer.mergeRunVerifiedAncestorSha({
      runId,
      orgId: ORG,
      ancestorSpecId: "spec_anc",
      entryJson: JSON.stringify({ sha: "deadbeef", reviewVerdict: "approved" }),
    });

    const row = await ownerPool().query<{
      speculative_base: string;
      percolation_pending: { reexecRunId?: string };
      verified_ancestor_shas: Record<string, { sha?: string; reviewVerdict?: string }>;
    }>("SELECT speculative_base, percolation_pending, verified_ancestor_shas FROM runs WHERE run_id = $1", [runId]);
    expect(row.rows[0]?.speculative_base).toBe("tanren/integ/x");
    expect(row.rows[0]?.percolation_pending?.reexecRunId).toBe("run_reexec");
    expect(row.rows[0]?.verified_ancestor_shas?.spec_anc).toMatchObject({ sha: "deadbeef", reviewVerdict: "approved" });

    // And the clear endpoint drops the marker.
    await writer.clearRunPercolationPending({ runId, orgId: ORG });
    const cleared = await ownerPool().query<{ percolation_pending: unknown }>(
      "SELECT percolation_pending FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(cleared.rows[0]?.percolation_pending).toBeNull();
  });
});

// RLS early-failure finalize — a run that throws BEFORE the per-job org scope
// is established (e.g. credential resolution fails) must still reach a terminal
// FINALIZED state, NOT get stuck `queued`, under the enforced `tanren_app` role.
//
// THE BUG (plane-split P2 flagged it): the worker's failure-path finalizer
// (`finalizeRunRecoverable`) org-scopes its `UPDATE runs` from `resolvedOrgId`,
// which was only assigned AFTER `loadRunExecutionContext` succeeds. A credential
// resolution throw — the common misconfigured-credentials case — happens INSIDE
// that load, so `resolvedOrgId` stayed null, the finalize ran UNSCOPED, the
// enforced policy denied the `UPDATE runs` (empty GUC → deny-by-default), and
// the run NEVER left `queued`. A run that can never leave `queued` is worse than
// a cleanly-failed one; operators hit it with misconfigured credentials.
//
// THE FIX: seed the finalize scope from the CLAIMED org (`job.orgId`, known at
// claim time — the queue carries it, job_queue stays OUTSIDE RLS) BEFORE any
// work that can throw. The early-failure finalize then runs org-scoped, the
// policy admits it, and the run lands `halted`.
//
// This test drives the REAL `executeNextPlanJob` against a REAL Postgres with
// the REAL migration's RLS policies ENABLED, the runtime pool connecting as the
// restricted `tanren_app` role (NOBYPASSRLS) — exactly the production data
// plane. It seeds a credential-FREE run so context load throws `MissingCredential`
// before any org scope is set, then asserts the run reaches a terminal finalized
// state (not `queued`). It is the regression lock for the fix.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R1 / R2 / R3a / R3b cohort tests. Wired into
// `just smoke` via `just smoke-rls-early-finalize`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { PgJobQueue } from "../src/engine/contracts/jobQueue.js";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { executeNextPlanJob } from "../src/engine/worker/runExecutor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_early_fail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_early_fail";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = "run_early_fail";
const PLAN_TASK = `task_plan_${ORG}`;

// The worker never reaches the runner/SSH/GitHub/workflow stage in this scenario
// (credential resolution throws first), so these adapters are inert stand-ins —
// present only to satisfy the deps shape.
const INERT_ALLOCATOR: Allocator = {
  taxonomy: "fixed_pool" as const,
  async allocate() {
    throw new Error("allocator should not be reached on an early credential failure");
  },
  async release() {},
};
const INERT_SSH: CommandSubstrate = {
  async run() {
    throw new Error("ssh should not be reached on an early credential failure");
  },
};
const INERT_GITHUB: GitHubHttpClient = {
  async request() {
    throw new Error("github should not be reached on an early credential failure");
  },
};

describeDb("RLS early-failure finalize — a pre-scope throw still finalizes the run (not stuck queued)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration enables RLS + the policies AND creates the roles, so the
    // app pool below is the enforced production data plane (NOBYPASSRLS).
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });

    // A NULL system pool: this scenario must NOT lean on the BYPASSRLS carve-out.
    // The fix is proven on the restricted app role alone (the worker's own pool).
    setSystemPool(undefined);

    // Seed a complete tenant chain AS THE OWNER (RLS-exempt). Crucially the
    // project config has NO credentials, so resolveCredentialsForRun — called
    // inside loadRunExecutionContext — throws MissingCredential BEFORE the worker
    // assigns the run's org to the finalize scope. The run starts `queued`,
    // exactly as a freshly-triggered run.
    await seedCredentialFreeRun(ownerPool);
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("finalizes an early-failing run (credential throw) to a terminal state under enforced RLS", async () => {
    const jobQueue = new PgJobQueue(appPool);
    // Enqueue the plan job as createQueuedRunFromSpec does — stamping the run's
    // org_id on the queue row (the worker's claim-time tenant source). Production
    // enqueues under `runWithOrgScope`, so the org is known and lands on the row;
    // we pass it explicitly to the same effect. The queue is OUTSIDE RLS, so the
    // app role enqueues + claims it with no org scope.
    await jobQueue.enqueue({
      runId: RUN,
      taskId: PLAN_TASK,
      taskKind: "plan",
      payload: { specId: SPEC, projectId: PROJECT },
      orgId: ORG,
    });

    // Sanity: the run starts `queued` (RLS-exempt owner read = ground truth).
    const before = await ownerPool.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [RUN]);
    expect(before.rows[0]?.status).toBe("queued");

    // Drive the worker's REAL claim→execute path on the enforced app pool. The
    // credential resolution throws early; the catch-path finalize must run.
    const result = await executeNextPlanJob({
      pool: appPool,
      jobQueue,
      allocator: INERT_ALLOCATOR,
      ssh: INERT_SSH,
      secrets: new FakeSecretStore(),
      githubHttp: INERT_GITHUB,
      identitySecretRef: "runner/test/identity",
      runStateWriter: new DirectRunStateWriter(appPool),
      // No heartbeat noise; the job finishes in one synchronous pass.
      heartbeatIntervalMs: 1_000_000,
    });

    // The worker reports the job failed (the early credential throw).
    expect(result.kind).toBe("failed");
    expect(result).toMatchObject({ runId: RUN });

    // THE CORE ASSERTION: the run reached a terminal FINALIZED state — it did NOT
    // get stuck `queued`. With the bug, the unscoped finalize was denied by RLS
    // and this read returned `queued`. With the fix, the claimed-org-scoped
    // finalize lands `halted` (the worker's recoverable terminal outcome).
    const after = await ownerPool.query<{ status: string; outcome: string | null; ended_at: Date | null }>(
      "SELECT status, outcome, ended_at FROM runs WHERE run_id = $1",
      [RUN],
    );
    expect(after.rows[0]?.status).not.toBe("queued");
    expect(after.rows[0]?.status).toBe("halted");
    expect(after.rows[0]?.outcome).toBe("halted");
    expect(after.rows[0]?.ended_at).not.toBeNull();

    // And the run.failed event the finalizer best-effort-appends landed too —
    // proving the WHOLE org-scoped finalize transaction (UPDATE + event) was
    // admitted by the policy, not just the UPDATE.
    const event = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE run_id = $1 AND event_type = 'run.failed'",
      [RUN],
    );
    expect(event.rows[0]?.org_id).toBe(ORG);

    // finding #3 (never-strand): the SPEC was seeded `in_flight`; an early infra
    // failure (MissingCredentialError) must NOT leave it occupying a DAG slot with a
    // dead run. The worker-level finalize reclaims it to the operator-recoverable
    // `needs_attention` (freeing the slot) + emits the loud dag.spec.needs_attention.
    const specAfter = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(specAfter.rows[0]?.status).toBe("needs_attention");
    const parked = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.needs_attention'",
      [SPEC],
    );
    expect(parked.rows[0]?.org_id).toBe(ORG);
  });
});

async function seedCredentialFreeRun(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  // No credentials anywhere: project config is a bare version:1 (no credential
  // refs) and the org has no defaults, so resolveCredentialsForRun throws
  // MissingCredential during context hydration — the EARLY failure. (Configs
  // must be explicitly versioned: the migration shim is deleted.)
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'p', 'https://example.com/r.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, $3, 't', 'd', $4::jsonb, 'in_flight')`,
    [SPEC, PROJECT, ORG, JSON.stringify(["ac"])],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'tanren/early_fail', 'queued')`,
    [RUN, SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
    [PLAN_TASK, RUN, ORG],
  );
}

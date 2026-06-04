// RLS full-run-lifecycle scoping — a REAL org-scoped run drives the REAL
// allocator + runner allocation + the whole plan→write→check→audit→PR→CI→
// review→merge→finalize lifecycle on the enforced `tanren_app` data plane, and
// EVERY tenant-table write along the way must succeed under RLS.
//
// THE GAP THIS LOCKS. The `just smoke` hello-fixture runs on the system/BYPASSRLS
// path, and the per-stage RLS cohorts each exercise ONE write seam in isolation.
// Nothing drove a real ORG-SCOPED run through the REAL allocator + the lifecycle
// loop end-to-end on the enforced role — so the runner-allocation INSERT (which
// runs OUTSIDE an open connection scope, under only the worker's lightweight
// per-job org-id) was never covered. Live validation hit it: `new row violates
// row-level security policy for table "runners"`. This test reproduces that exact
// shape and asserts the whole lifecycle's writes land.
//
// MECHANISM. It seeds a credential-COMPLETE run (so context hydration succeeds),
// then drives the REAL `executeNextPlanJob` on the enforced app pool with:
//   - the REAL `StaticRunnerAllocator` over a REAL `PgRunnerStore(appPool)` — so
//     the runner `claim`/`release` INSERT/UPDATE hit RLS exactly as in prod;
//   - a `runWorkflow` that calls the REAL `runPlannerLoopWorkflow` with a
//     DETERMINISTIC fake harness (planner/writer/checker/auditor) + stubbed SSH
//     and a scripted GitHub transport, so no real codex/git/github is needed but
//     every DB write (tasks/events/cost_records/runners/specs/runs) is REAL.
// It asserts (a) the run lands `done/ok`, (b) the runner row was written AND
// released under the run's org, and (c) the lifecycle's per-stage tenant rows
// (plan + write tasks, the native gate's `gate.verdict` — the CI-stage write under
// the no-Actions delivery model — events incl. runner.allocated/github.pr.created/
// runner.released, cost_records, the merged spec status) all persisted org-stamped
// — i.e. every stage's writes were admitted by the policy.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), like the other RLS cohort tests. Wired into `just smoke` via
// `just smoke-rls-run-lifecycle`.

import { Pool } from "pg";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { PgJobQueue } from "../src/engine/contracts/jobQueue.js";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { StaticRunnerAllocator } from "../src/engine/allocators/staticRunnerAllocator.js";
import { PgRunnerStore } from "../src/engine/allocators/runnerStore.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import { executeNextPlanJob } from "../src/engine/worker/runExecutor.js";
import {
  accounting,
  approvingReview,
  fakeProbe,
  healthyWindow,
  noopMerge,
  passingCheck,
  passingGitHub,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_lifecycle_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG = "org_lifecycle";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = "run_lifecycle";
const PLAN_TASK = `task_plan_${ORG}`;
const GITHUB_REF = "credential/github/dev";
const CODEX_REF = "credential/codex/dev";
const RUNNER_FINGERPRINT = "SHA256:lifecycle-runner-host";

// A no-op SSH substrate: the workflow's git-clone / bootstrap / branch-push AND the
// NATIVE GATE (deps-ensure + the gate tiers, all over `ssh.run`) run here; success
// (exit 0) lets the lifecycle proceed without a real runner. `git rev-parse HEAD`
// returns a deterministic 40-hex sha so the workspace clone HEAD resolves AND the
// native merge gate's head-sha anchor is present — so the gate emits its org-stamped
// `gate.verdict` (the native CI-stage tenant write this test locks under RLS) and the
// `tanren/gate` verdict publishes. The allocator's host-key fingerprint is provided so
// it skips the live TOFU discovery handshake.
const FAKE_HEAD_SHA = "a".repeat(40);
class NoopSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];
  async run(target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target, command });
    const stdout = command.command.includes("git rev-parse HEAD") ? FAKE_HEAD_SHA : "";
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
  }
}

describeDb("RLS run lifecycle — a real org-scoped run writes every lifecycle table under enforced RLS", () => {
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

    // No BYPASSRLS carve-out: the lifecycle must succeed on the restricted app
    // role alone (the worker's own pool), which is the production data plane.
    setSystemPool(undefined);

    await seedCredentialCompleteRun(ownerPool);
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

  it("drives allocate → loop → PR → CI → merge → finalize, every tenant write admitted by RLS", async () => {
    const jobQueue = new PgJobQueue(appPool);
    // Enqueue the plan job stamped with the run's org (the worker's claim-time
    // tenant source); job_queue is OUTSIDE RLS, so the app role enqueues+claims it.
    await jobQueue.enqueue({
      runId: RUN,
      taskId: PLAN_TASK,
      taskKind: "plan",
      payload: { specId: SPEC, projectId: PROJECT },
      orgId: ORG,
    });

    // The secret store the draft-PR stage resolves the GitHub token from. Fake +
    // pre-stored so no real GitHub auth is materialized.
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: GITHUB_REF, token: "ghp_lifecycleToken" });

    // The REAL allocator over a REAL PgRunnerStore on the ENFORCED app pool: this
    // is the seam the live run failed at — the runner INSERT runs under only the
    // worker's per-job org-id (no open connection scope), so it must self-scope.
    const runnerStore = new PgRunnerStore(appPool);
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      username: "tanren",
      hostKeyFingerprint: RUNNER_FINGERPRINT,
      runners: runnerStore,
    });
    const ssh = new NoopSsh();

    const result = await executeNextPlanJob({
      pool: appPool,
      jobQueue,
      allocator,
      ssh,
      secrets,
      vcsProvider: vcsProviderOver(passingGitHub()),
      identitySecretRef: "runner/test/identity",
      heartbeatIntervalMs: 1_000_000,
      maxCiPolls: 1,
      // Drive the REAL workflow with the deterministic fake harness + stubbed
      // transports. `executeNextPlanJob` wraps this in `runWithJobOrgId(ORG)` and
      // hands it `orgScopingPool(appPool)`, so every workflow tenant write — AND
      // the allocator's runner write — self-scopes to the run's org per op.
      runWorkflow: (input) =>
        runPlannerLoopWorkflow({
          ...input,
          buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
          buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
          runBootstrap: async () => {},
          // NO `runGate` stub: the REAL native gate runs over the NoopSsh (every tier
          // step exits 0 → pass) so its org-stamped `gate.*` + `gate.verdict` tenant
          // writes are exercised under enforced RLS — the native CI-stage coverage that
          // replaces the retired CI-poll `ci` task.
          reviewProbe: approvingReview(),
          mergeProbe: noopMerge(),
          sleep: async () => {},
        }),
    });

    // (1) The run completed cleanly — every lifecycle write was admitted by RLS.
    expect(result.kind).toBe("completed");
    expect(result).toMatchObject({ runId: RUN, outcome: "passed" });

    // (2) The run landed done/ok (owner read = RLS-exempt ground truth).
    const run = await ownerPool.query<{ status: string; outcome: string | null; pr_url: string | null }>(
      "SELECT status, outcome, pr_url FROM runs WHERE run_id = $1",
      [RUN],
    );
    expect(run.rows[0]?.status).toBe("done");
    expect(run.rows[0]?.outcome).toBe("ok");
    expect(run.rows[0]?.pr_url).not.toBeNull();

    // (3) THE CORE LOCK: the runner row was written AND released under the run's
    // org — the allocation INSERT + release UPDATE both ran org-scoped (the live
    // run's RLS denial was on exactly this INSERT).
    const runner = await ownerPool.query<{ org_id: string; status: string }>(
      "SELECT org_id, status FROM runners WHERE run_id = $1",
      [RUN],
    );
    expect(runner.rowCount).toBe(1);
    expect(runner.rows[0]?.org_id).toBe(ORG);
    expect(runner.rows[0]?.status).toBe("released");

    // (4) The per-stage lifecycle writes all persisted org-stamped — proving each
    // stage's op carried the org scope (an unscoped write would have been denied,
    // failing the run before reaching `done`).
    // - write subtasks (two), all org_id = ORG;
    const writeTasks = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM tasks WHERE run_id = $1 AND kind = 'write'",
      [RUN],
    );
    expect(writeTasks.rowCount).toBe(2);
    expect(writeTasks.rows.every((r) => r.org_id === ORG)).toBe(true);
    // - the NATIVE CI-stage write: the merge authority is the in-loop gate, so its
    //   org-stamped `gate.verdict` event (NOT a forge-CI `ci` task) is the CI-stage
    //   tenant write. A passing pre_merge verdict must have persisted under the org.
    const gateVerdicts = await ownerPool.query<{ org_id: string; payload: { when: string; passed: boolean } }>(
      "SELECT org_id, payload FROM events WHERE run_id = $1 AND event_type = 'gate.verdict'",
      [RUN],
    );
    expect(gateVerdicts.rowCount).toBeGreaterThan(0);
    expect(gateVerdicts.rows.every((r) => r.org_id === ORG)).toBe(true);
    expect(gateVerdicts.rows.some((r) => r.payload.when === "pre_merge" && r.payload.passed === true)).toBe(true);

    // - cost_records from the writer/checker/auditor cost recording, org-stamped;
    const costs = await ownerPool.query<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM cost_records WHERE run_id = $1",
      [RUN],
    );
    expect(costs.rowCount).toBeGreaterThan(0);
    expect(costs.rows.every((r) => r.org_id === ORG)).toBe(true);

    // - the key lifecycle events, each org-stamped (allocator → PR → release);
    const events = await ownerPool.query<{ event_type: string; org_id: string }>(
      "SELECT event_type, org_id FROM events WHERE run_id = $1",
      [RUN],
    );
    expect(events.rows.every((r) => r.org_id === ORG)).toBe(true);
    const eventTypes = new Set(events.rows.map((r) => r.event_type));
    for (const expected of ["runner.allocated", "workspace.prepared", "github.pr.created", "runner.released"]) {
      expect(eventTypes).toContain(expected);
    }

    // - the spec was advanced to its terminal lifecycle status, org-scoped.
    const spec = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(["done", "merged"]).toContain(spec.rows[0]?.status);
  });
});

async function seedCredentialCompleteRun(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  // A version:1 project config carrying both credential refs, so
  // resolveCredentialsForRun resolves from project config (no real secrets
  // needed) and the merge stage hands off (mergeIntegration unset → not_configured).
  const config = {
    version: 1,
    credentials: { codexCredentialRef: CODEX_REF, githubCredentialRef: GITHUB_REF },
  };
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'p', 'https://github.com/cat-cave/tanren-fixture-medium', 'main', 'runner:v0', $2, $3::jsonb)`,
    [PROJECT, ORG, JSON.stringify(config)],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, $3, 'Add status helpers', 'Implement two small helpers.', $4::jsonb, 'active')`,
    [SPEC, PROJECT, ORG, JSON.stringify(["status.ts exports ok()", "status.ts exports fail()"])],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'tanren/lifecycle', 'queued')`,
    [RUN, SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
    [PLAN_TASK, RUN, ORG],
  );
}

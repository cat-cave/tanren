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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { PgJobQueue } from "../src/engine/contracts/jobQueue.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { StaticRunnerAllocator } from "../src/engine/allocators/staticRunnerAllocator.js";
import { PgRunnerStore } from "../src/engine/allocators/runnerStore.js";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { executeNextPlanJob } from "../src/engine/worker/runExecutor.js";
import {
  lifecycleAuthorityBundle,
  driveLifecycleNativeQueueLand,
  accounting,
  approvingReview,
  fakeProbe,
  healthyWindow,
  noopMerge,
  completeCheck,
  passingGitHub,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";
import {
  lifecycleGithubCredentialRef,
  loadLifecycleRunExecutionContext,
  seededLifecycleGithubSecrets,
} from "./rlsRunLifecycleCredentials.fixtures.js";

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
const GITHUB_REF = lifecycleGithubCredentialRef(ORG);
const CODEX_REF = "credential/codex/dev";
const RUNNER_FINGERPRINT = "SHA256:lifecycle-runner-host";
const FOREIGN_OWNER = "org_lifecycle_foreign";
const FOREIGN_PROJECT = `proj_${ORG}_foreign_ref`;
const FOREIGN_SPEC = `spec_${ORG}_foreign_ref`;
const FOREIGN_RUN = "run_lifecycle_foreign_ref";
const FOREIGN_PLAN_TASK = `task_plan_${ORG}_foreign_ref`;
const FOREIGN_GITHUB_REF = lifecycleGithubCredentialRef(FOREIGN_OWNER);

// A no-op SSH substrate: the workflow's git-clone / bootstrap / branch-push AND the
// NATIVE GATE (deps-ensure + the gate tiers, all over `ssh.run`) run here; success
// (exit 0) lets the lifecycle proceed without a real runner. `git rev-parse HEAD`
// returns a deterministic 40-hex sha so the workspace clone HEAD resolves AND the
// native merge gate's head-sha anchor is present — so the gate emits its org-stamped
// `gate.verdict` (the native CI-stage tenant write this test locks under RLS) and the
// `tanren/gate` verdict publishes. The allocator's host-key fingerprint is provided so
// it skips the live TOFU discovery handshake.
const FAKE_HEAD_SHA = "a".repeat(40);
// v57 task #64: the runtime gate harvester reads the declared JUnit report over SSH
// (via a `cat`-with-absent-marker script). Without this fake returning a minimal
// 1-test JUnit XML, the gate would mark every tier-2 PASS as evidence_insufficient,
// the writer-rework loop would never converge, and this 5s integration test would
// time out (the failure mode the prior agent fixed in 3 sibling SSH fakes).
const ONE_TEST_JUNIT_XML =
  '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="1" failures="0" errors="0"><testsuite name="evidence-stub" tests="1" failures="0" errors="0"><testcase name="ok"/></testsuite></testsuites>';
class NoopSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];
  async run(target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target, command });
    const cmd = command.command;
    const stdout = cmd.includes("git rev-parse HEAD")
      ? FAKE_HEAD_SHA
      : cmd.includes("__TANREN_FILE_ABSENT__")
        ? ONE_TEST_JUNIT_XML
        : "";
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
  }
}

const LIFECYCLE_REPO = { owner: "cat-cave", name: "tanren-fixture-medium" };

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

    // Every TENANT write must succeed on the restricted app role alone (the
    // worker's own pool = the production data plane). Cross-org SYSTEM reads —
    // e.g. PgBudgetGate.resolveBudget's `SELECT org_id, config FROM projects` —
    // legitimately need BYPASSRLS scope (matches prod, where `tanren_system` is
    // the narrow BYPASSRLS pool). Point the system pool at `ownerPool` so
    // system-scoped reads land the cross-org row; tenant writes still go
    // through `appPool` and prove RLS admission.
    setSystemPool(ownerPool);

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
    const secrets = await seededLifecycleGithubSecrets(GITHUB_REF);

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
      githubHttp: passingGitHub(),
      identitySecretRef: "runner/test/identity",
      runStateWriter: new DirectRunStateWriter(appPool),
      // gv-11 / #25: required run-admission visibility predicate (passing — no
      // declared visibility on this seed).
      repositoryVisibilityAdmission: { admit: async () => {} },
      heartbeatIntervalMs: 1_000_000,
      // Drive the REAL workflow with the deterministic fake harness + stubbed
      // transports. `executeNextPlanJob` wraps this in `runWithJobOrgId(ORG)` and
      // hands it `orgScopingPool(appPool)`, so every workflow tenant write — AND
      // the allocator's runner write — self-scopes to the run's org per op.
      runWorkflow: (input) =>
        runPlannerLoopWorkflow({
          ...input,
          buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
          buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
          runBootstrap: async () => {},
          // NO `runGate` stub: the REAL native gate runs over the NoopSsh (every tier
          // step exits 0 → pass) so its org-stamped `gate.*` + `gate.verdict` tenant
          // writes are exercised under enforced RLS — the native CI-stage coverage that
          // replaces the retired CI-poll `ci` task.
          reviewProbe: approvingReview(),
          mergeProbe: noopMerge(),
          // The first native-queue pass only enqueues, but retain the lifecycle authority
          // harness the canonical coordinator drive reuses below for its in-memory host +
          // real RLS-backed land finalization.
          mergeAuthority: lifecycleAuthorityBundle({
            pool: appPool,
            orgId: ORG,
            repo: LIFECYCLE_REPO,
            headBranch: "tanren/lifecycle",
            headSha: FAKE_HEAD_SHA,
          }),
          sleep: async () => {},
        }),
    });

    // (1) The run completed cleanly — every lifecycle write was admitted by RLS.
    expect(result.kind).toBe("completed");
    expect(result).toMatchObject({ runId: RUN, outcome: "passed" });

    // `native_queue` intentionally ends the run-loop's first pass after ENQUEUE.
    // Drive its queued one-member canonical node through the real queue-to-land
    // authority now: this is where `merge.completed` and spec → `merged` must be
    // admitted by the enforced app-pool RLS policy.
    const nativeQueue = new PgMergeQueueModel(appPool);
    const queued = (await nativeQueue.loadSnapshot(PROJECT)).entries;
    expect(queued).toHaveLength(1);
    const entry = queued[0];
    const target = ssh.commands[0]?.target;
    if (entry === undefined || target === undefined)
      throw new Error("lifecycle native-queue drive has no queued entry or runner target");
    await driveLifecycleNativeQueueLand({
      pool: appPool,
      orgId: ORG,
      entry,
      queue: nativeQueue,
      repo: LIFECYCLE_REPO,
      headBranch: "tanren/lifecycle",
      headSha: FAKE_HEAD_SHA,
      ssh,
      target,
    });

    // (2) The run landed completed/ok (owner read = RLS-exempt ground truth).
    const run = await ownerPool.query<{ status: string; outcome: string | null; pr_url: string | null }>(
      "SELECT status, outcome, pr_url FROM runs WHERE run_id = $1",
      [RUN],
    );
    expect(run.rows[0]?.status).toBe("completed");
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
    for (const expected of [
      "runner.allocated",
      "workspace.prepared",
      "github.pr.created",
      "merge.completed",
      "runner.released",
    ]) {
      expect(eventTypes).toContain(expected);
    }

    // - the spec was advanced to its terminal lifecycle status, org-scoped.
    const spec = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(spec.rows[0]?.status).toBe("merged");
  });

  it("rejects a foreign-owner project ref during hydration with zero lifecycle side effects", async () => {
    await seedForeignCredentialRun(ownerPool);

    await expect(
      loadLifecycleRunExecutionContext(appPool, {
        orgId: ORG,
        runId: FOREIGN_RUN,
        identitySecretRef: "runner/test/identity",
      }),
    ).rejects.toMatchObject({
      name: "CredentialRefOwnershipError",
      credentialKind: "github_token",
    });

    // Context hydration is a read boundary. The hostile persisted coordinate is
    // rejected before allocation, workflow, GitHub, or finalization can mutate
    // any lifecycle table; the seed rows remain byte-for-byte in their initial
    // queued/in-flight state and no derived row exists.
    const state = await ownerPool.query<{
      run_status: string;
      run_outcome: string | null;
      run_ended_at: Date | null;
      spec_status: string;
      plan_status: string;
      derived_tasks: string;
      runners: string;
      events: string;
      costs: string;
    }>(
      `SELECT
         r.status AS run_status,
         r.outcome AS run_outcome,
         r.ended_at AS run_ended_at,
         s.status AS spec_status,
         t.status AS plan_status,
         (SELECT count(*) FROM tasks WHERE run_id = r.run_id AND task_id <> $2)::text AS derived_tasks,
         (SELECT count(*) FROM runners WHERE run_id = r.run_id)::text AS runners,
         (SELECT count(*) FROM events WHERE run_id = r.run_id)::text AS events,
         (SELECT count(*) FROM cost_records WHERE run_id = r.run_id)::text AS costs
       FROM runs r
       JOIN specs s ON s.spec_id = r.spec_id
       JOIN tasks t ON t.task_id = $2
       WHERE r.run_id = $1`,
      [FOREIGN_RUN, FOREIGN_PLAN_TASK],
    );
    expect(state.rows[0]).toEqual({
      run_status: "queued",
      run_outcome: null,
      run_ended_at: null,
      spec_status: "in_flight",
      plan_status: "queued",
      derived_tasks: "0",
      runners: "0",
      events: "0",
      costs: "0",
    });
  });
});

async function seedCredentialCompleteRun(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  // A version:1 project config carrying both credential refs and an explicit merge
  // integration, so resolveCredentialsForRun resolves from project config (no real
  // secrets needed) and this fixture proves the successful native-queue lifecycle.
  const config = {
    version: 1,
    mergeIntegration: "native_queue",
    governancePosture: "open",
    credentials: {
      defaultLlm: { cli: "codex", model: "default", authRef: CODEX_REF },
      githubCredentialRef: GITHUB_REF,
    },
  };
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'p', 'https://github.com/cat-cave/tanren-fixture-medium', 'main', 'runner:v0', $2, $3::jsonb)`,
    [PROJECT, ORG, JSON.stringify(config)],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, $3, 'Add status helpers', 'Implement two small helpers.', $4::jsonb, 'in_flight')`,
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

async function seedForeignCredentialRun(owner: Pool): Promise<void> {
  const config = {
    version: 1,
    mergeIntegration: "native_queue",
    governancePosture: "open",
    credentials: {
      defaultLlm: { cli: "codex", model: "default", authRef: CODEX_REF },
      githubCredentialRef: FOREIGN_GITHUB_REF,
    },
  };
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'foreign-ref', 'https://github.com/cat-cave/foreign-ref', 'main', 'runner:v0', $2, $3::jsonb)`,
    [FOREIGN_PROJECT, ORG, JSON.stringify(config)],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
     VALUES ($1, $2, $3, 'Foreign ref', 'Must fail before work.', $4::jsonb, 'in_flight')`,
    [FOREIGN_SPEC, FOREIGN_PROJECT, ORG, JSON.stringify(["no lifecycle side effects"])],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'tanren/foreign-ref', 'queued')`,
    [FOREIGN_RUN, FOREIGN_SPEC, FOREIGN_PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
    [FOREIGN_PLAN_TASK, FOREIGN_RUN, ORG],
  );
}

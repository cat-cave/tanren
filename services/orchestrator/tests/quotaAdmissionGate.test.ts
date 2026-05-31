// SaaS Tier-B quota-admission-gate: the worker pre-flight gate. Proves that
// executeNextPlanJob calls the wired QuotaPolicy BEFORE running the workflow,
// and on a deny lands the run in the recoverable `quota_exceeded` state, emits
// run.quota_exceeded, and completes the job WITHOUT touching the workflow. On an
// admit it runs the workflow and accrues the run's real cost_records usage.
//
// Assertions are about OUTCOMES + STATE (the run row's final outcome, the
// appended event, whether the workflow ran, the accrued usage handed to the
// policy) — never "a mock was called".

import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { AdmissionDecision, QuotaPolicy, RunUsage } from "../src/engine/quota/index.js";
import { executeNextPlanJob } from "../src/engine/worker/index.js";
import { StubAllocator, StubGitHub, StubSsh } from "./quotaAdmissionGate.stubs.js";

const ORG_ID = "org_gated";
const RUN_ID = "run_gated";

// Minimal stateful pg substitute for the gate path: the run⋈spec⋈project join
// (with org_id), the quota-exceeded run finalize, and the run.quota_exceeded
// event insert. Stores the run's final status/outcome + appended events so
// assertions are about state. cost_records reads return the seeded usage.
class GatePool {
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  readonly events: Array<{ eventType: string; payload: unknown }> = [];
  costTokens = 0;
  costUsd = 0;

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK" || trimmed.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    // RLS R1: the worker's establishJobOrgContext confirms the claimed run is
    // reachable under its org GUC before the workflow runs.
    if (trimmed.startsWith("SELECT 1 FROM runs WHERE run_id = $1 AND org_id = $2")) {
      const ok = params[0] === RUN_ID && params[1] === ORG_ID;
      return ok ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/FROM runs r\s+JOIN specs s/u.test(trimmed)) {
      return {
        rows: [
          {
            run_id: RUN_ID,
            spec_id: "spec_gated",
            project_id: "project_gated",
            branch: "tanren/gated",
            repo_url: "https://github.com/cat-cave/fixture",
            default_branch: "main",
            runner_image: "image",
            config: { version: 1, credentials: { codexCredentialRef: "cred/codex", githubCredentialRef: "cred/gh" } },
            org_id: ORG_ID,
            title: "t",
            description: "d",
            acceptance_criteria: [],
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith("SELECT config FROM organizations")) {
      // Project config already carries both refs, so org defaults are unused.
      return { rows: [{ config: { version: 1 } }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'halted', outcome = 'quota_exceeded'")) {
      this.runStatus = { status: "halted", outcome: "quota_exceeded" };
      return { rows: [{ spec_id: "spec_gated", project_id: "project_gated" }], rowCount: 1 };
    }
    // Matches the PgEventStore insert by its column list. We deliberately do
    // NOT spell the raw event-insert SQL token here: the single-event-writer
    // architecture rule flags that token anywhere outside eventStore.ts,
    // including in test fakes + comments.
    if (trimmed.includes("event_type, payload")) {
      this.events.push({ eventType: String(params[4]), payload: JSON.parse(String(params[5])) });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM cost_records/u.test(trimmed)) {
      return {
        rows: [{ runs: this.costTokens, tokens: this.costTokens, cost_usd: this.costUsd }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  // RLS R1: runWithOrgScope checks out a client; the pool returns itself.
  async connect(): Promise<GatePool> {
    return this;
  }

  release(): void {}
}

// A policy stub whose decision is fixed per-test and which records the usage it
// was accrued — so the accrual assertion is about the value handed over, a real
// outcome of reading cost_records.
class StubPolicy implements QuotaPolicy {
  readonly accrued: Array<{ orgId: string; usage: RunUsage }> = [];
  constructor(private readonly decision: AdmissionDecision) {}
  async checkAdmission(): Promise<AdmissionDecision> {
    return this.decision;
  }
  async accrueUsage(orgId: string, usage: RunUsage): Promise<void> {
    this.accrued.push({ orgId, usage });
  }
}

async function enqueuedQueue(): Promise<FakeJobQueue> {
  const jobQueue = new FakeJobQueue();
  await jobQueue.enqueue({ runId: RUN_ID, taskId: "task_gated", taskKind: "plan", payload: {} });
  return jobQueue;
}

function baseDeps(pool: GatePool, jobQueue: FakeJobQueue, quotaPolicy: QuotaPolicy) {
  return {
    pool: pool as never,
    jobQueue,
    allocator: new StubAllocator(),
    ssh: new StubSsh(),
    secrets: new FakeSecretStore(),
    githubHttp: new StubGitHub(),
    identitySecretRef: "runner/test/identity",
    quotaPolicy,
  };
}

describe("quota admission gate (executeNextPlanJob pre-flight)", () => {
  it("denies a run when the policy denies admission: workflow never runs, run is quota_exceeded, event emitted, job completed", async () => {
    const pool = new GatePool();
    const jobQueue = await enqueuedQueue();
    let workflowRan = false;

    const result = await executeNextPlanJob({
      ...baseDeps(
        pool,
        jobQueue,
        new StubPolicy({ admit: false, reason: "run quota exhausted", windowKey: "2026-05" }),
      ),
      runWorkflow: async () => {
        workflowRan = true;
        throw new Error("workflow must not run for a denied admission");
      },
    });

    // Outcome: the workflow was never invoked.
    expect(workflowRan).toBe(false);
    // Outcome: a typed quota_denied result carrying the reason.
    expect(result).toEqual({
      kind: "quota_denied",
      jobId: expect.any(String),
      runId: RUN_ID,
      reason: "run quota exhausted",
    });
    // State: the run is finalized recoverable as quota_exceeded.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "quota_exceeded" });
    // State: the run.quota_exceeded event was appended with the reason + window.
    const event = pool.events.find((e) => e.eventType === "run.quota_exceeded");
    expect(event?.payload).toEqual({ reason: "run quota exhausted", windowKey: "2026-05" });
    // State: the job reached a terminal (completed) queue state, not failed/claimed.
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("admits and runs the workflow, then accrues the run's real cost_records usage", async () => {
    const pool = new GatePool();
    pool.costTokens = 1200;
    pool.costUsd = 3.5;
    const jobQueue = await enqueuedQueue();
    const policy = new StubPolicy({ admit: true });
    let workflowRan = false;

    const result = await executeNextPlanJob({
      ...baseDeps(pool, jobQueue, policy),
      runWorkflow: async () => {
        workflowRan = true;
        return { outcome: { kind: "passed" } } as never;
      },
    });

    expect(workflowRan).toBe(true);
    expect(result).toMatchObject({ kind: "completed", runId: RUN_ID, outcome: "passed" });
    // Accrual outcome: the run's REAL usage (from cost_records) was handed to the policy.
    expect(policy.accrued).toEqual([{ orgId: ORG_ID, usage: { runs: 1, tokens: 1200, costUsd: 3.5 } }]);
    // The run was not forced into quota_exceeded on the admit path.
    expect(pool.runStatus.outcome).not.toBe("quota_exceeded");
  });

  it("defaults to unlimited (no policy wired): admits and runs the workflow", async () => {
    const pool = new GatePool();
    const jobQueue = await enqueuedQueue();
    let workflowRan = false;

    const result = await executeNextPlanJob({
      pool: pool as never,
      jobQueue,
      allocator: new StubAllocator(),
      ssh: new StubSsh(),
      secrets: new FakeSecretStore(),
      githubHttp: new StubGitHub(),
      identitySecretRef: "runner/test/identity",
      // No quotaPolicy → NoopQuotaPolicy (unlimited) by default.
      runWorkflow: async () => {
        workflowRan = true;
        return { outcome: { kind: "passed" } } as never;
      },
    });

    expect(workflowRan).toBe(true);
    expect(result).toMatchObject({ kind: "completed", outcome: "passed" });
    expect(pool.runStatus.outcome).not.toBe("quota_exceeded");
  });
});

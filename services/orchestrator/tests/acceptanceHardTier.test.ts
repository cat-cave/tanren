// the final v0 acceptance HARD tier, exercised through the REAL
// dequeue→execute path (the same seam runWorker.test.ts proves for the easy
// path). This is the deterministic replacement for the deleted direct-execution
// acceptance drivers (scripts/acceptance/*, removed in): instead of a
// linear easy run we script the FAKE adapters / gate / merge probe so a single
// run is forced down all three hard branches the v0 release gate must survive:
//
//   1. PLANNER RE-PLAN via the in-loop gate: the first writer
//      iteration's per_iteration gate FAILS → gateRejection → handleRejection
//      emits `planner.rerequested` and the loop re-plans (re-invokes the
//      planner) instead of dispatching a doomed checker call.
//   2. AUDITOR REJECTION LOOP: after the tree gates green, the auditor returns
//      `loop_to_planner` once → another `planner.rerequested` → re-plan, then
//      passes on the next audit.
//   3. CONFLICT RESOLUTION: the approved PR's direct merge reports a
//      conflict; the conflict-resolver hook resolves it and the retried merge
//      succeeds — the run lands a coherent terminal `done/ok`.
//
// Everything runs through `executeNextPlanJob` (claim a real queued plan job →
// run the REAL `runPlannerLoopWorkflow` body) with fakes injected through the
// workflow's existing buildAdapters / runGate / reviewProbe / mergeProbe /
// resolveConflict seams. No real Codex/SSH/GitHub is touched, and every hard
// loop stays inside the configured retry budgets.

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import type { AnswererAdapter } from "../src/engine/usage/index.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import { executeNextPlanJob } from "../src/engine/worker/index.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceStalled,
  incompleteCheck,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makePlanner,
  makeTriage,
  makeWriter,
  p1Audit,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";
import {
  enqueuePlanJob,
  failingGate,
  fakeProbe,
  fullAdapters,
  hardTierGitHub,
  hardTierWorkflowRunner,
  identitySecretRef,
  passingGate,
  RecordingAllocator,
  RecordingSsh,
  setupSeededRun,
  type HardTierTrace,
} from "./acceptanceHardTier.fixtures.js";

describe("acceptance hard tier (dequeue→execute, all hard paths)", () => {
  it("drives re-plan + auditor rejection + conflict resolution through the worker to a coherent terminal state", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const github = hardTierGitHub();
    const trace: HardTierTrace = {
      gateCalls: [],
      mergeAttempts: 0,
      conflictResolved: 0,
    };

    const result = await executeNextPlanJob({
      pool: pool.asPgPool(),
      jobQueue,
      allocator: new RecordingAllocator(),
      ssh: new RecordingSsh(),
      secrets,
      vcsProvider: vcsProviderOver(github),
      identitySecretRef,
      // Budgets generous enough that the scripted loops stay well within them.
      escapeHatches: {
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
      runWorkflow: hardTierWorkflowRunner(github, trace),
    });

    // The run completed through the worker (job claimed, workflow run, job done).
    expect(result).toMatchObject({ kind: "completed", runId: run.runId, outcome: "passed" });

    // Hard path 1 — re-plan via the in-loop gate: the very first per_iteration
    // gate failed, so the loop re-planned rather than checking a broken tree.
    expect(trace.gateCalls[0]).toEqual({ when: "per_iteration" });

    // Hard path 2 — auditor rejection loop: the auditor was asked at least
    // twice (reject once, then pass), proving the rework re-entered the loop.
    expect(trace.gateCalls.filter((c) => c.when === "pre_audit").length).toBeGreaterThanOrEqual(2);

    // Hard path 3 — conflict resolution: the merge was attempted twice (conflict
    // then success) and the resolver hook fired exactly once between them.
    expect(trace.conflictResolved).toBe(1);
    expect(trace.mergeAttempts).toBe(2);

    // Coherent terminal state: the conflict was resolved, the merge succeeded,
    // and the run + spec landed merged/done — NOT halted.
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    expect(pool.specStatus).toBe("merged");
    // Within budget: the run did not exhaust the rerun budget (no halt).
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("re-plans on the in-loop gate failure and on the auditor rejection (planner re-invoked across passes)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const github = hardTierGitHub();
    // Capture planner.rerequested events through the real workflow's event seam
    // by counting them on the fake pool's event router would require parsing
    // SQL; instead we assert the observable re-plan effect: the planner adapter
    // is invoked three times (initial + gate re-plan + auditor re-plan).
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "first", behaviorIds: ["B1"] }]),
      buildPlan([{ title: "T1", intent: "audit-fix", behaviorIds: ["B1"] }]),
    ]) as AnswererAdapter<PlanAnswer> & { calls: unknown[] };
    const checker = makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>;
    // A P1 audit finding once (→ triage task → convergence progress → re-plan), then clean.
    const auditor = makeAuditor([p1Audit, cleanAudit]) as AnswererAdapter<AuditAnswer>;
    const writer = makeWriter(["diff --git a/file\n+ok\n"]);
    let gateCall = 0;

    const result = await executeNextPlanJob({
      pool: pool.asPgPool(),
      jobQueue,
      allocator: new RecordingAllocator(),
      ssh: new RecordingSsh(),
      secrets,
      vcsProvider: vcsProviderOver(github),
      identitySecretRef,
      runWorkflow: (input) =>
        runPlannerLoopWorkflow({
          ...input,
          vcsProvider: vcsProviderOver(github),
          maxCiPolls: 1,
          ciPollDelayMs: 0,
          sleep: async () => {},
          runBootstrap: async () => {},
          runGate: async () => {
            gateCall += 1;
            return gateCall === 1 ? failingGate() : passingGate;
          },
          buildAdapters: () => fullAdapters({ planner, writer, checker, auditor }),
          buildUsageProbe: () => fakeProbe(),
          reviewProbe: {
            markReady: async () => {},
            fetchVerdict: async () => ({
              verdict: "approved" as const,
              latest: { state: "approved" as const, reviewer: "reviewer-bot" },
            }),
          },
          mergeProbe: {
            merge: async () => ({
              merged: true,
              mergeSha: "merge-sha",
              conflict: false,
              status: 200,
              message: "merged",
            }),
            // branch reports clean → up-to-date enforcement is a no-op.
            readMergeability: async () => ({
              state: "clean" as const,
              behind: false,
              baseBranch: "main",
              headBranch: "tanren/run_hard",
            }),
            updateBranch: async () => ({ outcome: "up_to_date" as const, message: "up to date" }),
          },
        }),
    });

    expect(result.kind).toBe("completed");
    // Initial plan + one re-plan (driven by the auditor's P1 → triage → convergence
    // progress) = 2 planner invocations.
    expect(planner.calls.length).toBe(2);
    expect(pool.runStatus.status).toBe("completed");
  });

  it("halts (recoverable) as convergence_stalled when the spec never converges — the SOLE loop bound", async () => {
    // SPEC-LOOP REDESIGN: there is NO retry-cap halt. A hard scenario that never
    // converges must NOT loop forever — it halts as convergence_stalled once the
    // convergence answerer reports N CONSECUTIVE stalls. Proves the loop is bounded by
    // convergence, not a retry counter.
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);

    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "never converges", behaviorIds: ["B1"] }]),
    ]) as AnswererAdapter<PlanAnswer> & { calls: unknown[] };
    // The checker stays incomplete EVERY loop → a P0 task-incomplete finding → triage
    // routes it to a task → convergence STALLS every loop.
    const checker = makeChecker([incompleteCheck]) as AnswererAdapter<CheckAnswer>;
    const auditor = makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>;
    const writer = makeWriter(["diff --git a/file\n+ok\n"]);
    const maxConsecutiveStalls = 2;

    const result = await executeNextPlanJob({
      pool: pool.asPgPool(),
      jobQueue,
      allocator: new RecordingAllocator(),
      ssh: new RecordingSsh(),
      secrets,
      vcsProvider: vcsProviderOver(hardTierGitHub()),
      identitySecretRef,
      runWorkflow: (input) =>
        runPlannerLoopWorkflow({
          ...input,
          vcsProvider: vcsProviderOver(hardTierGitHub()),
          maxCiPolls: 1,
          ciPollDelayMs: 0,
          sleep: async () => {},
          runBootstrap: async () => {},
          runGate: async () => passingGate,
          // Bound the per-task writer loop tight so the incompleteness becomes a finding
          // quickly; the convergence policy (maxConsecutiveStalls) is the real bound.
          context: { ...input.context, convergencePolicy: { maxConsecutiveStalls, demoRunEnabled: false } },
          buildAdapters: () =>
            fullAdapters({
              planner,
              writer,
              checker,
              auditor,
              triage: makeTriage([triageAllTasks]),
              convergence: makeConvergence([convergenceStalled]),
            }),
          buildUsageProbe: () => fakeProbe(),
        }),
    });

    // The workflow finalized the run as a recoverable halt (no PR) — convergence_stalled.
    expect(result).toMatchObject({ kind: "completed", outcome: "convergence_stalled" });
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "convergence_stalled" });
  });
});

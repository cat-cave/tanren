// SINGLE-FINALIZE INVARIANT (apex v35): a run attempt is finalized EXACTLY ONCE.
//
// The race this closes (confirmed live twice; #580 only papered over it with a
// timing-sensitive successor probe): when a spec's run fails on a retriable/random
// fault, TWO finalize paths handle the SAME thrown error and DOUBLE-FINALIZE —
//   1. the WORKFLOW re-drives the spec (run → halted, spec → open, `dag.spec.redriven`)
//      and historically RE-THREW the raw error, which
//   2. propagated to the WORKER's `finalizeRunRecoverable` → `parkStrandedSpec*`, which
//      stranded the just-re-driven spec `dag.spec.needs_attention reason:"no_live_run"`.
//
// The fix is an EXPLICIT signal, not a probe: the workflow's own finalizer runs FIRST +
// FULLY (run AND spec). A RE-DRIVEN attempt is terminally disposed of → the workflow
// returns NORMALLY (never re-throws). The other dispositions still fail the job, but are
// re-thrown wrapped in `WorkflowFinalizedError` so the worker SKIPS its safety-net
// re-finalize. A GENUINELY orphaned run (a crash whose workflow finalizer NEVER ran)
// throws RAW → the worker still strands it (the §2c safety net preserved).

import { describe, expect, it } from "vitest";
import { executeNextPlanJob } from "../src/engine/worker/index.js";
import {
  WorkflowFinalizedError,
  isWorkflowFinalized,
  rawCauseOf,
  type WorkflowErrorDisposition,
} from "../src/engine/workflow/workflowErrorDisposition.js";
import { deps, passingGitHub, SEEDED_ORG_ID, setupSeededRun } from "./helpers/workerExec.js";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";

async function enqueue(jobQueue: FakeJobQueue, run: { runId: string; plannerTaskId: string }) {
  await jobQueue.enqueue({
    runId: run.runId,
    taskId: run.plannerTaskId,
    taskKind: "plan",
    payload: {},
    orgId: SEEDED_ORG_ID,
  });
}

describe("WorkflowFinalizedError — the explicit single-finalize signal", () => {
  it("wraps the raw cause; the type guard + unwrap recover it (the worker classifies the raw error)", () => {
    const raw = new Error("a flaky internal blip");
    const wrapped = new WorkflowFinalizedError("escalated", raw);
    expect(isWorkflowFinalized(wrapped)).toBe(true);
    expect(isWorkflowFinalized(raw)).toBe(false);
    // The worker unwraps to the SAME raw error for job-fail accounting + the internal log.
    expect(rawCauseOf(wrapped)).toBe(raw);
    expect(rawCauseOf(raw)).toBe(raw);
    const disposition: WorkflowErrorDisposition = wrapped.disposition;
    expect(disposition).toBe("escalated");
  });
});

describe("run worker — single-finalize: the workflow's own finalize is NOT double-finalized", () => {
  it("a WorkflowFinalizedError (workflow already finalized) is NOT re-stranded by the worker", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    // The spec OCCUPIES a slot (in_flight) — exactly the state the orphan strand targets.
    // If the worker re-finalized, it would strand this spec `needs_attention`.
    pool.specStatus = "in_flight";
    const jobQueue = new FakeJobQueue();
    await enqueue(jobQueue, run);

    // The workflow re-threw a WRAPPED error (an escalate/recoverable-halt disposition) — the
    // worker MUST skip `finalizeRunRecoverable`. To prove the SKIP is a REAL guard (not an
    // accidental no-op a terminal run-status would also produce), we DELIBERATELY leave the run
    // `running`: were the worker to re-finalize, the `status IN ('running','queued','failed')`
    // guard WOULD bite, force-halt the run, and strand its still-`in_flight` spec `no_live_run`.
    // The explicit `WorkflowFinalizedError` signal prevents that double-finalize. (The RE-DRIVE
    // disposition never even re-throws — the workflow returns normally — so this wrapped-throw
    // path is the strictest worker-facing case.)
    pool.runStatus = { status: "running", outcome: null };
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        throw new WorkflowFinalizedError("escalated", new Error("the run failed with an internal error"));
      },
    });

    // The job still FAILS (the wrapped disposition fails the job)...
    expect(result.kind).toBe("failed");
    // ...but the worker's safety-net `finalizeRunRecoverable` was SKIPPED: NO `no_live_run`
    // strand event, and the spec was NOT flipped to `needs_attention` (it stays where the
    // workflow left it — the spec's own finalize/the walker owns it).
    const stranded = pool.events.find(
      (e) => e.eventType === "dag.spec.needs_attention" && (e.payload as { reason?: string }).reason === "no_live_run",
    );
    expect(stranded).toBeUndefined();
    expect(pool.specStatus).toBe("in_flight");
  });

  it("a GENUINELY orphaned run (raw throw, finalizer never ran) STILL strands no_live_run (safety net preserved)", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    pool.specStatus = "in_flight";
    // No successor run exists ⇒ a genuine orphan (not a re-drive transitioning the slot).
    pool.successorRunCount = 0;
    const jobQueue = new FakeJobQueue();
    await enqueue(jobQueue, run);

    // A genuine crash: the run is left `running` (the workflow's own finalize NEVER ran) and a
    // RAW error escapes. This is the §2c orphan the worker MUST strand.
    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        throw new Error("the run failed with an internal error");
      },
    });

    expect(result.kind).toBe("failed");
    // The worker force-halted the orphaned run AND stranded the spec `no_live_run`.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(pool.eventTypes).toContain("run.failed");
    const stranded = pool.events.find(
      (e) => e.eventType === "dag.spec.needs_attention" && (e.payload as { reason?: string }).reason === "no_live_run",
    );
    expect(stranded).toBeDefined();
    expect(pool.specStatus).toBe("needs_attention");
  });

  it("a re-driven attempt with a fresh successor is NOT stranded even if a raw orphan check ran (defense in depth)", async () => {
    // Belt-and-suspenders: even where a raw error reaches the worker, #580's successor probe
    // still skips the strand for a spec a re-drive already transitioned (a fresh queued
    // successor). This composes with the explicit-signal fix above.
    const { pool, secrets, run } = await setupSeededRun();
    pool.specStatus = "in_flight";
    // A re-drive enqueued a successor run (>0 ⇒ the spec is transitioning, not orphaned).
    pool.successorRunCount = 1;
    const jobQueue = new FakeJobQueue();
    await enqueue(jobQueue, run);

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        throw new Error("the run failed with an internal error");
      },
    });

    expect(result.kind).toBe("failed");
    // The successor probe recognized the transitioning slot → NO strand.
    const stranded = pool.events.find(
      (e) => e.eventType === "dag.spec.needs_attention" && (e.payload as { reason?: string }).reason === "no_live_run",
    );
    expect(stranded).toBeUndefined();
    expect(pool.specStatus).toBe("in_flight");
  });
});

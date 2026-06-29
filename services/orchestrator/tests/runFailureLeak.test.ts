// Public-error-leak hardening (code-integrity finding). The worker-level catch in
// runExecutor.ts wraps a WHOLE run, so a thrown error can carry a URL / repo ref /
// command fragment / secret-adjacent text. That raw string must NEVER reach the
// PUBLIC `run.failed.message` (sensitivityRules marks it `public`) — nor the public
// `dag.spec.needs_attention` strand. Instead the worker classifies the error into a
// closed-vocabulary `{ failureCode, stage, message: <fixed safe summary> }`, and the
// raw detail stays on the INTERNAL channel (job_queue.fail + the returned result).
//
// These tests drive the REAL executeNextPlanJob over the in-memory WorkerPool (which
// captures the JSON payload of every event the finalize path writes) and assert the
// public-vs-internal split directly.

import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { SpeculativeAssemblyError } from "../src/engine/dag/speculativeAssemblyError.js";
import { executeNextPlanJob, type ExecuteJobResult } from "../src/engine/worker/index.js";
import { classifyRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import { deps, passingGitHub, SEEDED_ORG_ID, setupSeededRun } from "./helpers/workerExec.js";

// A clone-failure message embedding a URL + a secret-adjacent token — the exact
// arbitrary raw string the finding warns can ride a caught run-level error.
const RAW_LEAK = "clone https://x-access-token:ghp_SECRET123@github.com/acme/private.git failed (exit 128)";

class WorkspaceBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBootstrapError";
  }
}

describe("run-failure public-error-leak hardening (runExecutor catch → run.failed)", () => {
  it("puts ONLY a code/stage/safe-summary on the PUBLIC events; the raw string stays internal", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
      orgId: SEEDED_ORG_ID,
    });

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [
          run.runId,
        ]);
        throw new WorkspaceBootstrapError(RAW_LEAK);
      },
    });

    // The PUBLIC run.failed event carries ONLY the classified code/stage + a fixed
    // safe summary — the operator-facing signal is present, the raw string is not.
    const runFailed = pool.events.find((e) => e.eventType === "run.failed");
    expect(runFailed?.payload).toMatchObject({
      status: "halted",
      failureCode: "workspace",
      stage: "workspace",
      message: "workspace bootstrap failed",
    });

    // NO public event the FINALIZE catch-path wrote (run.failed AND the public
    // dag.spec.needs_attention strand) may carry the raw string / URL / host / token.
    // (run.queued's project.repoUrl is a legitimately-public project field — scope the
    // leak assertion to the catch-path events the raw error message flowed into.)
    const FINALIZE_EVENTS = new Set(["run.failed", "dag.spec.needs_attention"]);
    const finalizeEvents = JSON.stringify(
      pool.events.filter((e) => FINALIZE_EVENTS.has(e.eventType)).map((e) => e.payload),
    );
    expect(finalizeEvents).not.toContain("ghp_SECRET123");
    expect(finalizeEvents).not.toContain("https://");
    expect(finalizeEvents).not.toContain("github.com");
    expect(finalizeEvents).not.toContain(RAW_LEAK);

    // The raw detail survives on the INTERNAL result channel for operator triage
    // (the worker passes it to job_queue.fail + returns it), off the public timeline.
    const failed = result as Extract<ExecuteJobResult, { kind: "failed" }>;
    expect(failed).toMatchObject({ kind: "failed", runId: run.runId });
    expect(failed.failure.message).toContain("ghp_SECRET123");
  });

  it("classifies a bare/unknown error CLOSED to the generic internal code (no raw pass-through)", () => {
    // The classifier keys off error.name, never the message — an unrecognized error
    // falls closed to `{ internal, run, <fixed summary> }`, so a novel secret shape in
    // the message can never widen what becomes public.
    expect(classifyRunFailure(new Error(RAW_LEAK))).toEqual({
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
    });
    expect(classifyRunFailure(RAW_LEAK)).toEqual({
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
    });
    // A known credential error maps to its safe code/stage/summary — never its message.
    expect(classifyRunFailure(new WorkspaceBootstrapError(RAW_LEAK)).summary).toBe("workspace bootstrap failed");
  });

  it("classifies SpeculativeAssemblyError to the specific `speculative_assembly` code (apex v56 #61)", async () => {
    // The bare `throw new Error(...)` on the dependent-run base-assembly path used to fall
    // to the catch-all `internal @ run` — apex v56 stranded with no actionable class. The
    // structured class now keys the classifier to a SPECIFIC public `speculative_assembly`
    // code (stage `workspace`, fixed safe summary). The `phase` discriminator (carried for
    // internal triage) does NOT widen what reaches the public event — the summary is the
    // same fixed sentence regardless of phase.
    const classified = classifyRunFailure(
      new SpeculativeAssemblyError("missing_ancestor_ref", "ancestor branch xyz vanished and did not merge"),
    );
    expect(classified).toEqual({
      code: "speculative_assembly",
      stage: "workspace",
      summary: "the dependent run's speculative base assembly failed",
    });
    // Every phase classifies to the SAME public shape (the phase is internal-only).
    expect(classifyRunFailure(new SpeculativeAssemblyError("phantom_workspace", "no workspace handle")).code).toBe(
      "speculative_assembly",
    );
    expect(classifyRunFailure(new SpeculativeAssemblyError("bootstrap_conflict", "specA vs specB")).code).toBe(
      "speculative_assembly",
    );
  });

  it("flows the SpeculativeAssemblyError class through the run.failed event payload (apex v56 #61)", async () => {
    // E2E counterpart: drive `executeNextPlanJob` with a workflow that throws the structured
    // class (the apex v56 scenario was an assembly throw before any task/planner event), and
    // assert the PUBLIC `run.failed` event carries the SPECIFIC `speculative_assembly` code +
    // stage + the fixed safe summary — NOT the generic `internal @ run` it stranded on.
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      payload: {},
      orgId: SEEDED_ORG_ID,
    });

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      runWorkflow: async () => {
        await pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [
          run.runId,
        ]);
        throw new SpeculativeAssemblyError(
          "missing_ancestor_ref",
          "jj-local integration: member spec_X (branch tanren/run_Y) has no tanren/run_Y@origin ref",
        );
      },
    });

    const runFailed = pool.events.find((e) => e.eventType === "run.failed");
    expect(runFailed?.payload).toMatchObject({
      status: "halted",
      failureCode: "speculative_assembly",
      stage: "workspace",
      message: "the dependent run's speculative base assembly failed",
    });
    // The class name surfaces on the internal channel for operator triage (the worker passes
    // `error.name` as the job-queue fail kind), proving the structured class flowed through.
    const failed = result as Extract<ExecuteJobResult, { kind: "failed" }>;
    expect(failed.failure.kind).toBe("SpeculativeAssemblyError");
  });

  it("classifies WorkspaceCommandError to the specific `workspace` code (apex v65)", async () => {
    // The bare workspace-SSH catch-all used to fall through to the catch-all `internal @ run`
    // — apex v65 stranded with `run.failed { failureCode: "internal" }` and no underlying
    // error event on the public timeline, hiding a real `prepare clean PR branch failed:
    // cannot rebase: You have unstaged changes` root cause. The classifier now keys it to a
    // SPECIFIC `workspace` code (stage `workspace`, fixed safe summary) so the operator
    // sees an actionable class on `dag.spec.needs_attention` and the convergence detector
    // keys a real fix-point on the workspace class, not every unknown throw aliased together.
    const { WorkspaceCommandError } = await import("../src/engine/workspace/ssh.js");
    const result = { exitCode: 1, stdout: "", stderr: "cannot rebase: You have unstaged changes", timedOut: false };
    expect(
      classifyRunFailure(
        new WorkspaceCommandError("prepare clean PR branch failed: exit 1", "prepare clean PR branch", result),
      ),
    ).toEqual({
      code: "workspace",
      stage: "workspace",
      summary: "a workspace command failed during the run",
    });
  });

  it("classifies the empty-writer-commit error as the retriable `empty_writer_output` code (v35)", async () => {
    const { EmptyWriterCommitError } = await import("../src/engine/workflow/plannerRunCi.js");
    // A "No commits between base and head" 422 whose branch produced nothing this attempt
    // is a TRANSIENT empty output — classified to its own retriable code (NOT the hard
    // `internal` strand it used to become), so the unified finalize re-drives it.
    expect(classifyRunFailure(new EmptyWriterCommitError("tanren/run_1", "main"))).toEqual({
      code: "empty_writer_output",
      stage: "agent",
      summary: "the writer produced no commit ahead of the base this attempt",
    });
  });
});

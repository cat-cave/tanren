// Mutation ratchet (run-loop cluster): the runPlannerLoopWorkflow review→rework
// re-entry + merge-outcome→run-state mapping (plannerRun.ts lines ~284-335) and
// the runOutcomeFor non-pass mapping. The existing plannerRun.test.ts pins only
// the approved+handed-off happy path, leaving the changes-requested re-entry,
// the rework-budget halt, the pending-after-budget halt, and the
// merged / conflict / failed merge branches unpinned. These tests drive the
// real workflow with the fake adapters + scripted review/merge probes and assert
// the OBSERVABLE outcomes: the persisted run + spec status, the planner.rerequested
// producer, and the events — never adapter internals.
import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { GitHubHttpResponse } from "../src/engine/providers/github.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  accounting,
  alwaysChangesReview,
  approvingReview,
  buildPlan,
  changesThenApproveReview,
  conflictMerge,
  directMergeConfig,
  FailingReleaseAllocator,
  failedMerge,
  fakeProbe,
  healthyWindow,
  loopAudit,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  mergedMerge,
  noopMerge,
  passingAudit,
  passingCheck,
  pendingReview,
  runPlannerLoopScoped,
  ScriptedGitHubHttp,
  setup,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

// One PR-publish round of GitHub responses (the forge PR-list + create). The native
// merge gate runs over SSH (no forge poll); the verdict-publish forge call is skipped
// here because the unit SSH fake yields no head sha. The review/merge stages are
// probe-injected, so only this PR-publish tail hits the scripted client.
function ghRound(): GitHubHttpResponse[] {
  return [
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 7,
        html_url: "https://github.com/cat-cave/tanren-fixture-medium/pull/7",
        draft: true,
        base: { ref: "main" },
      },
    },
  ];
}

const escapeHatches = { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 };

const baseInput = (over: Record<string, unknown>) => ({
  escapeHatches,
  timeoutMs: 100,
  maxCiPolls: 1,
  sleep: async () => {},
  buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
  ...over,
});

describe("runPlannerLoopWorkflow — review-rework re-entry", () => {
  it("re-plans against a changes-requested review, then completes on approval", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = new ScriptedGitHubHttp([...ghRound(), ...ghRound()]);
    // One shared adapter set across both passes; the planner records every call
    // so we can assert the second pass carried the reviewer feedback as steering.
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "add ok()", behaviorIds: [] }]),
      buildPlan([{ title: "T1b", intent: "rename per review", behaviorIds: [] }]),
    ]);
    const adapters = {
      planner: planner as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["diff a\n", "diff b\n"]),
      checker: makeChecker([passingCheck, passingCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([passingAudit, passingAudit]) as AnswererAdapter<AuditAnswer>,
    };

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => adapters,
        reviewProbe: changesThenApproveReview(),
        mergeProbe: noopMerge(),
        maxReviewReworks: 1,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    // Approved on the second pass, then explicitly direct-merged → completed/ok.
    expect(result.outcome.kind).toBe("passed");
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    // The re-entry put the spec back in_flight before the final merged.
    expect(pool.specStatuses).toEqual(["in_flight", "merged"]);
    // The loop re-entered: the planner was invoked a second time, and that
    // second prompt carried the reviewer's changes-requested feedback as the
    // seeded rejection steering (producer "reviewer" → renamed body in prose).
    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[0]!.prompt).toContain("no prior rejections");
    expect(planner.calls[1]!.prompt).toContain("Rejection #1 from reviewer:");
    expect(planner.calls[1]!.prompt).toContain("please rename ok()");
  });

  it("halts (no merge) when changes are requested and the rework budget is exhausted", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    // maxReviewReworks = 0 → the first changes-requested verdict exhausts the
    // budget immediately and halts without re-entering the loop.
    const github = new ScriptedGitHubHttp([...ghRound()]);

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: alwaysChangesReview(),
        mergeProbe: noopMerge(),
        maxReviewReworks: 0,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.outcome.kind).toBe("passed");
    expect(result.merge).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    // No re-entry → no in_flight write, and the spec was never marked done/merged.
    expect(pool.specStatuses).toEqual([]);
  });

  it("halts when the review stays pending after the poll budget", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const github = new ScriptedGitHubHttp([...ghRound()]);

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: pendingReview(),
        mergeProbe: noopMerge(),
        maxReviewReworks: 1,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.review?.verdict).toBe("pending");
    expect(result.merge).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
  });
});

describe("runPlannerLoopWorkflow — merge-outcome mapping (direct_merge)", () => {
  it("marks the spec merged and the run done/ok when the merge succeeds", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = new ScriptedGitHubHttp([...ghRound()]);

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("merged");
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    // A direct merge marks the spec merged (not the handed-off "done").
    expect(pool.specStatuses).toEqual(["merged"]);
  });

  it("halts (recoverable) when the merge reports a conflict", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = new ScriptedGitHubHttp([...ghRound()]);

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: conflictMerge(),
        // Isolate the merge-outcome mapping (conflict → halted) from the
        // resolver's own behavior (covered by conflictResolver.test.ts): inject
        // the test-fixture no-op resolver so the conflict stays unresolved.
        resolveConflict: noopConflictResolver,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("conflict");
    // A conflict is recoverable → halted, and the spec is NOT marked done/merged.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(pool.specStatuses).toEqual([]);
  });

  it("fails the run (not halted) when the merge fails outright", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = new ScriptedGitHubHttp([...ghRound()]);

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: failedMerge(),
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("failed");
    // A hard merge failure is a failed run (distinct from the recoverable halt).
    expect(pool.runStatus).toEqual({ status: "failed", outcome: "failed" });
    expect(pool.specStatuses).toEqual([]);
  });
});

describe("runPlannerLoopWorkflow — non-pass loop outcome mapping", () => {
  it("maps a retry_budget_exhausted loop to a halted run with that outcome (no PR)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    // Auditor loops forever; the rerun budget (2) is exhausted → retry_budget_exhausted.
    const adapters = {
      planner: makePlanner([
        buildPlan([{ title: "T1", intent: "a", behaviorIds: [] }]),
        buildPlan([{ title: "T2", intent: "b", behaviorIds: [] }]),
        buildPlan([{ title: "T3", intent: "c", behaviorIds: [] }]),
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d1\n", "d2\n", "d3\n"]),
      checker: makeChecker([passingCheck, passingCheck, passingCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([loopAudit, loopAudit, loopAudit]) as AnswererAdapter<AuditAnswer>,
    };

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(new ScriptedGitHubHttp([])),
        context: ctx,
        escapeHatches: { maxPlannerRerunsPerSpec: 2, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
        buildAdapters: () => adapters,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.outcome.kind).toBe("retry_budget_exhausted");
    expect(result.pullRequest).toBeUndefined();
    // The non-pass outcome maps to a halted run carrying the precise reason.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "retry_budget_exhausted" });
  });

  it("maps an auditor halt to a halted run with outcome=halted (no PR)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const adapters = {
      planner: makePlanner([
        buildPlan([{ title: "T1", intent: "doomed", behaviorIds: [] }]),
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d\n"]),
      checker: makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([
        { passed: false, reasoning: "unrecoverable", outstandingBehaviorIds: [], recommendedAction: "halt" },
      ]) as AnswererAdapter<AuditAnswer>,
    };

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(new ScriptedGitHubHttp([])),
        context: ctx,
        buildAdapters: () => adapters,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.outcome.kind).toBe("halted");
    expect(result.pullRequest).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
  });
});

// SECURITY-BASELINE CLEANUP-PROOF (tanren-direction.md § "Security Baseline"): the
// run-end release emits a `release.finalized` audit event proving WHETHER the runner
// was torn down + listing any residual resources to reconcile.
describe("runPlannerLoopWorkflow — release cleanup-proof", () => {
  it("records a clean release.finalized (cleanedUp, no residuals) on a successful teardown", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = new ScriptedGitHubHttp([...ghRound()]);

    await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    const finalized = events.events.find((e) => e.eventType === "release.finalized");
    expect(finalized).toBeDefined();
    expect(finalized!.payload).toEqual({
      runnerId: "runner_planner",
      cleanedUp: true,
      residualResources: [],
    });
  });

  it("records a FAILED release.finalized (residual runner + bounded reason) when teardown throws, without masking the run", async () => {
    const { ctx, pool, events, secrets, ssh } = await setup(directMergeConfig());
    const allocator = new FailingReleaseAllocator();
    const github = new ScriptedGitHubHttp([...ghRound()]);

    // The run still completes normally — a failed teardown is recorded loudly, never
    // re-thrown into the run's outcome (the release runs in `finally`).
    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        vcsProvider: vcsProviderOver(github),
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("merged");
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });

    const finalized = events.events.find((e) => e.eventType === "release.finalized");
    expect(finalized).toBeDefined();
    const payload = finalized!.payload as {
      cleanedUp: boolean;
      residualResources: string[];
      failureReason?: string;
    };
    expect(payload.cleanedUp).toBe(false);
    expect(payload.residualResources).toEqual(["runner:runner_planner"]);
    // The reason is a NON-SECRET single line (multi-line provider dumps are dropped).
    expect(payload.failureReason).toBe("hetzner: deleteServer 500");
  });
});

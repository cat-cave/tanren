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
  convergenceStalled,
  directMergeConfig,
  FailingReleaseAllocator,
  fakeProbe,
  healthyWindow,
  loopStageAdapters,
  p1Audit,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makePlanner,
  makeTriage,
  makeWriter,
  mergedMerge,
  noopMerge,
  plannerAuthorityBundle,
  plannerAuthorityHost,
  cleanAudit,
  completeCheck,
  pendingReview,
  runPlannerLoopScoped,
  ScriptedGitHubHttp,
  setup,
  triageAllTasks,
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

const escapeHatches = { maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 };

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
      checker: makeChecker([completeCheck, completeCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([cleanAudit, cleanAudit]) as AnswererAdapter<AuditAnswer>,
      ...loopStageAdapters(),
    };

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: github,
        context: ctx,
        buildAdapters: () => adapters,
        reviewProbe: changesThenApproveReview(),
        mergeProbe: noopMerge(),
        mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
        maxReviewReworks: 1,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    // Approved on the second pass, then explicitly authority-landed → completed/ok.
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
        reviewProbe: alwaysChangesReview(),
        mergeProbe: noopMerge(),
        maxReviewReworks: 0,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.outcome.kind).toBe("passed");
    expect(result.merge).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    // UNIFIED RUN-FINALIZE (apex v35): a review stall (changes-requested with the rework
    // budget exhausted) is TRANSIENT — the spec RE-DRIVES to `open` (the walker re-attempts),
    // NOT the old terminal `needs_attention` park. The OBSERVABLE retry event is emitted.
    expect(pool.specStatuses.at(-1)).toBe("open");
    expect(events.events.some((e) => e.eventType === "dag.spec.redriven")).toBe(true);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
        mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("merged");
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    // A direct (authority) land marks the spec merged (not the handed-off "done").
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: conflictMerge(),
        mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
        // §5h: the `behind` freshness routes through the unified base-shift hook, which
        // surfaces the conflict (jj owns conflict). Inject a scripted hook so the no-DB unit
        // run never allocates a runner; it returns `conflict` to drive the resolver path.
        baseShiftRebase: async () => ({ outcome: "conflict", message: "branch conflicts with base" }),
        // Isolate the merge-outcome mapping (conflict → halted) from the
        // resolver's own behavior (covered by conflictResolver.test.ts): inject
        // the test-fixture no-op resolver so the conflict stays unresolved.
        resolveConflict: noopConflictResolver,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.merge?.outcome).toBe("conflict");
    // UNIFIED RUN-FINALIZE (apex v35): a conflict is recoverable → the run halts and the
    // spec RE-DRIVES to `open` (the walker re-attempts; work never discarded) — NOT merged,
    // NOT parked at `needs_attention` (a resolvable conflict is not a human-decision).
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(pool.specStatuses.at(-1)).toBe("open");
  });

  // (DELETED with the host-merge land path) "fails the run when the merge fails outright":
  // the plain "merge API error → failed" disposition was UNIQUE to the deleted
  // `landViaHostMerge` (the host PR-merge returning neither merged nor conflict). The
  // unconditional `MergeAuthority` land has no such outcome — a land that cannot proceed is
  // `blocked` / `conflict` / `needs_attention` / `merge_state_unknown`, each covered by the
  // authority suites — so the behavior no longer exists to test.
});

describe("runPlannerLoopWorkflow — non-pass loop outcome mapping", () => {
  it("maps a convergence_stalled loop to a halted run with that outcome (no PR)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    // SPEC-LOOP REDESIGN: the auditor surfaces a P1 finding every loop; triage keeps it
    // in-spec; the convergence answerer STALLS every loop → after N consecutive stalls
    // the run halts as convergence_stalled (the SOLE loop bound — no retry cap).
    const adapters = {
      planner: makePlanner([
        buildPlan([{ title: "T1", intent: "a", behaviorIds: [] }]),
        buildPlan([{ title: "T2", intent: "b", behaviorIds: [] }]),
        buildPlan([{ title: "T3", intent: "c", behaviorIds: [] }]),
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d1\n", "d2\n", "d3\n"]),
      checker: makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([p1Audit]) as AnswererAdapter<AuditAnswer>,
      triage: makeTriage([triageAllTasks]),
      convergence: makeConvergence([convergenceStalled]),
      demoRun: makeDemoRun([{ findings: [], summary: "ok" }]),
    };

    const result = await runPlannerLoopScoped(
      baseInput({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context: { ...ctx, convergencePolicy: { maxConsecutiveStalls: 2, demoRunEnabled: false } },
        buildAdapters: () => adapters,
      }) as Parameters<typeof runPlannerLoopScoped>[0],
    );

    expect(result.outcome.kind).toBe("convergence_stalled");
    expect(result.pullRequest).toBeUndefined();
    // The non-pass outcome preserves its precise WHY on the run row (the recovery surface
    // keys off it), even though the SPEC re-drives.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "convergence_stalled" });
    // UNIFIED RUN-FINALIZE (apex v35): a convergence stall is TRANSIENT — the spec RE-DRIVES
    // to `open` (the walker re-attempts), NOT the old terminal `needs_attention` park.
    expect(pool.specStatuses.at(-1)).toBe("open");
    expect(events.events.some((e) => e.eventType === "dag.spec.redriven")).toBe(true);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
        mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
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
        githubHttp: github,
        context: ctx,
        buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
        reviewProbe: approvingReview(),
        mergeProbe: mergedMerge(),
        mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
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

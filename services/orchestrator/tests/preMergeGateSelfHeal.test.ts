// PRE-MERGE GATE SELF-HEAL (apex v34). The native gate runs at three lifecycle
// points (engine/ci/schema.ts `CiWhen`). Their failure routing — asserted for the
// per_iteration + pre_audit tiers in gateLoopRouting.test.ts — used to DIVERGE at the
// merge tier:
//   - per_iteration (fast tier) fail  → loops straight back to the WRITER (self-heal);
//   - pre_audit (slow tier) fail       → a P0 FINDING → triage → WRITER (self-heal);
//   - pre_merge ("merge" tier) fail    → THREW `planner-loop native gate failed: ...`
//                                        → the run failed `code:internal` → the spec
//                                        terminally STRANDED.
// That stranded a WRITER-FIXABLE failure (the merge tier is the writer's OWN
// scaffold/tests — e.g. a `tier-3` cucumber+stryker that exits 1). This pins the fix:
// a failed pre_merge gate now RE-ENTERS the writer loop (`mergeGateRejection`, mirroring
// the review-rework re-entry) with the failing tier/step/OUTPUT as steering — and is
// BOUNDED by `maxMergeGateReworks` so a genuinely-unmergeable spec halts LOUD (a parked
// `needs_attention` run), never an infinite loop, never a silent pass, never the old
// terminal `internal` strand.
import { describe, expect, it } from "vitest";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { AnswererAdapter } from "../src/engine/usage/index.js";
import {
  accounting,
  approvingReview,
  buildPlan,
  cleanAudit,
  completeCheck,
  directMergeConfig,
  fakeProbe,
  healthyWindow,
  loopStageAdapters,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  noopMerge,
  plannerAuthorityBundle,
  plannerAuthorityHost,
  runPlannerLoopScoped,
  setup,
} from "./plannerRun.fixtures.js";

// A method/path-AWARE GitHub fake (the positional `passingGitHub` queue assumes ONE
// publish cycle; the self-heal re-entry publishes the PR each loop). It find-or-creates
// the single canonical draft PR #7: the first head-lookup returns no PR (→ create), and
// every later lookup returns the open PR #7 on `main` (→ idempotent reuse, no PATCH). All
// other calls (graphql mark-ready, the `tanren/gate` commit-status POST) succeed. This
// lets the PR-publish tail run cleanly across any number of writer self-heal loops.
class ReusablePrGitHubHttp implements GitHubHttpClient {
  private created = false;
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.method === "GET" && (input.path === "/user" || input.path.startsWith("/user?"))) {
      return { status: 200, body: { login: "tanren[bot]", id: 424242 } };
    }
    const pr = {
      number: 7,
      html_url: "https://github.com/cat-cave/tanren-fixture-medium/pull/7",
      draft: true,
      base: { ref: "main" },
    };
    if (input.method === "GET" && input.path.includes("/pulls?")) {
      return { status: 200, body: this.created ? [pr] : [] };
    }
    if (input.method === "POST" && input.path.endsWith("/pulls")) {
      this.created = true;
      return { status: 201, body: pr };
    }
    // graphql (mark-ready node-id fetch + mutation), commit-status POST, everything else.
    return { status: 200, body: { data: { repository: { pullRequest: { id: "PR_node_7" } } } } };
  }
}

const passGate: GateOutcome = { passed: true, results: [] };

// A failed gate carrying the failing step's captured output tail (the cucumber/stryker
// stderr) so the writer-steering can surface the ACTUAL error to fix.
function failGate(tier: string, when: CiWhen, failedStep: string, outputTail: string): GateOutcome {
  return {
    passed: false,
    results: [],
    failure: {
      passed: false,
      tier,
      when,
      failedStep,
      exitCode: 1,
      steps: [{ name: failedStep, run: `just ${tier}`, exitCode: 1, passed: false, timedOut: false, outputTail }],
    },
  };
}

// A scripted gate: pre_merge follows its own per-call script; per_iteration / pre_audit
// always pass (the fast + slow tiers are not under test here). Records the writer
// prompts so we can assert the failing step's output reaches the re-authoring writer.
function scriptedGate(preMergeOutcomes: ReadonlyArray<GateOutcome>) {
  let preMergeIndex = 0;
  const preMergeCalls: GateOutcome[] = [];
  const runGate = async (input: { when: CiWhen; taskId?: string }): Promise<GateOutcome> => {
    if (input.when !== "pre_merge") return passGate;
    const outcome = preMergeOutcomes[preMergeIndex] ?? preMergeOutcomes.at(-1) ?? passGate;
    preMergeIndex += 1;
    preMergeCalls.push(outcome);
    return outcome;
  };
  return { runGate, preMergeCalls };
}

// A single-subtask adapter set with a writer whose `.calls` we count across loops. The
// answerers cycle their last scripted answer, so a self-heal re-entry (a fresh
// runSubtaskLoop pass) is safe.
function selfHealAdapters() {
  const writer = makeWriter(["diff one\n", "diff two\n", "diff three\n"]);
  const planner = makePlanner([buildPlan([{ title: "T1", intent: "build it", behaviorIds: [] }])]);
  return {
    adapters: {
      planner: planner as AnswererAdapter<PlanAnswer>,
      writer,
      checker: makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>,
      ...loopStageAdapters(),
    },
    writer,
    planner,
  };
}

describe("pre-merge gate self-heal (apex v34)", () => {
  it("a failed pre_merge ('merge'-tier) gate re-enters the WRITER with the failing step's output, NOT a code:internal strand", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    // The cucumber/stryker error the writer must see to fix its own tier-3.
    const tier3Error = "Failures:\n  cypress/e2e/redirect.feature:12 expected 302 got 404";
    // pre_merge FAILS on the first attempt, PASSES after the writer re-authors.
    const { runGate, preMergeCalls } = scriptedGate([
      failGate("tier-3", "pre_merge", "cucumber", tier3Error),
      passGate,
    ]);
    const { adapters, writer, planner } = selfHealAdapters();

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: new ReusablePrGitHubHttp(),
      context: ctx,
      escapeHatches: { maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      runGate,
      buildAdapters: () => adapters,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
    });

    // The run RECOVERED (the writer self-healed the tier-3) — NOT a terminal strand.
    expect(result.outcome.kind).toBe("passed");
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
    // The pre_merge gate ran twice (fail → re-author → pass), the second a clean merge.
    expect(preMergeCalls.map((o) => o.passed)).toEqual([false, true]);
    expect(result.mergeGate?.passed).toBe(true);
    // The spec was returned to in_flight for the self-heal re-entry (same as a review-rework).
    expect(pool.specStatuses).toContain("in_flight");
    // The writer re-authored after the merge-gate failure (a fresh runSubtaskLoop pass).
    expect(writer.calls.length).toBeGreaterThan(1);
    // The self-heal re-planned: the planner ran again (the re-entry runs the full loop).
    expect(planner.calls.length).toBeGreaterThan(1);
    // CRITICAL: the re-plan that drives the re-author carries the FAILING STEP'S OUTPUT
    // (the cucumber error) as `gate`-producer steering — so the writer fixes the REAL
    // failure, not a vague "tier-3 failed". `mergeGateRejection` → planner rejectionHistory.
    const rePlanPrompt = planner.calls.at(-1)!.prompt;
    expect(rePlanPrompt).toContain(tier3Error);
    expect(rePlanPrompt).toContain("pre-merge gate");
    expect(rePlanPrompt).toContain("from gate");
    // It is NOT a `code:internal` strand: no `planner-loop native gate failed` throw.
    expect(JSON.stringify(events.events)).not.toContain("planner-loop native gate failed");
  });

  it("a pre_merge gate failing the IDENTICAL way halts LOUD at a FIXED POINT (no count, never loops / never silently passes)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    // pre_merge fails the IDENTICAL way EVERY time — the writer never changes the error.
    const { runGate, preMergeCalls } = scriptedGate([
      failGate("tier-3", "pre_merge", "stryker", "mutation score 41% < 60%"),
    ]);
    const { adapters } = selfHealAdapters();

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: new ReusablePrGitHubHttp(),
      context: ctx,
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      runGate,
      buildAdapters: () => adapters,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
    });

    // It HALTED LOUD (a parked, requeueable run) — never merged on an unverified head.
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    expect(result.mergeGate?.passed).toBe(false);
    // FIXED POINT (no count): the initial gate run, then reworks that reproduce the IDENTICAL
    // error. A single repeat is NOT yet a fixed point (a transient may recur once); only once
    // the identical error RECURS as a cycle does the detector halt — so the gate runs three
    // times (initial + two identical reworks), then halts. A finite count proves it neither
    // looped forever nor silently passed — and the halt is the detector's, not a budget's.
    expect(preMergeCalls).toHaveLength(3);
    expect(preMergeCalls.every((o) => !o.passed)).toBe(true);
  });
});

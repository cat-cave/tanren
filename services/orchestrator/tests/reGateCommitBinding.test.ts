// RESIDUAL #4 — the BEHIND re-gate must bind its verdict to the EXACT rebased PR-head
// sha (tanren-owns-the-engine.md §5 commit-binding). `buildReGateCi` is the in-loop
// merge-stage re-gate hook; after a base-shift rebase the dispatcher calls it with the
// rebased head sha, and it MUST thread that sha as the `pre_merge` gate's
// `headShaOverride` so `gatedHeadSha === landedHeadSha` holds for the behind path (the
// forge-side rebase does NOT necessarily advance the local workspace HEAD, so binding
// to the workspace HEAD there is unproven). Absent (the resolved-tree re-gate, where the
// local workspace IS the head) ⇒ no override (bind to the workspace HEAD).
//
// Drives `buildReGateCi` against a spy gate closure (records the override it receives) +
// a no-publish input (no installation, empty static ref ⇒ publishMergeVerdict returns
// early), so the assertion is purely on the override threading — no live runner / forge.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { buildReGateCi, type MergeGateRunContext } from "../src/engine/workflow/plannerRunCi.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const REBASED_PR_HEAD = "c".repeat(40);

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

function context(): PlannerRunContext {
  return {
    runId: "run_behind",
    specId: "spec_behind",
    projectId: "project_behind",
    orgId: "org_behind",
    repoUrl: "https://github.com/cat-cave/behind",
    targetBranch: "main",
    runBranch: "tanren/behind",
    specTitle: "behind spec",
    specDescription: "rebase then re-gate",
    acceptanceCriteria: ["green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    // EMPTY static ref + no installation ⇒ publishMergeVerdict returns early (no forge).
    githubCredentialRef: "",
  };
}

// A spy gate closure recording the `headShaOverride` it is called with. Returns a
// passing outcome so the re-gate resolves to `passed` (the override threading is what
// we assert, not the verdict value).
function spyGate(): {
  runGate: (gate: { when: CiWhen; taskId?: string; headShaOverride?: string }) => Promise<GateOutcome>;
  calls: Array<{ when: CiWhen; headShaOverride?: string }>;
} {
  const calls: Array<{ when: CiWhen; headShaOverride?: string }> = [];
  return {
    calls,
    runGate: async ({ when, headShaOverride }) => {
      calls.push({ when, ...(headShaOverride !== undefined && { headShaOverride }) });
      return { passed: true, results: [] };
    },
  };
}

function gateCtx(runGate: MergeGateRunContext["runGate"]): MergeGateRunContext {
  return { runGate, target, workspacePath: "/workspace/runs/run_behind/repo", eventStore: new FakeEventStore() };
}

// A gate closure that throws (e.g. the runner SSH connection died mid re-gate). The
// re-gate must FAIL-CLOSED on this and log the error LOUD before returning `failed`.
const throwingGate: MergeGateRunContext["runGate"] = async () => {
  throw new Error("ssh: runner connection reset mid re-gate");
};

// buildReGateCi reads only context / ssh / vcsProvider / secrets / timeoutMs off the
// input — and with no installation + empty static ref the publish path returns before
// touching vcsProvider/secrets, so a minimal cast is sufficient.
function reGateInput(): RunPlannerLoopInput {
  return { context: context(), timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

describe("buildReGateCi — behind re-gate commit-binding (§5)", () => {
  it("binds the re-gate verdict to the rebased PR head when the dispatcher passes rebasedHeadSha", async () => {
    const gate = spyGate();
    const reGate = buildReGateCi(reGateInput(), gateCtx(gate.runGate));

    const result = await reGate({ rebasedHeadSha: REBASED_PR_HEAD });

    expect(result.status).toBe("passed");
    // The pre_merge gate ran with the rebased PR head as its verdict anchor (override),
    // NOT the local workspace HEAD.
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]).toEqual({ when: "pre_merge", headShaOverride: REBASED_PR_HEAD });
  });

  it("passes NO override (workspace-HEAD anchor) when called with no rebased head (resolved-tree re-gate)", async () => {
    const gate = spyGate();
    const reGate = buildReGateCi(reGateInput(), gateCtx(gate.runGate));

    // The resolved-tree re-gate (where the local workspace IS the resolved head) calls
    // the hook with no rebased head ⇒ the gate binds to the workspace HEAD.
    const result = await reGate({});

    expect(result.status).toBe("passed");
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]).toEqual({ when: "pre_merge" });
    expect(gate.calls[0]?.headShaOverride).toBeUndefined();
  });

  it("an empty rebasedHeadSha threads NO override (it never silently binds an empty anchor)", async () => {
    const gate = spyGate();
    const reGate = buildReGateCi(reGateInput(), gateCtx(gate.runGate));

    const result = await reGate({ rebasedHeadSha: "" });

    expect(result.status).toBe("passed");
    expect(gate.calls[0]?.headShaOverride).toBeUndefined();
  });
});

describe("buildReGateCi — a re-gate throw is FAIL-CLOSED and logged LOUD (no_silent_fallbacks)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status: failed AND logs the swallowed error (never a silent discard)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reGate = buildReGateCi(reGateInput(), gateCtx(throwingGate));

    const result = await reGate({ rebasedHeadSha: REBASED_PR_HEAD });

    // FAIL-CLOSED: the merge is blocked on the unverified rebase.
    expect(result.status).toBe("failed");
    // The swallowed error is logged LOUD (at error level → console.error) BEFORE the
    // failed verdict — never a bare silent catch that discards it.
    expect(logged).toHaveBeenCalled();
    const line = logged.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/re-gate failed/iu);
    expect(line).toMatch(/connection reset mid re-gate/u);
  });
});

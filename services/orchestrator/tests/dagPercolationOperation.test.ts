// (autonomy-engine.md §2c; walker-jj-local-integration-design.md §4): the
// PercolatingKickOff operation — RE-RESOLVE the unmerged-ancestor stack + hand it to the
// never-discard base-shift re-executor (rebase IN PLACE + re-gate). Driven through
// in-memory seams (TEST FIXTURES — they live here, never src/). Proves:
//   - it RE-RESOLVES the ordered unmerged-ancestor stack (the real PR-head branches) and
//     zips in the dependent's recorded per-ancestor head shas;
//   - on a clean kick-off it RE-EXECUTES (rebase + re-gate), returning the re-execution
//     run id — it does NOT absorb / record a SHA here (that is settle);
//   - the merged ancestors are DROPPED (only the unmerged are stacked); when EVERY ancestor
//     merged the re-exec is genuinely NON-speculative (empty stack).

import { describe, expect, it } from "vitest";
import type { PercolationDecision, SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import {
  PercolatingKickOff,
  type PercolationReexecutor,
  type PercolationStackResolver,
} from "../src/engine/dag/percolationOperation.js";

const PROJECT = "project_percolation";

class FakeStackResolver implements PercolationStackResolver {
  readonly calls: Array<{ projectId: string; unmergedAncestorSpecIds: ReadonlyArray<string> }> = [];
  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<{ specId: string; runId: string; branch: string }>> {
    this.calls.push(input);
    // Resolve each unmerged ancestor to its real PR-head branch + run id (DAG order preserved).
    return input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/run/${specId}`,
    }));
  }
}

class RecordingReexecutor implements PercolationReexecutor {
  readonly calls: Array<{
    specId: string;
    ancestorStack: AncestorStack;
    nonSpeculative: boolean;
  }> = [];
  async reexecute(input: {
    dependent: SpeculativeDependent;
    ancestorStack: AncestorStack;
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string }> {
    this.calls.push({
      specId: input.dependent.specId,
      ancestorStack: input.ancestorStack,
      nonSpeculative: input.nonSpeculative,
    });
    return { reexecRunId: `reexec_${input.dependent.specId}` };
  }
}

function dependent(specId: string, shas: Record<string, string>): SpeculativeDependent {
  return {
    specId,
    runId: `run_${specId}`,
    speculativeBase: null,
    integratedAncestorShas: shas,
    verifiedAncestorShas: shas,
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

function decision(ancestorSpecId: string, toSha: string): PercolationDecision {
  return { ancestorSpecId, promptness: "immediate", fromSha: "sha-old", toSha, immediateSeverity: "P0" };
}

describe("PercolatingKickOff (§4 re-resolve stack + re-base + re-execute)", () => {
  it("a clean kick-off RE-EXECUTES the dependent (returns the re-exec run id) — no absorb here", async () => {
    const stackResolver = new FakeStackResolver();
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ stackResolver, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
      mergedAncestorSpecIds: [],
    });

    expect(outcome.result).toBe("reexecuting");
    expect(outcome.reexecRunId).toBe("reexec_spec_b");
    // The stack was RE-RESOLVED before the re-execution; no merged ancestors ⇒ the full set.
    expect(stackResolver.calls).toHaveLength(1);
    expect(stackResolver.calls[0]?.unmergedAncestorSpecIds).toEqual(["spec_a"]);
    // The re-execution was driven against the re-resolved ordered stack (branches + head shas).
    expect(reexecutor.calls).toEqual([
      {
        specId: "spec_b",
        ancestorStack: [{ specId: "spec_a", runId: "run_spec_a", branch: "tanren/run/spec_a", headSha: "sha-old" }],
        nonSpeculative: false,
      },
    ]);
  });

  it("the ONLY ancestor merged ⇒ DROPS it (empty stack) + re-exec is NON-speculative", async () => {
    const stackResolver = new FakeStackResolver();
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ stackResolver, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "main-merge-sha"),
      mergedAncestorSpecIds: ["spec_a"],
    });

    expect(outcome.result).toBe("reexecuting");
    // The merged ancestor is DROPPED — the stack is not even resolved (empty unmerged set).
    expect(stackResolver.calls).toHaveLength(0);
    // The re-execution is genuinely NON-speculative (re-based onto plain main; empty stack).
    expect(reexecutor.calls).toHaveLength(1);
    expect(reexecutor.calls[0]?.nonSpeculative).toBe(true);
    expect(reexecutor.calls[0]?.ancestorStack).toEqual([]);
  });

  it("mixed merged+unmerged ⇒ the stack carries ONLY the unmerged; re-exec stays speculative", async () => {
    const stackResolver = new FakeStackResolver();
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ stackResolver, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_c", { spec_a: "sha-old", spec_b: "sha-old" }),
      decision: decision("spec_a", "main-merge-sha"),
      mergedAncestorSpecIds: ["spec_a"],
    });

    expect(outcome.result).toBe("reexecuting");
    // ONLY the unmerged spec_b is stacked; the merged spec_a is dropped (arrives via main).
    expect(stackResolver.calls[0]?.unmergedAncestorSpecIds).toEqual(["spec_b"]);
    // A non-empty unmerged stack ⇒ still speculative.
    expect(reexecutor.calls[0]?.nonSpeculative).toBe(false);
    expect(reexecutor.calls[0]?.ancestorStack).toEqual([
      { specId: "spec_b", runId: "run_spec_b", branch: "tanren/run/spec_b", headSha: "sha-old" },
    ]);
  });
});

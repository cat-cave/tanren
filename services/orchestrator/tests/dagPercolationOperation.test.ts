// P2c-2 (autonomy-engine.md §2c): the PercolatingKickOff operation — rebuild the
// integration + re-base + RE-EXECUTE the dependent through a real run. Driven
// through in-memory seams (TEST FIXTURES — they live here, never src/). Proves:
//   - it REBUILDS the integration via the SpeculativeIntegrator (reused, not duped);
//   - on a clean rebuild it RE-EXECUTES (re-base + re-enqueue), returning the
//     re-execution run id — it does NOT absorb / record a SHA here (that is settle);
//   - on an ancestor-vs-ancestor conflict on the rebuild it HOLDS (routed to P2b),
//     with NO re-execution kicked off.

import { describe, expect, it } from "vitest";
import type { PercolationDecision, SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../src/engine/contracts/speculativeIntegrator.js";
import { PercolatingKickOff, type PercolationReexecutor } from "../src/engine/dag/percolationOperation.js";

const PROJECT = "project_percolation";

class FakeIntegrator implements SpeculativeIntegrator {
  readonly calls: BuildSpeculativeIntegrationInput[] = [];
  constructor(private readonly mode: "ok" | "conflict") {}
  async buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome> {
    this.calls.push(input);
    const integrationBranch = `tanren/integ/${input.dependentSpecId}`;
    if (this.mode === "conflict") {
      return {
        outcome: "conflict",
        integrationBranch,
        ancestorHeadShas: {},
        conflictBetween: {
          specId: input.unmergedAncestorSpecIds[1] ?? "",
          otherSpecId: input.unmergedAncestorSpecIds[0] ?? "",
        },
        message: "ancestors conflict",
      };
    }
    return {
      outcome: "integrated",
      integrationBranch,
      ancestorHeadShas: Object.fromEntries(input.unmergedAncestorSpecIds.map((id) => [id, `sha-${id}`])),
      message: "ok",
    };
  }
}

class RecordingReexecutor implements PercolationReexecutor {
  readonly calls: Array<{
    specId: string;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
    nonSpeculative: boolean;
  }> = [];
  async reexecute(input: {
    dependent: SpeculativeDependent;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string }> {
    this.calls.push({
      specId: input.dependent.specId,
      integrationBranch: input.integrationBranch,
      ancestorHeadShas: input.ancestorHeadShas,
      nonSpeculative: input.nonSpeculative,
    });
    return { reexecRunId: `reexec_${input.dependent.specId}` };
  }
}

function dependent(specId: string, shas: Record<string, string>): SpeculativeDependent {
  return {
    specId,
    runId: `run_${specId}`,
    speculativeBase: `tanren/integ/${specId}`,
    integratedAncestorShas: shas,
    verifiedAncestorShas: shas,
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

function decision(ancestorSpecId: string, toSha: string): PercolationDecision {
  return { ancestorSpecId, promptness: "immediate", fromSha: "sha-old", toSha, immediateSeverity: "P0" };
}

describe("PercolatingKickOff (§2c rebuild + re-base + re-execute)", () => {
  it("a clean rebuild RE-EXECUTES the dependent (returns the re-exec run id) — no absorb here", async () => {
    const integrator = new FakeIntegrator("ok");
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ integrator, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
      mergedAncestorSpecIds: [],
    });

    expect(outcome.result).toBe("reexecuting");
    expect(outcome.reexecRunId).toBe("reexec_spec_b");
    // The integration was REBUILT (reused integrator) before the re-execution.
    expect(integrator.calls).toHaveLength(1);
    // No merged ancestors ⇒ the unmerged stack is the full ancestor set; speculative.
    expect(integrator.calls[0]?.unmergedAncestorSpecIds).toEqual(["spec_a"]);
    // The re-execution was driven against the rebuilt integration branch + new SHAs.
    expect(reexecutor.calls).toEqual([
      {
        specId: "spec_b",
        integrationBranch: "tanren/integ/spec_b",
        ancestorHeadShas: { spec_a: "sha-spec_a" },
        nonSpeculative: false,
      },
    ]);
  });

  it("an ancestor-vs-ancestor conflict on the rebuild HOLDS (no re-execution)", async () => {
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ integrator: new FakeIntegrator("conflict"), reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_c", { spec_a: "sha-old", spec_b: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
      mergedAncestorSpecIds: [],
    });

    expect(outcome.result).toBe("held");
    // Never re-executed on a held rebuild.
    expect(reexecutor.calls).toEqual([]);
  });

  it("the ONLY ancestor merged ⇒ DROPS it (empty unmerged stack) + re-exec is NON-speculative", async () => {
    const integrator = new FakeIntegrator("ok");
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ integrator, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "main-merge-sha"),
      mergedAncestorSpecIds: ["spec_a"],
    });

    expect(outcome.result).toBe("reexecuting");
    // The merged ancestor is DROPPED — the integration is built with an EMPTY unmerged
    // stack (the integrator resets the ephemeral ref to plain default_branch).
    expect(integrator.calls).toHaveLength(1);
    expect(integrator.calls[0]?.unmergedAncestorSpecIds).toEqual([]);
    // The re-execution is genuinely NON-speculative (re-based onto plain main).
    expect(reexecutor.calls).toHaveLength(1);
    expect(reexecutor.calls[0]?.nonSpeculative).toBe(true);
  });

  it("mixed merged+unmerged ⇒ the integration stacks ONLY the unmerged; re-exec stays speculative", async () => {
    const integrator = new FakeIntegrator("ok");
    const reexecutor = new RecordingReexecutor();
    const op = new PercolatingKickOff({ integrator, reexecutor });

    const outcome = await op.kickOff({
      projectId: PROJECT,
      dependent: dependent("spec_c", { spec_a: "sha-old", spec_b: "sha-old" }),
      decision: decision("spec_a", "main-merge-sha"),
      mergedAncestorSpecIds: ["spec_a"],
    });

    expect(outcome.result).toBe("reexecuting");
    // ONLY the unmerged spec_b is stacked; the merged spec_a is dropped (arrives via main).
    expect(integrator.calls[0]?.unmergedAncestorSpecIds).toEqual(["spec_b"]);
    // A non-empty unmerged stack ⇒ still speculative (based on the integration branch).
    expect(reexecutor.calls[0]?.nonSpeculative).toBe(false);
    expect(reexecutor.calls[0]?.ancestorHeadShas).toEqual({ spec_b: "sha-spec_b" });
  });
});

// P2c-2 (autonomy-engine.md §2c): the PercolatingOperation — the chain
// re-integration for ONE (dependent, ancestor-change). Driven through in-memory
// seams (TEST FIXTURES — they live here, never src/). Proves the operation:
//   - REBUILDS the integration via the SpeculativeIntegrator (reused, not duped);
//   - on a clean re-gate ABSORBS the change AND records the new integrated SHA
//     (the termination key) — never merging unverified;
//   - on an ancestor-vs-ancestor conflict on the rebuild HOLDS (routed to P2b);
//   - on an irreconcilable re-gate REPLANS (work alive, not dropped/merged);
//   - threads viaResolver through.

import { describe, expect, it } from "vitest";
import type { PercolationDecision, SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../src/engine/contracts/speculativeIntegrator.js";
import { PercolatingOperation, type PercolationReGate } from "../src/engine/dag/percolationOperation.js";

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

class ScriptedReGate implements PercolationReGate {
  readonly calls: Array<{ specId: string; integrationBranch: string }> = [];
  constructor(private readonly verdict: { outcome: "absorbed" | "replanned"; viaResolver: boolean; reason?: string }) {}
  async rebaseAndReGate(input: {
    dependent: SpeculativeDependent;
    integrationBranch: string;
  }): Promise<{ outcome: "absorbed" | "replanned"; viaResolver: boolean; reason?: string }> {
    this.calls.push({ specId: input.dependent.specId, integrationBranch: input.integrationBranch });
    return this.verdict;
  }
}

function dependent(specId: string, shas: Record<string, string>): SpeculativeDependent {
  return { specId, runId: `run_${specId}`, speculativeBase: `tanren/integ/${specId}`, integratedAncestorShas: shas };
}

function decision(ancestorSpecId: string, toSha: string): PercolationDecision {
  return { ancestorSpecId, promptness: "immediate", fromSha: "sha-old", toSha, immediateSeverity: "P0" };
}

describe("PercolatingOperation (§2c chain re-integration)", () => {
  it("a clean re-base/re-gate ABSORBS + records the new integrated SHA (termination key)", async () => {
    const recorded: Array<{ runId: string; ancestorSpecId: string; sha: string }> = [];
    const integrator = new FakeIntegrator("ok");
    const reGate = new ScriptedReGate({ outcome: "absorbed", viaResolver: false });
    const op = new PercolatingOperation({
      integrator,
      reGate,
      recordIntegratedSha: async (i) => {
        recorded.push({ runId: i.runId, ancestorSpecId: i.ancestorSpecId, sha: i.sha });
      },
    });

    const outcome = await op.percolate({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
    });

    expect(outcome.result).toBe("absorbed");
    expect(outcome.newIntegratedSha).toBe("sha-new");
    // The integration was REBUILT (reused integrator) before the re-gate.
    expect(integrator.calls).toHaveLength(1);
    expect(reGate.calls).toEqual([{ specId: "spec_b", integrationBranch: "tanren/integ/spec_b" }]);
    // The new SHA was recorded on the run (the next detect's no-op key).
    expect(recorded).toEqual([{ runId: "run_spec_b", ancestorSpecId: "spec_a", sha: "sha-new" }]);
  });

  it("an ancestor-vs-ancestor conflict on the rebuild HOLDS (no re-gate, no record)", async () => {
    const recorded: unknown[] = [];
    const reGate = new ScriptedReGate({ outcome: "absorbed", viaResolver: false });
    const op = new PercolatingOperation({
      integrator: new FakeIntegrator("conflict"),
      reGate,
      recordIntegratedSha: async () => {
        recorded.push(1);
      },
    });

    const outcome = await op.percolate({
      projectId: PROJECT,
      dependent: dependent("spec_c", { spec_a: "sha-old", spec_b: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
    });

    expect(outcome.result).toBe("held");
    // Never re-gated on a held rebuild; never recorded — nothing was absorbed.
    expect(reGate.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("an irreconcilable re-gate REPLANS (work alive, never merged/recorded)", async () => {
    const recorded: unknown[] = [];
    const op = new PercolatingOperation({
      integrator: new FakeIntegrator("ok"),
      reGate: new ScriptedReGate({ outcome: "replanned", viaResolver: true, reason: "irreconcilable" }),
      recordIntegratedSha: async () => {
        recorded.push(1);
      },
    });

    const outcome = await op.percolate({
      projectId: PROJECT,
      dependent: dependent("spec_b", { spec_a: "sha-old" }),
      decision: decision("spec_a", "sha-new"),
    });

    expect(outcome.result).toBe("replanned");
    expect(outcome.viaResolver).toBe(true);
    expect(outcome.reason).toBe("irreconcilable");
    // An unverified percolation NEVER records/merges.
    expect(recorded).toEqual([]);
  });
});

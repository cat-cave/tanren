// (autonomy-engine.md §2c): the UPSTREAM-CHANGE MODE of the P2b
// intent-preserving resolver. The SAME conflict Answerer + the SAME
// `decideConflictResolution` core are reused — only the PROMPT FRAMING differs:
// the ancestor's intentional change flows INTO the dependent while the dependent's
// work stays intact. Proves: the prompt reframes (upstream-change header + the
// ancestor/dependent labels + the change summary); the invoker threads it; and an
// `irreconcilable` answer in upstream-change mode routes the 'merging' side (= the
// dependent) back to the planner WITH the ancestor's change as context (NOT
// discarded, NOT merged). Fakes live HERE, never src/.

import { describe, expect, it } from "vitest";
import { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";
import {
  AnswererBackedConflictInvoker,
  buildConflictResolverPrompt,
} from "../src/engine/workflow/reviewMerge/conflictResolver/answerer.js";
import { decideConflictResolution } from "../src/engine/contracts/conflictResolution.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";

const dependentIntent = {
  specId: "spec_b",
  title: "Add analytics counter",
  description: "Count clicks per link.",
  acceptanceCriteria: ["increments on redirect"],
};
const ancestorIntent = {
  specId: "spec_a",
  title: "Storage layer",
  description: "Persist links.",
  acceptanceCriteria: ["links survive restart"],
};

describe("conflict resolver — upstream-change mode (§2c)", () => {
  it("the prompt reframes for an upstream change (header + ancestor/dependent labels + change summary)", () => {
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: dependentIntent,
      conflictingSpecIntent: ancestorIntent,
      dagEdge: true,
      conflictedFiles: [{ path: "src/store.ts", conflictedContent: "<<<<<<<\nx\n=======\ny\n>>>>>>>" }],
      upstreamChange: { ancestorSpecId: "spec_a", changeSummary: "reviewer reworked the storage schema" },
    });

    expect(prompt).toContain("UPSTREAM-CHANGE");
    expect(prompt).toContain("reviewer reworked the storage schema");
    expect(prompt).toContain("KEEPING THE DEPENDENT'S OWN WORK INTACT");
    // The dependent is labelled as the side to keep intact; the ancestor as the
    // source of the inbound change.
    expect(prompt).toContain("DEPENDENT spec");
    expect(prompt).toContain("ANCESTOR spec spec_a");
  });

  it("the default (symmetric) framing is used when there is no upstream change", () => {
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: dependentIntent,
      conflictingSpecIntent: ancestorIntent,
      dagEdge: false,
      conflictedFiles: [{ path: "src/store.ts", conflictedContent: "<<<<<<<\nx\n=======\ny\n>>>>>>>" }],
    });
    expect(prompt).not.toContain("UPSTREAM-CHANGE");
    expect(prompt).toContain("A merge conflict");
    expect(prompt).toContain("MERGING spec");
  });

  it("the invoker threads the upstream-change context into the answerer prompt", async () => {
    let seenPrompt = "";
    const adapter: AnswererAdapter<ConflictAnswer> = {
      async runAnswerer(opts) {
        seenPrompt = opts.prompt;
        return ConflictAnswer.parse({
          decision: "resolve",
          reasoning: "kept both",
          resolvedFiles: [{ path: "src/store.ts", content: "merged" }],
        });
      },
    };
    const invoker = new AnswererBackedConflictInvoker({ adapter, timeoutMs: 1000 });
    const answer = await invoker.resolve({
      mergingSpecIntent: dependentIntent,
      conflictingSpecIntent: ancestorIntent,
      dagEdge: true,
      conflictedFiles: [{ path: "src/store.ts", conflictedContent: "<<<<<<<\nx\n=======\ny\n>>>>>>>" }],
      upstreamChange: { ancestorSpecId: "spec_a", changeSummary: "new P1 finding patched upstream" },
    });
    expect(answer.decision).toBe("resolve");
    expect(seenPrompt).toContain("UPSTREAM-CHANGE");
    expect(seenPrompt).toContain("new P1 finding patched upstream");
  });

  it("an irreconcilable upstream-change answer routes the DEPENDENT (merging side) back to the planner WITH the ancestor's change", () => {
    // In upstream-change mode the 'merging' side IS the dependent (B); 'base' is
    // the ancestor (A). An irreconcilable answer keeps B alive by re-planning it
    // on top of A's change — never dropping B, never merging it unverified.
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "the dependent's API cannot coexist with the reworked storage",
      replanSpec: { which: "merging", newContext: "rebuild on the new storage schema from spec_a" },
    });
    const decision = decideConflictResolution(answer, { mergingSpecId: "spec_b", conflictingSpecId: "spec_a" });

    expect(decision.kind).toBe("irreconcilable");
    // The DEPENDENT (the 'merging' side in upstream-change mode) is re-planned ON
    // TOP OF the ancestor's change — work kept alive, never dropped or merged.
    const replan = decision.kind === "irreconcilable" ? decision.replan : undefined;
    expect(replan?.specId).toBe("spec_b");
    expect(replan?.otherSpecId).toBe("spec_a");
    expect(replan?.newContext).toContain("new storage schema");
  });
});

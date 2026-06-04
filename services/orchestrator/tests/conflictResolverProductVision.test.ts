// The PRODUCT-VISION enrichment of the intent-preserving conflict resolver: the
// resolver now frames a resolution against the product (personas / persona-
// behaviors / design-DNA) AND uses it to judge whether the two intents genuinely
// clash (the escalation discipline — a real persona-behavior contradiction is the
// legitimate `irreconcilable` product decision; a mechanical clash with compatible
// intents stays autonomously resolvable). All seams are fakes under tests/ — NO
// real LLM/runner/DB. Proves:
//
//   - the prompt builder RENDERS the product-vision section when present (personas
//     + the two specs' behaviors + design-DNA) and OMITS it cleanly when empty (a
//     real empty state, never a stub);
//   - the resolver THREADS the loaded vision into the answerer input;
//   - the resolver reads an EMPTY vision (no personas/behaviors) and omits it;
//   - CLASSIFICATION: a vision showing a genuine persona-behavior contradiction
//     reaches the answerer (which judges `irreconcilable` → the escalate/re-plan
//     path); compatible intents resolve (the autonomous path).

import { describe, expect, it } from "vitest";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { buildConflictResolverPrompt } from "../src/engine/workflow/reviewMerge/conflictResolver/answerer.js";
import { buildIntentPreservingConflictResolver } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import {
  isProductVisionEmpty,
  type ConflictAnswererInvoker,
  type ConflictProvenance,
  type ConflictProvenanceReader,
  type GatheredConflict,
  type ProductVision,
  type ProductVisionReader,
  type ReGateVerdict,
  type ReplanRouter,
  type ResolvedTreeReGate,
  type SpecIntent,
  type WorkspaceConflictApplier,
} from "../src/engine/contracts/conflictResolution.js";
import type { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";

const MERGING: SpecIntent = {
  specId: "spec_merging",
  title: "One-tap reorder",
  description: "A shopper re-orders their last basket in one tap",
  acceptanceCriteria: ["one tap re-orders the last basket"],
};
const BASE: SpecIntent = {
  specId: "spec_base",
  title: "Mandatory order review",
  description: "Every order passes a manual review step before placement",
  acceptanceCriteria: ["an order is placed only after a review step"],
};

const CONTEXT: ConflictContext = {
  runId: "run_1",
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  baseBranch: "main",
  message: "merge conflict in src/checkout.ts",
};

const conflictedFiles: GatheredConflict["files"] = [
  { path: "src/checkout.ts", conflictedContent: "<<<<<<< HEAD\noneTap\n=======\nreview\n>>>>>>> base\n" },
];

const RICH_VISION: ProductVision = {
  designDna: "Frictionless commerce — every step the shopper takes is one tap.",
  personas: [
    { name: "Shopper", description: "Buys fast, hates friction", surface: "handheld" },
    { name: "Compliance officer", description: "Must review high-value orders", surface: "ops dashboard" },
  ],
  behaviors: [
    {
      persona: "Shopper",
      title: "One-tap reorder",
      given: "a past basket",
      when: "the shopper taps reorder",
      thenOutcome: "the order is placed immediately with no further steps",
    },
    {
      persona: "Compliance officer",
      title: "Mandatory review",
      given: "a placed order",
      when: "it is submitted",
      thenOutcome: "it is held for a manual review before it is placed",
    },
  ],
};

function fakeProvenance(p: ConflictProvenance): ConflictProvenanceReader {
  return { read: async () => p };
}
function fakeVisionReader(vision: ProductVision): ProductVisionReader {
  return { read: async () => vision };
}
function fakeApplier(files: GatheredConflict["files"], log: string[]): WorkspaceConflictApplier {
  return {
    gather: async () => {
      log.push("gather");
      return { files };
    },
    applyResolution: async () => log.push("apply"),
    publishResolved: async () => log.push("publish"),
    abort: async () => log.push("abort"),
  };
}
function fakeAnswerer(
  answer: ConflictAnswer,
  captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] },
): ConflictAnswererInvoker {
  return {
    resolve: async (input) => {
      captured.input = input;
      return answer;
    },
  };
}
function fakeReGate(verdict: ReGateVerdict): ResolvedTreeReGate {
  return { reGate: async () => verdict };
}
function recordingReplan(): ReplanRouter & { calls: Array<{ specId: string }> } {
  const calls: Array<{ specId: string }> = [];
  return { calls, routeBackToPlanner: async (input) => void calls.push(input) };
}

describe("conflict resolver — product-vision prompt rendering", () => {
  it("renders the product-vision section when present (personas + both specs' behaviors + design-DNA)", () => {
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: MERGING,
      conflictingSpecIntent: BASE,
      dagEdge: true,
      conflictedFiles,
      productVision: RICH_VISION,
    });
    expect(prompt).toContain("Product vision the resolution must HONOR");
    expect(prompt).toContain("Design-DNA / identity: Frictionless commerce");
    expect(prompt).toContain("Shopper [surface: handheld]");
    expect(prompt).toContain("Compliance officer [surface: ops dashboard]");
    // Both specs' behaviors are present, attributed to their persona.
    expect(prompt).toContain("(Shopper) One-tap reorder");
    expect(prompt).toContain("(Compliance officer) Mandatory review");
    // It frames the genuine-clash judgement.
    expect(prompt).toContain("real PRODUCT-INTENT clash");
  });

  it("omits the product-vision section cleanly when the vision is empty (a real empty state, no stub)", () => {
    const emptyVision: ProductVision = { personas: [], behaviors: [] };
    expect(isProductVisionEmpty(emptyVision)).toBe(true);
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: MERGING,
      conflictingSpecIntent: BASE,
      dagEdge: true,
      conflictedFiles,
      productVision: emptyVision,
    });
    expect(prompt).not.toContain("Product vision the resolution must HONOR");
    // The pre-vision framing is intact.
    expect(prompt).toContain("MERGING spec");
  });

  it("omits the section when no vision is threaded at all", () => {
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: MERGING,
      conflictingSpecIntent: BASE,
      dagEdge: true,
      conflictedFiles,
    });
    expect(prompt).not.toContain("Product vision the resolution must HONOR");
  });
});

describe("conflict resolver — product-vision threading + classification", () => {
  it("threads the loaded product vision into the answerer input", async () => {
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: new FakeEventStore(),
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      productVision: fakeVisionReader(RICH_VISION),
      applier: fakeApplier(conflictedFiles, []),
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "kept both",
          resolvedFiles: [{ path: "src/checkout.ts", content: "resolved\n" }],
          replanSpec: null,
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan: recordingReplan(),
    });

    await resolver(CONTEXT);
    expect(captured.input?.productVision).toEqual(RICH_VISION);
  });

  it("omits the vision from the answerer input when the reader returns an empty product (no stub)", async () => {
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: new FakeEventStore(),
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      productVision: fakeVisionReader({ personas: [], behaviors: [] }),
      applier: fakeApplier(conflictedFiles, []),
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "kept both",
          resolvedFiles: [{ path: "src/checkout.ts", content: "resolved\n" }],
          replanSpec: null,
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan: recordingReplan(),
    });

    await resolver(CONTEXT);
    expect(captured.input?.productVision).toBeUndefined();
  });

  it("CLASSIFY: a genuine persona-behavior contradiction reaches the answerer → the irreconcilable/escalate path", async () => {
    // The vision shows a genuine product-intent clash (one-tap-immediate vs.
    // mandatory-review-before-placement). The answerer — handed that vision —
    // judges `irreconcilable`; the resolver routes ONE spec back (intent stays
    // alive) and returns { resolved: false } (the escalate/re-plan disposition).
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};
    const replan = recordingReplan();
    const events = new FakeEventStore();
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      productVision: fakeVisionReader(RICH_VISION),
      applier: fakeApplier(conflictedFiles, []),
      answerer: fakeAnswerer(
        {
          decision: "irreconcilable",
          reasoning: "the Shopper's one-tap-immediate behavior contradicts the Compliance officer's mandatory review",
          resolvedFiles: [],
          replanSpec: { which: "merging", newContext: "reconcile one-tap reorder with the mandatory review gate" },
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "unused" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(false);
    // The contradiction signal was the basis: the vision reached the answerer.
    expect(captured.input?.productVision?.behaviors).toHaveLength(2);
    // Intent stays alive (routed back, not dropped/merged).
    expect(replan.calls).toEqual([expect.objectContaining({ specId: "spec_merging" })]);
    expect(events.events.some((e) => e.eventType === "merge.conflict.irreconcilable")).toBe(true);
    expect(events.events.some((e) => e.eventType === "merge.conflict.resolved")).toBe(false);
  });

  it("CLASSIFY: compatible intents under the same vision RESOLVE autonomously (no escalation)", async () => {
    const replan = recordingReplan();
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: new FakeEventStore(),
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      productVision: fakeVisionReader(RICH_VISION),
      applier: fakeApplier(conflictedFiles, []),
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "the two changes touch different code paths; both behaviors stay true",
          resolvedFiles: [{ path: "src/checkout.ts", content: "oneTap + review\n" }],
          replanSpec: null,
        },
        {},
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan,
    });

    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(true);
    expect(replan.calls).toHaveLength(0);
  });
});

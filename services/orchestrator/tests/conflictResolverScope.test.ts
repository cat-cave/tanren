// apex pre-run §7.2 — the conflict-resolver scope bound:
//   - an EMPTY gather short-circuits BEFORE any model call (no whole-files-in token
//     spend on a clean re-rebase), and the resolver hook returns without inventing a
//     resolution;
//   - a LARGE conflicted file is HUNK-SCOPED in the prompt (only its conflict regions
//     + context go inline), while a small file is shown in FULL.
// All seams are fakes under tests/ — NO real LLM/runner/DB.

import { describe, expect, it } from "vitest";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import {
  AnswererBackedConflictInvoker,
  buildConflictResolverPrompt,
  renderConflictedFileForPrompt,
} from "../src/engine/workflow/reviewMerge/conflictResolver/answerer.js";
import { buildIntentPreservingConflictResolver } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import type {
  ConflictProvenance,
  ConflictProvenanceReader,
  GatheredConflict,
  SpecIntent,
  WorkspaceConflictApplier,
} from "../src/engine/contracts/conflictResolution.js";
import type { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";

const MERGING: SpecIntent = {
  specId: "spec_merging",
  title: "One-tap reorder",
  description: "A shopper re-orders their last basket in one tap",
  acceptanceCriteria: ["one tap re-orders the last basket"],
};

const CONTEXT: ConflictContext = {
  runId: "run_1",
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  baseBranch: "main",
  message: "merge conflict in src/checkout.ts",
};

function fakeProvenance(p: ConflictProvenance): ConflictProvenanceReader {
  return { read: async () => p };
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

// A counting AnswererAdapter — proves whether the model was invoked at all.
function countingAdapter(calls: { count: number }): AnswererAdapter<ConflictAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/fake",
    runAnswerer: async () => {
      calls.count += 1;
      return { decision: "resolve", reasoning: "resolved", resolvedFiles: [], replanSpec: null };
    },
  };
}

describe("conflict resolver — empty-gather short-circuit (§7.2)", () => {
  it("makes NO model call when the gather is empty (the invoker short-circuits)", async () => {
    const calls = { count: 0 };
    const invoker = new AnswererBackedConflictInvoker({ adapter: countingAdapter(calls), timeoutMs: 1000 });
    const answer = await invoker.resolve({
      mergingSpecIntent: MERGING,
      dagEdge: false,
      conflictedFiles: [],
    });
    expect(calls.count).toBe(0);
    expect(answer.resolvedFiles).toEqual([]);
    expect(answer.decision).toBe("resolve");
  });

  it("the resolver hook short-circuits an empty gather without invoking the answerer or applying", async () => {
    const log: string[] = [];
    const calls = { count: 0 };
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: new FakeEventStore(),
      provenance: fakeProvenance({ dagEdge: false }),
      applier: fakeApplier([], log),
      answerer: new AnswererBackedConflictInvoker({ adapter: countingAdapter(calls), timeoutMs: 1000 }),
      reGate: { reGate: async () => ({ passed: true }) },
      replan: {
        routeBackToPlanner: async (input) => ({
          kind: "owned",
          receipt: {
            kind: "planner_replan",
            specId: input.specId,
            run: { kind: "already_running", runId: "run_live" },
          },
        }),
      },
    });
    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved result");
    expect(result.recovery.kind).toBe("parking_required");
    // No model call; gathered then short-circuited — no apply/publish.
    expect(calls.count).toBe(0);
    expect(log).toEqual(["gather"]);
  });
});

describe("conflict resolver — hunk-scoping a large file (§7.2)", () => {
  it("renders a small conflicted file in FULL", () => {
    const small = { path: "a.ts", conflictedContent: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> base\n" };
    expect(renderConflictedFileForPrompt(small)).toBe(small.conflictedContent);
  });

  it("HUNK-SCOPES a large conflicted file (conflict region inline, bulk omitted)", () => {
    // 300 lines: a single conflict region in the middle, surrounded by inert bulk.
    const before = Array.from({ length: 140 }, (_, i) => `line-${i}`);
    const after = Array.from({ length: 140 }, (_, i) => `tail-${i}`);
    const conflictedContent = [...before, "<<<<<<< HEAD", "oneTap", "=======", "review", ">>>>>>> base", ...after].join(
      "\n",
    );
    const rendered = renderConflictedFileForPrompt({ path: "big.ts", conflictedContent });
    // The conflict region IS shown.
    expect(rendered).toContain("<<<<<<< HEAD");
    expect(rendered).toContain("oneTap");
    expect(rendered).toContain(">>>>>>> base");
    // It is HUNK-SCOPED, not the whole file: an omission marker is present and the
    // far-away bulk lines are dropped.
    expect(rendered).toContain("HUNK-SCOPED");
    expect(rendered).toContain("unchanged — read from workspace");
    expect(rendered).not.toContain("line-0");
    expect(rendered).not.toContain("tail-139");
    // The rendered scope is far smaller than the full file.
    expect(rendered.split("\n").length).toBeLessThan(conflictedContent.split("\n").length);
  });

  it("the prompt hunk-scopes a large file but shows a small one whole", () => {
    const bulk = Array.from({ length: 250 }, (_, i) => `keep-${i}`).join("\n");
    const big = { path: "big.ts", conflictedContent: `${bulk}\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> base` };
    const small = { path: "small.ts", conflictedContent: "<<<<<<< HEAD\nC\n=======\nD\n>>>>>>> base" };
    const prompt = buildConflictResolverPrompt({
      mergingSpecIntent: MERGING,
      dagEdge: false,
      conflictedFiles: [big, small],
    });
    // The large file is hunk-scoped (its far bulk omitted); the small file is whole.
    expect(prompt).toContain("HUNK-SCOPED");
    expect(prompt).not.toContain("keep-0");
    expect(prompt).toContain("\nC\n");
  });
});

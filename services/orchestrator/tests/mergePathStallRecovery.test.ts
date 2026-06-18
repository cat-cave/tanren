// MERGE / BASE-SHIFT path answerer-stall RECOVERY (v39 finding).
//
// The finding: at 9/11 on template-creation, spec_148a565e bricked when the
// CONFLICT-RESOLVER answerer (tanren.conflict_answer.v1) STALLED mid base-shift
// resolve. The transient stall propagated straight to the base-shift coordinator's
// catch → `base shift held at resolve: Answerer stalled (no sign of life) …` →
// merge.conflict → merge.dequeued {reason:"conflict"} — the spec was DEQUEUED on a
// NON-deterministic blip the next identical call would have resolved, never re-driven.
//
// Phase-2's loop-stage recovery (loopStageRecovery.ts) re-drives a transient
// `AnswererStalledError` in place and escalates LOUDLY only at a proven fixed point —
// but it wrapped ONLY the SPEC-LOOP stages. The merge-path answerer calls (the
// conflict-resolver + the simulated reviewer) were NOT wrapped. These prove the SAME
// recovery now guards the merge path:
//   - a transient conflict-resolver stall re-drives the resolve and succeeds (no brick);
//   - a repeatedly-stalling resolver escalates LOUDLY only at a real fixed point;
//   - a genuine `irreconcilable` answer is an ANSWER (not a stall) and is returned
//     unchanged for the existing conflict-handling to route;
//   - the simulated reviewer (the other merge-path model call) likewise re-drives a
//     transient stall.
// All seams are fakes under tests/ — NO real LLM/runner/DB.

import { describe, expect, it } from "vitest";
import { AnswererBackedConflictInvoker } from "../src/engine/workflow/reviewMerge/conflictResolver/answerer.js";
import { runSimulatedReviewer } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";
import { StageStallEscalationError } from "../src/engine/workflow/loopStageRecovery.js";
import { AnswererStalledError } from "../src/engine/providers/answererSchemaError.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { ConflictAnswer, ReviewAnswer } from "../src/engine/answerers/schemas/index.js";
import type { SpecIntent } from "../src/engine/contracts/conflictResolution.js";

const MERGING: SpecIntent = {
  specId: "spec_merging",
  title: "Mutation gate",
  description: "Add the mutation gate to the template",
  acceptanceCriteria: ["the mutation gate runs in CI"],
};

const CONFLICTED = [{ path: "src/router.ts", conflictedContent: "<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> base\n" }];

// A conflict adapter that throws `AnswererStalledError` (the typed TRANSIENT stall the
// real codex/claude adapters surface) for the first `stallTimes` calls, then returns
// the scripted answer. `Number.POSITIVE_INFINITY` = stalls on EVERY call (a wedge).
function stallingConflictAdapter(
  stallTimes: number,
  answer: ConflictAnswer,
  calls: { count: number },
): AnswererAdapter<ConflictAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/fake",
    runAnswerer: async (opts) => {
      calls.count += 1;
      if (calls.count <= stallTimes) throw new AnswererStalledError(opts.outputSchema.name);
      return opts.outputSchema.parse(answer);
    },
  };
}

function stallingReviewerAdapter(
  stallTimes: number,
  verdict: ReviewAnswer,
  calls: { count: number },
): AnswererAdapter<ReviewAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/fake",
    runAnswerer: async (opts) => {
      calls.count += 1;
      if (calls.count <= stallTimes) throw new AnswererStalledError(opts.outputSchema.name);
      return opts.outputSchema.parse(verdict);
    },
  };
}

describe("merge/base-shift path — conflict-resolver answerer stall recovery (v39 finding)", () => {
  it("RE-DRIVES a transient conflict-resolver stall and returns the resolution (no brick/dequeue)", async () => {
    const calls = { count: 0 };
    const resolved: ConflictAnswer = {
      decision: "resolve",
      reasoning: "kept both intents",
      resolvedFiles: [{ path: "src/router.ts", content: "merged" }],
      replanSpec: null,
    };
    const invoker = new AnswererBackedConflictInvoker({ adapter: stallingConflictAdapter(2, resolved, calls) });
    const answer = await invoker.resolve({ mergingSpecIntent: MERGING, dagEdge: false, conflictedFiles: CONFLICTED });
    // The resolve re-drove through both transient stalls IN PLACE and returned the real
    // answer — it did NOT propagate the stall up to a `base shift held at resolve` brick.
    expect(answer.decision).toBe("resolve");
    expect(answer.resolvedFiles).toEqual([{ path: "src/router.ts", content: "merged" }]);
    // Re-driven until success (NOT a fixed count): 2 stalls then the answer.
    expect(calls.count).toBe(3);
  });

  it("ESCALATES LOUDLY only at a real fixed point (the resolver stalls on EVERY re-drive)", async () => {
    const calls = { count: 0 };
    const invoker = new AnswererBackedConflictInvoker({
      // Stalls forever → the convergence detector proves a fixed point → escalate.
      adapter: stallingConflictAdapter(Number.POSITIVE_INFINITY, {} as ConflictAnswer, calls),
    });
    await expect(
      invoker.resolve({ mergingSpecIntent: MERGING, dagEdge: false, conflictedFiles: CONFLICTED }),
    ).rejects.toThrow(StageStallEscalationError);
    // It RE-DROVE first (>1 call) — the escalation is the proven fixed point, not the
    // first transient blip and not a hardcoded count.
    expect(calls.count).toBeGreaterThanOrEqual(2);
  });

  it("returns a genuine IRRECONCILABLE answer UNCHANGED (an answer, not a stall — routed by existing handling)", async () => {
    const calls = { count: 0 };
    const irreconcilable: ConflictAnswer = {
      decision: "irreconcilable",
      reasoning: "the two intents genuinely clash",
      resolvedFiles: [],
      replanSpec: { which: "merging", newContext: "the base spec rate-limits the route" },
    };
    const invoker = new AnswererBackedConflictInvoker({ adapter: stallingConflictAdapter(0, irreconcilable, calls) });
    const answer = await invoker.resolve({ mergingSpecIntent: MERGING, dagEdge: false, conflictedFiles: CONFLICTED });
    // An irreconcilable verdict is an ANSWER — returned verbatim (one call, no re-drive),
    // so the existing conflict-handling routes the replan. Recovery did NOT swallow it.
    expect(answer.decision).toBe("irreconcilable");
    expect(answer.replanSpec?.which).toBe("merging");
    expect(calls.count).toBe(1);
  });

  it("does NOT re-drive on the empty-files short-circuit (no model call to stall)", async () => {
    const calls = { count: 0 };
    const invoker = new AnswererBackedConflictInvoker({
      adapter: stallingConflictAdapter(Number.POSITIVE_INFINITY, {} as ConflictAnswer, calls),
    });
    const answer = await invoker.resolve({ mergingSpecIntent: MERGING, dagEdge: false, conflictedFiles: [] });
    expect(answer.decision).toBe("resolve");
    // The short-circuit never reaches the adapter — recovery wraps only the real call.
    expect(calls.count).toBe(0);
  });
});

describe("merge path — simulated reviewer answerer stall recovery (v39 finding)", () => {
  it("RE-DRIVES a transient reviewer stall and returns the verdict", async () => {
    const calls = { count: 0 };
    const result = await runSimulatedReviewer(
      stallingReviewerAdapter(2, { verdict: "approve", reasoning: "ok" }, calls),
      {
        context: { specTitle: "Add widget", specDescription: "x", acceptanceCriteria: ["renders"], prDiff: "diff" },
      },
    );
    expect(result.verdict.verdict).toBe("approve");
    expect(calls.count).toBe(3);
  });

  it("ESCALATES LOUDLY only at a real fixed point (the reviewer stalls on EVERY re-drive)", async () => {
    const calls = { count: 0 };
    await expect(
      runSimulatedReviewer(stallingReviewerAdapter(Number.POSITIVE_INFINITY, {} as ReviewAnswer, calls), {
        context: { specTitle: "Add widget", specDescription: "x", acceptanceCriteria: ["renders"], prDiff: "diff" },
      }),
    ).rejects.toThrow(StageStallEscalationError);
    expect(calls.count).toBeGreaterThanOrEqual(2);
  });
});

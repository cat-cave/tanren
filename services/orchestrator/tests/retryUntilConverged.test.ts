import { describe, expect, it } from "vitest";
import { type AttemptSignature, fixedPointRuleJudgment } from "../src/engine/workflow/convergenceDetector.js";
import { type AttemptOutcome, retryUntilConverged } from "../src/engine/workflow/retryUntilConverged.js";

// retryUntilConverged is the doctrine's progress-based replacement for attempt/poll caps
// (feedback_no_timeouts_progress_based): an UNBOUNDED loop that continues while making
// PROGRESS and escalates ONLY at a genuine, intelligently-detected fixed point. There is
// NO `K`, NO max, NO deadline. These tests prove: unbounded while progressing; escalates
// only at a proven fixed point; a shrinking magnitude trajectory (1000→500→100) never
// escalates no matter how many attempts.

// A judge that NEVER escalates — proves the loop is driven purely by structural progress.
const neverEscalate = () => ({ verdict: "keep_going" }) as const;
// The principled stand-in judge (the durable-loop default) — escalates at a proven fixed point.
const ruleJudge = (history: ReadonlyArray<AttemptSignature>) =>
  fixedPointRuleJudgment(history, () => "the same failure recurred with identical work; a human must decide");

describe("retryUntilConverged (progress-based, unbounded)", () => {
  it("returns done as soon as an attempt succeeds", async () => {
    let calls = 0;
    const outcome = await retryUntilConverged<string>({
      attempt: () => {
        calls += 1;
        return Promise.resolve({ result: "ok", signature: { failureSignature: "none" }, done: true });
      },
      judge: ruleJudge,
    });
    expect(outcome).toEqual({ kind: "done", result: "ok" });
    expect(calls).toBe(1);
  });

  it("runs UNBOUNDED while progressing (a changing failure signature) — far past any cap", async () => {
    // 200 attempts, each a DIFFERENT failure signature (always progress), succeeding only on
    // the 200th. No cap of any kind would let this complete; progress-based has no cap.
    let calls = 0;
    const outcome = await retryUntilConverged<number>({
      attempt: () => {
        calls += 1;
        const done = calls === 200;
        const result: AttemptOutcome<number> = {
          result: calls,
          signature: { failureSignature: `failure-${calls}` },
          done,
        };
        return Promise.resolve(result);
      },
      judge: neverEscalate,
    });
    expect(outcome).toEqual({ kind: "done", result: 200 });
    expect(calls).toBe(200);
  });

  it("NEVER escalates on a shrinking-magnitude trajectory (1000 → 500 → 100 → 1)", async () => {
    const trajectory = [1000, 500, 100, 1, 0];
    let i = 0;
    const outcome = await retryUntilConverged<number>({
      attempt: () => {
        const magnitude = trajectory[i] ?? 0;
        const done = magnitude === 0;
        i += 1;
        // SAME failure signature throughout — only the magnitude shrinks. The detector must
        // read every step as progress (a smaller magnitude), never a fixed point.
        return Promise.resolve({
          result: magnitude,
          signature: { failureSignature: "same-failure", magnitude },
          done,
        });
      },
      // Use the rule judge: if any step were wrongly flagged a fixed point, it would escalate.
      judge: ruleJudge,
    });
    expect(outcome).toEqual({ kind: "done", result: 0 });
  });

  it("escalates ONLY at a proven fixed point (identical failure + identical work repeated)", async () => {
    // Every attempt reproduces byte-identical observable work with the same failure — a
    // proven dead-end on the first repeat. The rule judge escalates with a human-actionable reason.
    const outcome = await retryUntilConverged<string>({
      attempt: () =>
        Promise.resolve({
          result: "stuck-output",
          signature: { failureSignature: "same-failure", workSignature: "same-head", magnitude: 5 },
          done: false,
        }),
      judge: ruleJudge,
    });
    expect(outcome).toEqual({
      kind: "escalate",
      reason: "the same failure recurred with identical work; a human must decide",
      result: "stuck-output",
    });
  });

  it("CONTINUES at a suspected fixed point when the judge says keep_going", async () => {
    // Identical work twice (a suspected fixed point), but the judge says keep going; the
    // third attempt then succeeds. The loop must not have escalated.
    let calls = 0;
    const outcome = await retryUntilConverged<string>({
      attempt: () => {
        calls += 1;
        if (calls < 3) {
          return Promise.resolve({
            result: "same",
            signature: { failureSignature: "f", workSignature: "w", magnitude: 5 },
            done: false,
          });
        }
        return Promise.resolve({ result: "fixed", signature: { failureSignature: "none" }, done: true });
      },
      judge: neverEscalate,
    });
    expect(outcome).toEqual({ kind: "done", result: "fixed" });
    expect(calls).toBe(3);
  });

  it("applies backoff SPACING between attempts without bounding the loop", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await retryUntilConverged<number>({
      attempt: () => {
        calls += 1;
        return Promise.resolve({
          result: calls,
          signature: { failureSignature: `f-${calls}` },
          done: calls === 3,
        });
      },
      judge: neverEscalate,
      backoff: (history) => {
        // SPACING is a cadence (here recorded, with a tiny real delay so the test stays fast).
        delays.push(history.length);
        return 1;
      },
    });
    expect(outcome).toEqual({ kind: "done", result: 3 });
    // backoff consulted after attempts 1 and 2 (not after the successful 3rd).
    expect(delays).toEqual([1, 2]);
  });
});

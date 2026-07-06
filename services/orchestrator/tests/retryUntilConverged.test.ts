import { describe, expect, it } from "vitest";
import { type AttemptSignature, fixedPointRuleJudgment } from "../src/engine/workflow/convergenceDetector.js";
import {
  type AttemptInfo,
  type AttemptOutcome,
  retryUntilConverged,
} from "../src/engine/workflow/retryUntilConverged.js";

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

// Codex critic #13: the loop's per-iteration observability gap. Prior to this fix an
// operator could not see WHICH retries were happening or how many, unless the caller
// separately logged — a silently-spinning stall-recovery loop was invisible. The optional
// `onAttempt` hook closes that gap while keeping the primitive's default silent (existing
// callers with NO `onAttempt` keep working unchanged — verified by the tests above, which
// omit `onAttempt` and still pass).
describe("retryUntilConverged onAttempt observability (Codex critic #13)", () => {
  it("fires onAttempt ONCE per iteration with the signature, decision, and 1-indexed attempt count", async () => {
    // Three iterations: progress → progress → done. The hook must fire on every one, in
    // order, with the same signature the attempt yielded and the decision the loop reached.
    const observed: AttemptInfo[] = [];
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
      onAttempt: (info) => {
        observed.push(info);
      },
    });
    expect(outcome).toEqual({ kind: "done", result: 3 });
    expect(observed).toHaveLength(3);
    expect(observed[0]).toEqual({
      attempt: 1,
      signature: { failureSignature: "f-1" },
      done: false,
      decision: "progress",
    });
    expect(observed[1]).toEqual({
      attempt: 2,
      signature: { failureSignature: "f-2" },
      done: false,
      decision: "progress",
    });
    expect(observed[2]).toEqual({
      attempt: 3,
      signature: { failureSignature: "f-3" },
      done: true,
      decision: "done",
    });
  });

  it("fires onAttempt with decision=escalate on the terminal fixed-point attempt", async () => {
    // Identical failure + identical work on every attempt: the second observation is the
    // proven fixed point (structural repeat), the rule judge escalates, the hook fires with
    // decision "escalate" — an operator watching the log sees WHEN the escalation happened.
    const observed: AttemptInfo[] = [];
    const outcome = await retryUntilConverged<string>({
      attempt: () =>
        Promise.resolve({
          result: "stuck",
          signature: { failureSignature: "same", workSignature: "w", magnitude: 5 },
          done: false,
        }),
      judge: ruleJudge,
      onAttempt: (info) => {
        observed.push(info);
      },
    });
    expect(outcome.kind).toBe("escalate");
    // First attempt: `first` structural read → progress; second attempt: proven fixed point → escalate.
    expect(observed).toHaveLength(2);
    expect(observed[0]?.decision).toBe("progress");
    expect(observed[1]?.decision).toBe("escalate");
    expect(observed[1]?.attempt).toBe(2);
  });

  it("BACKWARD COMPAT — omitting onAttempt keeps the primitive silent and functional", async () => {
    // Every existing caller relies on the loop working with NO observability hook. The
    // primitive must remain identical when the hook is absent (no throws, correct outcome).
    const outcome = await retryUntilConverged<string>({
      attempt: () => Promise.resolve({ result: "ok", signature: { failureSignature: "none" }, done: true }),
      judge: ruleJudge,
      // deliberately no onAttempt — same shape every legacy caller uses today.
    });
    expect(outcome).toEqual({ kind: "done", result: "ok" });
  });

  it("awaits an async onAttempt before starting the next iteration", async () => {
    // The primitive `await`s the hook so a caller can persist a durable event without
    // races (e.g. append `deploy.verify.retrying` before the next verify runs).
    const events: string[] = [];
    let calls = 0;
    await retryUntilConverged<number>({
      attempt: () => {
        events.push(`attempt-${calls + 1}-body`);
        calls += 1;
        return Promise.resolve({
          result: calls,
          signature: { failureSignature: `f-${calls}` },
          done: calls === 2,
        });
      },
      judge: neverEscalate,
      onAttempt: async (info) => {
        // A microtask hop before recording — proves the loop `await`s the hook.
        await Promise.resolve();
        events.push(`onAttempt-${info.attempt}`);
      },
    });
    // Strict interleaving: attempt-1-body → onAttempt-1 → attempt-2-body → onAttempt-2.
    expect(events).toEqual(["attempt-1-body", "onAttempt-1", "attempt-2-body", "onAttempt-2"]);
  });
});

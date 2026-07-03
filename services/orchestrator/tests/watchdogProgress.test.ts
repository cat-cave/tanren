import { describe, expect, it } from "vitest";
import {
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT,
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
  WORK_SIGNATURE_WINDOW,
  appendWorkSignature,
  distinctRecentOutput,
  isWedgedNonAdvancing,
  workSignature,
} from "../src/engine/ssh/watchdogProgress.js";

// The watchdog WORK-SIGNATURE progress backstop (feedback_no_timeouts_progress_based, BINDING):
// the ActivityWatchdog's liveness signal correctly never kills working work, but on its own
// cannot tell an ALIVE-AND-ADVANCING process from an ALIVE-BUT-WEDGED one (an infinite loop
// spewing byte-identical output, a CPU-burn touching nothing). This layer feeds the SEQUENCE of
// work signatures (output tail folded with the workspace signature) into the shared convergence
// detector: a CHANGING signature = progress (continue UNBOUNDED), a FIXED POINT = a wedge
// (surface a stall). The trigger is signature IDENTITY, never elapsed time.

describe("workSignature — folds the output tail with the workspace signature", () => {
  it("is STABLE for identical inputs and DISTINCT when either axis changes", () => {
    expect(workSignature("out", "ws:1")).toBe(workSignature("out", "ws:1"));
    // New output content → a different signature (a streaming process advancing).
    expect(workSignature("out-a", "ws:1")).not.toBe(workSignature("out-b", "ws:1"));
    // Advancing workspace → a different signature (a silent build writing files).
    expect(workSignature("out", "ws:1")).not.toBe(workSignature("out", "ws:2"));
  });

  it("an UNREACHABLE workspace (undefined) is a fixed sentinel — new output alone still advances", () => {
    // Two unreachable reads with the SAME output collapse to the SAME signature (the
    // dead/zombied case: no new work). But NEW output with an unreachable workspace still
    // advances the signature (a streaming process whose probe momentarily can't reach).
    const unreachable: string | undefined = undefined;
    expect(workSignature("same", unreachable)).toBe(workSignature("same", unreachable));
    expect(workSignature("a", unreachable)).not.toBe(workSignature("b", unreachable));
  });
});

describe("distinctRecentOutput — RATE-INDEPENDENT new-distinct-work over the output increment", () => {
  it("fingerprints only the increment since priorLen and reports the new length", () => {
    const out = distinctRecentOutput("aaa\nbbb", 4);
    expect(out.content).toBe("bbb");
    expect(out.length).toBe(7);
  });

  it("DEDUPS repeated lines so the rate of repetition does not matter (the wedge case)", () => {
    // The SAME line 1 time and 1000 times collapse to the SAME distinct content.
    const once = distinctRecentOutput("Retrying...\n", 0).content;
    const flood = distinctRecentOutput("Retrying...\n".repeat(1000), 0).content;
    expect(once).toBe(flood);
  });

  it("a NEW distinct line changes the content (genuine forward motion)", () => {
    expect(distinctRecentOutput("a\nb\n", 0).content).not.toBe(distinctRecentOutput("a\nc\n", 0).content);
  });

  it("no new output (priorLen at end) yields empty content — relies on the workspace signal", () => {
    expect(distinctRecentOutput("done", 4).content).toBe("");
  });
});

describe("appendWorkSignature — bounded trailing history (a cycle window, NOT an attempt cap)", () => {
  it("clamps to WORK_SIGNATURE_WINDOW, keeping the most recent signatures", () => {
    let history: string[] = [];
    for (let i = 0; i < WORK_SIGNATURE_WINDOW + 5; i += 1) {
      history = appendWorkSignature(history, `s${i}`);
    }
    expect(history.length).toBe(WORK_SIGNATURE_WINDOW);
    expect(history.at(-1)).toBe(`s${WORK_SIGNATURE_WINDOW + 4}`);
  });
});

describe("isWedgedNonAdvancing — the progress verdict over the work-signature sequence", () => {
  it("a single snapshot is NEVER wedged (nothing to compare → continue)", () => {
    expect(isWedgedNonAdvancing([])).toBe(false);
    expect(isWedgedNonAdvancing(["s1"])).toBe(false);
  });

  it("a streaming process emitting genuinely-NEW output is NEVER wedged (the common case)", () => {
    const history: string[] = [];
    let h: string[] = history;
    // 200 ticks of distinct, advancing work signatures — never flagged regardless of length.
    for (let i = 0; i < 200; i += 1) {
      h = appendWorkSignature(h, workSignature(`token-${i}`, "ws:flat"));
      expect(isWedgedNonAdvancing(h)).toBe(false);
    }
  });

  it("a process advancing the WORKSPACE (mtime climbing) with no output is NEVER wedged", () => {
    let h: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      // No output (constant empty tail), but the workspace mtime climbs each tick → advancing.
      h = appendWorkSignature(h, workSignature("", `ws:${1000 + i}`));
      expect(isWedgedNonAdvancing(h)).toBe(false);
    }
  });

  it("a WEDGED-BUT-BUSY process — BYTE-IDENTICAL output forever, workspace flat — SURFACES a wedge", () => {
    let h: string[] = [];
    // The same output line + the same workspace signature each tick = no NEW distinct work.
    h = appendWorkSignature(h, workSignature("Retrying...\n", "ws:1000"));
    // First snapshot: nothing to compare yet.
    expect(isWedgedNonAdvancing(h)).toBe(false);
    h = appendWorkSignature(h, workSignature("Retrying...\n", "ws:1000"));
    // A single identical-neighbor pair (streak=1) is BELOW the MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS
    // floor (apex v50): a `pnpm install` mid-IO-burst can legitimately read identical
    // signature across one 15s tick. The watchdog requires the streak to reach the floor
    // before firing — still progress/sign-of-life, just an honest floor for tool-invoking execs.
    expect(isWedgedNonAdvancing(h)).toBe(false);
    // Now the trailing identical-neighbor streak has grown to MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS
    // consecutive identical pairs (≈30s of signature identity) — proven non-advancing.
    for (let i = 0; i < MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS - 1; i += 1) {
      h = appendWorkSignature(h, workSignature("Retrying...\n", "ws:1000"));
    }
    expect(isWedgedNonAdvancing(h)).toBe(true);
  });

  it("a genuinely-DEAD process — no output, workspace unreachable — SURFACES a wedge once the streak floor is reached", () => {
    const unreachable: string | undefined = undefined;
    let h: string[] = [];
    h = appendWorkSignature(h, workSignature("", unreachable));
    h = appendWorkSignature(h, workSignature("", unreachable));
    // 1 identical-neighbor pair (streak=1) — below the floor; the substrate keeps polling.
    expect(isWedgedNonAdvancing(h)).toBe(false);
    // Append until the trailing identical-neighbor streak reaches the floor.
    for (let i = 0; i < MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS - 1; i += 1) {
      h = appendWorkSignature(h, workSignature("", unreachable));
    }
    expect(isWedgedNonAdvancing(h)).toBe(true);
  });

  it("advancement RESETS forever: any new distinct work after a stuck stretch is progress again", () => {
    let h: string[] = [];
    // Build a stuck stretch long enough to fire the watchdog.
    for (let i = 0; i < MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 1; i += 1) {
      h = appendWorkSignature(h, workSignature("same\n", "ws:1"));
    }
    expect(isWedgedNonAdvancing(h)).toBe(true);
    // Then the process produces NEW output → advancing again → not wedged.
    h = appendWorkSignature(h, workSignature("NEW LINE\n", "ws:1"));
    expect(isWedgedNonAdvancing(h)).toBe(false);
  });

  it("the STREAK FLOOR (apex v50): a SINGLE identical-neighbor pair is NEVER yet a wedge", () => {
    // The apex-v50 disguised survivor: a 1-neighbor floor killed legitimate writers running
    // `pnpm install` whose stdout was silent (captured BY codex) while the workspace probe
    // momentarily read identical count+bytes across a single 15s tick mid-IO-burst.
    let h: string[] = [];
    h = appendWorkSignature(h, workSignature("step 1\n", "ws:flat"));
    h = appendWorkSignature(h, workSignature("step 1\n", "ws:flat"));
    expect(isWedgedNonAdvancing(h)).toBe(false);
    // 2 consecutive identical-neighbor pairs (3 identical signatures in a row) IS a wedge.
    h = appendWorkSignature(h, workSignature("step 1\n", "ws:flat"));
    expect(isWedgedNonAdvancing(h)).toBe(true);
  });

  it("the STREAK FLOOR is met by EXACTLY MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS consecutive identical pairs", () => {
    // Build the history one signature at a time and verify the watchdog only fires once the
    // trailing identical-neighbor streak reaches the floor.
    let h: string[] = [];
    h = appendWorkSignature(h, workSignature("x", "ws:1"));
    for (let pairs = 1; pairs <= MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 2; pairs += 1) {
      h = appendWorkSignature(h, workSignature("x", "ws:1"));
      const expectedWedged = pairs >= MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS;
      expect(isWedgedNonAdvancing(h)).toBe(expectedWedged);
    }
  });
});

// A small deterministic PRNG so the properties are reproducible in CI (no flake).
function makeRng(seed: number): () => number {
  let state = Math.trunc(seed);
  return () => {
    state = Math.trunc(state * 1_664_525 + 1_013_904_223) % 0x100_000_000;
    return Math.abs(state) / 0x100_000_000;
  };
}

describe("class-specific streak floor: agent vs vcs (apex v76/v77)", () => {
  // The named constants document the empirical basis in-source (see watchdogProgress.ts).
  // The apex v77 evidence: writer.subtask.failed at ~60% rate on tiny 350-char subtasks
  // because Codex CLI is a burst-stream (~9k bytes streamed, then 30-60s silent generation,
  // then more) and the 2-neighbor floor false-fired wedges mid-generation. The 5-neighbor
  // floor (~75s of signature identity at the 15s probe cadence) tolerates the cycle with margin.
  it("the vcs floor stays at 2 (the historic `pnpm install` case is unchanged)", () => {
    expect(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS).toBe(2);
  });

  it("the agent floor is 5 (Codex think-then-stream burst pattern from apex v77)", () => {
    expect(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT).toBe(5);
    // The agent floor MUST be strictly greater than the vcs floor — that is the whole point.
    expect(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT).toBeGreaterThan(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS);
  });

  it("with the DEFAULT (vcs) floor, 3 identical signatures wedge (current behavior preserved)", () => {
    // The historic vcs semantics: 2 identical-neighbor pairs (3 identical signatures) → wedge.
    // Kept as the default so existing call sites (and the tickWatchdog fallback) keep the
    // exact behavior on file today.
    const sig = workSignature("Retrying...\n", "ws:1000");
    // 2 identical (streak=1) is BELOW the vcs floor.
    expect(isWedgedNonAdvancing([sig, sig])).toBe(false);
    // 3 identical (streak=2) MEETS the vcs floor → wedge.
    expect(isWedgedNonAdvancing([sig, sig, sig])).toBe(true);
  });

  it("with the AGENT floor, 2 identical is NOT wedged (Codex silent-generation window)", () => {
    // The Codex burst pattern: after a chunk streams, the agent goes silent for 30-60s to
    // generate the next chunk. At the 15s probe cadence, that is 2-4 identical work signatures
    // in a row before more output arrives. The 2-neighbor vcs floor false-positive-wedges
    // this legitimately-alive-and-generating agent. The 5-neighbor agent floor tolerates it.
    const sig = workSignature("stream-then-silent\n", "ws:flat");
    expect(isWedgedNonAdvancing([sig, sig], { minNonAdvancingRepeats: MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT })).toBe(
      false,
    );
  });

  it("with the AGENT floor, 3-5 identical signatures are STILL not yet wedged (below the 5-pair streak)", () => {
    // A slow Codex turn spanning 45-75s of silent generation (streak of 2-4 identical pairs).
    // Still legitimately alive — the widened floor tolerates the full burst-stream cycle.
    const sig = workSignature("still-generating\n", "ws:flat");
    for (let identicalCount = 2; identicalCount <= 5; identicalCount += 1) {
      const history = Array.from({ length: identicalCount }, () => sig);
      expect(isWedgedNonAdvancing(history, { minNonAdvancingRepeats: MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT })).toBe(
        false,
      );
    }
  });

  it("with the AGENT floor, the streak reaching MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT pairs DOES wedge", () => {
    // Once the identical-neighbor streak reaches 5 pairs (6 identical signatures, ~75s), the
    // agent is provably wedged even under the widened floor. The floor is a STREAK ceiling,
    // not a duration — an actually-dead agent still surfaces.
    const sig = workSignature("wedged-forever\n", "ws:flat");
    const history = Array.from({ length: MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT + 1 }, () => sig);
    expect(isWedgedNonAdvancing(history, { minNonAdvancingRepeats: MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT })).toBe(
      true,
    );
  });

  it("with the AGENT floor, a genuinely-advancing signature NEVER wedges regardless of length", () => {
    // The whole doctrine: a working agent runs UNBOUNDED. Even under the widened floor, a
    // stream of distinct work signatures is always progress.
    let h: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      h = appendWorkSignature(h, workSignature(`token-${i}`, "ws:flat"));
      expect(isWedgedNonAdvancing(h, { minNonAdvancingRepeats: MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT })).toBe(false);
    }
  });
});

describe("PROPERTY: progress => never wedged; a fixed point => wedged (signature identity, not time)", () => {
  it("ANY sequence of strictly-advancing work signatures is NEVER wedged, regardless of length", () => {
    const rng = makeRng(12_345);
    for (let trial = 0; trial < 500; trial += 1) {
      const len = 2 + Math.floor(rng() * 30);
      let h: string[] = [];
      for (let i = 0; i < len; i += 1) {
        // Every tick has genuinely-new output content: a distinct, advancing signature.
        h = appendWorkSignature(h, workSignature(`work-${trial}-${i}-${rng()}`, `ws:${i}`));
      }
      expect(isWedgedNonAdvancing(h)).toBe(false);
    }
  });

  it("ANY sequence ending in the SAME repeated signature with no advance since SURFACES a wedge once the floor is met", () => {
    const rng = makeRng(98_765);
    for (let trial = 0; trial < 500; trial += 1) {
      // Some genuine progress first, then a wedge.
      const lead = Math.floor(rng() * 5);
      let h: string[] = [];
      for (let i = 0; i < lead; i += 1) {
        h = appendWorkSignature(h, workSignature(`lead-${trial}-${i}`, `ws:${i}`));
      }
      // Then the SAME byte-identical signature enough times that the trailing identical-
      // neighbor streak reaches MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS — a wedge sets in.
      const stuck = workSignature(`stuck-${trial}`, "ws:stuck");
      for (let i = 0; i < MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 1; i += 1) {
        h = appendWorkSignature(h, stuck);
      }
      expect(isWedgedNonAdvancing(h)).toBe(true);
    }
  });
});

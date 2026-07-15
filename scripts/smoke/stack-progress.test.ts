import { describe, expect, it } from "vitest";
import { progressCycleReached, waitWhileProgressing } from "./stack-progress.js";

describe("structural progress convergence", () => {
  it("detects both fixed points and alternating cycles without a poll budget", () => {
    expect(progressCycleReached(["queued"])).toBe(false);
    expect(progressCycleReached(["queued", "queued"])).toBe(true);
    expect(progressCycleReached(["queued", "claimed", "queued"])).toBe(true);
    expect(progressCycleReached(["queued", "claimed", "running"])).toBe(false);
  });

  it("waits through repeated identical advancing observations without mistaking them for a cycle", async () => {
    // The boot receipt shape: a service reports the same not-ready signature on
    // every poll while it is still starting. Two (or more) identical observations
    // are waiting, not an oscillation, so the wait must continue until ready.
    const states = ["boot", "boot", "boot"];
    const result = await waitWhileProgressing({
      probe: async () => states.shift() ?? "ready",
      classify: (signature) =>
        signature === "ready" ? { kind: "ready", value: signature } : { kind: "advancing", signature },
      sleep: async () => {},
    });
    expect(result).toBe("ready");
  });

  it("holds a constant-space chain across a large identical-observation run then reaches ready", async () => {
    // A boot/stabilization wait can observe the SAME not-ready signature for an
    // unbounded number of polls. The wait must terminate at ready without growing
    // the transition chain per poll: the implementation visibly appends only on a
    // signature change, so N identical observations must not be pushed (which would
    // also make each poll's cycle check O(N) over the growing history). We assert
    // completion + exact poll count — no internals exposed, no wall-clock timeout
    // used to inspect history length.
    const identicalPolls = 5_000;
    let polls = 0;
    const result = await waitWhileProgressing({
      probe: async () => {
        polls += 1;
        return polls <= identicalPolls ? "boot" : "ready";
      },
      classify: (signature) =>
        signature === "ready" ? { kind: "ready", value: signature } : { kind: "advancing", signature },
      sleep: async () => {},
    });
    expect(result).toBe("ready");
    // One poll per identical observation, then one ready poll — no retries.
    expect(polls).toBe(identicalPolls + 1);
  });

  it("still throws on a true nonconsecutive oscillation (A,B,A)", async () => {
    const states = ["queued", "claimed", "running", "claimed"];
    await expect(
      waitWhileProgressing({
        probe: async () => states.shift() ?? "claimed",
        classify: (signature) => ({ kind: "advancing", signature }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/progress cycle/u);
  });

  it("terminates a permanent fixed point through the operator AbortSignal, not a wall-clock timeout", async () => {
    const controller = new AbortController();
    let polls = 0;
    await expect(
      waitWhileProgressing({
        signal: controller.signal,
        probe: async () => "stuck",
        classify: (signature) => ({ kind: "advancing", signature }),
        sleep: async () => {
          polls += 1;
          if (polls >= 3) controller.abort(new Error("operator fence"));
        },
      }),
    ).rejects.toThrow(/operator fence/u);
  });
});

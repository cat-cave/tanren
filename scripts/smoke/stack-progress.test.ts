import { describe, expect, it } from "vitest";
import { progressCycleReached, waitWhileProgressing } from "./stack-progress.js";

describe("structural progress convergence", () => {
  it("detects both fixed points and alternating cycles without a poll budget", () => {
    expect(progressCycleReached(["queued"])).toBe(false);
    expect(progressCycleReached(["queued", "queued"])).toBe(true);
    expect(progressCycleReached(["queued", "claimed", "queued"])).toBe(true);
    expect(progressCycleReached(["queued", "claimed", "running"])).toBe(false);
  });

  it("continues through unique progress and terminates on a repeated state", async () => {
    const states = ["queued", "claimed", "running", "claimed"];
    await expect(
      waitWhileProgressing({
        probe: async () => states.shift() ?? "claimed",
        classify: (signature) => ({ kind: "advancing", signature }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/progress cycle/u);
  });
});

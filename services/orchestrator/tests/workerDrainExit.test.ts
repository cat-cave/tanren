// H10 hardening: the worker shutdown drain is FAIL-CLOSED. `drainWorkerAndExit`
// exits 0 ONLY when both stops resolved cleanly; if either `stop()` REJECTED (a
// wedged drain), it exits NON-ZERO so the supervisor restarts the worker rather
// than treating a failed drain as a clean shutdown. Each test asserts the observable
// OUTCOME — the captured exit code — not merely how the exit fn was invoked.
import { describe, expect, it } from "vitest";
import { drainWorkerAndExit } from "../src/engine/worker/lifecycle.js";

/** Capture the exit code the drain decides (the observable outcome). */
function captureExit(): { exit: (code: number) => void; codes: number[] } {
  const codes: number[] = [];
  return { exit: (code: number) => codes.push(code), codes };
}

describe("drainWorkerAndExit — fail-closed exit code", () => {
  it("exits 0 when both worker.stop() and reaper.stop() resolve", async () => {
    const { exit, codes } = captureExit();
    await drainWorkerAndExit({ stop: async () => {} }, { stop: async () => {} }, exit);
    expect(codes).toEqual([0]);
  });

  it("exits NON-ZERO when worker.stop() rejects", async () => {
    const { exit, codes } = captureExit();
    await drainWorkerAndExit(
      {
        stop: async () => {
          throw new Error("worker drain wedged");
        },
      },
      { stop: async () => {} },
      exit,
    );
    expect(codes).toEqual([1]);
  });

  it("exits NON-ZERO when reaper.stop() rejects", async () => {
    const { exit, codes } = captureExit();
    await drainWorkerAndExit(
      { stop: async () => {} },
      {
        stop: async () => {
          throw new Error("reaper drain wedged");
        },
      },
      exit,
    );
    expect(codes).toEqual([1]);
  });
});

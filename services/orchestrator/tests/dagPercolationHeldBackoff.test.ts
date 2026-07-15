// Part B PROOF (apex-v35 false-escalation fix): the base-shift / percolation HELD re-drive
// must be SPACED per spec so a TRANSIENT infra hold cannot re-fail many times per second
// and burn the consecutive-same-failure cap (K=4) into a FALSE `persistent_failure`.
//
// The live repro: 388 `dag.spec.percolating` notifications fired in seconds, so a HELD
// dependent re-failed ~4× in ~3s. With the per-spec backoff a held spec is NOT re-driven
// until its backoff window elapses — but a GENUINELY persistent hold still re-drives once
// spaced (it never gives up), so the K-cap counts spaced retries over time, not a hot-loop.
//
// Driven through TEST FIXTURES (a clock-injected HeldReDriveBackoff + a kick-off that
// throws BaseShiftHeldError), so the spacing is asserted deterministically with no DB.

import { describe, expect, it } from "vitest";
import type {
  AncestorChangeSignal,
  PercolationEventEmitter,
  PercolationKickOff,
  PercolationReadModel,
  PercolationSettler,
  SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { BaseShiftHeldError } from "../src/engine/dag/baseShiftCoordinator.js";
import { HeldReDriveBackoff } from "../src/engine/dag/heldReDriveBackoff.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_backoff";

function dependent(): SpeculativeDependent {
  return {
    specId: "spec_b",
    runId: "run_b",
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

const readModel: PercolationReadModel = {
  async loadSpeculativeDependents(): Promise<SpeculativeDependent[]> {
    return [dependent()];
  },
  async loadAncestorSignals(): Promise<AncestorChangeSignal[]> {
    return [{ ancestorSpecId: "spec_a", verifiedSha: "sha-old", currentSha: "sha-new", openFindingMaxSeverity: "P0" }];
  },
};

const noopEmitter: PercolationEventEmitter = {
  async emitPercolating(): Promise<void> {},
  async emitPercolated(): Promise<void> {},
  async emitPercolationDeferred(): Promise<void> {},
  async emitPercolationReplan(): Promise<void> {},
};

const noopSettler: PercolationSettler = {
  async absorb() {
    return { result: "absorbed" };
  },
  async replan() {
    return { result: "replanned", reexecRunId: "run_replan" };
  },
};

describe("percolation HELD re-drive is spaced by a per-spec backoff (apex-v35 Part B)", () => {
  it("two HELD passes within the backoff window do NOT both re-drive the kick-off", async () => {
    let clock = 1_000;
    const backoff = new HeldReDriveBackoff(() => clock);
    let kickOffCalls = 0;
    const kickOff: PercolationKickOff = {
      async kickOff(): Promise<never> {
        kickOffCalls += 1;
        throw new BaseShiftHeldError("rebase", "static runner host key discovery failed: read ECONNRESET");
      },
    };
    const coord = new PercolatingCoordinator({
      readModel,
      kickOff,
      settler: noopSettler,
      events: noopEmitter,
      heldBackoff: backoff,
    });

    // Pass 1: the kick-off runs and HOLDS (records the backoff window).
    const first = await coord.percolate(PROJECT);
    expect(first.held).toEqual(["spec_b"]);
    expect(kickOffCalls).toBe(1);

    // Pass 2 immediately after (the rapid 388-notification storm): still held, but the
    // kick-off is SKIPPED — it did not re-fire within the backoff window (a few ms later,
    // well inside the first 3s backoff).
    clock += 5;
    const second = await coord.percolate(PROJECT);
    expect(second.held).toEqual(["spec_b"]);
    // NOT re-driven — the re-drive was spaced.
    expect(kickOffCalls).toBe(1);

    // Pass 3 after the window elapses (past the first 3s backoff): now re-drive-eligible,
    // the kick-off re-fires.
    clock += 4_000;
    const third = await coord.percolate(PROJECT);
    expect(third.held).toEqual(["spec_b"]);
    // Re-driven once spaced — it never gives up.
    expect(kickOffCalls).toBe(2);
  });

  it("genuine spaced repeats still re-drive (the K-cap counts spaced retries, never a hot-loop)", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    let kickOffCalls = 0;
    const kickOff: PercolationKickOff = {
      async kickOff(): Promise<never> {
        kickOffCalls += 1;
        throw new BaseShiftHeldError("rebase", "a genuinely persistent infra hold");
      },
    };
    const coord = new PercolatingCoordinator({
      readModel,
      kickOff,
      settler: noopSettler,
      events: noopEmitter,
      heldBackoff: backoff,
    });

    // Drive the storm: a notification every 100ms for 10s. Without the backoff this would
    // re-fire the kick-off ~100 times (the hot-loop that burned the K-cap in ~3s); WITH it
    // the re-drives are SPACED on the 3s → 10s → 30s → 60s curve.
    for (let t = 0; t < 10_000; t += 100) {
      clock = t;
      await coord.percolate(PROJECT);
    }

    // Over 10s the spaced curve allows only a handful of genuine re-drives (the first at
    // t=0, then ~3s, ~13s... so 2 within the window) — NOT ~100. It still re-drives (never
    // gives up); the K-cap now reflects genuine repeated failures over time.
    expect(kickOffCalls).toBeGreaterThanOrEqual(1);
    expect(kickOffCalls).toBeLessThan(5);
  });

  it("a recovered spec clears its backoff: a later re-detect kicks off immediately", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    let held = true;
    let kickOffCalls = 0;
    const kickOff: PercolationKickOff = {
      async kickOff(): Promise<{ result: "reexecuting"; ancestorSpecId: string; reexecRunId: string }> {
        kickOffCalls += 1;
        if (held) {
          throw new BaseShiftHeldError("rebase", "transient hold");
        }
        return { result: "reexecuting", ancestorSpecId: "spec_a", reexecRunId: "run_b" };
      },
    };
    const coord = new PercolatingCoordinator({
      readModel,
      kickOff,
      settler: noopSettler,
      events: noopEmitter,
      heldBackoff: backoff,
    });

    // Pass 1: held (records backoff).
    await coord.percolate(PROJECT);
    expect(kickOffCalls).toBe(1);
    expect(backoff.shouldSkip("spec_b")).toBe(true);

    // The transient clears; once the window elapses the kick-off re-execs and CLEARS the
    // backoff so a later genuine hold gets the full curve, not a stale long delay.
    held = false;
    clock += 4_000;
    const result = await coord.percolate(PROJECT);
    expect(result.reexecuting).toEqual(["spec_b"]);
    expect(kickOffCalls).toBe(2);
    // The backoff was cleared on the successful re-exec.
    expect(backoff.shouldSkip("spec_b")).toBe(false);
  });
});

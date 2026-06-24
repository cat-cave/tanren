// Unit tests for the convergence-based readiness primitive (task #31).
// PURE in-memory exercises — the cloud-specific harnesses (`describeReadinessConvergence`)
// re-validate the per-allocator wiring in `tests/conformance/readinessConvergenceConformance.ts`.

import { describe, expect, it } from "vitest";
import {
  pollUntilReady,
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  STABLE_CADENCE_FLOOR,
  type ReadinessClassification,
} from "../src/engine/allocators/readinessConvergence.js";

interface FakeObservation {
  status: string;
  ip?: string;
}

function classify(observation: FakeObservation): ReadinessClassification<FakeObservation> {
  if (observation.status === "running" && observation.ip !== undefined && observation.ip !== "") {
    return { kind: "ready", observation };
  }
  if (observation.status === "terminated") {
    return { kind: "terminal_error", reason: "provider terminated the resource" };
  }
  if (observation.status === "pending" || observation.status === "running") {
    return { kind: "advancing", observation };
  }
  return { kind: "unknown_state", state: observation.status };
}

function signature(observation: FakeObservation): string {
  return `${observation.status}|${observation.ip !== undefined && observation.ip !== "" ? "ip" : "no-ip"}`;
}

// Used by the "loops UNBOUNDED while the structural signature keeps ADVANCING"
// test, which threads an `intermediate-*` IP token through every probe. Defined
// at module scope (the eslint `consistent-function-scoping` rule flags closures
// that don't capture parent scope when they could live at the top level).
function classifyAdvancingForReadinessTest(o: FakeObservation): ReadinessClassification<FakeObservation> {
  if (o.status === "running" && o.ip !== undefined && !o.ip.startsWith("intermediate-")) {
    return { kind: "ready", observation: o };
  }
  return { kind: "advancing", observation: o };
}
function signatureForReadinessTest(o: FakeObservation): string {
  return `${o.status}|${o.ip ?? "no-ip"}`;
}

const noSleep = async (): Promise<void> => undefined;

describe("pollUntilReady", () => {
  it("returns the ready observation once classify yields `ready`", async () => {
    const observations: FakeObservation[] = [
      { status: "pending" },
      { status: "running", ip: undefined },
      { status: "running", ip: "203.0.113.10" },
    ];
    let i = 0;
    const ready = await pollUntilReady(async () => observations[i++]!, {
      classify,
      signature,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(ready).toEqual({ status: "running", ip: "203.0.113.10" });
  });

  it("loops UNBOUNDED while the structural signature keeps ADVANCING (50+ changing probes)", async () => {
    // 60 distinct advancing probes — each signature differs (pending|no-ip, then
    // running|no-ip cycles), then a ready hit at the end. The loop must NOT escalate.
    const advancing: FakeObservation[] = [];
    for (let i = 0; i < 60; i += 1) {
      advancing.push({ status: i % 2 === 0 ? "pending" : "running", ip: undefined });
    }
    advancing.push({ status: "running", ip: "203.0.113.99" });
    // The above produces only 2 distinct signatures alternating — under the
    // structural detector that is a CYCLE. To make every probe genuinely advance,
    // synthesize a unique signature per probe by piggy-backing a counter on the IP.
    const probes: FakeObservation[] = [];
    for (let i = 0; i < 60; i += 1) {
      probes.push({ status: "pending", ip: `intermediate-${i}` });
    }
    probes.push({ status: "running", ip: "203.0.113.99" });

    let i = 0;
    const observedProbes: number[] = [];
    const ready = await pollUntilReady(async () => probes[i++]!, {
      classify: classifyAdvancingForReadinessTest,
      signature: signatureForReadinessTest,
      pollIntervalMs: 1,
      sleep: noSleep,
      onProbe: (info) => observedProbes.push(info.probe),
    });
    expect(ready.ip).toBe("203.0.113.99");
    // 60 advancing probes were recorded (the ready hit ends the loop before recording).
    expect(observedProbes.at(-1)).toBe(60);
  });

  it("throws LOUD PersistentProvisioningOutageError on a STUCK identical signature past the saturation gate", async () => {
    // EVERY probe returns identical pending|no-ip. After STABLE_CADENCE_FLOOR + 1
    // probes the convergence detector reads fixed_point and the loop surfaces loud.
    const probes: number[] = [];
    await expect(
      pollUntilReady(async () => ({ status: "pending", ip: undefined }), {
        classify,
        signature,
        pollIntervalMs: 1,
        sleep: noSleep,
        onProbe: (info) => probes.push(info.probe),
      }),
    ).rejects.toBeInstanceOf(PersistentProvisioningOutageError);
    expect(probes.length).toBeGreaterThan(STABLE_CADENCE_FLOOR);
    expect(probes.length).toBeLessThan(STABLE_CADENCE_FLOOR + 5);
  });

  it("PersistentProvisioningOutageError carries the stuck signature for diagnosability", async () => {
    const error = await pollUntilReady(async () => ({ status: "pending", ip: undefined }), {
      classify,
      signature,
      pollIntervalMs: 1,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PersistentProvisioningOutageError);
    const outage = error as PersistentProvisioningOutageError;
    expect(outage.stuckSignature).toBe("pending|no-ip");
    expect(outage.lastObservedState).toBe("pending|no-ip");
    expect(outage.probesObserved).toBeGreaterThan(STABLE_CADENCE_FLOOR);
    expect(outage.name).toBe("PersistentProvisioningOutageError");
  });

  it("fires terminal_error IMMEDIATELY (never via the fixed-point gate)", async () => {
    // The first probe is already terminal — must throw on probe 1, not on probe 6.
    const probes: number[] = [];
    await expect(
      pollUntilReady(async () => ({ status: "terminated", ip: undefined }), {
        classify,
        signature,
        pollIntervalMs: 1,
        sleep: noSleep,
        onProbe: (info) => probes.push(info.probe),
      }),
    ).rejects.toBeInstanceOf(ProvisioningTerminalStateError);
    // No `advancing` signatures were ever recorded — the terminal arm short-circuited.
    expect(probes).toEqual([]);
  });

  it("fires unknown_state IMMEDIATELY (fail-closed ratchet, never silently advancing)", async () => {
    // A brand-new provider state the classifier does not recognize. Fail-closed:
    // surface UnknownProvisioningStateError on the very first read, so an operator
    // extends the allocator's status allowlist rather than the loop spinning forever.
    await expect(
      pollUntilReady(async () => ({ status: "rebuilding-from-snapshot-2030", ip: undefined }), {
        classify,
        signature,
        pollIntervalMs: 1,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("UnknownProvisioningStateError names the observed state in its message", async () => {
    const error = await pollUntilReady(async () => ({ status: "frozen-pending", ip: undefined }), {
      classify,
      signature,
      pollIntervalMs: 1,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownProvisioningStateError);
    expect((error as UnknownProvisioningStateError).observedState).toBe("frozen-pending");
    expect((error as Error).message).toContain("frozen-pending");
  });

  it("ProvisioningTerminalStateError carries the reason verbatim", async () => {
    const error = await pollUntilReady(async () => ({ status: "terminated", ip: undefined }), {
      classify,
      signature,
      pollIntervalMs: 1,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningTerminalStateError);
    expect((error as ProvisioningTerminalStateError).reason).toBe("provider terminated the resource");
  });

  it("does NOT escalate when an advancing signature persists for EXACTLY the saturation floor", async () => {
    // STABLE_CADENCE_FLOOR identical probes are still under the saturation gate;
    // a probe past that (advancing past it with a CHANGED signature) keeps the loop
    // running — only IDENTICAL signatures PAST the floor are a fixed point.
    let call = 0;
    const ready = await pollUntilReady(
      async () => {
        call += 1;
        if (call <= STABLE_CADENCE_FLOOR) {
          return { status: "pending", ip: undefined };
        }
        // Then a single advance (different signature), then ready.
        if (call === STABLE_CADENCE_FLOOR + 1) {
          return { status: "running", ip: undefined };
        }
        return { status: "running", ip: "203.0.113.7" };
      },
      { classify, signature, pollIntervalMs: 1, sleep: noSleep },
    );
    expect(ready.ip).toBe("203.0.113.7");
  });

  it("observes every probe via onProbe with monotonically increasing indices", async () => {
    const seen: Array<{ probe: number; signature: string }> = [];
    let call = 0;
    await pollUntilReady(
      async () => {
        call += 1;
        if (call <= 3) {
          return { status: "pending", ip: undefined };
        }
        return { status: "running", ip: "203.0.113.7" };
      },
      {
        classify,
        signature,
        pollIntervalMs: 1,
        sleep: noSleep,
        onProbe: (info) => seen.push(info),
      },
    );
    expect(seen.map((s) => s.probe)).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.signature === "pending|no-ip")).toBe(true);
  });

  it("uses the per-allocator signature() function (not the raw observation) for the convergence read", async () => {
    // Hand pollUntilReady a signature() that ALWAYS returns a UNIQUE string per
    // probe — even if the underlying state were "identical", the loop must keep
    // running because the SIGNATURE keeps changing. This pins that `pollUntilReady`
    // routes its convergence decision through the caller-supplied `signature`.
    let call = 0;
    const ready = await pollUntilReady(
      async () => {
        call += 1;
        if (call > 20) {
          return { status: "running", ip: "203.0.113.7" };
        }
        return { status: "pending", ip: undefined };
      },
      {
        classify,
        // A monotonically unique signature per probe — always advancing in the
        // structural reader's eyes regardless of the underlying observation.
        signature: () => `unique-${call}`,
        pollIntervalMs: 1,
        sleep: noSleep,
      },
    );
    expect(ready.ip).toBe("203.0.113.7");
    // 20 advancing probes ran, the loop only converged because we explicitly let it.
    expect(call).toBe(21);
  });
});

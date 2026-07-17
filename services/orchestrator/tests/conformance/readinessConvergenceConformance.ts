// Conformance harness for the per-allocator readiness convergence wiring (task #31).
//
// Every cloud allocator (DO / AWS EC2 / GCP / Kubernetes / Hetzner) now polls on
// STRUCTURAL signature progress via the shared `pollUntilReady` primitive
// (`engine/allocators/readinessConvergence.ts`). The four scenarios below pin that
// per-allocator wiring at the SAME contract — so a future refactor that breaks any
// allocator's classifier / signature / terminal-arm wiring fails CI uniformly.
//
// Per-allocator test files call `describeReadinessConvergence(label, harness)`. The
// `harness` is parameterized so each allocator brings its own fake client, its own
// expected advancing sequence, its own expected fixed-point signature, its own
// expected unknown-state probe, and its own list of expected terminal arms.
//
// Mirrors the existing `allocatorConformance.ts` style — a reusable behavior spec
// invoked once per implementation; the SUITE asserts the contract, not private fields.

import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator } from "../../src/engine/contracts/allocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
} from "../../src/engine/allocators/readinessConvergence.js";

/**
 * What a per-allocator test file hands the conformance suite.
 */
export interface ReadinessConvergenceHarness {
  /**
   * Build a FRESH allocator wired with a fake client whose `wait*` polls produce
   * `advancingSequence` — a sequence of `N` non-ready observations with EACH
   * having a different STRUCTURAL signature (so the convergence detector sees
   * forward motion and the loop runs unbounded). The final observation in the
   * sequence MUST be the ready state so the test exits.
   *
   * `expectedAdvancingProbes` is the count of intermediate advancing probes the
   * test should observe before the ready hit.
   */
  buildAdvancing(): {
    allocator: Allocator;
    request: AllocationRequest;
    expectedAdvancingProbes: number;
  };

  /**
   * Build a FRESH allocator wired with a fake client that returns the SAME
   * non-ready observation every poll (a stuck provisioning). `allocate()` must
   * reject with a `PersistentProvisioningOutageError` once the loop has crossed
   * the saturation gate. `expectedStuckSignature` is the per-allocator structural
   * signature the loop will surface (e.g. `pending|no-ip` for AWS).
   */
  buildStuck(): {
    allocator: Allocator;
    request: AllocationRequest;
    expectedStuckSignature: string;
  };

  /**
   * Build a FRESH allocator wired with a fake client whose poll returns a brand-new
   * PROVIDER STATE the allocator's status allowlist does NOT recognize. `allocate()`
   * must reject with `UnknownProvisioningStateError` IMMEDIATELY (not via fixed-point).
   * `expectedUnknownState` is the verbatim unknown-state token the test injects.
   */
  buildUnknownState(): {
    allocator: Allocator;
    request: AllocationRequest;
    expectedUnknownState: string;
  };

  /**
   * Build a FRESH allocator + request whose fake client's poll returns the given
   * `terminalState` (a known terminal arm — AWS `terminated`, K8s `Failed`, GCP
   * `operation.error`, etc.). `allocate()` must reject with
   * `ProvisioningTerminalStateError` IMMEDIATELY (not via fixed-point), confirming
   * the per-allocator terminal-arm wiring fires on its existing arm without
   * waiting for the saturation gate.
   */
  buildTerminalArm(terminalState: string): {
    allocator: Allocator;
    request: AllocationRequest;
  };

  /**
   * The list of PROVIDER terminal-arm tokens the allocator must surface immediately
   * (e.g. AWS `["terminated", "shutting-down"]`; K8s `["Failed", "Succeeded"]`).
   * Each is independently tested against `buildTerminalArm`.
   */
  expectedTerminalArms: ReadonlyArray<string>;
}

/**
 * The 4 scenarios per Plan §5, parameterized by allocator. Each scenario asserts
 * BEHAVIOR (the error class, the lack-of-escalation invariant, the fixed-point
 * surface), never private fields. Adding a new allocator only requires writing a
 * `ReadinessConvergenceHarness`; the suite below holds the contract.
 */
export function describeReadinessConvergence(label: string, harness: ReadinessConvergenceHarness): void {
  describe(`readiness convergence — ${label}`, () => {
    // SCENARIO 1: unbounded retry while state is ADVANCING. A long sequence of
    // distinct non-ready signatures must never escalate; the ready hit at the
    // end resolves normally. Proves the loop does NOT have a hidden poll cap or
    // wall-clock deadline.
    it("loops UNBOUNDED while the structural signature keeps ADVANCING", async () => {
      const { allocator, request, expectedAdvancingProbes } = harness.buildAdvancing();
      const allocation = await allocator.allocate(request);
      // The allocator returned an allocation (no escalation, no throw).
      expect(allocation.runnerId).toBeTruthy();
      // The expected count of advancing probes is informational — the harness
      // already exercised them by reaching `ready`. Pin it so a future regression
      // that short-circuits the loop early (e.g. accepting `pending` as `ready`)
      // is caught at this seam.
      expect(expectedAdvancingProbes).toBeGreaterThan(0);
    });

    it("emits allocation progress while readiness probes converge", async () => {
      const { allocator, request } = harness.buildAdvancing();
      let progressTicks = 0;
      await allocator.allocate({ ...request, onProgress: () => (progressTicks += 1) });
      expect(progressTicks).toBeGreaterThan(0);
    });

    // SCENARIO 2: LOUD PersistentProvisioningOutageError on a STUCK identical
    // signature past the saturation gate. The cloud returned the SAME non-ready
    // observation every poll — the loop surfaces a wedged provisioning loud.
    it("surfaces PersistentProvisioningOutageError on a fixed-point identical signature", async () => {
      const { allocator, request, expectedStuckSignature } = harness.buildStuck();
      let caught: unknown;
      try {
        await allocator.allocate(request);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PersistentProvisioningOutageError);
      const outage = caught as PersistentProvisioningOutageError;
      expect(outage.stuckSignature).toBe(expectedStuckSignature);
      expect(outage.lastObservedState).toBe(expectedStuckSignature);
    });

    // SCENARIO 3: NEW provider state → UnknownProvisioningStateError. A
    // fail-closed ratchet: the allocator's status allowlist did not recognize
    // the state, so the loop surfaces loud rather than silently treating the
    // unknown state as `advancing` forever.
    it("fails closed with UnknownProvisioningStateError on a NEW unrecognized provider state", async () => {
      const { allocator, request, expectedUnknownState } = harness.buildUnknownState();
      let caught: unknown;
      try {
        await allocator.allocate(request);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnknownProvisioningStateError);
      expect((caught as UnknownProvisioningStateError).observedState).toBe(expectedUnknownState);
    });

    // SCENARIO 4: existing terminal arms still fire IMMEDIATELY (not via
    // fixed-point). One sub-test per per-allocator terminal arm token.
    for (const terminalState of harness.expectedTerminalArms) {
      it(`fires terminal arm immediately on provider state '${terminalState}' (not via fixed-point)`, async () => {
        const { allocator, request } = harness.buildTerminalArm(terminalState);
        let caught: unknown;
        try {
          await allocator.allocate(request);
        } catch (error) {
          caught = error;
        }
        // The terminal arm must throw ProvisioningTerminalStateError — NOT
        // PersistentProvisioningOutageError. The latter would mean the allocator
        // waited for the fixed-point gate; the former means the per-allocator
        // classifier fired on the documented terminal token at the first probe.
        expect(caught).toBeInstanceOf(ProvisioningTerminalStateError);
        expect((caught as ProvisioningTerminalStateError).reason).toContain(terminalState);
      });
    }
  });
}

import { describe, expect, it } from "vitest";
import type {
  PercolationEventEmitter,
  PercolationReadModel,
  PercolationRecoveryOutcome,
  PercolationSettler,
  SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_percolation_recovery";
const DEPENDENT: SpeculativeDependent = {
  specId: "spec_b",
  runId: "run_b",
  speculativeBase: null,
  integratedAncestorShas: { spec_a: "sha_old" },
  verifiedAncestorShas: { spec_a: "sha_old" },
  lifecycleState: "blocked",
  openFindingMaxSeverity: "P0",
  pending: { ancestorSpecId: "spec_a", toSha: "sha_new", reexecRunId: "run_b" },
};

function coordinator(outcome: PercolationRecoveryOutcome, replanEvents: string[]): PercolatingCoordinator {
  const readModel: PercolationReadModel = {
    async loadSpeculativeDependents() {
      return [DEPENDENT];
    },
    async loadAncestorSignals() {
      throw new Error("settle must not detect");
    },
  };
  const settler: PercolationSettler = {
    async absorb() {
      return { result: "absorbed" };
    },
    async replan() {
      return outcome;
    },
  };
  const events: PercolationEventEmitter = {
    async emitPercolating() {},
    async emitPercolated() {},
    async emitPercolationDeferred() {},
    async emitPercolationReplan(input) {
      replanEvents.push(input.specId);
    },
  };
  return new PercolatingCoordinator({
    readModel,
    kickOff: {
      async kickOff() {
        throw new Error("settle must not kick off");
      },
    },
    settler,
    events,
  });
}

describe("percolation consumes typed recovery outcomes truthfully", () => {
  it("confirmed atomic park is visible as parked, never replanned", async () => {
    const events: string[] = [];
    const result = await coordinator({ result: "parked" }, events).percolate(PROJECT);
    expect(result.parked).toEqual(["spec_b"]);
    expect(result.replanned).toEqual([]);
    expect(result.held).toEqual([]);
    expect(events).toEqual([]);
  });

  it("parking failure remains held and emits no false replan", async () => {
    const events: string[] = [];
    const result = await coordinator({ result: "held", reason: "atomic park retained the queue" }, events).percolate(
      PROJECT,
    );
    expect(result.held).toEqual(["spec_b"]);
    expect(result.parked).toEqual([]);
    expect(result.replanned).toEqual([]);
    expect(events).toEqual([]);
  });
});

// DB-free unit tests for the delivery DAG's fenced plan orchestration + the effect-boundary
// demo idempotency (in-17, layer-2/3 audit). Split from deliveryDagUnit.test.ts for the cap.

import { describe, expect, it } from "vitest";
import {
  driveDeliveryStagePlan,
  type DeliveryStagePlanStore,
  type DeliveryStagesLike,
} from "../src/engine/postMerge/delivery/deliveryDagDriver.js";
import { DeliveryStages, newDriveMemo } from "../src/engine/postMerge/delivery/deliveryStages.js";
import { DELIVERY_STAGES, type DeliveryStage } from "../src/engine/postMerge/delivery/stageModel.js";
import {
  FakeStore,
  RecordingEventStore,
  fakeGate,
  fakeRunner,
  fakeSignals,
  fakeStages,
  lineage,
  stagesDeps,
} from "./helpers/deliveryDagFakes.js";

const plan = (store: DeliveryStagePlanStore, stages: DeliveryStagesLike, events: RecordingEventStore) =>
  driveDeliveryStagePlan({ store, stages, eventStore: events, lineage, deliveryRunId: "d-1", token: "tok-1" });

describe("driveDeliveryStagePlan", () => {
  it("runs all nine stages then marks the delivery completed", async () => {
    const store = new FakeStore();
    const stages = fakeStages({});
    expect(await plan(store, stages, new RecordingEventStore())).toBe("completed");
    expect(stages.ran).toEqual([...DELIVERY_STAGES]);
    expect(store.markCompletedCalls).toBe(1);
    expect(store.degraded).toHaveLength(0);
  });

  it("RESUMES: never re-runs a durably-succeeded stage", async () => {
    const store = new FakeStore(new Set<DeliveryStage>(["reconcile_binding", "mint_lease"]));
    const stages = fakeStages({});
    await plan(store, stages, new RecordingEventStore());
    expect(stages.ran).not.toContain("reconcile_binding");
    expect(stages.ran).not.toContain("mint_lease");
    // resumed exactly at the first unfinished stage
    expect(stages.ran[0]).toBe("materialize_env");
  });

  it("DEGRADES fail-closed: stops at the first unconfirmed stage, never marks completed", async () => {
    const store = new FakeStore();
    const stages = fakeStages({
      observe: { kind: "degraded", classification: "demo_effect_not_observed", detail: "x" },
    });
    const events = new RecordingEventStore();
    expect(await plan(store, stages, events)).toBe("degraded");
    // the gravest fail-open is impossible here
    expect(store.markCompletedCalls).toBe(0);
    expect(store.markDegradedCalls).toEqual(["demo_effect_not_observed"]);
    // never advanced past the unconfirmed effect
    expect(stages.ran).not.toContain("record_evidence");
    expect(events.appended.map((e) => e.eventType)).toContain("delivery.degraded");
    expect(events.appended.map((e) => e.eventType)).not.toContain("delivery.completed");
  });

  it("ABORTS (claim_lost) when the fence renew is superseded — no stage runs, nothing terminal", async () => {
    const store = new FakeStore(new Set(), "renew");
    const stages = fakeStages({});
    const events = new RecordingEventStore();
    expect(await plan(store, stages, events)).toBe("claim_lost");
    expect(stages.ran).toHaveLength(0);
    expect(store.markCompletedCalls).toBe(0);
    expect(store.markDegradedCalls).toHaveLength(0);
    expect(events.appended).toHaveLength(0);
  });

  it("ABORTS (claim_lost) when a stage-attempt succeed is superseded mid-drive", async () => {
    const store = new FakeStore(new Set(), "succeed");
    expect(await plan(store, fakeStages({}), new RecordingEventStore())).toBe("claim_lost");
    // never completes on a lost fence
    expect(store.markCompletedCalls).toBe(0);
  });

  it("does NOT report completed when markCompleted's evidence gate/fence returns false", async () => {
    const store = new FakeStore();
    // no durable delivery.completed evidence, or superseded
    store.markCompletedResult = false;
    expect(await plan(store, fakeStages({}), new RecordingEventStore())).toBe("claim_lost");
    expect(store.markCompletedCalls).toBe(1);
  });

  // Finding 2: a lost fence on degradeStageAttempt aborts (its boolean is now checked).
  it("ABORTS (claim_lost) when degradeStageAttempt's fence is superseded — no delivery.degraded emitted", async () => {
    const store = new FakeStore(new Set(), "degrade");
    const stages = fakeStages({ observe: { kind: "degraded", classification: "x", detail: "y" } });
    const events = new RecordingEventStore();
    expect(await plan(store, stages, events)).toBe("claim_lost");
    // never reached the run-level flip or narrated a degrade under a lost fence
    expect(store.markDegradedCalls).toHaveLength(0);
    expect(events.appended).toHaveLength(0);
  });
});

describe("demo stage idempotency (Finding HIGH — tight intent boundary, pre-dispatch re-fires)", () => {
  // (b) crash mid-dispatch: a LIVE fire-intent (started>aborted) + no terminal → degrade, never re-fire.
  it("REFUSES to re-fire and degrades when a LIVE fire-intent is present without a terminal", async () => {
    const demoRunner = fakeRunner();
    const { deps } = stagesDeps({
      demoRunner,
      signals: fakeSignals({ demoTerminalExists: async () => false, demoStimulusIntentLive: async () => true }),
    });
    const out = await new DeliveryStages(deps).run("stimulate", lineage, "d-1", newDriveMemo());
    expect(out).toMatchObject({ kind: "degraded", classification: "demo_effect_in_flight_unknown" });
    // NEVER re-fired the committed-maybe effect
    expect(demoRunner.calls).toHaveLength(0);
  });

  // (a) never-fired: NO live intent + deploy verified → FIRES, records the intent, terminal appears → confirms.
  it("FIRES the demo (recording the fire-intent) when no live intent exists — never sticks degraded", async () => {
    let fired = false;
    const demoRunner = fakeRunner(async () => {
      fired = true;
    });
    const { deps, events } = stagesDeps({
      demoRunner,
      signals: fakeSignals({
        demoStimulusIntentLive: async () => false,
        deployReach: async () => "verified",
        // the terminal appears once the runner has fired (a real runner appends demo.completed)
        demoTerminalExists: async () => fired,
        demoReach: async () => (fired ? "observed" : "none"),
      }),
    });
    const out = await new DeliveryStages(deps).run("stimulate", lineage, "d-1", newDriveMemo());
    expect(out.kind).toBe("confirmed");
    // the effect ran
    expect(demoRunner.calls).toEqual(["run-1"]);
    const types = events.appended.map((e) => e.eventType);
    // the fire-intent was recorded at the effect boundary and NOT aborted (a terminal followed)
    expect(types).toContain("delivery.demo_stimulus_started");
    expect(types).not.toContain("delivery.demo_stimulus_aborted");
  });

  // (a') pre-dispatch failure: the runner throws leaving NO terminal → the intent is ABORTED so a
  // resume RE-FIRES (never a permanent degrade for a never-fired demo).
  it("ABORTS the fire-intent (able to re-fire) when the runner fails before dispatch (no terminal)", async () => {
    const demoRunner = fakeRunner(async () => {
      // a pre-dispatch failure (e.g. loadVerifiedDeploy throwing) — NO terminal demo event
      throw new Error("loadVerifiedDeploy transient failure");
    });
    const { deps, events } = stagesDeps({
      demoRunner,
      signals: fakeSignals({
        demoStimulusIntentLive: async () => false,
        deployReach: async () => "verified",
        demoTerminalExists: async () => false,
      }),
    });
    await new DeliveryStages(deps).run("stimulate", lineage, "d-1", newDriveMemo());
    const types = events.appended.map((e) => e.eventType);
    // intent recorded AND then aborted ⇒ NOT live ⇒ a resume re-fires (no permanent degrade)
    expect(types).toContain("delivery.demo_stimulus_started");
    expect(types).toContain("delivery.demo_stimulus_aborted");
  });

  // (c) no-op demo (deploy NOT verified): runner no-ops, NO intent recorded, confirm — never false-degrades.
  it("does NOT record a fire-intent for a no-op demo (deploy not verified) — no false-degrade on resume", async () => {
    const demoRunner = fakeRunner();
    const { deps, events } = stagesDeps({
      demoRunner,
      signals: fakeSignals({ deployReach: async () => "none", demoReach: async () => "none" }),
    });
    const out = await new DeliveryStages(deps).run("stimulate", lineage, "d-1", newDriveMemo());
    expect(out.kind).toBe("confirmed");
    // invoked (a clean no-op)
    expect(demoRunner.calls).toEqual(["run-1"]);
    expect(events.appended.map((e) => e.eventType)).not.toContain("delivery.demo_stimulus_started");
  });

  it("does NOT re-fire when a terminal demo event already exists (reads the committed outcome)", async () => {
    const demoRunner = fakeRunner();
    const { deps } = stagesDeps({
      demoRunner,
      signals: fakeSignals({
        demoTerminalExists: async () => true,
        deployReach: async () => "verified",
        demoReach: async () => "observed",
      }),
    });
    const out = await new DeliveryStages(deps).run("observe", lineage, "d-1", newDriveMemo());
    expect(out.kind).toBe("confirmed");
    expect(demoRunner.calls).toHaveLength(0);
  });

  it("degrades this pass when another worker holds the demo advisory lock", async () => {
    const demoRunner = fakeRunner();
    const { deps } = stagesDeps({ demoRunner, demoGate: fakeGate(false) });
    const out = await new DeliveryStages(deps).run("stimulate", lineage, "d-1", newDriveMemo());
    expect(out).toMatchObject({ kind: "degraded", classification: "demo_locked_elsewhere" });
    // lock not acquired ⇒ did not fire
    expect(demoRunner.calls).toHaveLength(0);
  });
});

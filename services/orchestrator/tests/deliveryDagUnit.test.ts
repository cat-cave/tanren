// DB-free unit tests for the durable delivery DAG (in-17). Cover the fail-closed arms —
// the pure stage-outcome mappers, the signed-evidence builder, the stage executors (with a
// fake signal port + fake seams), and the resume/degrade/complete plan orchestration — so
// the gravest fail-open (reporting complete without the observed effect) is provably
// impossible without a database.

import { describe, expect, it } from "vitest";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { DeployTriggerGate } from "../src/engine/postMerge/deployTriggerGate.js";
import {
  driveDeliveryStagePlan,
  type DeliveryStagePlanStore,
  type DeliveryStagesLike,
} from "../src/engine/postMerge/delivery/deliveryDagDriver.js";
import {
  buildDeliveryEvidence,
  contentAddressedEvidenceSigner,
  hmacEvidenceSigner,
} from "../src/engine/postMerge/delivery/deliveryEvidence.js";
import type { DeliverySignals, DemoReach } from "../src/engine/postMerge/delivery/deliverySignals.js";
import {
  DeliveryStages,
  newDriveMemo,
  observedEffectFor,
  outcomeForDemoStage,
  outcomeForDeployStage,
  type DeliveryStageDeps,
} from "../src/engine/postMerge/delivery/deliveryStages.js";
import type { StageProgress } from "../src/engine/postMerge/delivery/deliveryRunStore.js";
import {
  DELIVERY_STAGES,
  stageOrdinal,
  type DeliveryLineage,
  type DeliveryStage,
  type StageOutcome,
} from "../src/engine/postMerge/delivery/stageModel.js";

const lineage: DeliveryLineage = {
  runId: "run-1",
  specId: "spec-1",
  projectId: "proj-1",
  orgId: "org-1",
  mergeSha: "abc123",
};

class RecordingEventStore implements EventStore {
  readonly appended: AppendEventInput<EventName>[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push(input);
  }
}

/** A fully-configurable fake signal port (every value defaults to the no-op path). */
function fakeSignals(overrides: Partial<DeliverySignals> = {}): DeliverySignals {
  return {
    deployReach: async () => "none",
    demoReach: async () => "none",
    releaseRequiredCount: async () => 0,
    provisionedProductionSecretRefs: async () => [],
    verifiedDeploymentId: async () => {},
    deliveryCompletedExists: async () => false,
    demoTerminalExists: async () => false,
    ...overrides,
  };
}

function fakeRunner(onCheck?: () => Promise<void>): { check: (runId: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: async (runId: string) => {
      calls.push(runId);
      if (onCheck !== undefined) await onCheck();
    },
  };
}

/** An advisory-gate fake — acquires by default; `acquired=false` simulates a lock held elsewhere. */
function fakeGate(acquired = true): DeployTriggerGate {
  return {
    run: async <T>(_runId: string, work: () => Promise<T>) =>
      acquired ? { acquired: true, value: await work() } : { acquired: false },
  };
}

function stagesDeps(overrides: Partial<DeliveryStageDeps> = {}): {
  deps: DeliveryStageDeps;
  events: RecordingEventStore;
} {
  const events = new RecordingEventStore();
  const deps: DeliveryStageDeps = {
    signals: fakeSignals(),
    deployRunner: fakeRunner(),
    demoRunner: fakeRunner(),
    saga: { driveForOrg: async () => ({ stateUnknown: 0, needsAttention: 0 }) },
    evidence: { eventStore: events, signer: contentAddressedEvidenceSigner },
    demoGate: fakeGate(),
    ...overrides,
  };
  return { deps, events };
}

describe("delivery stage model", () => {
  it("has the nine 0043 stages in dependency order (bind before deploy before observe)", () => {
    expect([...DELIVERY_STAGES]).toEqual([
      "reconcile_binding",
      "mint_lease",
      "materialize_env",
      "attach_runtime",
      "deploy",
      "verify_deploy",
      "stimulate",
      "observe",
      "record_evidence",
    ]);
    expect(stageOrdinal("attach_runtime")).toBeLessThan(stageOrdinal("deploy"));
    expect(stageOrdinal("deploy")).toBeLessThan(stageOrdinal("verify_deploy"));
    expect(stageOrdinal("observe")).toBeLessThan(stageOrdinal("record_evidence"));
  });
});

describe("deploy-cluster outcome mapping", () => {
  it("confirms every cluster stage as a no-op when no deploy is configured", () => {
    for (const s of ["materialize_env", "attach_runtime", "deploy", "verify_deploy"] as DeliveryStage[]) {
      expect(outcomeForDeployStage(s, "none").kind).toBe("confirmed");
    }
  });
  it("confirms only through the reached stage and degrades the first unconfirmed one", () => {
    expect(outcomeForDeployStage("materialize_env", "attached").kind).toBe("confirmed");
    expect(outcomeForDeployStage("attach_runtime", "attached").kind).toBe("confirmed");
    expect(outcomeForDeployStage("deploy", "attached").kind).toBe("degraded");
    expect(outcomeForDeployStage("deploy", "triggered").kind).toBe("confirmed");
    expect(outcomeForDeployStage("verify_deploy", "triggered").kind).toBe("degraded");
    expect(outcomeForDeployStage("verify_deploy", "verified").kind).toBe("confirmed");
    expect(outcomeForDeployStage("materialize_env", "expected").kind).toBe("degraded");
  });
});

describe("demo-cluster outcome mapping", () => {
  const cases: Array<[DemoReach, "confirmed" | "degraded", "confirmed" | "degraded"]> = [
    ["none", "confirmed", "confirmed"],
    ["observed", "confirmed", "confirmed"],
    // stimulate ran; effect NOT observed
    ["failed", "confirmed", "degraded"],
    ["expected", "degraded", "degraded"],
  ];
  it.each(cases)("reach %s → stimulate %s, observe %s", (reach, stimulate, observe) => {
    expect(outcomeForDemoStage("stimulate", reach).kind).toBe(stimulate);
    expect(outcomeForDemoStage("observe", reach).kind).toBe(observe);
  });
});

describe("observed effect derivation", () => {
  it("prefers the independently-observed demo, then a verified deploy, then none", () => {
    expect(observedEffectFor("verified", "observed")).toBe("demo_observed");
    expect(observedEffectFor("verified", "expected")).toBe("deploy_verified");
    expect(observedEffectFor("none", "none")).toBe("none");
  });
});

describe("signed delivery evidence", () => {
  const input = {
    lineage,
    deliveryRunId: "d-1",
    observedEffect: "demo_observed" as const,
    deploymentId: "dep-9",
    stagesConfirmed: ["observe"],
  };
  it("is deterministic and content-addressed", () => {
    const a = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    const b = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    expect(a.evidenceDigest).toBe(b.evidenceDigest);
    expect(a.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(a.signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
  it("changes digest when the observed effect changes", () => {
    const a = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    const b = buildDeliveryEvidence({ ...input, observedEffect: "deploy_verified" }, contentAddressedEvidenceSigner);
    expect(a.evidenceDigest).not.toBe(b.evidenceDigest);
  });
  it("signs with an HMAC when a key is provided", () => {
    const signed = buildDeliveryEvidence(input, hmacEvidenceSigner("k"));
    expect(signed.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
  });
});

describe("reconcile_binding stage", () => {
  it("confirms when the saga converged", async () => {
    const { deps } = stagesDeps();
    expect((await new DeliveryStages(deps).run("reconcile_binding", lineage, "d-1", newDriveMemo())).kind).toBe(
      "confirmed",
    );
  });
  it("degrades on an unresolved reconcile (state_unknown / needs_attention)", async () => {
    const { deps } = stagesDeps({ saga: { driveForOrg: async () => ({ stateUnknown: 1, needsAttention: 0 }) } });
    const out = await new DeliveryStages(deps).run("reconcile_binding", lineage, "d-1", newDriveMemo());
    expect(out.kind).toBe("degraded");
  });
});

describe("mint_lease stage (fail-closed on unavailable scoped-lease backend)", () => {
  it("no-ops when there are no provisioned production secrets", async () => {
    const { deps } = stagesDeps();
    expect((await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo())).kind).toBe("confirmed");
  });
  it("degrades fail-closed when product secrets exist but no minter is available", async () => {
    const { deps } = stagesDeps({ signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a"] }) });
    const out = await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo());
    expect(out).toMatchObject({ kind: "degraded", classification: "scoped_lease_backend_unavailable" });
  });
  it("mints the activation-scoped lease over exactly the project secret refs", async () => {
    const minted: string[][] = [];
    const { deps } = stagesDeps({
      signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a", "ref/b"] }),
      minter: {
        mintScopedRunToken: async (i) => {
          minted.push([...i.credentialRefPaths]);
          return {
            token: "t",
            policyName: "p",
            refPaths: [...i.credentialRefPaths],
            writableRefPaths: [],
            ttlSeconds: i.ttlSeconds,
            numUses: i.numUses,
          };
        },
      },
    });
    expect((await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo())).kind).toBe("confirmed");
    expect(minted).toEqual([["ref/a", "ref/b"]]);
  });
  it("degrades when the mint throws (never a silent pass)", async () => {
    const { deps } = stagesDeps({
      signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a"] }),
      minter: {
        mintScopedRunToken: async () => {
          throw new Error("vault down");
        },
      },
    });
    const out = await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo());
    expect(out).toMatchObject({ kind: "degraded", classification: "scoped_lease_mint_failed" });
  });
});

describe("deploy + demo cluster stages drive the idempotent runners once", () => {
  it("invokes the deploy runner exactly once across the four deploy stages", async () => {
    const deployRunner = fakeRunner();
    const { deps } = stagesDeps({ deployRunner, signals: fakeSignals({ deployReach: async () => "verified" }) });
    const stages = new DeliveryStages(deps);
    const memo = newDriveMemo();
    for (const s of ["materialize_env", "attach_runtime", "deploy", "verify_deploy"] as DeliveryStage[]) {
      expect((await stages.run(s, lineage, "d-1", memo)).kind).toBe("confirmed");
    }
    expect(deployRunner.calls).toEqual(["run-1"]);
  });
  it("folds a deploy-runner throw into an 'expected' reach that degrades materialize_env", async () => {
    let threwSeen = false;
    const deployRunner = fakeRunner(async () => {
      throw new Error("proof gate blocked");
    });
    const { deps } = stagesDeps({
      deployRunner,
      signals: fakeSignals({
        deployReach: async (_l, threw) => {
          threwSeen = threw;
          return threw ? "expected" : "none";
        },
      }),
    });
    const out = await new DeliveryStages(deps).run("materialize_env", lineage, "d-1", newDriveMemo());
    expect(threwSeen).toBe(true);
    expect(out.kind).toBe("degraded");
  });
  it("confirms the demo cluster when the effect was independently observed", async () => {
    const { deps } = stagesDeps({
      signals: fakeSignals({ deployReach: async () => "verified", demoReach: async () => "observed" }),
    });
    const stages = new DeliveryStages(deps);
    const memo = newDriveMemo();
    expect((await stages.run("stimulate", lineage, "d-1", memo)).kind).toBe("confirmed");
    expect((await stages.run("observe", lineage, "d-1", memo)).kind).toBe("confirmed");
  });
});

describe("record_evidence stage (the fail-closed completion gate)", () => {
  it("degrades fail-closed when a product integration requires an unobservable A3 effect", async () => {
    const { deps, events } = stagesDeps({ signals: fakeSignals({ releaseRequiredCount: async () => 1 }) });
    const out = await new DeliveryStages(deps).run("record_evidence", lineage, "d-1", newDriveMemo());
    expect(out).toMatchObject({ kind: "degraded", classification: "product_integration_effect_unobservable" });
    // NEVER a completed attestation without the effect
    expect(events.appended).toHaveLength(0);
  });
  it("records the signed delivery.completed attestation and confirms on the common path", async () => {
    const { deps, events } = stagesDeps({
      signals: fakeSignals({
        deployReach: async () => "verified",
        demoReach: async () => "observed",
        verifiedDeploymentId: async () => "dep-9",
      }),
    });
    const out = await new DeliveryStages(deps).run("record_evidence", lineage, "d-2", newDriveMemo());
    expect(out.kind).toBe("confirmed");
    expect(events.appended).toHaveLength(1);
    const ev = events.appended[0];
    expect(ev?.eventType).toBe("delivery.completed");
    expect(ev?.payload).toMatchObject({ deliveryRunId: "d-2", observedEffect: "demo_observed", deploymentId: "dep-9" });
  });
  it("does not double-emit on resume when the attestation already exists", async () => {
    const { deps, events } = stagesDeps({ signals: fakeSignals({ deliveryCompletedExists: async () => true }) });
    expect((await new DeliveryStages(deps).run("record_evidence", lineage, "d-1", newDriveMemo())).kind).toBe(
      "confirmed",
    );
    expect(events.appended).toHaveLength(0);
  });
});

// ---- driveDeliveryStagePlan (resume / degrade / complete) with a fake store + stages ----

/** A fenced fake store. `loseFenceAt` makes the named fenced write return `false` (superseded). */
class FakeStore implements DeliveryStagePlanStore {
  readonly started: DeliveryStage[] = [];
  readonly succeeded: string[] = [];
  readonly degraded: string[] = [];
  markCompletedCalls = 0;
  markDegradedCalls: string[] = [];
  markCompletedResult = true;
  constructor(
    private readonly preSucceeded: Set<DeliveryStage> = new Set(),
    private readonly loseFenceAt?: "renew" | "start" | "succeed",
    private readonly demoPreviouslyStarted = false,
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async loadStageProgress(): Promise<Map<DeliveryStage, StageProgress>> {
    const m = new Map<DeliveryStage, StageProgress>();
    for (const s of DELIVERY_STAGES)
      m.set(s, { succeeded: this.preSucceeded.has(s), attemptsSoFar: this.preSucceeded.has(s) ? 1 : 0 });
    if (this.demoPreviouslyStarted) m.set("stimulate", { succeeded: false, attemptsSoFar: 1 });
    return m;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async renewClaim(): Promise<boolean> {
    return this.loseFenceAt !== "renew";
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async startStageAttempt(
    _o: string,
    _d: string,
    _t: string,
    stage: DeliveryStage,
    attempt: number,
  ): Promise<string | undefined> {
    if (this.loseFenceAt === "start") return undefined;
    this.started.push(stage);
    return `${stage}:${attempt}`;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async succeedStageAttempt(_o: string, _d: string, _t: string, id: string): Promise<boolean> {
    if (this.loseFenceAt === "succeed") return false;
    this.succeeded.push(id);
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async degradeStageAttempt(_o: string, _d: string, _t: string, id: string): Promise<boolean> {
    this.degraded.push(id);
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async markCompleted(): Promise<boolean> {
    this.markCompletedCalls += 1;
    return this.markCompletedResult;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async markDegraded(_o: string, _d: string, _t: string, c: string): Promise<boolean> {
    this.markDegradedCalls.push(c);
    return true;
  }
}

const plan = (store: DeliveryStagePlanStore, stages: DeliveryStagesLike, events: RecordingEventStore) =>
  driveDeliveryStagePlan({ store, stages, eventStore: events, lineage, deliveryRunId: "d-1", token: "tok-1" });

function fakeStages(
  outcomes: Partial<Record<DeliveryStage, StageOutcome>>,
): DeliveryStagesLike & { ran: DeliveryStage[] } {
  const ran: DeliveryStage[] = [];
  return {
    ran,
    // eslint-disable-next-line @typescript-eslint/require-await
    run: async (stage) => {
      ran.push(stage);
      return outcomes[stage] ?? { kind: "confirmed" };
    },
  };
}

describe("driveDeliveryStagePlan", () => {
  it("runs all nine stages then marks the delivery completed", async () => {
    const store = new FakeStore();
    const stages = fakeStages({});
    const events = new RecordingEventStore();
    expect(await plan(store, stages, events)).toBe("completed");
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
    const stages = fakeStages({});
    const events = new RecordingEventStore();
    expect(await plan(store, stages, events)).toBe("claim_lost");
    // never completes on a lost fence
    expect(store.markCompletedCalls).toBe(0);
  });

  it("does NOT report completed when markCompleted's evidence gate/fence returns false", async () => {
    const store = new FakeStore();
    // no durable delivery.completed evidence, or superseded
    store.markCompletedResult = false;
    const stages = fakeStages({});
    expect(await plan(store, stages, new RecordingEventStore())).toBe("claim_lost");
    expect(store.markCompletedCalls).toBe(1);
  });
});

describe("demo stage idempotency (Finding 2)", () => {
  it("REFUSES to re-fire and degrades when a prior demo attempt has no terminal event", async () => {
    const demoRunner = fakeRunner();
    const { deps } = stagesDeps({ demoRunner, signals: fakeSignals({ demoTerminalExists: async () => false }) });
    const memo = newDriveMemo(true);
    const out = await new DeliveryStages(deps).run("stimulate", lineage, "d-1", memo);
    expect(out).toMatchObject({ kind: "degraded", classification: "demo_effect_in_flight_unknown" });
    // NEVER re-fired the committed-maybe effect
    expect(demoRunner.calls).toHaveLength(0);
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
    const out = await new DeliveryStages(deps).run("observe", lineage, "d-1", newDriveMemo(true));
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

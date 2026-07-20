// Shared DB-free fakes for the in-17 delivery DAG unit tests (split across
// deliveryDagUnit.test.ts + deliveryDagPlan.test.ts to respect the 500-line source cap).

import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { EventName } from "../../src/engine/events/index.js";
import type { DeployTriggerGate } from "../../src/engine/postMerge/deployTriggerGate.js";
import type {
  DeliveryStagePlanStore,
  DeliveryStagesLike,
} from "../../src/engine/postMerge/delivery/deliveryDagDriver.js";
import { contentAddressedEvidenceSigner } from "../../src/engine/postMerge/delivery/deliveryEvidence.js";
import type { DeliverySignals } from "../../src/engine/postMerge/delivery/deliverySignals.js";
import type { DeliveryStageDeps } from "../../src/engine/postMerge/delivery/deliveryStages.js";
import type { StageProgress } from "../../src/engine/postMerge/delivery/deliveryRunStore.js";
import {
  DELIVERY_STAGES,
  type DeliveryLineage,
  type DeliveryStage,
  type StageOutcome,
} from "../../src/engine/postMerge/delivery/stageModel.js";

export const lineage: DeliveryLineage = {
  runId: "run-1",
  specId: "spec-1",
  projectId: "proj-1",
  orgId: "org-1",
  mergeSha: "abc123",
};

export class RecordingEventStore implements EventStore {
  readonly appended: AppendEventInput<EventName>[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push(input);
  }
}

/** A fully-configurable fake signal port (every value defaults to the no-op path). */
export function fakeSignals(overrides: Partial<DeliverySignals> = {}): DeliverySignals {
  return {
    deployReach: async () => "none",
    demoReach: async () => "none",
    releaseRequiredCount: async () => 0,
    provisionedProductionSecretRefs: async () => [],
    verifiedDeploymentId: async () => {},
    deliveryCompletedExists: async () => false,
    demoTerminalExists: async () => false,
    demoStimulusIntentExists: async () => false,
    ...overrides,
  };
}

export function fakeRunner(onCheck?: () => Promise<void>): {
  check: (runId: string) => Promise<void>;
  calls: string[];
} {
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
export function fakeGate(acquired = true): DeployTriggerGate {
  return {
    run: async <T>(_runId: string, work: () => Promise<T>) =>
      acquired ? { acquired: true, value: await work() } : { acquired: false },
  };
}

export function stagesDeps(overrides: Partial<DeliveryStageDeps> = {}): {
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

/** A fenced fake store. `loseFenceAt` makes the named fenced write return `false` (superseded). */
export class FakeStore implements DeliveryStagePlanStore {
  readonly started: DeliveryStage[] = [];
  readonly succeeded: string[] = [];
  readonly degraded: string[] = [];
  markCompletedCalls = 0;
  markDegradedCalls: string[] = [];
  markCompletedResult = true;
  constructor(
    private readonly preSucceeded: Set<DeliveryStage> = new Set(),
    private readonly loseFenceAt?: "renew" | "start" | "succeed" | "degrade",
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async loadStageProgress(): Promise<Map<DeliveryStage, StageProgress>> {
    const m = new Map<DeliveryStage, StageProgress>();
    for (const s of DELIVERY_STAGES)
      m.set(s, { succeeded: this.preSucceeded.has(s), attemptsSoFar: this.preSucceeded.has(s) ? 1 : 0 });
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
    if (this.loseFenceAt === "degrade") return false;
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

export function fakeStages(
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

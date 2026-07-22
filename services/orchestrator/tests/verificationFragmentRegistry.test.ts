// rv-3 unit proofs — the verification-fragment registry + F2-on-missing, exercised
// through the REAL compile path (`compileAndBindAcceptancePlan`) with an in-memory
// conformant store fake and a fixture authorer injected through the SAME kernel seam:
//   1. a plan citing a REGISTERED fragment resolves it + binds it into the plan;
//   2. a MISSING fragment spawns F2 authoring (writer→validate convergent) and, on
//      success, registers + versions + binds it;
//   3. an authoring FAILURE halts loud (typed error) — never a silent skip;
//   4. a missing fragment with NO authoring seam halts loud (fail-closed).

import { describe, expect, it, vi } from "vitest";
import type { AuthoringAuthorer, AuthoringEvents } from "../src/engine/contracts/authoringKernel.js";
import type { CapabilityFragmentRef } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type {
  BindPlanInput,
  CreateVerificationFragmentInput,
  ResolveCapabilityInput,
  VerificationFragmentStore,
} from "../src/engine/repositories/verificationFragmentStore.js";
import {
  VERIFICATION_FRAGMENT_CONTRACT_VERSION,
  compileAndBindAcceptancePlan,
  buildVerificationFragmentValidator,
  createVerificationFragmentAuthoringEventFactory,
  toCapabilityFragmentRef,
  VerificationFragmentAuthoringFailedError,
  VerificationFragmentEventSinkRequiredError,
  type PlanCapabilityAuthoring,
  type PresentVerificationCapability,
  type ValidatedVerificationFragment,
  type VerificationFragmentAuthoringEvent,
  type VerificationFragmentDraftV1,
  type VerificationFragmentSpecV1,
} from "../src/engine/verification/acceptance/index.js";
import type { AcceptanceEventSink } from "../src/engine/verification/acceptance/eventSink.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
  capabilities: [
    { stepKind: "fixture", stepId: "f1", capabilityKey: "seed_user", fragmentKind: "fixture", surface: "api" },
  ],
};

const REVISION = { id: "br_1", personaRevisionId: "pr_1", behaviorRevisionHash: DIGEST, acceptance: ACCEPTANCE };

/** An in-memory conformant `VerificationFragmentStore` — the resolve/register/bind seam. */
class InMemoryStore implements VerificationFragmentStore {
  public readonly versions = new Map<string, ValidatedVerificationFragment>();
  public readonly bindCalls: BindPlanInput[] = [];
  public readonly deleted: string[] = [];

  public async resolveByCapability(input: ResolveCapabilityInput): Promise<CapabilityFragmentRef | undefined> {
    for (const v of this.versions.values()) {
      if (v.capabilityKey === input.capabilityKey && v.fragmentKind === input.fragmentKind)
        return toCapabilityFragmentRef(v);
    }
    return undefined;
  }
  public async listPresent(): Promise<PresentVerificationCapability[]> {
    return [...this.versions.values()].map((v) => ({ capabilityKey: v.capabilityKey, fragmentKind: v.fragmentKind }));
  }
  public async createValidated(input: CreateVerificationFragmentInput): Promise<{ persistedId: string }> {
    this.versions.set(input.fragment.fragmentVersionId, input.fragment);
    return { persistedId: input.fragment.fragmentVersionId };
  }
  public async deleteById(_orgId: string, id: string): Promise<void> {
    this.deleted.push(id);
    this.versions.delete(id);
  }
  public async bindPlan(input: BindPlanInput): Promise<void> {
    this.bindCalls.push(input);
  }
}

/** A fixture authorer producing a fixed draft — injected through the real kernel seam. */
function fixtureAuthorer(
  draftFor: (spec: VerificationFragmentSpecV1) => VerificationFragmentDraftV1,
): AuthoringAuthorer<VerificationFragmentSpecV1, VerificationFragmentDraftV1> {
  return {
    async author({ spec }): Promise<VerificationFragmentDraftV1> {
      return draftFor(spec);
    },
  };
}

const noopEvents: AuthoringEvents<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
> = { factory: createVerificationFragmentAuthoringEventFactory(), sink: { async emit(): Promise<void> {} } };

function validDraft(spec: VerificationFragmentSpecV1): VerificationFragmentDraftV1 {
  return {
    capabilityKey: spec.capabilityKey,
    fragmentKind: spec.fragmentKind,
    surface: spec.surface,
    version: "1.0.0",
    contractVersion: VERIFICATION_FRAGMENT_CONTRACT_VERSION,
    entrypoint: "seedUser",
    source: "export function seedUser() { return { ok: true }; }",
  };
}

function authoring(
  store: VerificationFragmentStore,
  authorer: AuthoringAuthorer<VerificationFragmentSpecV1, VerificationFragmentDraftV1>,
): PlanCapabilityAuthoring {
  return { deps: { authorer, store, events: noopEvents } };
}

function recordedEvents(): { readonly sink: AcceptanceEventSink; readonly events: AppendEventInput[] } {
  const events: AppendEventInput[] = [];
  return {
    events,
    sink: {
      async append<N extends EventName>(event: AppendEventInput<N>): Promise<void> {
        events.push(event);
      },
    },
  };
}

const silentEvents: AcceptanceEventSink = { async append(): Promise<void> {} };

describe("rv-3 verification-fragment registry + F2 authoring", () => {
  it("marks fragment-validation negative control unknown when F2 did not measure one", async () => {
    const spec: VerificationFragmentSpecV1 = { capabilityKey: "seed_user", fragmentKind: "fixture", surface: "api" };
    const verdict = await buildVerificationFragmentValidator().validate({
      request: { context: { orgId: "org1", projectId: "proj1", behaviorRevisionId: "br_1" } },
      spec,
      draft: validDraft(spec),
    });
    if (verdict.kind !== "valid") throw new Error("fixture draft must be valid");
    const event = createVerificationFragmentAuthoringEventFactory().build({
      request: { context: { orgId: "org1", projectId: "proj1", behaviorRevisionId: "br_1" } },
      lifecycle: { point: "succeeded", unitId: "fixture:seed_user", attempts: 1, validated: verdict.validated },
    });
    if (event.kind !== "emit" || event.eventType !== "behavior.fragment.validated") {
      throw new Error("expected a fragment validated event");
    }
    expect(event.payload.negativeControlPassed).toBeUndefined();
    expect("negativeControlPassed" in event.payload).toBe(false);
  });

  it("fails loud with a typed error when a compilation emit path has no sink", async () => {
    const store = new InMemoryStore();
    await expect(
      compileAndBindAcceptancePlan({
        revision: REVISION,
        orgId: "org1",
        projectId: "proj1",
        store,
        events: undefined as never,
      }),
    ).rejects.toBeInstanceOf(VerificationFragmentEventSinkRequiredError);
  });

  it("resolves a REGISTERED fragment and binds it into the plan (no authoring)", async () => {
    const store = new InMemoryStore();
    // Pre-register the cited capability directly through the store seam.
    const spec: VerificationFragmentSpecV1 = { capabilityKey: "seed_user", fragmentKind: "fixture", surface: "api" };
    await runAuthoringOnce(store, spec);

    const plan = await compileAndBindAcceptancePlan({
      revision: REVISION,
      orgId: "org1",
      projectId: "proj1",
      store,
      events: silentEvents,
    });
    expect(plan.capabilityFragments).toHaveLength(1);
    expect(store.bindCalls).toHaveLength(1);
    expect(store.bindCalls[0]?.bindings[0]?.stepId).toBe("f1");
    expect(store.bindCalls[0]?.status).toBe("compiled");
  });

  it("F2-authors a MISSING fragment, then registers + binds it", async () => {
    const store = new InMemoryStore();
    const author = vi.fn<(spec: VerificationFragmentSpecV1) => VerificationFragmentDraftV1>(validDraft);
    const plan = await compileAndBindAcceptancePlan({
      revision: REVISION,
      orgId: "org1",
      projectId: "proj1",
      store,
      events: silentEvents,
      authoring: authoring(store, fixtureAuthorer(author)),
    });
    expect(author).toHaveBeenCalledTimes(1);
    expect(store.versions.size).toBe(1);
    expect(plan.capabilityFragments).toHaveLength(1);
    expect(store.bindCalls).toHaveLength(1);
  });

  it("HALTS LOUD when authoring cannot converge (writer never authors the requested slot)", async () => {
    const store = new InMemoryStore();
    // Always author the WRONG capability — the validator rejects every attempt; the
    // fixed-point window halts it (no retry cap) and the loud typed error surfaces.
    const wrong = fixtureAuthorer((spec) => ({ ...validDraft(spec), capabilityKey: "wrong_capability" }));
    await expect(
      compileAndBindAcceptancePlan({
        revision: REVISION,
        orgId: "org1",
        projectId: "proj1",
        store,
        events: silentEvents,
        authoring: authoring(store, wrong),
      }),
    ).rejects.toBeInstanceOf(VerificationFragmentAuthoringFailedError);
    expect(store.versions.size).toBe(0);
    expect(store.bindCalls).toHaveLength(0);
  });

  it("HALTS LOUD when a cited fragment is missing and NO authoring seam is configured", async () => {
    const store = new InMemoryStore();
    await expect(
      compileAndBindAcceptancePlan({
        revision: REVISION,
        orgId: "org1",
        projectId: "proj1",
        store,
        events: silentEvents,
      }),
    ).rejects.toBeInstanceOf(VerificationFragmentAuthoringFailedError);
  });

  it("compiles a plan with NO cited capabilities unchanged (no binding, no authoring)", async () => {
    const store = new InMemoryStore();
    const plan = await compileAndBindAcceptancePlan({
      revision: { ...REVISION, acceptance: { ...ACCEPTANCE, capabilities: [] } },
      orgId: "org1",
      projectId: "proj1",
      store,
      events: silentEvents,
    });
    expect(plan.capabilityFragments).toBeUndefined();
    expect(store.bindCalls).toHaveLength(0);
  });

  it("emits respec.requested and never compiled for a needs-respec compile", async () => {
    const store = new InMemoryStore();
    const recorded = recordedEvents();
    await expect(
      compileAndBindAcceptancePlan({
        revision: {
          ...REVISION,
          acceptance: {
            ...ACCEPTANCE,
            capabilities: [],
            assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "eventually", expected: 200 }],
          },
        },
        orgId: "org1",
        projectId: "proj1",
        store,
        events: recorded.sink,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(recorded.events.map((event) => event.eventType)).toEqual([
      "behavior.contract.compilation_started",
      "behavior.respec.requested",
    ]);
  });

  it("emits contract.rejected and never compiled for an invalid stored spec", async () => {
    const store = new InMemoryStore();
    const recorded = recordedEvents();
    await expect(
      compileAndBindAcceptancePlan({
        revision: { ...REVISION, acceptance: {} },
        orgId: "org1",
        projectId: "proj1",
        store,
        events: recorded.sink,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(recorded.events.map((event) => event.eventType)).toEqual([
      "behavior.contract.compilation_started",
      "behavior.contract.rejected",
    ]);
  });
});

/** Register a capability through the real F2 authoring path (used to pre-seed the
 * "already registered" case). */
async function runAuthoringOnce(store: VerificationFragmentStore, spec: VerificationFragmentSpecV1): Promise<void> {
  const { runVerificationFragmentAuthoring } = await import("../src/engine/verification/acceptance/index.js");
  const result = await runVerificationFragmentAuthoring({
    missing: [spec],
    context: { orgId: "org1", projectId: "proj1", behaviorRevisionId: "br_1" },
    deps: { authorer: fixtureAuthorer(validDraft), store, events: noopEvents },
  });
  if (result.failedIds.length > 0) throw new Error(`pre-seed authoring failed: ${result.failedIds.join(",")}`);
}

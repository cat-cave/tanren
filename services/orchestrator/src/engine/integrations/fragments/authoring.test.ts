import { describe, expect, it, vi } from "vitest";
import {
  IntegrationFragmentAuthoringFailedError,
  IntegrationFragmentValidationError,
  resolveIntegrationFragments,
  type IntegrationFragmentConfig,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSpec,
  type ValidatedIntegrationFragment,
} from "./index.js";
import { validateIntegrationFragment } from "./model.js";
import type { IntegrationFragmentPersistenceStore } from "./store.js";

const context = { orgId: "org-in7", projectId: "project-in7", createdBy: "operator-in7" };

const slackSpec: IntegrationFragmentSpec = {
  capability: "messaging.send",
  providerKind: "slack",
  plane: "product",
  version: "1.0.0",
};

const sentrySpec: IntegrationFragmentSpec = {
  capability: "errors.capture",
  providerKind: "sentry",
  plane: "product",
  version: "1.0.0",
};

function draft(spec: IntegrationFragmentSpec): IntegrationFragmentDraft {
  const bindingKind = spec.plane === "product" ? "product.messaging.bot_token_ref" : "control.notify.bot_token_ref";
  return {
    spec,
    definition: {
      direction: "outbound",
      criticality: "release_required",
      bindingOutputs: [
        { kind: bindingKind, logicalKey: "PROVIDER_TOKEN", classification: "secret_ref", required: true },
      ],
      operations: ["send"],
      validationPlan: {
        version: 1,
        preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
        postDeploy: { liveStimulus: true, independentObservation: true },
        negativeControls: ["missing-scope"],
      },
    },
  };
}

function config(specs: readonly IntegrationFragmentSpec[]): IntegrationFragmentConfig {
  return { apiVersion: "tanren.dev/integration-fragments/v1", schemaVersion: 1, fragments: [...specs] };
}

function idOf(fragment: ValidatedIntegrationFragment): string {
  return `${fragment.draft.spec.capability}:${fragment.draft.spec.providerKind}@${fragment.draft.spec.version}`;
}

function memoryStore(seed: readonly ValidatedIntegrationFragment[] = []): IntegrationFragmentPersistenceStore & {
  readonly rowIds: () => string[];
} {
  let rows: ValidatedIntegrationFragment[] = [...seed];
  const id = idOf;
  return {
    rowIds: () => rows.map((row) => id(row)),
    async createValidated(input) {
      const persistedId = id(input.fragment);
      if (rows.some((row) => id(row) === persistedId)) throw new Error(`duplicate ${persistedId}`);
      rows = [...rows, input.fragment];
      return { persistedId };
    },
    async deleteById(_orgId, persistedId) {
      rows = rows.filter((row) => id(row) !== persistedId);
    },
    async listValidated() {
      return rows;
    },
  };
}

function eventSink() {
  const eventTypes: string[] = [];
  return {
    eventTypes,
    sink: {
      async append(input: { eventType: string }) {
        eventTypes.push(input.eventType);
      },
    },
  };
}

describe("in-7 integration fragment F2 production resolver", () => {
  it("resolves a REGISTERED provider definition without invoking the authorer", async () => {
    const store = memoryStore([validateIntegrationFragment(draft(slackSpec))]);
    const events = eventSink();
    const author = vi.fn<(input: { spec: IntegrationFragmentSpec }) => Promise<IntegrationFragmentDraft>>();

    const composed = await resolveIntegrationFragments({
      config: config([slackSpec]),
      context,
      authorer: { author },
      store,
      eventStore: events.sink,
    });

    expect(author).not.toHaveBeenCalled();
    expect(events.eventTypes).toEqual([]);
    expect(composed.snapshot).toHaveLength(1);
    expect(composed.snapshot[0]).toMatchObject({ capability: "messaging.send", providerKind: "slack" });
  });

  it("spawns the shared F2 kernel on a MISSING definition, registers it, and emits integration.author.* per attempt", async () => {
    const store = memoryStore();
    const events = eventSink();
    const author = vi.fn<(input: { spec: IntegrationFragmentSpec }) => Promise<IntegrationFragmentDraft>>(
      async ({ spec }) => draft(spec),
    );

    const composed = await resolveIntegrationFragments({
      config: config([slackSpec, sentrySpec]),
      context,
      authorer: { author },
      store,
      eventStore: events.sink,
    });

    expect(author).toHaveBeenCalledTimes(2);
    expect(composed.snapshot).toHaveLength(2);
    // Kernel lifecycle proof: started → attempt(converged) → succeeded per unit.
    expect(events.eventTypes.filter((t) => t === "integration.author.started")).toHaveLength(2);
    expect(events.eventTypes.filter((t) => t === "integration.author.attempt")).toHaveLength(2);
    expect(events.eventTypes.filter((t) => t === "integration.author.succeeded")).toHaveLength(2);
    expect(events.eventTypes).not.toContain("integration.author.failed");
    // The authored rows are durably registered (reused on the next resolve).
    expect(store.rowIds().sort()).toEqual(["errors.capture:sentry@1.0.0", "messaging.send:slack@1.0.0"]);

    const second = await resolveIntegrationFragments({
      config: config([slackSpec, sentrySpec]),
      context,
      authorer: { author },
      store,
      eventStore: eventSink().sink,
    });
    // No re-authoring — the definitions are reused from the registry.
    expect(author).toHaveBeenCalledTimes(2);
    expect(second.snapshot).toHaveLength(2);
  });

  it("HALTS LOUD with a typed error when a definition is missing and NO authorer is provided", async () => {
    const store = memoryStore();
    const events = eventSink();

    await expect(
      resolveIntegrationFragments({ config: config([slackSpec]), context, store, eventStore: events.sink }),
    ).rejects.toBeInstanceOf(IntegrationFragmentAuthoringFailedError);
    expect(store.rowIds()).toEqual([]);
    expect(events.eventTypes).toEqual([]);
  });

  it("HALTS LOUD when the writer never converges (always-invalid drafts), emitting integration.author.failed", async () => {
    const store = memoryStore();
    const events = eventSink();
    // A draft whose declared plane contradicts its binding-output kind → the
    // validator rejects every attempt → the fixed-point loop halts → failed.
    const author = vi.fn<() => Promise<IntegrationFragmentDraft>>(async () => {
      const bad = draft(slackSpec);
      return {
        ...bad,
        definition: {
          ...bad.definition,
          bindingOutputs: [{ ...bad.definition.bindingOutputs[0]!, kind: "control.notify.bot_token_ref" as const }],
        },
      };
    });

    await expect(
      resolveIntegrationFragments({
        config: config([slackSpec]),
        context,
        authorer: { author },
        store,
        eventStore: events.sink,
      }),
    ).rejects.toBeInstanceOf(IntegrationFragmentAuthoringFailedError);
    // Nothing durably registered.
    expect(store.rowIds()).toEqual([]);
    expect(events.eventTypes).toContain("integration.author.failed");
  });

  it("RETRACTS the persisted row and HALTS LOUD when the whole-batch compose rejects", async () => {
    const store = memoryStore();
    const events = eventSink();
    // Same capability, two providers, CONFLICTING planes: each fragment validates
    // in isolation but the batch compose rejects (a capability is single-plane).
    const productSpec = slackSpec;
    const controlSpec: IntegrationFragmentSpec = { ...slackSpec, providerKind: "pagerduty", plane: "control" };
    const author = vi.fn<(input: { spec: IntegrationFragmentSpec }) => Promise<IntegrationFragmentDraft>>(
      async ({ spec }) => draft(spec),
    );

    await expect(
      resolveIntegrationFragments({
        config: config([productSpec, controlSpec]),
        context,
        authorer: { author },
        store,
        eventStore: events.sink,
      }),
    ).rejects.toBeInstanceOf(IntegrationFragmentAuthoringFailedError);
    // Retract-before-failed: no cross-run contamination survives.
    expect(store.rowIds()).toEqual([]);
    expect(events.eventTypes).toContain("integration.author.failed");
    expect(events.eventTypes).not.toContain("integration.author.succeeded");
  });
});

describe("in-7 integration fragment validation", () => {
  it("rejects a binding-output kind whose plane contradicts the declared plane", () => {
    const bad = draft(slackSpec);
    expect(() =>
      validateIntegrationFragment({
        ...bad,
        definition: {
          ...bad.definition,
          bindingOutputs: [{ ...bad.definition.bindingOutputs[0]!, kind: "control.notify.bot_token_ref" }],
        },
      }),
    ).toThrow(IntegrationFragmentValidationError);
  });

  it("rejects a provider policy that forbids the definition's own provider", () => {
    const bad = draft(slackSpec);
    expect(() =>
      validateIntegrationFragment({
        ...bad,
        definition: { ...bad.definition, providerPolicy: { forbidden: ["slack"] } },
      }),
    ).toThrow(IntegrationFragmentValidationError);
  });

  it("accepts a well-formed provider integration definition and stamps a sha256 digest", () => {
    const validated = validateIntegrationFragment(draft(sentrySpec));
    expect(validated.fragmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

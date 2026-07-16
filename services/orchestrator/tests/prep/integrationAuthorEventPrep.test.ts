import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_ATTEMPT_BODY_PREVIEW_MAX,
  type AuthoringKernelInput,
  type AuthoringLifecyclePoint,
} from "../../src/engine/contracts/authoringKernel.js";
import {
  buildIntegrationAuthorEventDraft,
  createIntegrationAuthorEventFactoryDraft,
  emitIntegrationAuthorEventDraftBestEffort,
  integrationAuthorEmitBoundaryDraft,
  integrationAuthorTerminalEmissionIsEligible,
  integrationAuthorTerminalsAreExactlyOnce,
  type IntegrationAuthorEventDraft,
} from "../../src/engine/contracts/prep/integrationAuthorEventFactory.js";
import {
  INTEGRATION_AUTHOR_EVENT_NAMESPACE_STATUS,
  integrationAuthorEventDefaultSeverityDraft,
  integrationAuthorEventPayloadDrafts,
  integrationAuthorEventSensitivityDrafts,
  PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES,
  type ProspectiveIntegrationAuthorEventName,
} from "../../src/engine/contracts/prep/integrationAuthorEventPayloads.js";

const request: AuthoringKernelInput<unknown> = {
  missing: [],
  context: { missionNodeId: "in-7", orgId: "org-1", runId: "author-run-1" },
};

function draftFor(
  lifecycle: AuthoringLifecyclePoint<unknown, unknown, unknown>,
  authoringRequest: AuthoringKernelInput<unknown> = request,
): IntegrationAuthorEventDraft {
  return buildIntegrationAuthorEventDraft({ request: authoringRequest, lifecycle });
}

const validPayloads = {
  "integration.author.started": { missionNodeId: "in-7", unitId: "slack-product-message" },
  "integration.author.attempt": {
    missionNodeId: "in-7",
    unitId: "slack-product-message",
    attempt: 1,
    bodyPreview: "export const send = () => undefined;",
    canonicalSignature: "candidate-signature",
    rejection: "",
    decision: "converged",
  },
  "integration.author.succeeded": {
    missionNodeId: "in-7",
    unitId: "slack-product-message",
    attempts: 1,
  },
  "integration.author.failed": {
    missionNodeId: "in-7",
    unitId: "slack-product-message",
    reason: "authorer_failed_before_first_attempt",
    attempts: 0,
  },
} as const;

const expectedSensitivityPaths: Readonly<Record<ProspectiveIntegrationAuthorEventName, readonly string[]>> = {
  "integration.author.started": ["missionNodeId", "unitId"],
  "integration.author.attempt": [
    "missionNodeId",
    "unitId",
    "attempt",
    "bodyPreview",
    "canonicalSignature",
    "rejection",
    "decision",
  ],
  "integration.author.succeeded": ["missionNodeId", "unitId", "attempts"],
  "integration.author.failed": ["missionNodeId", "unitId", "reason", "attempts"],
};

describe("IN-7 prospective event payload contracts", () => {
  it("keeps all four names explicitly prospective with exact severity drafts", () => {
    expect(INTEGRATION_AUTHOR_EVENT_NAMESPACE_STATUS).toBe("prospective_unfrozen");
    expect(PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES).toEqual([
      "integration.author.started",
      "integration.author.attempt",
      "integration.author.succeeded",
      "integration.author.failed",
    ]);
    expect(integrationAuthorEventDefaultSeverityDraft).toEqual({
      "integration.author.started": "ok",
      "integration.author.attempt": "info",
      "integration.author.succeeded": "ok",
      "integration.author.failed": "fail",
    });
  });

  it("accepts the minimal strict payload for every lifecycle fact", () => {
    for (const eventName of PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES) {
      expect(integrationAuthorEventPayloadDrafts[eventName].safeParse(validPayloads[eventName]).success).toBe(true);
      expect(
        integrationAuthorEventPayloadDrafts[eventName].safeParse({
          ...validPayloads[eventName],
          orgId: "payload-tenancy-is-forbidden",
        }).success,
      ).toBe(false);
    }
  });

  it("pins identity, preview, signature, diagnostics, and attempt bounds", () => {
    const attempt = integrationAuthorEventPayloadDrafts["integration.author.attempt"];
    const succeeded = integrationAuthorEventPayloadDrafts["integration.author.succeeded"];
    const failed = integrationAuthorEventPayloadDrafts["integration.author.failed"];

    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], missionNodeId: "in-8" }).success).toBe(
      false,
    );
    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], unitId: "" }).success).toBe(false);
    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], unitId: "u".repeat(257) }).success).toBe(
      false,
    );
    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], attempt: 0 }).success).toBe(false);
    expect(
      attempt.safeParse({
        ...validPayloads["integration.author.attempt"],
        bodyPreview: "x".repeat(AUTHORING_ATTEMPT_BODY_PREVIEW_MAX + 1),
      }).success,
    ).toBe(false);
    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], canonicalSignature: "" }).success).toBe(
      false,
    );
    expect(
      attempt.safeParse({ ...validPayloads["integration.author.attempt"], rejection: "x".repeat(2_001) }).success,
    ).toBe(false);
    expect(attempt.safeParse({ ...validPayloads["integration.author.attempt"], decision: "retry" }).success).toBe(
      false,
    );
    expect(succeeded.safeParse({ ...validPayloads["integration.author.succeeded"], attempts: 0 }).success).toBe(false);
    expect(failed.safeParse({ ...validPayloads["integration.author.failed"], attempts: -1 }).success).toBe(false);
    expect(failed.safeParse({ ...validPayloads["integration.author.failed"], reason: "" }).success).toBe(false);
  });

  it("enumerates every strict schema leaf once and marks it public", () => {
    for (const eventName of PROSPECTIVE_INTEGRATION_AUTHOR_EVENT_NAMES) {
      const schemaPaths = Object.keys(integrationAuthorEventPayloadDrafts[eventName].shape).sort();
      const rules = integrationAuthorEventSensitivityDrafts.filter((rule) => rule.eventName === eventName);
      expect(rules.map((rule) => rule.path).sort()).toEqual([...expectedSensitivityPaths[eventName]].sort());
      expect(rules.map((rule) => rule.path).sort()).toEqual(schemaPaths);
      expect(new Set(rules.map((rule) => rule.path)).size).toBe(rules.length);
      expect(rules.every((rule) => rule.tag === "public")).toBe(true);
    }
  });
});

describe("IN-7 SP-2 lifecycle factory draft", () => {
  it("stamps org/run in the envelope and mission identity in payload only", () => {
    const built = draftFor({
      point: "started",
      unitId: "slack-product-message",
      spec: { privateProviderPlan: "must-not-leak" },
    });

    expect(built).toEqual({
      eventType: "integration.author.started",
      envelope: { orgId: "org-1", runId: "author-run-1" },
      payload: { missionNodeId: "in-7", unitId: "slack-product-message" },
    });
    expect(JSON.stringify(built)).not.toContain("must-not-leak");
    expect(built.payload).not.toHaveProperty("orgId");
  });

  it("maps every point without leaking opaque draft or validated material", () => {
    const attempt = draftFor({
      point: "attempt",
      unitId: "slack-product-message",
      attempt: 2,
      draft: { providerToken: "draft-secret" },
      bodyPreview: "bounded public preview",
      canonicalSignature: "signature-2",
      rejection: "needs a recording fake",
      decision: "continue",
    });
    const succeeded = draftFor({
      point: "succeeded",
      unitId: "slack-product-message",
      attempts: 2,
      validated: { contractBody: "validated-secret" },
    });
    const failed = draftFor({
      point: "failed",
      unitId: "webhook-product-message",
      reason: "authorer_failed_before_first_attempt",
      attempts: 0,
    });

    expect(attempt).toMatchObject({
      eventType: "integration.author.attempt",
      payload: {
        missionNodeId: "in-7",
        unitId: "slack-product-message",
        attempt: 2,
        bodyPreview: "bounded public preview",
        canonicalSignature: "signature-2",
        rejection: "needs a recording fake",
        decision: "continue",
      },
    });
    expect(succeeded).toMatchObject({
      eventType: "integration.author.succeeded",
      payload: { missionNodeId: "in-7", unitId: "slack-product-message", attempts: 2 },
    });
    expect(failed).toMatchObject({
      eventType: "integration.author.failed",
      payload: { missionNodeId: "in-7", unitId: "webhook-product-message", attempts: 0 },
    });
    expect(JSON.stringify([attempt, succeeded])).not.toContain("secret");
    expect([attempt.eventType, succeeded.eventType, failed.eventType]).not.toContain("fragment.authoring.succeeded");
  });

  it("round-trips every SP-2 attempt decision through the factory", () => {
    const decisions = ["continue", "converged", "halted_fixed_point"] as const;

    for (const decision of decisions) {
      const built = draftFor({
        point: "attempt",
        unitId: `decision-${decision}`,
        attempt: 1,
        draft: {},
        bodyPreview: "bounded public preview",
        canonicalSignature: `signature-${decision}`,
        rejection: "",
        decision,
      });

      expect(built).toMatchObject({
        eventType: "integration.author.attempt",
        payload: { unitId: `decision-${decision}`, decision },
      });
      expect(integrationAuthorEventPayloadDrafts["integration.author.attempt"].parse(built.payload)).toEqual(
        built.payload,
      );
    }
  });

  it("requires strict mission/org context while allowing an org-only envelope", () => {
    const factory = createIntegrationAuthorEventFactoryDraft<unknown, unknown, unknown>();
    const lifecycle: AuthoringLifecyclePoint<unknown, unknown, unknown> = {
      point: "failed",
      unitId: "unit-1",
      reason: "language_failure",
      attempts: 0,
    };

    expect(
      factory.build({
        request: { missing: [], context: { missionNodeId: "in-7", orgId: "org-only" } },
        lifecycle,
      }),
    ).toMatchObject({ envelope: { orgId: "org-only" } });
    expect(() => factory.build({ request: { missing: [], context: { orgId: "org-1" } }, lifecycle })).toThrow(
      /missionNodeId/u,
    );
    expect(() =>
      factory.build({
        request: { missing: [], context: { missionNodeId: "in-7", orgId: "org-1", extra: true } },
        lifecycle,
      }),
    ).toThrow(/extra/u);
  });
});

describe("IN-7 event observability cannot become product authority", () => {
  it("pins terminal firing eligibility to persistence, batch, and retraction truth", () => {
    expect(integrationAuthorEmitBoundaryDraft).toEqual({
      authority: "validated_non_retracted_family_row",
      transaction: "outside_family_persistence_transaction",
      delivery: "best_effort_observability",
      sinkFailure: "warn_and_continue",
      terminalCardinality: "exactly_one_per_unit",
    });
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.succeeded", {
        persisted: true,
        batchVerdict: "passed",
        retracted: false,
      }),
    ).toBe(true);
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.succeeded", {
        persisted: true,
        batchVerdict: "not_run",
        retracted: false,
      }),
    ).toBe(false);
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.succeeded", {
        persisted: true,
        batchVerdict: "passed",
        retracted: true,
      }),
    ).toBe(false);
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.failed", {
        persisted: false,
        batchVerdict: "not_run",
        retracted: false,
      }),
    ).toBe(true);
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.failed", {
        persisted: true,
        batchVerdict: "failed",
        retracted: true,
      }),
    ).toBe(true);
    expect(
      integrationAuthorTerminalEmissionIsEligible("integration.author.failed", {
        persisted: true,
        batchVerdict: "skipped",
        retracted: false,
      }),
    ).toBe(false);
  });

  it("requires exactly one terminal draft per authored unit", () => {
    const succeeded = draftFor({ point: "succeeded", unitId: "unit-a", attempts: 1, validated: {} });
    const failed = draftFor({ point: "failed", unitId: "unit-b", reason: "fixed_point", attempts: 2 });
    const conflicting = draftFor({ point: "failed", unitId: "unit-a", reason: "late_failure", attempts: 1 });
    const started = draftFor({ point: "started", unitId: "unit-a", spec: {} });

    expect(integrationAuthorTerminalsAreExactlyOnce(["unit-a", "unit-b"], [started, succeeded, failed])).toBe(true);
    expect(integrationAuthorTerminalsAreExactlyOnce(["unit-a"], [succeeded, conflicting])).toBe(false);
    expect(integrationAuthorTerminalsAreExactlyOnce(["unit-a", "unit-b"], [succeeded])).toBe(false);
  });

  it("swallows a sink throw and leaves validated-row authority untouched", async () => {
    const validatedRows = new Set(["unit-a"]);
    const warnings: Array<Readonly<Record<string, string>>> = [];
    const event = draftFor({ point: "succeeded", unitId: "unit-a", attempts: 1, validated: {} });

    const outcome = await emitIntegrationAuthorEventDraftBestEffort({
      sink: {
        emit: async () => {
          throw new Error("event store unavailable");
        },
      },
      event,
      warn: (_message, fields) => warnings.push(fields),
    });

    expect(outcome).toEqual({
      kind: "observability_gap",
      errorMessage: "event store unavailable",
      warningDelivered: true,
    });
    expect(warnings).toEqual([
      { eventType: "integration.author.succeeded", unitId: "unit-a", error: "event store unavailable" },
    ]);
    expect([...validatedRows]).toEqual(["unit-a"]);
  });

  it("does not let an event alone create a validated row and survives a warning failure", async () => {
    const validatedRows = new Set<string>();
    const observed: IntegrationAuthorEventDraft[] = [];
    const event = draftFor({ point: "failed", unitId: "unit-a", reason: "fixed_point", attempts: 2 });

    await expect(
      emitIntegrationAuthorEventDraftBestEffort({
        sink: { emit: async (draft) => void observed.push(draft) },
        event,
        warn: () => {
          // The success path does not call the warning seam.
        },
      }),
    ).resolves.toEqual({ kind: "emitted" });
    expect(observed).toEqual([event]);
    expect(validatedRows.size).toBe(0);

    await expect(
      emitIntegrationAuthorEventDraftBestEffort({
        sink: {
          emit: async () => {
            throw new Error("append failed");
          },
        },
        event,
        warn: () => {
          throw new Error("logger failed");
        },
      }),
    ).resolves.toEqual({ kind: "observability_gap", errorMessage: "append failed", warningDelivered: false });
  });

  it("has no production registration or authority imports", () => {
    const payloadSource = readFileSync(
      new URL("../../src/engine/contracts/prep/integrationAuthorEventPayloads.ts", import.meta.url),
      "utf8",
    );
    const factorySource = readFileSync(
      new URL("../../src/engine/contracts/prep/integrationAuthorEventFactory.ts", import.meta.url),
      "utf8",
    );
    const productionSources = [
      readFileSync(new URL("../../src/engine/events/registry.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../src/engine/events/sensitivityRules.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../src/engine/notifications/eventDefaultSeverity.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../../../db/src/eventTypesSeed.ts", import.meta.url), "utf8"),
    ];

    expect(importPaths(payloadSource).sort()).toEqual([
      "../../events/sensitivity.js",
      "../../notifications/schemas.js",
      "../authoringKernel.js",
      "zod",
    ]);
    expect(importPaths(factorySource).sort()).toEqual([
      "../authoringKernel.js",
      "./integrationAuthorEventPayloads.js",
      "zod",
    ]);
    for (const source of productionSources) {
      expect(source).not.toContain("integration.author.");
      expect(source).not.toContain("integrationAuthorEvent");
    }
  });
});

function importPaths(source: string): string[] {
  return [...source.matchAll(/from\s+"(?<path>[^"]+)"/gu)].map((match) => match.groups?.["path"] ?? "");
}

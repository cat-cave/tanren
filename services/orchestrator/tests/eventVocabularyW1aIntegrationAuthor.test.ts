import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AUTHORING_ATTEMPT_BODY_PREVIEW_MAX } from "../src/engine/contracts/authoringKernel.js";
import { EventRegistry, listEventNames, listSensitivityPathsFor, sensitivityFor } from "../src/engine/events/index.js";
import { w1aEventRegistry } from "../src/engine/events/schemas/eventVocabularyW1aIntegrationAuthor.js";
import { defaultSeverityFor } from "../src/engine/notifications/index.js";

const W1A_EVENT_NAMES = [
  "integration.author.started",
  "integration.author.attempt",
  "integration.author.succeeded",
  "integration.author.failed",
] as const;

type W1aEventName = (typeof W1A_EVENT_NAMES)[number];

const eventTypesSeed = [
  ...readFileSync(new URL("../../../db/src/eventTypesSeed.ts", import.meta.url), "utf8").matchAll(
    /\{ name: "(?<name>[^"]+)", defaultSeverity: "(?<defaultSeverity>ok|info|warn|fail)" \}/gu,
  ),
].map(({ groups }) => ({
  name: groups?.["name"] ?? "",
  defaultSeverity: groups?.["defaultSeverity"] ?? "",
}));

const validPayloads: Record<W1aEventName, unknown> = {
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
};

const expectedSensitivityPaths: Record<W1aEventName, readonly string[]> = {
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

function parses(eventName: W1aEventName, payload: unknown): boolean {
  return EventRegistry[eventName].safeParse(payload).success;
}

describe("mission-complete W1-A integration.author event vocabulary", () => {
  it("registers exactly the four frozen names with seed and severity ok/info/ok/fail", () => {
    for (const eventName of W1A_EVENT_NAMES) {
      expect(listEventNames()).toContain(eventName);
      expect(parses(eventName, validPayloads[eventName])).toBe(true);
    }

    expect(eventTypesSeed.filter(({ name }) => (W1A_EVENT_NAMES as readonly string[]).includes(name))).toEqual([
      { name: "integration.author.attempt", defaultSeverity: "info" },
      { name: "integration.author.failed", defaultSeverity: "fail" },
      { name: "integration.author.started", defaultSeverity: "ok" },
      { name: "integration.author.succeeded", defaultSeverity: "ok" },
    ]);
    expect(W1A_EVENT_NAMES.map((name) => [name, defaultSeverityFor(name)])).toEqual([
      ["integration.author.started", "ok"],
      ["integration.author.attempt", "info"],
      ["integration.author.succeeded", "ok"],
      ["integration.author.failed", "fail"],
    ]);
  });

  it("wires w1aEventRegistry into EventRegistry without PREP draft authority", () => {
    expect(Object.keys(w1aEventRegistry)).toEqual([...W1A_EVENT_NAMES]);
    for (const [name, schema] of Object.entries(w1aEventRegistry)) {
      expect(EventRegistry[name as W1aEventName]).toBe(schema);
    }
    const registrySource = readFileSync(new URL("../src/engine/events/registry.ts", import.meta.url), "utf8");
    expect(registrySource).toContain("w1aEventRegistry");
    expect(registrySource).not.toContain("integrationAuthorEventPayloadDrafts");
    expect(registrySource).not.toContain("contracts/prep/");
  });

  it("rejects unknown keys and bound/enum violations at every strict boundary", () => {
    for (const eventName of W1A_EVENT_NAMES) {
      expect(parses(eventName, { ...(validPayloads[eventName] as object), unexpected: true })).toBe(false);
      expect(parses(eventName, { ...(validPayloads[eventName] as object), orgId: "forbidden" })).toBe(false);
    }

    const attempt = validPayloads["integration.author.attempt"] as Record<string, unknown>;
    expect(parses("integration.author.attempt", { ...attempt, missionNodeId: "in-8" })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, unitId: "" })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, unitId: "u".repeat(257) })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, attempt: 0 })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, attempt: 1.5 })).toBe(false);
    expect(
      parses("integration.author.attempt", {
        ...attempt,
        bodyPreview: "x".repeat(AUTHORING_ATTEMPT_BODY_PREVIEW_MAX + 1),
      }),
    ).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, canonicalSignature: "" })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, canonicalSignature: "s".repeat(257) })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, rejection: "x".repeat(2_001) })).toBe(false);
    expect(parses("integration.author.attempt", { ...attempt, decision: "retry" })).toBe(false);

    expect(parses("integration.author.succeeded", { ...validPayloads["integration.author.succeeded"], attempts: 0 })).toBe(
      false,
    );
    expect(parses("integration.author.failed", { ...validPayloads["integration.author.failed"], reason: "" })).toBe(
      false,
    );
    expect(parses("integration.author.failed", { ...validPayloads["integration.author.failed"], attempts: -1 })).toBe(
      false,
    );
  });

  it("accepts all three attempt decisions and failed attempts at zero", () => {
    for (const decision of ["continue", "converged", "halted_fixed_point"] as const) {
      expect(
        parses("integration.author.attempt", {
          ...validPayloads["integration.author.attempt"],
          decision,
        }),
      ).toBe(true);
    }
    expect(parses("integration.author.failed", validPayloads["integration.author.failed"])).toBe(true);
    expect(parses("integration.author.started", { missionNodeId: "in-7", unitId: "u" })).toBe(true);
  });

  it("registers exactly the sixteen frozen public sensitivity leaves", () => {
    let leafCount = 0;
    for (const eventName of W1A_EVENT_NAMES) {
      const actualPaths = [...listSensitivityPathsFor(eventName)].sort();
      const expectedPaths = [...expectedSensitivityPaths[eventName]].sort();
      expect(actualPaths).toEqual(expectedPaths);
      leafCount += actualPaths.length;
      for (const path of actualPaths) {
        expect(sensitivityFor(eventName, path)).toBe("public");
      }
    }
    expect(leafCount).toBe(16);
  });
});

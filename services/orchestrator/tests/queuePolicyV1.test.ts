import { describe, expect, it } from "vitest";
import {
  QueueCommandV1Schema,
  QueuePolicyV1Schema,
  QueueWindowV1Schema,
  matchesQueueMatcher,
} from "../src/engine/merge/queuePolicy.js";

const policy = {
  schemaVersion: "queue_policy.v1",
  routes: [
    {
      name: "main",
      targetBranch: "main",
      matcher: {
        kind: "all",
        clauses: [
          { kind: "branch", equals: "main" },
          { kind: "schedule", window: "business" },
        ],
      },
      priority: { base: "P1", aging: { enabled: true, step: 1 } },
      partition: { mode: "scoped", capacity: 2, batchLimit: 2, deployGroupLimit: 1 },
      interruption: { mode: "hold" },
      requiredWindows: ["business"],
    },
  ],
};

describe("QueuePolicyV1 frozen grammar", () => {
  it("rejects command/expression escapes and blank control inputs before persistence", () => {
    expect(() => QueuePolicyV1Schema.parse({ ...policy, shell: "rm -rf /" })).toThrow("Unrecognized key");
    expect(() =>
      QueuePolicyV1Schema.parse({
        ...policy,
        routes: [{ ...policy.routes[0], matcher: { kind: "expr", source: "land()" } }],
      }),
    ).toThrow("Invalid input");
    expect(() =>
      QueueCommandV1Schema.parse({
        schemaVersion: "queue_command.v1",
        command: "land",
        idempotencyKey: "i",
        scope: { projectId: "p" },
      }),
    ).toThrow("Invalid input");
    expect(() =>
      QueueCommandV1Schema.parse({
        schemaVersion: "queue_command.v1",
        command: "freeze",
        idempotencyKey: "freeze-1",
        scope: { projectId: "p" },
        reason: "freeze",
        bypassAuthority: true,
      }),
    ).toThrow("Unrecognized key");
    expect(() =>
      QueueCommandV1Schema.parse({
        schemaVersion: "queue_command.v1",
        command: "freeze",
        idempotencyKey: " ",
        scope: { projectId: "p" },
        reason: "freeze",
      }),
    ).toThrow("Too small");
    expect(() =>
      QueueWindowV1Schema.parse({
        schemaVersion: "queue_window.v1",
        name: "x",
        kind: "allow",
        timezone: "UTC",
        scope: { projectId: "p" },
        intervals: [],
      }),
    ).toThrow("Too small");
  });

  it("fails closed when matcher evidence is unobservable, including through not", () => {
    const parsed = QueuePolicyV1Schema.parse(policy);
    expect(matchesQueueMatcher(parsed.routes[0].matcher, { branch: "main", openWindows: new Set(["business"]) })).toBe(
      true,
    );
    expect(matchesQueueMatcher({ kind: "not", clause: { kind: "labels", includes: "skip" } }, { branch: "main" })).toBe(
      false,
    );
  });

  it("evaluates every closed matcher leaf without treating missing evidence as a match", () => {
    const facts = {
      branch: "main",
      labels: ["release"],
      paths: ["packages/api.ts"],
      author: "octavia",
      review: "approved" as const,
      checks: { unit: "passed" as const },
      scope: "backend",
      openWindows: new Set(["business"]),
    };
    expect(matchesQueueMatcher({ kind: "branch", equals: "main" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "labels", includes: "release" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "paths", includes: "packages/api.ts" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "author", equals: "octavia" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "review", state: "approved" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "check", name: "unit", state: "passed" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "scope", equals: "backend" }, facts)).toBe(true);
    expect(matchesQueueMatcher({ kind: "schedule", window: "business" }, facts)).toBe(true);
    expect(
      matchesQueueMatcher(
        {
          kind: "any",
          clauses: [
            { kind: "branch", equals: "other" },
            { kind: "scope", equals: "backend" },
          ],
        },
        facts,
      ),
    ).toBe(true);
    expect(matchesQueueMatcher({ kind: "check", name: "missing", state: "passed" }, facts)).toBe(false);
  });
});

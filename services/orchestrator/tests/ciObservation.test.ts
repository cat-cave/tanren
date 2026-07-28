// The native external-check evaluator (`evaluateCiObservation`) — a pure reducer over
// a forge check snapshot. The native gate is the merge authority, so this is NOT a
// merge-gating poll; it is how the post-merge regression watcher interprets the
// external CI on `default_branch` (and the future external-check escape hatch). These
// assert the classification + required-check gating against hand-built snapshots.

import { describe, expect, it } from "vitest";
import { parseGitHubPullRequestUrl } from "../src/engine/providers/github.js";
import { parseRequiredCheckAppIds, parseRequiredContexts } from "../src/engine/providers/githubChecksParse.js";
import { evaluateCiObservation } from "../src/engine/workflow/ciObservation.js";

describe("evaluateCiObservation — forge check snapshot reducer", () => {
  it("parses required branch checks with exact GitHub App identities", () => {
    expect(
      parseRequiredCheckAppIds({
        checks: [
          { context: "build", app_id: 123 },
          { context: "legacy", app_id: null },
        ],
      }),
    ).toEqual({ build: 123 });
  });
  it("rejects malformed required app identities instead of dropping the binding", () => {
    expect(() =>
      parseRequiredCheckAppIds({
        checks: [{ context: "build", app_id: "123" }],
      }),
    ).toThrow(/invalid app_id/u);
  });
  it("preserves a prototype-named app binding through required-check gating", () => {
    const requiredCheckAppIds = parseRequiredCheckAppIds({
      checks: [{ context: "__proto__", app_id: 123 }],
    });
    expect(Object.getPrototypeOf(requiredCheckAppIds)).toBeNull();
    expect(requiredCheckAppIds["__proto__"]).toBe(123);

    const observation = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [{ name: "__proto__", status: "completed", conclusion: "success", appId: 999 }],
        statuses: [],
        requiredCheckAppIds,
      },
      { quarantinedCheckNames: new Set(["__proto__"]) },
    );
    expect(observation.status).toBe("failed");
    expect(observation.failingChecks[0]).toMatchObject({ name: "__proto__", state: "wrong_app_identity" });
  });
  it("rejects conflicting duplicate required context/app bindings", () => {
    expect(() =>
      parseRequiredCheckAppIds({
        checks: [
          { context: "build", app_id: 123 },
          { context: "build", app_id: 456 },
        ],
      }),
    ).toThrow(/conflicting app_id/u);
    expect(() => parseRequiredContexts({ checks: [{ context: "build" }, { context: "build" }] })).toThrow(
      /duplicate contexts/u,
    );
  });
  it("fails closed on malformed or conflicting required-protection evidence", () => {
    const malformedPayloads: ReadonlyArray<readonly [unknown, RegExp]> = [
      [null, /not an object/u],
      [[], /not an object/u],
      [{ checks: {} }, /non-array checks/u],
      [{ contexts: {} }, /non-array contexts/u],
      [{ checks: [{ context: 7 }] }, /missing context/u],
      [{ checks: [null] }, /not an object/u],
    ];
    for (const [payload, reason] of malformedPayloads) {
      expect(() => parseRequiredContexts(payload)).toThrow(reason);
      expect(() => parseRequiredCheckAppIds(payload)).toThrow(reason);
    }
    expect(() => parseRequiredContexts({ checks: [{ context: "build", app_id: 123 }], contexts: ["e2e"] })).toThrow(
      /disagreed/u,
    );
    expect(() => parseRequiredContexts({ checks: [], contexts: ["build"] })).toThrow(/disagreed/u);
    // An explicit empty array is the only valid no-required-check proof; the
    // two response representations cannot disagree about it.
    expect(parseRequiredContexts({ checks: [] })).toEqual([]);
    expect(parseRequiredContexts({ contexts: [] })).toEqual([]);
    expect(parseRequiredContexts({ contexts: ["legacy"] })).toEqual(["legacy"]);
    expect(parseRequiredCheckAppIds({ contexts: ["legacy"] })).toEqual({});
  });
  it("parses GitHub PR URLs and classifies pending, passing, and failing checks", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/cat-cave/tanren-fixture-easy/pull/1")).toEqual({
      repo: { owner: "cat-cave", name: "tanren-fixture-easy" },
      pullNumber: 1,
    });
    expect(() => parseGitHubPullRequestUrl("https://example.com/cat-cave/repo/pull/1")).toThrow("unsupported GitHub");

    expect(evaluateCiObservation({ head: { sha: "abc" }, checkRuns: [], statuses: [] })).toMatchObject({
      status: "pending",
      reason: "no_checks",
    });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [{ context: "legacy", state: "success" }],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "in_progress" }],
        statuses: [],
      }),
    ).toMatchObject({ status: "pending", reason: "checks_pending" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "timed_out" }],
        statuses: [{ context: "legacy", state: "success" }],
      }),
    ).toMatchObject({ status: "failed", reason: "check_failed" });
  });

  it("gates on required branch-protection checks only", () => {
    // A required check that hasn't reported yet keeps the result pending even
    // though every OBSERVED check is green.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [],
        requiredContexts: ["build", "e2e"],
      }),
    ).toMatchObject({ status: "pending", reason: "checks_pending" });

    // An OPTIONAL check failing does not block when it isn't required.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint-optional", status: "completed", conclusion: "failure" },
        ],
        statuses: [],
        requiredContexts: ["build"],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });

    // A REQUIRED check failing fails the verdict.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
        requiredContexts: ["build"],
      }),
    ).toMatchObject({ status: "failed", reason: "check_failed" });

    // All required contexts present + green → passed.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "e2e", status: "completed", conclusion: "success" },
        ],
        statuses: [],
        requiredContexts: ["build", "e2e"],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("excludes a quarantined check from the failure verdict", () => {
    expect(
      evaluateCiObservation(
        {
          head: { sha: "abc" },
          checkRuns: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "flaky-e2e", status: "completed", conclusion: "failure" },
          ],
          statuses: [],
        },
        { quarantinedCheckNames: new Set(["flaky-e2e"]) },
      ),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("never lets quarantine suppress a required failure or wrong-app check", () => {
    const failed = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure", appId: 999 }],
        statuses: [],
        requiredContexts: ["build"],
        requiredCheckAppIds: { build: 123 },
      },
      { quarantinedCheckNames: new Set(["build"]) },
    );
    expect(failed.status).toBe("failed");
    expect(failed.failingChecks[0]).toMatchObject({ name: "build", state: "wrong_app_identity" });

    const legacyStatus = evaluateCiObservation({
      head: { sha: "abc" },
      checkRuns: [],
      statuses: [{ context: "build", state: "success" }],
      requiredContexts: ["build"],
      requiredCheckAppIds: { build: 123 },
    });
    expect(legacyStatus.status).toBe("pending");
    expect(legacyStatus.pendingChecks[0]).toMatchObject({ name: "build", state: "expected" });

    const appBoundWithoutContextList = evaluateCiObservation(
      {
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success", appId: 999 }],
        statuses: [],
        requiredCheckAppIds: { build: 123 },
      },
      { quarantinedCheckNames: new Set(["build"]) },
    );
    expect(appBoundWithoutContextList.status).toBe("failed");
    expect(appBoundWithoutContextList.failingChecks[0]).toMatchObject({
      name: "build",
      state: "wrong_app_identity",
    });
  });
});

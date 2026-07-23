import { describe, expect, it, vi } from "vitest";
import {
  authorizeAndSquashMerge,
  type MergeAuthorizationInput,
  type MergeAuthorizationSnapshot,
  type MergeAuthorityGateway,
} from "../src/mergeAuthority.js";
import { firstSha, secondSha } from "./helpers.js";

const mergeSha = "3".repeat(40);
const input: MergeAuthorizationInput = {
  pr: 1240,
  auditedHeadSha: firstSha,
  auditedBaseSha: secondSha,
  auditedIssueNumber: 1247,
  casHeadSha: firstSha,
  rubricVersion: "2026-07-22",
};

function green(): MergeAuthorizationSnapshot {
  return {
    pr: 1240,
    repository: "cat-cave/tanren",
    state: "OPEN",
    isDraft: false,
    baseBranch: "main",
    baseSha: secondSha,
    headSha: firstSha,
    title: "Complete CRA",
    body: "Closes #1247",
    historyVersion: `v1:${firstSha}`,
    rulesetVersion: "rules-v1",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    auditedIssueNumber: 1247,
    sourceIssues: [{ number: 1247, state: "OPEN", appropriate: true, blockers: [{ number: 1246, state: "CLOSED" }] }],
    latestCraReview: {
      id: 55,
      actor: "trevor-workstation[bot]",
      state: "APPROVED",
      headSha: firstSha,
      rubricVersion: "2026-07-22",
      reportValid: true,
      latest: true,
      dismissed: false,
      findingSeverities: ["P2"],
      unresolvedRequiredChecks: [],
    },
    requiredContexts: ["ci"],
    checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", kind: "check_run" }],
    rateLimited: false,
    health: {
      identity: true,
      permissions: true,
      singletonLease: true,
      statePersistence: true,
      readAfterWrite: true,
    },
  };
}

function gateway(reads: readonly MergeAuthorizationSnapshot[]): MergeAuthorityGateway & {
  squashMerge: ReturnType<typeof vi.fn<MergeAuthorityGateway["squashMerge"]>>;
} {
  let cursor = 0;
  return {
    readFresh: vi.fn<MergeAuthorityGateway["readFresh"]>(async () => reads[Math.min(cursor++, reads.length - 1)]!),
    squashMerge: vi.fn<MergeAuthorityGateway["squashMerge"]>(async () => ({
      merged: true,
      mergeCommitSha: mergeSha,
    })),
    readMerged: vi.fn<MergeAuthorityGateway["readMerged"]>(async () => ({
      state: "MERGED",
      headSha: firstSha,
      mergeCommitSha: mergeSha,
    })),
  };
}

async function expectDenied(...reads: readonly MergeAuthorizationSnapshot[]) {
  const fake = gateway(reads);
  const result = await authorizeAndSquashMerge({ gateway: fake }, input);
  expect(result.merged).toBe(false);
  expect(fake.squashMerge).not.toHaveBeenCalled();
}

describe("fresh fail-closed merge authorization", () => {
  it("invokes exactly one SHA-CAS squash merge and verifies returned state before post-merge routing", async () => {
    const fake = gateway([green(), green(), green()]);
    const route = vi.fn<(sha: string) => Promise<void>>(async () => {});
    const result = await authorizeAndSquashMerge({ gateway: fake, afterVerifiedMerge: route }, input);
    expect(result).toEqual({ merged: true, verified: true, mergeCommitSha: mergeSha, reasons: [] });
    expect(fake.squashMerge).toHaveBeenCalledOnce();
    expect(fake.squashMerge).toHaveBeenCalledWith(1240, firstSha);
    expect(route).toHaveBeenCalledWith(mergeSha);
  });

  it("denies the audited-issue body-swap attack without merging or closing the substituted issue", async () => {
    const substitutedIssue = {
      ...green(),
      body: "Closes #999",
      historyVersion: "v2",
      sourceIssues: [{ number: 999, state: "OPEN", appropriate: false, blockers: [] }],
    };
    const fake = gateway([green(), substitutedIssue]);
    const result = await authorizeAndSquashMerge({ gateway: fake }, input);
    expect(result.merged).toBe(false);
    expect(result.reasons).toContain("live closing issue differs from audited issue");
    expect(fake.squashMerge).not.toHaveBeenCalled();
    expect(substitutedIssue.sourceIssues[0]?.state).toBe("OPEN");
  });

  it.each(["missing", "pending"])("denies an inherited org required check that is %s", async (condition) => {
    const snapshot = {
      ...green(),
      requiredContexts: ["ci", "org/security"],
      checks:
        condition === "missing"
          ? green().checks
          : [
              ...green().checks,
              {
                name: "org/security",
                status: "IN_PROGRESS",
                conclusion: null,
                kind: "check_run" as const,
              },
            ],
    };
    await expectDenied(snapshot);
  });

  it("denies a disposition-bound approval superseded by a later CRA review for the same head", async () => {
    await expectDenied({ ...green(), latestCraReview: { ...green().latestCraReview!, latest: false } });
  });

  it("re-reads immediately before merge and denies a review dismissed after the stable snapshot", async () => {
    const dismissed = {
      ...green(),
      latestCraReview: { ...green().latestCraReview!, state: "DISMISSED", dismissed: true },
    };
    const fake = gateway([green(), green(), dismissed]);
    const result = await authorizeAndSquashMerge({ gateway: fake }, input);
    expect(result.merged).toBe(false);
    expect(result.reasons).toContain("CRA review was dismissed");
    expect(fake.squashMerge).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unknown check",
      () => ({ checks: [{ name: "ci", status: "COMPLETED", conclusion: null, kind: "check_run" as const }] }),
    ],
    ["missing check", () => ({ checks: [] })],
    [
      "pending check",
      () => ({ checks: [{ name: "ci", status: "IN_PROGRESS", conclusion: null, kind: "check_run" as const }] }),
    ],
    [
      "skipped check",
      () => ({ checks: [{ name: "ci", status: "COMPLETED", conclusion: "SKIPPED", kind: "check_run" as const }] }),
    ],
    ["behind base", () => ({ mergeStateStatus: "BEHIND" })],
    ["conflict", () => ({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })],
    ["draft PR", () => ({ isDraft: true })],
    ["wrong target", () => ({ baseBranch: "release" })],
    ["ambiguous source issue", () => ({ sourceIssues: [...green().sourceIssues, ...green().sourceIssues] })],
    [
      "dismissed review",
      () => ({ latestCraReview: { ...green().latestCraReview!, state: "DISMISSED", dismissed: true } }),
    ],
    ["stale rubric", () => ({ latestCraReview: { ...green().latestCraReview!, rubricVersion: "old" } })],
    ["invalid report", () => ({ latestCraReview: { ...green().latestCraReview!, reportValid: false } })],
    [
      "unresolved audit check",
      () => ({ latestCraReview: { ...green().latestCraReview!, unresolvedRequiredChecks: ["ci"] } }),
    ],
    ["P0 present", () => ({ latestCraReview: { ...green().latestCraReview!, findingSeverities: ["P0"] as const } })],
    ["P1 present", () => ({ latestCraReview: { ...green().latestCraReview!, findingSeverities: ["P1"] as const } })],
    [
      "open blocked_by",
      () => ({ sourceIssues: [{ ...green().sourceIssues[0]!, blockers: [{ number: 1246, state: "OPEN" }] }] }),
    ],
    ["missing required-check set", () => ({ requiredContexts: [] })],
    ["rate limit", () => ({ rateLimited: true })],
    ["unhealthy identity", () => ({ health: { ...green().health, identity: false } })],
    ["unhealthy permissions", () => ({ health: { ...green().health, permissions: false } })],
    ["lost singleton lease", () => ({ health: { ...green().health, singletonLease: false } })],
    ["unhealthy persistence", () => ({ health: { ...green().health, statePersistence: false } })],
    ["failed review read-after-write", () => ({ health: { ...green().health, readAfterWrite: false } })],
  ])("denies %s without invoking merge", async (_name, mutate) => {
    await expectDenied({ ...green(), ...mutate() });
  });

  it("denies a changed head or base during the decision", async () => {
    await expectDenied(green(), { ...green(), headSha: "4".repeat(40), historyVersion: "v2" });
    await expectDenied(green(), { ...green(), baseSha: "5".repeat(40), historyVersion: "v2" });
  });

  it("denies a scope, review, or ruleset change during the decision", async () => {
    await expectDenied(green(), { ...green(), body: "different scope", historyVersion: "v2" });
    await expectDenied(green(), { ...green(), rulesetVersion: "rules-v2" });
    await expectDenied(green(), { ...green(), latestCraReview: { ...green().latestCraReview!, dismissed: true } });
  });

  it("converts read/rate/API uncertainty into denial, never approval", async () => {
    const fake = gateway([green()]);
    fake.readFresh = vi.fn<MergeAuthorityGateway["readFresh"]>(async () => {
      throw new Error("rate limited");
    });
    const result = await authorizeAndSquashMerge({ gateway: fake }, input);
    expect(result.reasons[0]).toContain("unconfirmable");
    expect(fake.squashMerge).not.toHaveBeenCalled();
  });

  it("does not route findings when post-merge verification disagrees", async () => {
    const fake = gateway([green(), green(), green()]);
    fake.readMerged = vi.fn<MergeAuthorityGateway["readMerged"]>(async () => ({
      state: "OPEN",
      headSha: firstSha,
      mergeCommitSha: null,
    }));
    const route = vi.fn<(sha: string) => Promise<void>>(async () => {});
    const result = await authorizeAndSquashMerge({ gateway: fake, afterVerifiedMerge: route }, input);
    expect(result.verified).toBe(false);
    expect(fake.squashMerge).toHaveBeenCalledOnce();
    expect(route).not.toHaveBeenCalled();
  });
});

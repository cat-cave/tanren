// Seam conformance suite for the VcsProvider contract
// (`engine/contracts/vcsProvider.ts`, autonomy-engine.md §2d). The reusable
// behavior spec every VcsProvider implementation must satisfy — the
// provider-agnostic surface over the run+merge lifecycle's VCS/CI operations. It
// pins the CONTRACT behaviorally, through the public surface + observable
// effects only (never private fields or transport internals): credential
// resolution yields a usable token + working refresh; URL parsing round-trips;
// opening a draft PR signals reuse; mark-ready is idempotent; CI/check + review
// reads return the contract shapes; a merge distinguishes merged from a conflict
// (recoverable); and a base-branch file read returns the content or `undefined`
// when absent. Mirrors the Allocator / DagWalker / Repositories suites.
//
// The SAME spec runs against the REAL `GitHubVcsProvider` (over a scripted HTTP
// transport) AND a purely in-memory contract fake, so a future provider
// (GitLab) gets contract coverage by adding one harness entry.

import { describe, expect, it } from "vitest";
import {
  RepositoryAlreadyExistsError,
  type ActorIdentity,
  type ResolvedVcsToken,
  type VcsProvider,
} from "../../src/engine/contracts/vcsProvider.js";

/**
 * What a per-implementation test file hands the suite. `make()` returns a FRESH
 * provider whose operations are wired to behave per the scripted scenario the
 * suite drives (the scenarios below name well-known repos/PRs/refs the harness
 * primes). `creds()` returns a credential context the provider's `resolveToken`
 * can resolve. The scenario constants keep the harnesses and the assertions in
 * lockstep without leaking transport details into the spec.
 */
export interface VcsProviderConformanceHarness {
  /** Build a fresh provider wired for the conformance scenario. */
  make(): VcsProvider;
  /** A credential context `resolveToken` can resolve to a usable token. */
  creds(): Parameters<VcsProvider["resolveToken"]>[0];
}

/** The repo/PR/ref/file the harnesses prime and the suite asserts against. */
export const CONFORMANCE_REPO_URL = "https://github.com/cat-cave/tanren-conformance";
export const CONFORMANCE_PR_URL = "https://github.com/cat-cave/tanren-conformance/pull/7";
export const CONFORMANCE_BASE_BRANCH = "main";
export const CONFORMANCE_PRESENT_FILE = "tanren-ci.yml";
export const CONFORMANCE_PRESENT_FILE_BODY = "version: 1\n";
export const CONFORMANCE_ABSENT_FILE = "does/not/exist.yml";
export const CONFORMANCE_CONFLICT_PR_NUMBER = 9;
/** a PR whose branch is behind base (clean update available). */
export const CONFORMANCE_BEHIND_PR_NUMBER = 11;
/** a PR whose branch conflicts with base (update-branch reports a conflict). */
export const CONFORMANCE_DIRTY_PR_NUMBER = 13;
export const CONFORMANCE_HEAD_BRANCH = "tanren/run_conf";
/** a branch that does not exist (readBranchHeadSha → undefined). */
export const CONFORMANCE_ABSENT_BRANCH = "tanren/does-not-exist";
/** the ephemeral integration ref `deleteBranch`'s idempotent-cleanup conformance pins. */
export const CONFORMANCE_INTEGRATION_BRANCH = "tanren/integ/spec_c";
/** a branch ref whose CI (readBranchChecks) is GREEN (prospective merged state passes). */
export const CONFORMANCE_GREEN_BRANCH = "tanren/integ/green";
/** a branch ref whose CI (readBranchChecks) is FAILING (a bad interaction). */
export const CONFORMANCE_FAILING_BRANCH = "tanren/integ/failing";
/**
 * MERGE-SAFETY (self-identity): the actor identity `resolveActorIdentity` resolves
 * for the static credential the suite primes (the GitHub harness's `GET /user`
 * serves this login+id; the in-memory fake returns it directly). The noreply is
 * the canonical `<id>+<login>@users.noreply.github.com`.
 */
export const CONFORMANCE_ACTOR_LOGIN = "tanren-bot-user";
export const CONFORMANCE_ACTOR_ID = "424242";
export const CONFORMANCE_ACTOR_NOREPLY_EMAIL = "424242+tanren-bot-user@users.noreply.github.com";
/** GREENFIELD: the owner + names the suite creates a brand-new repo under. */
export const CONFORMANCE_REPO_OWNER = "cat-cave";
export const CONFORMANCE_NEW_REPO_NAME = "tanren-greenfield-new";
/** GREENFIELD: a repo name that already exists (createRepository → typed 422 error). */
export const CONFORMANCE_EXISTING_REPO_NAME = "tanren-greenfield-taken";

const REPO = { owner: "cat-cave", name: "tanren-conformance" };

/**
 * Behavior spec every VcsProvider implementation must pass. Call once per impl.
 */
export function describeVcsProviderConformance(label: string, harness: VcsProviderConformanceHarness): void {
  describe(`VcsProvider conformance: ${label}`, () => {
    const resolve = async (provider: VcsProvider): Promise<ResolvedVcsToken> => provider.resolveToken(harness.creds());

    it("resolveToken yields a non-empty token + a working refresh supplier", async () => {
      const provider = harness.make();
      const resolved = await resolve(provider);
      expect(typeof resolved.token).toBe("string");
      expect(resolved.token.length).toBeGreaterThan(0);
      expect(resolved.source === "github_app" || resolved.source === "static").toBe(true);
      const refreshed = await resolved.refresh();
      expect(typeof refreshed).toBe("string");
      expect(refreshed.length).toBeGreaterThan(0);
    });

    it("resolveActorIdentity resolves Tanren's pushing login + id + a canonical noreply email", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const actor: ActorIdentity = await provider.resolveActorIdentity(token);
      expect(actor.login).toBe(CONFORMANCE_ACTOR_LOGIN);
      expect(actor.id).toBe(CONFORMANCE_ACTOR_ID);
      // The noreply email is the canonical <id>+<login>@users.noreply.github.com
      // (what the runner sets git user.email to so commits attribute to the login).
      expect(actor.noreplyEmail).toBe(CONFORMANCE_ACTOR_NOREPLY_EMAIL);
      expect(actor.noreplyEmail).toContain(actor.id);
      expect(actor.noreplyEmail).toContain(actor.login);
    });

    it("parseRepository round-trips a clone URL to owner/name", () => {
      const provider = harness.make();
      expect(provider.parseRepository(CONFORMANCE_REPO_URL)).toEqual(REPO);
    });

    it("parsePullRequest round-trips a PR URL to repo + number", () => {
      const provider = harness.make();
      expect(provider.parsePullRequest(CONFORMANCE_PR_URL)).toEqual({ repo: REPO, number: 7 });
    });

    it("readPullRequestState proves an open unmerged PR state", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const state = await provider.readPullRequestState({ repo: REPO, number: 7 }, token);
      expect(state).toEqual({ confirmed: true, merged: false, open: true });
    });

    it("openDraftPullRequest returns a PR with url/number and a reused flag", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const opened = await provider.openDraftPullRequest({
        repo: REPO,
        token,
        headBranch: "tanren/run_conf",
        baseBranch: CONFORMANCE_BASE_BRANCH,
        title: "conformance",
      });
      expect(typeof opened.url).toBe("string");
      expect(opened.url.length).toBeGreaterThan(0);
      expect(Number.isInteger(opened.number)).toBe(true);
      expect(typeof opened.reused).toBe("boolean");
    });

    it("createIssue opens a tracking issue and returns its number + url", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const issue = await provider.createIssue({
        repo: REPO,
        token,
        title: "post-merge CI failed",
        body: "the post-merge check failed on main",
        labels: ["tanren:post-merge-failure"],
      });
      expect(Number.isInteger(issue.number)).toBe(true);
      expect(issue.number).toBeGreaterThan(0);
      expect(typeof issue.url).toBe("string");
      expect(issue.url.length).toBeGreaterThan(0);
    });

    // ---- GREENFIELD: createRepository -----------------------------------

    it("createRepository creates a brand-new repo and returns full_name/url/default_branch", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const created = await provider.createRepository(
        { owner: CONFORMANCE_REPO_OWNER, name: CONFORMANCE_NEW_REPO_NAME, private: true, autoInit: true },
        token,
      );
      expect(created.fullName).toBe(`${CONFORMANCE_REPO_OWNER}/${CONFORMANCE_NEW_REPO_NAME}`);
      expect(typeof created.repoUrl).toBe("string");
      expect(created.repoUrl.length).toBeGreaterThan(0);
      // auto_init seeded a default branch so the repo is immediately cloneable.
      expect(typeof created.defaultBranch).toBe("string");
      expect(created.defaultBranch.length).toBeGreaterThan(0);
    });

    it("createRepository surfaces a typed already-exists error for a taken name (not a stack trace)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      await expect(
        provider.createRepository(
          { owner: CONFORMANCE_REPO_OWNER, name: CONFORMANCE_EXISTING_REPO_NAME, private: true, autoInit: true },
          token,
        ),
      ).rejects.toBeInstanceOf(RepositoryAlreadyExistsError);
    });

    it("markReadyForReview resolves (idempotent un-draft)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      await expect(provider.markReadyForReview({ repo: REPO, number: 7 }, token)).resolves.toBeUndefined();
    });

    it("readPullRequestChecks returns a head sha + check/status arrays", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const checks = await provider.readPullRequestChecks({ repo: REPO, number: 7 }, token);
      expect(typeof checks.head.sha).toBe("string");
      expect(Array.isArray(checks.checkRuns)).toBe(true);
      expect(Array.isArray(checks.statuses)).toBe(true);
    });

    it("readReviewVerdict reduces to one of the actionable verdicts", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const verdict = await provider.readReviewVerdict({ repo: REPO, number: 7 }, token);
      expect(["approved", "changes_requested", "pending"]).toContain(verdict.verdict);
    });

    it("readPullRequestDiff returns a string", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const diff = await provider.readPullRequestDiff({ repo: REPO, number: 7 }, token);
      expect(typeof diff).toBe("string");
    });

    it("listContributors returns the distinct logins", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const contributors = await provider.listContributors({ repo: REPO, number: 7 }, token);
      expect(Array.isArray(contributors.logins)).toBe(true);
    });

    it("mergePullRequest of a mergeable PR reports merged with a sha", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const result = await provider.mergePullRequest({ repo: REPO, number: 7 }, token);
      expect(result.merged).toBe(true);
      expect(result.conflict).toBe(false);
      expect(typeof result.mergeSha).toBe("string");
    });

    it("mergePullRequest of a conflicted PR reports a recoverable conflict, not a throw", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const result = await provider.mergePullRequest({ repo: REPO, number: CONFORMANCE_CONFLICT_PR_NUMBER }, token);
      expect(result.merged).toBe(false);
      expect(result.conflict).toBe(true);
    });

    it("readFileOnBranch returns the content of a present file", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const content = await provider.readFileOnBranch({
        repo: REPO,
        ref: CONFORMANCE_BASE_BRANCH,
        path: CONFORMANCE_PRESENT_FILE,
        token,
      });
      expect(content).toBe(CONFORMANCE_PRESENT_FILE_BODY);
    });

    it("readFileOnBranch returns undefined for an absent file", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const content = await provider.readFileOnBranch({
        repo: REPO,
        ref: CONFORMANCE_BASE_BRANCH,
        path: CONFORMANCE_ABSENT_FILE,
        token,
      });
      expect(content).toBeUndefined();
    });

    // ----: branch head SHA (change-percolation divergence key) ------

    it("readBranchHeadSha returns a SHA for an existing branch", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const sha = await provider.readBranchHeadSha({ repo: REPO, branch: CONFORMANCE_HEAD_BRANCH, token });
      expect(typeof sha).toBe("string");
      expect(sha).not.toBe("");
    });

    it("readBranchHeadSha returns undefined for a missing branch (deleted ref)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const sha = await provider.readBranchHeadSha({ repo: REPO, branch: CONFORMANCE_ABSENT_BRANCH, token });
      expect(sha).toBeUndefined();
    });

    // ----: branch-ref CI read (batch-check) -------------------------
    it("readBranchChecks reads CI for a GREEN integration ref (prospective merged state passes)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const checks = await provider.readBranchChecks({ repo: REPO, branch: CONFORMANCE_GREEN_BRANCH, token });
      expect(typeof checks.head.sha).toBe("string");
      expect(Array.isArray(checks.checkRuns)).toBe(true);
      // A green ref has no failing check run.
      expect(checks.checkRuns.some((c) => c.conclusion === "failure")).toBe(false);
    });

    it("readBranchChecks reads CI for a FAILING integration ref (a bad interaction)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const checks = await provider.readBranchChecks({ repo: REPO, branch: CONFORMANCE_FAILING_BRANCH, token });
      // The failing ref reports at least one failing check (the bad-interaction signal).
      expect(checks.checkRuns.some((c) => c.conclusion === "failure")).toBe(true);
    });

    // ----: up-to-date / mergeability + update-branch ------------------

    it("readMergeability of a current PR reports clean (not behind) with the refs", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const m = await provider.readMergeability({ repo: REPO, number: 7 }, token);
      expect(m.state).toBe("clean");
      expect(m.behind).toBe(false);
      expect(m.baseBranch).toBe(CONFORMANCE_BASE_BRANCH);
      expect(m.headBranch).toBe(CONFORMANCE_HEAD_BRANCH);
    });

    it("readMergeability of a stale PR reports behind", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const m = await provider.readMergeability({ repo: REPO, number: CONFORMANCE_BEHIND_PR_NUMBER }, token);
      expect(m.state).toBe("behind");
      expect(m.behind).toBe(true);
    });

    it("readMergeability of a conflicting PR reports dirty (routes to the resolver)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const m = await provider.readMergeability({ repo: REPO, number: CONFORMANCE_DIRTY_PR_NUMBER }, token);
      expect(m.state).toBe("dirty");
    });

    it("updateBranch advances a behind PR (updated), idempotent up_to_date on a current PR", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const updated = await provider.updateBranch({ repo: REPO, number: CONFORMANCE_BEHIND_PR_NUMBER }, token);
      expect(updated.outcome).toBe("updated");
      const current = await provider.updateBranch({ repo: REPO, number: 7 }, token);
      expect(current.outcome).toBe("up_to_date");
    });

    it("updateBranch of a conflicting PR reports a recoverable conflict, not a throw", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const result = await provider.updateBranch({ repo: REPO, number: CONFORMANCE_DIRTY_PR_NUMBER }, token);
      expect(result.outcome).toBe("conflict");
    });

    it("retargetPullRequestBase re-points an open PR's base (lands a speculative dep on real main)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      // Resolves (no throw) when GitHub accepts the PATCH /pulls/:n { base }.
      await expect(
        provider.retargetPullRequestBase({ repo: REPO, number: 7 }, CONFORMANCE_BASE_BRANCH, token),
      ).resolves.toBeUndefined();
    });

    it("deleteBranch removes the ephemeral integration ref; a missing ref is success (idempotent)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      await expect(provider.deleteBranch(REPO, CONFORMANCE_INTEGRATION_BRANCH, token)).resolves.toBeUndefined();
      // A second delete (ref already gone) is still success — best-effort cleanup.
      await expect(provider.deleteBranch(REPO, CONFORMANCE_INTEGRATION_BRANCH, token)).resolves.toBeUndefined();
    });
  });
}

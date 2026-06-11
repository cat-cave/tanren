// Seam conformance suite for the residual VcsProvider contract
// (`engine/contracts/vcsProvider.ts`, autonomy-engine.md §2d). After the
// VcsProvider→CodeHost/VisibilityProjection decomposition this pins the surviving
// surface behaviorally, through the public surface + observable effects only (never
// private fields or transport internals): credential resolution yields a usable
// token + working refresh; self-identity resolves the pushing login/id/noreply; URL
// parsing round-trips; the post-merge branch-CI read returns the contract shape; and
// the external-approval review read reduces to one actionable verdict. The merge-
// coordination grain it once carried now lives on `CodeHost`/`VisibilityProjection`
// (whose own conformance suites pin it). Mirrors the Allocator / DagWalker /
// Repositories suites.
//
// The SAME spec runs against the REAL `GitHubVcsProvider` (over a scripted HTTP
// transport) AND a purely in-memory contract fake, so a future provider
// (GitLab) gets contract coverage by adding one harness entry.

import { describe, expect, it } from "vitest";
import type { ActorIdentity, ResolvedVcsToken, VcsProvider } from "../../src/engine/contracts/vcsProvider.js";

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

/** The repo/PR/ref the harnesses prime and the suite asserts against. */
export const CONFORMANCE_REPO_URL = "https://github.com/cat-cave/tanren-conformance";
export const CONFORMANCE_PR_URL = "https://github.com/cat-cave/tanren-conformance/pull/7";
export const CONFORMANCE_HEAD_BRANCH = "tanren/run_conf";
/** a branch ref whose CI (readBranchChecks) is GREEN (post-merge base CI passes). */
export const CONFORMANCE_GREEN_BRANCH = "tanren/integ/green";
/** a branch ref whose CI (readBranchChecks) is FAILING (a post-merge regression). */
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

    // ----: post-merge branch-ref CI read (§5e fork) -----------------------
    it("readBranchChecks reads CI for a GREEN base ref (post-merge CI passes)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const checks = await provider.readBranchChecks({ repo: REPO, branch: CONFORMANCE_GREEN_BRANCH, token });
      expect(typeof checks.head.sha).toBe("string");
      expect(Array.isArray(checks.checkRuns)).toBe(true);
      // A green ref has no failing check run.
      expect(checks.checkRuns.some((c) => c.conclusion === "failure")).toBe(false);
    });

    it("readBranchChecks reads CI for a FAILING base ref (a post-merge regression)", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const checks = await provider.readBranchChecks({ repo: REPO, branch: CONFORMANCE_FAILING_BRANCH, token });
      // The failing ref reports at least one failing check (the regression signal).
      expect(checks.checkRuns.some((c) => c.conclusion === "failure")).toBe(true);
    });

    // ----: external-approval review read (§5f fork) -----------------------
    it("readReviewVerdict reduces to one of the actionable verdicts", async () => {
      const provider = harness.make();
      const token = await resolve(provider);
      const verdict = await provider.readReviewVerdict({ repo: REPO, number: 7 }, token);
      expect(["approved", "changes_requested", "pending"]).toContain(verdict.verdict);
    });
  });
}

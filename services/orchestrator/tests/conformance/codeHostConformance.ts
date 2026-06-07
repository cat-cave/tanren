// Seam conformance suite for the `CodeHost` contract
// (`engine/contracts/codeHost.ts`, tanren-owns-the-engine.md §6). The reusable
// behavior spec EVERY host impl (the Wave-1 GitHub impl; later GitLab/Bitbucket)
// must satisfy — the MINIMAL host surface where the host HOSTS but never DECIDES:
//   - pushRef / fetchRef round-trip (a pushed ref is fetchable at its sha);
//   - landAuthorizedRef ADVANCES main via compare-and-swap (it is a plain push of
//     the AUTHORIZED commit, not a "merge PR" API), and REJECTS a stale CAS;
//   - readDefaultBranch returns the host default branch.
//
// Parameterized by an impl factory (+ a seed hook so the suite can stand up a repo
// in whatever the impl's terms are). Mirrors the existing conformance suites.

import { describe, expect, it } from "vitest";
import type { CodeHost, CodeHostRepoRef } from "../../src/engine/contracts/codeHost.js";

export interface CodeHostConformanceHarness {
  /** A fresh impl per call. */
  make(): CodeHost;
  /**
   * Stand up `repo` with `defaultBranch` at `initialSha` in the impl's terms, so
   * the round-trip + land cases have a base to operate on. (A real GitHub harness
   * creates the repo via the API; the in-memory fake seeds a map.)
   */
  seed(host: CodeHost, repo: CodeHostRepoRef, defaultBranch: string, initialSha: string): Promise<void> | void;
}

const REPO: CodeHostRepoRef = { owner: "owner", name: "repo" };

export function describeCodeHostConformance(label: string, harness: CodeHostConformanceHarness): void {
  describe(`CodeHost conformance: ${label}`, () => {
    it("pushRef / fetchRef ROUND-TRIP (a pushed branch is fetchable at its sha)", async () => {
      const host = harness.make();
      await harness.seed(host, REPO, "main", "sha-main-0");

      await host.pushRef({ repo: REPO, localRef: "refs/heads/feature", remoteBranch: "feature", sha: "sha-feat-1" });
      const fetched = await host.fetchRef({ repo: REPO, remoteBranch: "feature" });

      expect(fetched).toBe("sha-feat-1");
    });

    it("fetchRef returns undefined for an absent branch", async () => {
      const host = harness.make();
      await harness.seed(host, REPO, "main", "sha-main-0");
      expect(await host.fetchRef({ repo: REPO, remoteBranch: "nope" })).toBeUndefined();
    });

    it("readDefaultBranch returns the host default branch", async () => {
      const host = harness.make();
      await harness.seed(host, REPO, "main", "sha-main-0");
      expect(await host.readDefaultBranch(REPO)).toBe("main");
    });

    it("landAuthorizedRef ADVANCES main (compare-and-swap push of the authorized commit)", async () => {
      const host = harness.make();
      await harness.seed(host, REPO, "main", "sha-main-0");

      const result = await host.landAuthorizedRef({
        repo: REPO,
        intoMain: "main",
        authorizedSha: "sha-authorized-1",
        expectedMainSha: "sha-main-0",
      });

      expect(result.mainSha).toBe("sha-authorized-1");
      expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-authorized-1");
    });

    it("landAuthorizedRef REJECTS a stale compare-and-swap (main moved underneath)", async () => {
      const host = harness.make();
      await harness.seed(host, REPO, "main", "sha-main-0");
      // main advanced to a different sha out-of-band.
      await host.pushRef({ repo: REPO, localRef: "refs/heads/main", remoteBranch: "main", sha: "sha-main-1" });

      await expect(
        host.landAuthorizedRef({
          repo: REPO,
          intoMain: "main",
          authorizedSha: "sha-authorized-1",
          // A stale expectation: main already advanced to sha-main-1.
          expectedMainSha: "sha-main-0",
        }),
      ).rejects.toThrow(/reject|stale|expect|conflict|cas/iu);
    });
  });
}

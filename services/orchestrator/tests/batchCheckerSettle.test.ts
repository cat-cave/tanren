// Focused unit test of the PgBatchChecker NO-CHECKS SETTLE (the bug-fix for a no-CI
// repo hanging the native merge queue forever) over a FAKE pool + FAKE VcsProvider
// (test fixtures — they live here, never src/). It proves the SAFETY BOUNDARY of the
// settle:
//   (a) `no_checks` + elapsed < settle           → pending WITH settleAfterMs;
//   (b) `no_checks` + elapsed >= settle           → PASS (nothing to verify; mirror
//       GitHub merging a PR with no required checks + no failing checks);
//   (c) `checks_pending` (real CI registered, not done) → pending REGARDLESS of elapsed
//       (the settle NEVER short-circuits a repo that actually has CI);
//   (d) a failing check                            → fail (never settled — red blocks).
// The settle is anchored on the STABLE `MIN(enqueued_at)` (a fake value here), never the
// ephemeral integration sha. An injectable clock drives the grace deterministically.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgBatchChecker } from "../src/engine/merge/batchChecker.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type { GitHubPullRequestChecks } from "../src/engine/providers/github.js";
import type {
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";

const ORG = "org_1";
const PROJECT = "project_1";
const SETTLE_MS = 45_000;
// The stable anchor every test seeds as MIN(enqueued_at): a fixed wall-clock instant.
const ENQUEUED_AT_MS = 1_000_000;

/** A fake pg pool that routes on SQL fragments to canned rows (covers connect()). */
class FakePool {
  constructor(private readonly minEnqueuedAt: Date | null) {}
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.minEnqueuedAt);
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient(this.minEnqueuedAt).query(sql, params);
  }
}

class FakeClient {
  constructor(private readonly minEnqueuedAt: Date | null) {}
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK")
    ) {
      return { rows: [] };
    }
    // resolveProjectOrg (system scope).
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    // loadProject.
    if (text.includes("FROM projects p") && text.includes("default_branch")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/cat-cave/apex",
            default_branch: "main",
            project_config: { version: 1, credentials: { githubCredentialRef: "credential/github/project" } },
            org_config: { version: 1 },
          },
        ],
      };
    }
    // loadEntryBranches.
    if (text.includes("FROM runs r") && text.includes("DISTINCT ON")) {
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: ids.map((specId) => ({ spec_id: specId, branch: `tanren/${specId}` })) };
    }
    // loadBatchEnqueueAnchorMs: MIN(enqueued_at) over the batch's active queue entries.
    if (text.includes("MIN(enqueued_at)") && text.includes("FROM merge_queue")) {
      return { rows: [{ min_enqueued_at: this.minEnqueuedAt }] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release(): void {}
}

/** A fake VcsProvider: integration always succeeds; readBranchChecks returns canned checks. */
class FakeVcsProvider implements Partial<VcsProvider> {
  constructor(private readonly checks: GitHubPullRequestChecks) {}
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "t", source: "static", refresh: async () => "t2" };
  }
  parseRepository(repoUrl: string): RepoRef {
    const m = /github\.com\/([^/]+)\/([^/]+)/u.exec(repoUrl)!;
    return { owner: m[1]!, name: m[2]! };
  }
  async buildIntegrationBranch(input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    return {
      outcome: "integrated",
      integrationBranch: input.integrationBranch,
      mergedAncestors: input.ancestors.map((a) => a.specId),
      message: "ok",
    };
  }
  async readBranchChecks(): Promise<GitHubPullRequestChecks> {
    return this.checks;
  }
}

function entry(specId: string): MergeQueueEntry {
  return {
    queueId: `q_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://github.com/cat-cave/apex/pull/1`,
    prNumber: 1,
    dependsOn: [],
    priority: "tbd",
    orderKey: 0,
  };
}

function makeChecker(
  checks: GitHubPullRequestChecks,
  nowMs: number,
  minEnqueuedAt: Date | null = new Date(ENQUEUED_AT_MS),
): PgBatchChecker {
  return new PgBatchChecker({
    pool: new FakePool(minEnqueuedAt) as unknown as pg.Pool,
    vcsProvider: new FakeVcsProvider(checks) as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
    now: () => nowMs,
  });
}

// A genuinely-zero-checks integration ref (a no-CI repo): no check-runs, no statuses.
const NO_CHECKS: GitHubPullRequestChecks = { head: { sha: "abc" }, checkRuns: [], statuses: [] };
// A real CI registered but not yet done (a queued/in-progress check-run).
const CHECKS_PENDING: GitHubPullRequestChecks = {
  head: { sha: "abc" },
  checkRuns: [{ name: "build", status: "in_progress" }],
  statuses: [],
};
// A failing check — must ALWAYS block (never settled).
const FAILING: GitHubPullRequestChecks = {
  head: { sha: "abc" },
  checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
  statuses: [],
};

describe("PgBatchChecker — no-checks settle (no-CI repo hang fix)", () => {
  it("(a) no_checks + elapsed < settle → pending WITH settleAfterMs", async () => {
    // 30s elapsed of a 45s grace.
    const checker = makeChecker(NO_CHECKS, ENQUEUED_AT_MS + 30_000);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pending");
    if (verdict.result !== "pending") throw new Error("unreachable");
    expect(verdict.settleAfterMs).toBe(SETTLE_MS - 30_000);
  });

  it("(b) no_checks + elapsed >= settle → PASS (nothing to verify after the grace)", async () => {
    // Exactly at the grace boundary settles.
    const checker = makeChecker(NO_CHECKS, ENQUEUED_AT_MS + SETTLE_MS);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pass");
  });

  it("(c) checks_pending (real CI registered) → pending REGARDLESS of elapsed (NO settle short-circuit)", async () => {
    // Even far past the grace, a real registered-but-pending check NEVER settles.
    const checker = makeChecker(CHECKS_PENDING, ENQUEUED_AT_MS + SETTLE_MS * 100);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pending");
    if (verdict.result !== "pending") throw new Error("unreachable");
    // No settle remainder — a registered-CI pending hold carries no settleAfterMs.
    expect(verdict.settleAfterMs).toBeUndefined();
  });

  it("(d) a failing check → fail (never settled — a red check always blocks)", async () => {
    const checker = makeChecker(FAILING, ENQUEUED_AT_MS + SETTLE_MS * 100);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("fail");
  });

  it("a green prospective state passes immediately (no settle path, unaffected)", async () => {
    const green: GitHubPullRequestChecks = {
      head: { sha: "abc" },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    };
    const checker = makeChecker(green, ENQUEUED_AT_MS + 1);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pass");
  });

  it("holds (does not settle) when the stable anchor is missing (defensive)", async () => {
    // No active queue row ⇒ MIN(enqueued_at) is NULL ⇒ elapsed treated as 0 ⇒ HOLD, even
    // far past wall-clock, rather than settling on a missing anchor.
    const checker = makeChecker(NO_CHECKS, ENQUEUED_AT_MS + SETTLE_MS * 100, null);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pending");
    if (verdict.result !== "pending") throw new Error("unreachable");
    expect(verdict.settleAfterMs).toBe(SETTLE_MS);
  });
});

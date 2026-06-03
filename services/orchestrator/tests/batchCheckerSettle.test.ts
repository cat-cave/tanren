// Focused unit test of the PgBatchChecker NO-CHECKS SETTLE (the bug-fix for a no-CI
// repo hanging the native merge queue forever) over a FAKE pool + FAKE VcsProvider
// (test fixtures — they live here, never src/). The settle is anchored on the head
// entry's PERSISTED `merge_queue.no_checks_since` (NOT `enqueued_at`), so the grace
// measures CONTINUOUS no-checks since checking began — a real-CI repo whose head sat
// in the queue longer than the grace can NEVER settle-merge before its workflow even
// registers a check. It proves the SAFETY BOUNDARY:
//   (a) `no_checks` FIRST observation                → sets no_checks_since + pending;
//   (b) `no_checks` continuous past the grace        → PASS;
//   (c) `checks_pending` (real CI registered)        → CLEARS no_checks_since + pending,
//       REGARDLESS of elapsed (never settles a repo that has CI);
//   (d) a failing check                              → fail (never settled — red blocks);
//   (e) the HOLE: head enqueued long ago, real CI    → first no_checks does NOT settle
//       (sets the clock), then checks_pending clears it, then all_checks_passed → pass;
//   (f) the reset: once checks_pending clears the clock, a later transient no_checks
//       RESTARTS the 45s (does not instantly settle).
// The fake models the persisted `no_checks_since` read/write/clear keyed on the head
// queue id; an injectable clock drives the grace deterministically.

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

/**
 * A stateful fake pg pool: models the `merge_queue.no_checks_since` clock keyed by
 * queue id (a real persisted column), plus the project/branch reads the checker issues.
 * One store instance is shared across `connect()`/`query` so writes persist across the
 * checker's separate org-scoped operations within (and across) checkBatch calls.
 */
class FakePool {
  // queueId -> no_checks_since (ms epoch) | null. Absent key ⇒ NULL.
  readonly noChecksSince = new Map<string, number | null>();
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.noChecksSince);
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient(this.noChecksSince).query(sql, params);
  }
}

class FakeClient {
  constructor(private readonly noChecksSince: Map<string, number | null>) {}
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
    // loadNoChecksSinceMs: SELECT no_checks_since FROM merge_queue WHERE queue_id = $1.
    if (text.includes("SELECT no_checks_since FROM merge_queue")) {
      const queueId = params?.[0] as string;
      const ms = this.noChecksSince.get(queueId);
      return { rows: [{ no_checks_since: ms === undefined || ms === null ? null : new Date(ms) }] };
    }
    // clearNoChecksSince: UPDATE merge_queue SET no_checks_since = NULL WHERE queue_id = $1 ...
    if (text.includes("SET no_checks_since = NULL")) {
      const queueId = params?.[0] as string;
      this.noChecksSince.set(queueId, null);
      return { rows: [] };
    }
    // setNoChecksSince: UPDATE merge_queue SET no_checks_since = $2 WHERE queue_id = $1.
    if (text.includes("SET no_checks_since = $2")) {
      const queueId = params?.[0] as string;
      const iso = params?.[1] as string;
      this.noChecksSince.set(queueId, new Date(iso).getTime());
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release(): void {}
}

/** A fake VcsProvider: integration always succeeds; readBranchChecks returns canned checks. */
class FakeVcsProvider implements Partial<VcsProvider> {
  constructor(private checks: GitHubPullRequestChecks) {}
  setChecks(checks: GitHubPullRequestChecks): void {
    this.checks = checks;
  }
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

/** A mutable clock so a test can advance wall time BETWEEN sequential checkBatch calls. */
class Clock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
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
// An all-green check — passes.
const ALL_PASSED: GitHubPullRequestChecks = {
  head: { sha: "abc" },
  checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
  statuses: [],
};

function makeChecker(pool: FakePool, vcs: FakeVcsProvider, clock: Clock): PgBatchChecker {
  return new PgBatchChecker({
    pool: pool as unknown as pg.Pool,
    vcsProvider: vcs as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
    now: clock.now,
  });
}

describe("PgBatchChecker — no-checks settle (no-CI repo hang fix, no_checks_since anchor)", () => {
  it("(a) no_checks FIRST observation → sets no_checks_since + pending (never settles on first sight)", async () => {
    const pool = new FakePool();
    const clock = new Clock(1_000_000);
    const checker = makeChecker(pool, new FakeVcsProvider(NO_CHECKS), clock);

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pending");
    if (verdict.result !== "pending") throw new Error("unreachable");
    expect(verdict.settleAfterMs).toBe(SETTLE_MS);
    // The clock was STARTED on the head entry (the tail spec's queue row).
    expect(pool.noChecksSince.get("q_spec_a")).toBe(1_000_000);
  });

  it("(b) no_checks continuous past the grace → PASS (clock drives it, not enqueue)", async () => {
    const pool = new FakePool();
    const clock = new Clock(1_000_000);
    const checker = makeChecker(pool, new FakeVcsProvider(NO_CHECKS), clock);

    // First pass starts the clock + holds.
    const first = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(first.result).toBe("pending");

    // Advance past the grace; still no checks → settle to pass.
    clock.advance(SETTLE_MS);
    const second = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(second.result).toBe("pass");
  });

  it("(c) checks_pending (real CI registered) → CLEARS no_checks_since + pending REGARDLESS of elapsed", async () => {
    const pool = new FakePool();
    // Pre-seed an ANCIENT no_checks_since (as if a prior no_checks pass set it long ago).
    pool.noChecksSince.set("q_spec_a", 1);
    const clock = new Clock(1_000_000_000);
    const checker = makeChecker(pool, new FakeVcsProvider(CHECKS_PENDING), clock);

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pending");
    if (verdict.result !== "pending") throw new Error("unreachable");
    // A registered-CI pending hold carries no settle remainder + WIPES the clock.
    expect(verdict.settleAfterMs).toBeUndefined();
    expect(pool.noChecksSince.get("q_spec_a")).toBeNull();
  });

  it("(d) a failing check → fail (never settled — a red check always blocks)", async () => {
    const pool = new FakePool();
    // Even with an ancient clock, red blocks.
    pool.noChecksSince.set("q_spec_a", 1);
    const clock = new Clock(1_000_000_000);
    const checker = makeChecker(pool, new FakeVcsProvider(FAILING), clock);

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("fail");
    // The clock is cleared on the fail verdict too.
    expect(pool.noChecksSince.get("q_spec_a")).toBeNull();
  });

  it("(e) THE HOLE: real-CI repo enqueued long ago does NOT settle before its workflow registers", async () => {
    const pool = new FakePool();
    const vcs = new FakeVcsProvider(NO_CHECKS);
    // `now` is FAR past any enqueue time — under the old MIN(enqueued_at) anchor this
    // would have settle-merged on the FIRST pass. With no_checks_since it cannot.
    const clock = new Clock(10_000_000_000);
    const checker = makeChecker(pool, vcs, clock);

    // Pass 1: the freshly-rebuilt integration ref has no checks yet (workflow not
    // registered) → START the clock + HOLD. It MUST NOT settle-merge despite the
    // ancient enqueue.
    const p1 = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(p1.result).toBe("pending");
    expect(pool.noChecksSince.get("q_spec_a")).toBe(10_000_000_000);

    // Pass 2 (a few seconds later): the workflow has now registered a queued check →
    // checks_pending CLEARS the clock + holds (waits for the real check).
    clock.advance(3_000);
    vcs.setChecks(CHECKS_PENDING);
    const p2 = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(p2.result).toBe("pending");
    expect(pool.noChecksSince.get("q_spec_a")).toBeNull();

    // Pass 3: the real check finished green → pass (verified, not settle-merged).
    clock.advance(30_000);
    vcs.setChecks(ALL_PASSED);
    const p3 = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(p3.result).toBe("pass");
  });

  it("(f) the reset: once checks_pending clears the clock, a later transient no_checks RESTARTS the grace", async () => {
    const pool = new FakePool();
    const vcs = new FakeVcsProvider(CHECKS_PENDING);
    const clock = new Clock(1_000_000);
    const checker = makeChecker(pool, vcs, clock);

    // Pass 1: checks_pending → clock stays NULL (cleared).
    await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(pool.noChecksSince.get("q_spec_a")).toBeNull();

    // Pass 2 (much later): a TRANSIENT no_checks (e.g. the check vanished on a rebuild)
    // → it must START the clock fresh + HOLD, NOT instantly settle on stale elapsed.
    clock.advance(10_000_000);
    vcs.setChecks(NO_CHECKS);
    const p2 = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(p2.result).toBe("pending");
    if (p2.result !== "pending") throw new Error("unreachable");
    expect(p2.settleAfterMs).toBe(SETTLE_MS);
    expect(pool.noChecksSince.get("q_spec_a")).toBe(clock.ms);
  });

  it("a green prospective state passes immediately (no settle path) + clears the clock", async () => {
    const pool = new FakePool();
    pool.noChecksSince.set("q_spec_a", 1);
    const clock = new Clock(1_000_001);
    const checker = makeChecker(pool, new FakeVcsProvider(ALL_PASSED), clock);

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pass");
    expect(pool.noChecksSince.get("q_spec_a")).toBeNull();
  });

  it("keys the clock on the TAIL (head) entry of a multi-entry batch", async () => {
    const pool = new FakePool();
    const clock = new Clock(2_000_000);
    const checker = makeChecker(pool, new FakeVcsProvider(NO_CHECKS), clock);

    // A→B chain: the head/anchor is the tail spec (spec_b), matching the integration ref.
    const verdict = await checker.checkBatch({
      projectId: PROJECT,
      entries: [entry("spec_a"), { ...entry("spec_b"), dependsOn: ["spec_a"] }],
    });
    expect(verdict.result).toBe("pending");
    expect(pool.noChecksSince.get("q_spec_b")).toBe(2_000_000);
    expect(pool.noChecksSince.get("q_spec_a")).toBeUndefined();
  });
});

// (§2c "ancestor-merged → proactive re-base"): focused unit test of
// `PgPercolationReadModel.loadAncestorSignals`'s NEW merged-ancestor divergence
// axis, over a FAKE pool + FAKE VcsProvider (test fixtures — they live here, never
// src/). It proves:
//   - a MERGED ancestor (lifecycle `merged`) produces its signal off the project's
//     `default_branch` HEAD (the merge commit), NOT the stale run branch, with
//     `ancestorMerged: true` + `mergedSha` set — so the descendant re-bases onto
//     fresh main instead of stranding on a squash-induced conflict; and
//   - an UNMERGED ancestor keeps the existing run-branch head behavior (the
//     reviewer-push detection is intact, NOT regressed).
// The full RLS/credential resolution is integration-tested live.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore, type SecretValue } from "../src/engine/contracts/secretStore.js";
import { PgPercolationReadModel } from "../src/engine/dag/percolationPg.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

/** A secret store that returns a stub `github_token` for any ref (so the head-sha read's
 * static-credential resolution succeeds without a live store). */
class TokenSecretStore extends InMemorySecretStore {
  override async get(ref: string): Promise<SecretValue | undefined> {
    return { ref, value: "t" };
  }
}

const ORG = "org_1";
const PROJECT = "project_1";
const DEFAULT_BRANCH = "main";
const MERGE_SHA = "main-merge-sha";

/** A fake pg pool that routes on SQL fragments to canned rows. `mergedSpecIds` flips
 *  a spec's lifecycle to `merged` (its run carries a merge.completed event). */
class FakePool {
  constructor(private readonly mergedSpecIds: Set<string>) {}
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.mergedSpecIds);
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient(this.mergedSpecIds).query(sql, params);
  }
}

class FakeClient {
  constructor(private readonly mergedSpecIds: Set<string>) {}
  release(): void {
    /* no-op */
  }
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
    // resolveProjectOrg + the lifecycle org guard.
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    // The lifecycle projection: one row per ancestor spec. A merged ancestor carries
    // merge_completed=true (⇒ lifecycle `merged`); an unmerged one is plain.
    if (text.includes("FROM specs s") && text.includes("LEFT JOIN LATERAL")) {
      const specIds = ["spec_a", "spec_b"];
      return {
        rows: specIds.map((specId) => ({
          spec_id: specId,
          spec_status: this.mergedSpecIds.has(specId) ? "merged" : "active",
          run_id: `run_${specId}`,
          run_status: "running",
          pr_opened: true,
          ci_passed: true,
          audit_passed: true,
          audit_recommended_action: null,
          audit_outstanding_count: 0,
          review_approved: false,
          review_changes_requested: false,
          review_auto_approved: false,
          merge_completed: this.mergedSpecIds.has(specId),
        })),
      };
    }
    // resolveAncestorRead: project repo + default_branch + configs.
    if (text.includes("FROM projects p") && text.includes("default_branch")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/cat-cave/apex",
            default_branch: DEFAULT_BRANCH,
            project_config: { version: 1 },
            org_config: { version: 1, defaultCredentials: { github_token: "credential/github/org/default" } },
          },
        ],
      };
    }
    // resolveAncestorRead: one run branch per ancestor spec.
    if (text.includes("FROM runs r") && text.includes("DISTINCT ON")) {
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: ids.map((specId) => ({ spec_id: specId, branch: `tanren/${specId}` })) };
    }
    return { rows: [] };
  }
}

/**
 * A scripted GitHub transport answering the git-ref reads `CodeHost.fetchRef` issues:
 * `default_branch` sits at the merge SHA, every other branch (each ancestor's run branch)
 * is UNCHANGED at `sha-old` (the squash-merge left it put). This is the fixture the read
 * model's real `GitHubCodeHost` reads through (decomposition PR-6 — the head-sha read moved
 * off `VcsProvider.readBranchHeadSha` onto the host seam).
 */
const fetchRefGitHubHttp: GitHubHttpClient = {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const path = input.path.split("?")[0] ?? input.path;
    const match = /\/git\/ref\/heads\/([^/]+)$/u.exec(path);
    if (input.method === "GET" && match) {
      const branch = decodeURIComponent(match[1] ?? "");
      const sha = branch === DEFAULT_BRANCH ? MERGE_SHA : "sha-old";
      return { status: 200, body: { object: { sha } } };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  },
};

function makeReadModel(mergedSpecIds: string[]): PgPercolationReadModel {
  return new PgPercolationReadModel({
    pool: new FakePool(new Set(mergedSpecIds)) as unknown as pg.Pool,
    githubHttp: fetchRefGitHubHttp,
    secrets: new TokenSecretStore(),
  });
}

const dependent = {
  specId: "spec_dep",
  runId: "run_dep",
  speculativeBase: "tanren/integ/spec_dep",
  // Built on spec_a + spec_b, both verified at sha-old.
  integratedAncestorShas: { spec_a: "sha-old", spec_b: "sha-old" },
  verifiedAncestorShas: { spec_a: "sha-old", spec_b: "sha-old" },
  lifecycleState: "building" as const,
  openFindingMaxSeverity: "unaudited" as const,
};

describe("PgPercolationReadModel.loadAncestorSignals (§2c merged-ancestor axis)", () => {
  it("a MERGED ancestor signals off default_branch HEAD (the merge commit), NOT the stale run branch", async () => {
    const rm = makeReadModel(["spec_a"]);
    const signals = await rm.loadAncestorSignals({ projectId: PROJECT, dependent });

    const a = signals.find((s) => s.ancestorSpecId === "spec_a");
    expect(a).toBeDefined();
    // The merge axis: currentSha/mergedSha come off default_branch HEAD (the merge
    // commit), NOT the run branch (which still reads sha-old).
    expect(a?.ancestorMerged).toBe(true);
    expect(a?.currentSha).toBe(MERGE_SHA);
    expect(a?.mergedSha).toBe(MERGE_SHA);
    expect(a?.verifiedSha).toBe("sha-old");
  });

  it("an UNMERGED ancestor keeps the run-branch head behavior (reviewer-push detection intact)", async () => {
    // Only spec_a merged; spec_b stays unmerged.
    const rm = makeReadModel(["spec_a"]);
    const signals = await rm.loadAncestorSignals({ projectId: PROJECT, dependent });

    const b = signals.find((s) => s.ancestorSpecId === "spec_b");
    expect(b).toBeDefined();
    // No merge flag; the current SHA is read off the run branch (unchanged ⇒ sha-old).
    expect(b?.ancestorMerged).toBeUndefined();
    expect(b?.mergedSha).toBeUndefined();
    expect(b?.currentSha).toBe("sha-old");
  });
});

// ---- loadSpeculativeDependents: exclude terminal + clear stale marker -------

/**
 * A fake pool for `loadSpeculativeDependents`: one MERGED dependent run carrying a
 * STALE `percolation_pending` marker + one LIVE (in-flight) dependent run. The
 * lifecycle projection flips a spec to `merged` when its id is in `mergedSpecIds`.
 * Records every `percolation_pending = NULL` clear so the test asserts the moot
 * marker on the merged run is cleared (and the live one is NOT).
 */
class DependentsFakePool {
  readonly clearedRunIds: string[] = [];
  constructor(private readonly mergedSpecIds: Set<string>) {}
  async connect(): Promise<DependentsFakeClient> {
    return new DependentsFakeClient(this.mergedSpecIds, this.clearedRunIds);
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new DependentsFakeClient(this.mergedSpecIds, this.clearedRunIds).query(sql, params);
  }
}

class DependentsFakeClient {
  constructor(
    private readonly mergedSpecIds: Set<string>,
    private readonly clearedRunIds: string[],
  ) {}
  release(): void {
    /* no-op */
  }
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
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    // The stale-marker housekeeping clear — record which run it targeted.
    if (text.includes("UPDATE runs SET percolation_pending = NULL")) {
      this.clearedRunIds.push(String((params ?? [])[0]));
      return { rows: [] };
    }
    // The lifecycle projection: spec_merged is `merged`, spec_live is in-flight.
    if (text.includes("FROM specs s") && text.includes("LEFT JOIN LATERAL")) {
      const specIds = ["spec_merged", "spec_live"];
      return {
        rows: specIds.map((specId) => ({
          spec_id: specId,
          spec_status: this.mergedSpecIds.has(specId) ? "merged" : "active",
          run_id: `run_${specId}`,
          run_status: "running",
          pr_opened: true,
          ci_passed: true,
          audit_passed: true,
          audit_recommended_action: null,
          audit_outstanding_count: 0,
          review_approved: false,
          review_changes_requested: false,
          review_auto_approved: false,
          merge_completed: this.mergedSpecIds.has(specId),
        })),
      };
    }
    // The dependents load: each run carries a non-empty jj-native `ancestor_stack` (WS-A
    // PR-8c: the build-base + divergence key derive from `ancestor_stack[].headSha`) + a
    // stale in-flight marker. The legacy `speculative_base`/`integrated_ancestor_shas`
    // columns are gone (WS-B PR-12) — `ancestor_stack` is the sole divergence source.
    if (text.includes("FROM runs r") && text.includes("r.percolation_pending")) {
      const marker = { ancestorSpecId: "spec_anc", toSha: "sha-new", reexecRunId: "run_reexec" };
      const stack = [{ specId: "spec_anc", runId: "run_anc", branch: "tanren/spec_anc", headSha: "sha-old" }];
      return {
        rows: [
          {
            run_id: "run_spec_merged",
            spec_id: "spec_merged",
            ancestor_stack: stack,
            verified_ancestor_shas: { spec_anc: "sha-old" },
            percolation_pending: marker,
          },
          {
            run_id: "run_spec_live",
            spec_id: "spec_live",
            ancestor_stack: stack,
            verified_ancestor_shas: { spec_anc: "sha-old" },
            percolation_pending: marker,
          },
        ],
      };
    }
    return { rows: [] };
  }
}

function makeDependentsReadModel(pool: DependentsFakePool): PgPercolationReadModel {
  return new PgPercolationReadModel({
    pool: pool as unknown as pg.Pool,
    githubHttp: fetchRefGitHubHttp,
    secrets: new TokenSecretStore(),
  });
}

describe("PgPercolationReadModel.loadSpeculativeDependents (exclude terminal + clear stale marker)", () => {
  it("a MERGED spec with a stale percolation_pending marker is NOT returned as a dependent", async () => {
    const pool = new DependentsFakePool(new Set(["spec_merged"]));
    const dependents = await makeDependentsReadModel(pool).loadSpeculativeDependents(PROJECT);

    // The merged spec is excluded; only the live in-flight dependent survives.
    expect(dependents.map((d) => d.specId)).toEqual(["spec_live"]);
  });

  it("clears the stale marker on the merged run, but NOT on the live one (idempotent housekeeping)", async () => {
    const pool = new DependentsFakePool(new Set(["spec_merged"]));
    await makeDependentsReadModel(pool).loadSpeculativeDependents(PROJECT);

    // Exactly the merged run's moot marker is cleared; the live run is untouched.
    expect(pool.clearedRunIds).toEqual(["run_spec_merged"]);
  });

  it("when NO dependent is terminal, nothing is cleared and both are returned", async () => {
    const pool = new DependentsFakePool(new Set());
    const dependents = await makeDependentsReadModel(pool).loadSpeculativeDependents(PROJECT);

    expect(dependents.map((d) => d.specId).sort()).toEqual(["spec_live", "spec_merged"]);
    expect(pool.clearedRunIds).toEqual([]);
  });
});

// P2c-2 (§2c "ancestor-merged → proactive re-base"): focused unit test of
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
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgPercolationReadModel } from "../src/engine/dag/percolationPg.js";
import type {
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";

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
            org_config: { version: 1 },
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

/** A fake VcsProvider whose branch heads are configurable: each ancestor's run
 *  branch sits at `sha-old` (unchanged), while default_branch sits at the merge SHA. */
class FakeVcs implements Partial<VcsProvider> {
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "t", source: "static", refresh: async () => "t" };
  }
  parseRepository(_repoUrl: string): RepoRef {
    return { owner: "cat-cave", name: "apex" };
  }
  async readBranchHeadSha(input: { branch: string }): Promise<string | undefined> {
    if (input.branch === DEFAULT_BRANCH) return MERGE_SHA;
    // Every ancestor run branch is UNCHANGED (the squash-merge left it put).
    return "sha-old";
  }
}

function makeReadModel(mergedSpecIds: string[]): PgPercolationReadModel {
  return new PgPercolationReadModel({
    pool: new FakePool(new Set(mergedSpecIds)) as unknown as pg.Pool,
    vcsProvider: new FakeVcs() as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
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

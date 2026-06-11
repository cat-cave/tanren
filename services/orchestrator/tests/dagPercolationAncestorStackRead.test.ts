// WS-A PR-8c (walker-jj-local-integration-design.md §2.3, §4) — the change-percolation
// READ side now selects in-flight speculative dependents on the jj-native
// `runs.ancestor_stack` (non-empty) and derives the build-base / divergence key from
// `ancestor_stack[].headSha`, REPLACING the legacy `speculative_base IS NOT NULL` selection
// + the `integrated_ancestor_shas` build-base read (both columns dropped in WS-B PR-12 —
// `ancestor_stack` is the sole truth). This proves the read-side selects the same dependents
// + builds the same divergence map off the jj-native stack. Over a FAKE pool + FAKE
// VcsProvider (test fixtures — they live here, never src/).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgPercolationReadModel } from "../src/engine/dag/percolationPg.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";

const ORG = "org_1";
const PROJECT = "project_1";

/** These read-side tests assert the dependents SELECT predicate only — they never reach the
 *  per-ancestor head-sha read, so the GitHub transport is never invoked. */
const inertGitHubHttp: GitHubHttpClient = {
  async request() {
    throw new Error("the dependents read predicate test must not reach the GitHub transport");
  },
};

/**
 * A fake pool for `loadSpeculativeDependents` that returns ONE run row whose contents the
 * test controls — proving (a) the SELECT predicate selects on a non-empty `ancestor_stack`
 * (the design's §2.3 "speculative iff `ancestor_stack` non-empty"), and (b) the build-base
 * / divergence key derives from `ancestor_stack[].headSha`. The captured `selectSql` lets
 * the test assert the predicate moved off `speculative_base`.
 */
class StackRowFakePool {
  selectSql = "";
  constructor(private readonly row: Record<string, unknown> | null) {}
  async connect(): Promise<StackRowFakeClient> {
    return new StackRowFakeClient(this.row, (sql) => {
      this.selectSql = sql;
    });
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new StackRowFakeClient(this.row, (s) => {
      this.selectSql = s;
    }).query(sql, params);
  }
}

class StackRowFakeClient {
  constructor(
    private readonly row: Record<string, unknown> | null,
    private readonly onSelect: (sql: string) => void,
  ) {}
  release(): void {
    /* no-op */
  }
  async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK")
    ) {
      return { rows: [] };
    }
    if (text.includes("SELECT org_id FROM projects")) return { rows: [{ org_id: ORG }] };
    // The lifecycle projection — the dependent spec is in-flight (`building`), not terminal.
    if (text.includes("FROM specs s") && text.includes("LEFT JOIN LATERAL")) {
      return {
        rows: [
          {
            spec_id: "spec_dep",
            spec_status: "active",
            run_id: "run_dep",
            run_status: "running",
            pr_opened: true,
            ci_passed: true,
            audit_passed: true,
            audit_recommended_action: null,
            audit_outstanding_count: 0,
            review_approved: false,
            review_changes_requested: false,
            review_auto_approved: false,
            merge_completed: false,
          },
        ],
      };
    }
    // The dependents SELECT — record the SQL (the predicate assertion) + return the row.
    if (text.includes("FROM runs r") && text.includes("r.ancestor_stack")) {
      this.onSelect(text);
      return { rows: this.row === null ? [] : [this.row] };
    }
    return { rows: [] };
  }
}

function makeStackRowReadModel(pool: StackRowFakePool): PgPercolationReadModel {
  return new PgPercolationReadModel({
    pool: pool as unknown as pg.Pool,
    githubHttp: inertGitHubHttp,
    secrets: new InMemorySecretStore(),
  });
}

describe("PgPercolationReadModel.loadSpeculativeDependents (WS-A PR-8c: reads ancestor_stack)", () => {
  it("the SELECT predicate selects on a non-empty ancestor_stack, NOT speculative_base", async () => {
    const pool = new StackRowFakePool({
      run_id: "run_dep",
      spec_id: "spec_dep",
      ancestor_stack: [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha-a" }],
      verified_ancestor_shas: null,
      percolation_pending: null,
    });
    await makeStackRowReadModel(pool).loadSpeculativeDependents(PROJECT);
    // The §2.3 predicate: a non-empty jsonb ARRAY `ancestor_stack` (not `speculative_base`).
    expect(pool.selectSql).toContain("jsonb_typeof(r.ancestor_stack) = 'array'");
    expect(pool.selectSql).toContain("jsonb_array_length(r.ancestor_stack) > 0");
    expect(pool.selectSql).not.toContain("r.speculative_base IS NOT NULL");
  });

  it("derives the build-base / divergence key from ancestor_stack[].headSha", async () => {
    // The stack carries the per-ancestor head shas the assembly captured — the SOLE divergence
    // source now (the legacy `integrated_ancestor_shas` column was dropped in WS-B PR-12).
    const pool = new StackRowFakePool({
      run_id: "run_dep",
      spec_id: "spec_dep",
      ancestor_stack: [
        { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha-a" },
        { specId: "spec_b", runId: "run_b", branch: "tanren/spec_b", headSha: "sha-b" },
      ],
      verified_ancestor_shas: null,
      percolation_pending: null,
    });
    const dependents = await makeStackRowReadModel(pool).loadSpeculativeDependents(PROJECT);
    expect(dependents).toHaveLength(1);
    // The build base + the verified default both derive from `ancestor_stack[].headSha`.
    expect(dependents[0]?.integratedAncestorShas).toEqual({ spec_a: "sha-a", spec_b: "sha-b" });
    expect(dependents[0]?.verifiedAncestorShas).toEqual({ spec_a: "sha-a", spec_b: "sha-b" });
  });

  it("a stack with EMPTY-placeholder heads (not yet bootstrapped) yields NO dependent to detect against", async () => {
    // A run enqueued but not yet bootstrapped: the stack entries carry the EMPTY placeholder
    // headSha (the bootstrap write-back fills them, PR-8c). The build-base map derives empty,
    // and with no in-flight marker the run is not yet a detect target — it becomes one once
    // its bootstrap fills the per-ancestor shas. The legacy SHA-map fallback is GONE (PR-9).
    const pool = new StackRowFakePool({
      run_id: "run_dep",
      spec_id: "spec_dep",
      ancestor_stack: [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "" }],
      verified_ancestor_shas: null,
      percolation_pending: null,
    });
    const dependents = await makeStackRowReadModel(pool).loadSpeculativeDependents(PROJECT);
    expect(dependents).toEqual([]);
  });

  it("an EMPTY ancestor_stack with no marker yields NO dependent (nothing to detect against)", async () => {
    const pool = new StackRowFakePool(null);
    const dependents = await makeStackRowReadModel(pool).loadSpeculativeDependents(PROJECT);
    expect(dependents).toEqual([]);
  });
});

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { PgPostMergeIssueClaimStore } from "../src/engine/postMerge/issueClaimStore.js";

function claimPool(state: { updates: number; exactExistsJoin: boolean }): pg.Pool {
  const query = async (sql: string) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT EXISTS/u.test(sql)) {
      state.exactExistsJoin = /r\.project_id = c\.project_id/u.test(sql) && /s\.project_id = r\.project_id/u.test(sql);
      return { rows: [{ exists: false }], rowCount: 1 };
    }
    if (/SELECT c\.org_id AS claim_org_id/u.test(sql)) {
      return {
        rows: [
          {
            claim_org_id: "org_a",
            claim_project_id: "project_b",
            claim_spec_id: "spec_b",
            run_org_id: "org_a",
            run_project_id: "project_b",
            run_spec_id: "spec_b",
            project_org_id: "org_b",
            spec_org_id: "org_b",
            spec_project_id: "project_b",
          },
        ],
        rowCount: 1,
      };
    }
    if (/UPDATE post_merge_issue_claims/u.test(sql)) state.updates += 1;
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

describe("post-merge issue claim lineage", () => {
  it("rejects malformed historical ownership before settling a claim", async () => {
    const state = { updates: 0, exactExistsJoin: false };
    const store = new PgPostMergeIssueClaimStore(claimPool(state));
    await expect(store.markFiled("run_bad", { url: "https://example.com/1", number: 1 })).rejects.toThrow(
      /claim lineage mismatch/u,
    );
    expect(state.updates).toBe(0);
  });

  it("only treats a claim as existing when its exact run tuple still joins", async () => {
    const state = { updates: 0, exactExistsJoin: false };
    const store = new PgPostMergeIssueClaimStore(claimPool(state));
    expect(await store.exists("run_bad")).toBe(false);
    expect(state.exactExistsJoin).toBe(true);
  });
});

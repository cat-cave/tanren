// WS-A PR-1 (walker-jj-local-integration-design.md §2.3, §7): the typed
// `AncestorStack` + the pure DUAL-READ resolver. Proves both read branches:
//   (1) the new `ancestor_stack` column is the source of truth when present;
//   (2) else the stack is reconstructed from the legacy `integrated_ancestor_shas`
//       SHA map (best-effort — runId/branch empty, since the legacy column carries
//       only the per-ancestor head sha);
//   (3) a non-speculative run (no column, no legacy map) resolves to an EMPTY stack.
//
// WS-A PR-2 (§2.1, §7 PR-2): the WRITE-side `resolveDependentAncestorStack` — the
// DAG-ordered, org-scoped (RLS-safe) resolver extracted out of
// `PgSpeculativeIntegrator.loadAncestorBranches`. Proves DAG ordering, the
// diamond/N-ancestor case, org-scope isolation (off-scope rows are invisible to the
// scoped client → the missing-branch hard error), and merged-ancestor exclusion (the
// caller passes only UNMERGED ancestors; a merged spec id never reaches the resolver
// and so is never integrated). Tests over a FAKE org-scoped query client (a fixture —
// it lives here, never src/); the full live RLS resolution is integration-tested.
// Pure functions — no DB, no seams.

import { describe, expect, it } from "vitest";
import {
  ancestorStackFromShaMap,
  ancestorStackSchema,
  resolveAncestorStack,
  resolveDependentAncestorStack,
  type AncestorStack,
  type AncestorStackQueryClient,
} from "../src/engine/dag/ancestorStack.js";

describe("AncestorStack — typed shape + zod schema", () => {
  it("accepts a well-formed ordered stack", () => {
    const stack: AncestorStack = [
      { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" },
      { specId: "spec_b", runId: "run_b", branch: "tanren/spec_b", headSha: "sha_b" },
    ];
    expect(ancestorStackSchema.parse(stack)).toEqual(stack);
  });

  it("rejects a malformed member (missing headSha)", () => {
    const bad = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a" }];
    expect(ancestorStackSchema.safeParse(bad).success).toBe(false);
  });
});

describe("ancestorStackFromShaMap — legacy SHA map → ordered stack", () => {
  it("reconstructs one member per ancestor (runId/branch empty, headSha from the map)", () => {
    expect(ancestorStackFromShaMap({ spec_a: "sha_a", spec_b: "sha_b" })).toEqual([
      { specId: "spec_a", runId: "", branch: "", headSha: "sha_a" },
      { specId: "spec_b", runId: "", branch: "", headSha: "sha_b" },
    ]);
  });

  it("an empty map yields an empty stack", () => {
    expect(ancestorStackFromShaMap({})).toEqual([]);
  });
});

describe("resolveAncestorStack — DUAL-READ", () => {
  it("(1) reads the new ancestor_stack column when present (the source of truth)", () => {
    const stack: AncestorStack = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" }];
    // The legacy columns carry DIFFERENT data — the column must win.
    const resolved = resolveAncestorStack({
      ancestorStack: stack,
      speculativeBase: "tanren/integ/spec_x",
      integratedAncestorShas: { spec_z: "sha_z" },
    });
    expect(resolved).toEqual(stack);
  });

  it("(2) reconstructs from the legacy integrated_ancestor_shas when the column is absent", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: null,
      speculativeBase: "tanren/integ/spec_b",
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });

  it("(2b) reconstructs from the legacy map when the column is an empty array (treated as absent)", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: [],
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });

  it("(3) a non-speculative run (no column, no legacy map) resolves to an EMPTY stack", () => {
    expect(resolveAncestorStack({ ancestorStack: null, speculativeBase: null, integratedAncestorShas: null })).toEqual(
      [],
    );
    expect(resolveAncestorStack({})).toEqual([]);
  });

  it("ignores a malformed ancestor_stack column and falls back to the legacy map", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: [{ specId: "spec_a" }],
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });
});

// One ancestor's stored run row, keyed by the org it belongs to — the fixture's
// stand-in for the `runs` table under RLS.
interface ScopedRunRow {
  spec_id: string;
  run_id: string;
  branch: string;
  org_id: string;
}

/**
 * A fake org-scoped query client: it answers the resolver's `DISTINCT ON (r.spec_id)`
 * branch query, returning ONLY rows whose `org_id` matches the scope it was opened
 * for — exactly what `runWithOrgScope` + RLS enforce (a query off the scoped client
 * sees zero off-scope rows). The DISTINCT-ON ordering (`started_at DESC`) is modeled
 * by the row order the fixture is seeded in (first row per spec wins).
 */
class FakeScopedClient implements AncestorStackQueryClient {
  constructor(
    private readonly scopeOrgId: string,
    private readonly rows: ReadonlyArray<ScopedRunRow>,
  ) {}
  async query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (!(text.includes("FROM runs r") && text.includes("DISTINCT ON"))) {
      throw new Error(`unexpected query: ${text}`);
    }
    const wanted = new Set((params?.[0] as string[] | undefined) ?? []);
    const seen = new Set<string>();
    const out: ScopedRunRow[] = [];
    for (const row of this.rows) {
      // RLS: a query off the scoped client only sees the scope org's rows.
      if (row.org_id !== this.scopeOrgId) continue;
      if (!wanted.has(row.spec_id)) continue;
      // DISTINCT ON (spec_id): the first row per spec wins.
      if (seen.has(row.spec_id)) continue;
      seen.add(row.spec_id);
      out.push(row);
    }
    return { rows: out as unknown as R[] };
  }
}

const ORG = "org_1";

/** Build in-scope run rows (one per spec) for the given specs under org `org`. */
function rowsFor(specIds: string[], org = ORG): ScopedRunRow[] {
  return specIds.map((specId) => ({
    spec_id: specId,
    run_id: `run_${specId}`,
    branch: `tanren/${specId}`,
    org_id: org,
  }));
}

describe("resolveDependentAncestorStack — DAG-ordered, org-scoped WRITE resolver", () => {
  it("returns the ancestors in the caller's DAG order (not the query's row order)", async () => {
    // Seed the rows in a DIFFERENT order than the requested DAG order; the resolver
    // must re-order to the caller's order.
    const client = new FakeScopedClient(ORG, rowsFor(["spec_b", "spec_a"]));
    const stack = await resolveDependentAncestorStack(client, ["spec_a", "spec_b"]);
    expect(stack).toEqual([
      { specId: "spec_a", runId: "run_spec_a", branch: "tanren/spec_a" },
      { specId: "spec_b", runId: "run_spec_b", branch: "tanren/spec_b" },
    ]);
  });

  it("resolves the diamond / N-ancestor case in topological order (A then B,C)", async () => {
    // Diamond A → {B,C} → D: D's unmerged ancestors, DAG-ordered [A, B, C].
    const client = new FakeScopedClient(ORG, rowsFor(["spec_c", "spec_a", "spec_b"]));
    const stack = await resolveDependentAncestorStack(client, ["spec_a", "spec_b", "spec_c"]);
    expect(stack.map((m) => m.specId)).toEqual(["spec_a", "spec_b", "spec_c"]);
    expect(stack.map((m) => m.branch)).toEqual(["tanren/spec_a", "tanren/spec_b", "tanren/spec_c"]);
  });

  it("an empty ancestor list resolves to an empty stack (no query issued)", async () => {
    const client = new FakeScopedClient(ORG, rowsFor(["spec_a"]));
    expect(await resolveDependentAncestorStack(client, [])).toEqual([]);
  });

  it("org-scope isolation: an OFF-SCOPE ancestor is invisible → the missing-branch hard error", async () => {
    // spec_b's run row belongs to a DIFFERENT org — under RLS the scoped client sees
    // zero rows for it, so it resolves to no branch and HARD-ERRORS (never a phantom).
    const client = new FakeScopedClient(ORG, [...rowsFor(["spec_a"]), ...rowsFor(["spec_b"], "org_other")]);
    await expect(resolveDependentAncestorStack(client, ["spec_a", "spec_b"])).rejects.toThrow(
      "unmerged ancestor spec_b has no run branch to integrate",
    );
  });

  it("merged-ancestor exclusion: only the UNMERGED specs the caller passes are resolved", async () => {
    // The caller (the walker) passes only unmerged ancestors. Even though a merged
    // ancestor (spec_merged) has a run row, it is not in the requested list, so it
    // never appears in the stack.
    const client = new FakeScopedClient(ORG, rowsFor(["spec_a", "spec_merged"]));
    const stack = await resolveDependentAncestorStack(client, ["spec_a"]);
    expect(stack.map((m) => m.specId)).toEqual(["spec_a"]);
  });
});

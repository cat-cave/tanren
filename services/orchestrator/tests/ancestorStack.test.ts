// walker-jj-local-integration-design.md §2.3: the typed `AncestorStack` + the pure
// `resolveAncestorStack` reader over the SOLE base source `runs.ancestor_stack`:
//   (1) reads the column when present + well-formed;
//   (2) a non-speculative run (no column / null) resolves to an EMPTY stack;
//   (3) a PRESENT but MALFORMED column throws `MalformedAncestorStackError` (Codex
//       critic #9): a corrupt payload must NEVER silently degrade to `[]` — that
//       would flip a speculative run non-speculative and merge it against the wrong
//       base.
//
// §2.1: the WRITE-side `resolveDependentAncestorStack` — the DAG-ordered, org-scoped
// (RLS-safe) resolver. Proves DAG ordering, the diamond/N-ancestor case, org-scope
// isolation (off-scope rows are invisible to the scoped client → the missing-branch hard
// error), and merged-ancestor exclusion (the caller passes only UNMERGED ancestors; a
// merged spec id never reaches the resolver and so is never integrated). Tests over a FAKE
// org-scoped query client (a fixture — it lives here, never src/); the full live RLS
// resolution is integration-tested. Pure functions — no DB, no seams.

import { describe, expect, it } from "vitest";
import {
  ancestorStackSchema,
  MalformedAncestorStackError,
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

describe("resolveAncestorStack — the ancestor_stack column reader", () => {
  it("(1) reads the ancestor_stack column when present (the sole base source)", () => {
    const stack: AncestorStack = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" }];
    expect(resolveAncestorStack({ ancestorStack: stack })).toEqual(stack);
  });

  it("(2) a well-formed empty column returns [] (a run whose stack fully drained via the retarget walk)", () => {
    expect(resolveAncestorStack({ ancestorStack: [] })).toEqual([]);
  });

  it("(3) ABSENT column ⇒ [] — null, undefined, and missing all resolve as non-speculative", () => {
    expect(resolveAncestorStack({ ancestorStack: null })).toEqual([]);
    expect(resolveAncestorStack({ ancestorStack: undefined })).toEqual([]);
    expect(resolveAncestorStack({})).toEqual([]);
  });

  // Codex critic #9: a MALFORMED payload must NEVER silently degrade to `[]` — that
  // would flip a speculative run non-speculative and merge it against the wrong base.
  it("(4) MALFORMED column throws MalformedAncestorStackError (never a silent [])", () => {
    expect(() => resolveAncestorStack({ ancestorStack: [{ specId: "spec_a" }] })).toThrow(MalformedAncestorStackError);
  });

  it("(4a) other malformed shapes also throw — a non-array payload is corruption", () => {
    expect(() => resolveAncestorStack({ ancestorStack: "not-an-array" })).toThrow(MalformedAncestorStackError);
    expect(() => resolveAncestorStack({ ancestorStack: { specId: "spec_a" } })).toThrow(MalformedAncestorStackError);
    // A member with wrong-typed fields (e.g. numeric branch) is corruption too.
    expect(() =>
      resolveAncestorStack({ ancestorStack: [{ specId: "spec_a", runId: "r", branch: 42, headSha: "s" }] }),
    ).toThrow(MalformedAncestorStackError);
  });

  it("(4b) the thrown error carries the zod issues + raw value for triage", () => {
    const raw = [{ specId: "spec_a" }];
    // Capture the thrown error via a plain wrapper so the assertions live outside the
    // try/catch (avoids the `no-conditional-expect` lint).
    let caught: unknown;
    try {
      resolveAncestorStack({ ancestorStack: raw });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedAncestorStackError);
    const mErr = caught as MalformedAncestorStackError;
    expect(mErr.name).toBe("MalformedAncestorStackError");
    expect(mErr.issues.length).toBeGreaterThan(0);
    expect(mErr.rawValue).toBe(raw);
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

// gv-17 durable-lineage PROVENANCE: what `base_shift_operations` is allowed to claim.
//
// Two things flow into that table that nothing downstream can falsify:
//   - `ancestor_spec_id` has NO foreign key, so a non-spec string (the base BRANCH the
//     merge-`behind` marker keys on) inserts cleanly and the history API then serves
//     `"main"` as a spec id. The record must carry a REAL ancestor spec or none at all.
//   - `invalidation_cause` is a six-value vocabulary. It used to be hardcoded to
//     `ancestor_landed`, so every restack claimed an ancestor landed — including a plain
//     base-branch advance where nothing landed. The driver knows the real cause; it says so.
//
// Both are observable only on the emitted lineage payload (the pg emitter writes it
// verbatim), so these drive the REAL entry points — the merge-behind hook and the
// percolation `reexecute` — and read the lineage the coordinator handed the emitter.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { PercolationDecision } from "../src/engine/contracts/changePercolation.js";
import { buildBaseShiftRebaseHook } from "../src/engine/dag/baseShiftRebaseHook.js";
import { DECISION, DEP_RUN, harness, PROJECT, reexec } from "./dagBaseShiftCoordinator.fixtures.js";

const DEP_SPEC = "spec_b";

/** A pool whose pooled client answers the hook's `runs` lookup (via `runWithSystemScope`). */
function fakeRunsPool(): pg.Pool {
  const answer = (sql: string) =>
    /SELECT spec_id, project_id FROM runs/u.test(sql)
      ? { rows: [{ spec_id: DEP_SPEC, project_id: PROJECT }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  const client = { query: (sql: string) => Promise.resolve(answer(sql)), release: () => {} };
  return {
    query: (sql: string) => Promise.resolve(answer(sql)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
}

describe("base-shift durable lineage provenance", () => {
  it("the merge-`behind` hook records NO ancestor spec and a `base_moved` cause", async () => {
    const h = harness({ reGate: "passed" });
    const hook = buildBaseShiftRebaseHook({ pool: fakeRunsPool(), coordinator: h.coord });

    const outcome = await hook({ runId: DEP_RUN, baseBranch: "main", headBranch: "tanren/run_dependent" });

    expect(outcome.outcome).toBe("rebased");
    expect(h.events.lineages).toHaveLength(1);
    const lineage = h.events.lineages[0]!;
    // THE FK-LESS-COLUMN GUARD: the marker still keys on the base branch (`ancestorSpecId:
    // input.baseBranch` in the hook), but that branch name must NEVER be persisted as a spec
    // id. A regression re-surfaces here as `ancestorSpecId === "main"`.
    expect(lineage.ancestorSpecId).toBeUndefined();
    expect(Object.hasOwn(lineage, "ancestorSpecId")).toBe(false);
    // Nothing landed and no member head moved — the base branch advanced. Say exactly that.
    expect(lineage.invalidationCause).toBe("base_moved");
    // The marker itself is unchanged: it still keys the shift's `from` on the base branch.
    expect(h.persistence.markedInFlight).toEqual([{ runId: DEP_RUN, ancestorSpecId: "main", toSha: "" }]);
  });

  it("an ancestor-MERGED percolation records the real ancestor spec + `ancestor_landed`", async () => {
    const h = harness({ reGate: "passed" });
    const decision: PercolationDecision = { ...DECISION, immediateSeverity: "ancestor_merged" };

    await reexec(h, { decision });

    const lineage = h.events.lineages[0]!;
    expect(lineage.ancestorSpecId).toBe("spec_a");
    expect(lineage.invalidationCause).toBe("ancestor_landed");
  });

  it("a P1-severity percolation records `member_head_moved`, not a fabricated landing", async () => {
    const h = harness({ reGate: "passed" });
    const decision: PercolationDecision = { ...DECISION, immediateSeverity: "P1" };

    await reexec(h, { decision });

    const lineage = h.events.lineages[0]!;
    // The ancestor did NOT land — its head (or verdict) moved under the dependent.
    expect(lineage.invalidationCause).toBe("member_head_moved");
    expect(lineage.ancestorSpecId).toBe("spec_a");
  });
});

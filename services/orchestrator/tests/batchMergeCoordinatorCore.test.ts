// Unit tests for the PURE batch-formation + bisect core (autonomy-engine.md §2d —
// speculative batch-check + bisect). These pin the contract's pure functions
// (`formBatch` / `bisectCulprit`) with NO DB, NO VCS — the conformance-tested core
// the BatchMergeCoordinator is built on. They prove: a batch is the DAG-ordered
// mutually-eligible prefix (ancestor before dependent, never a dependent without its
// in-batch ancestor), capped + flagged; bisect isolates EXACTLY the culprit (the PR a
// sub-batch passes without and fails with), never an innocent, and terminates in
// O(log n) probes.

import { describe, expect, it } from "vitest";
import { bisectCulprit, formBatch } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry, MergeQueueSnapshot } from "../src/engine/contracts/mergeCoordinator.js";
import type { SpecPriority } from "../src/engine/state/spec.js";

let order = 0;
function entry(specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): MergeQueueEntry {
  order += 1;
  return {
    orgId: "org_test",
    projectId: "p",
    queueId: `mq_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://github.test/pr/${specId}`,
    prNumber: order,
    dependsOn,
    priority,
    orderKey: order,
  };
}

function snapshot(entries: MergeQueueEntry[], merged: string[] = [], mergingInFlight = false): MergeQueueSnapshot {
  return { projectId: "p", entries, mergedSpecIds: new Set(merged), mergingInFlight };
}

describe("formBatch (pure)", () => {
  it("forms a batch of independent eligible entries, ordered by priority", () => {
    const e = [entry("spec_a", [], "P2"), entry("spec_b", [], "P0"), entry("spec_c", [], "P1")];
    const formation = formBatch(snapshot(e), 5);
    expect(formation.batch.map((x) => x.specId)).toEqual(["spec_b", "spec_c", "spec_a"]);
    expect(formation.capped).toBe(false);
    expect(formation.eligibleCount).toBe(3);
  });

  it("orders an in-batch chain ancestor-before-dependent (A→B→C all in one batch)", () => {
    // C depends on B, B depends on A — all queued, none merged. They all enter the
    // SAME batch (their ancestor is earlier in the batch), in dependency order.
    const e = [entry("spec_c", ["spec_b"], "P0"), entry("spec_a", [], "P2"), entry("spec_b", ["spec_a"], "P0")];
    const formation = formBatch(snapshot(e), 5);
    expect(formation.batch.map((x) => x.specId)).toEqual(["spec_a", "spec_b", "spec_c"]);
  });

  it("NEVER includes a dependent whose ancestor is neither merged nor in the batch (cap drops the ancestor)", () => {
    // Chain A→B→C; cap of 2 ⇒ only A,B fit. C is excluded because its ancestor B is in
    // the batch but C itself does not fit — and critically C never appears WITHOUT B.
    const e = [entry("spec_a", []), entry("spec_b", ["spec_a"]), entry("spec_c", ["spec_b"])];
    const formation = formBatch(snapshot(e), 2);
    expect(formation.batch.map((x) => x.specId)).toEqual(["spec_a", "spec_b"]);
    expect(formation.capped).toBe(true);
    expect(formation.eligibleCount).toBe(3);
    // C is absent; B (its ancestor) is present — never a dependent ahead of its ancestor.
    expect(formation.batch.map((x) => x.specId)).not.toContain("spec_c");
  });

  it("treats a MERGED ancestor as satisfied (a dependent on a merged spec is eligible alone)", () => {
    const e = [entry("spec_dep", ["spec_anc"])];
    const formation = formBatch(snapshot(e, ["spec_anc"]), 5);
    expect(formation.batch.map((x) => x.specId)).toEqual(["spec_dep"]);
  });

  it("holds a dependent whose ancestor is neither merged nor in the batch", () => {
    const formation = formBatch(snapshot([entry("spec_dep", ["spec_anc"])]), 5);
    expect(formation.batch).toEqual([]);
    expect(formation.eligibleCount).toBe(0);
  });

  it("holds (empty batch) when a merge is already in flight (serialization dominates)", () => {
    const formation = formBatch(snapshot([entry("spec_a")], [], true), 5);
    expect(formation.batch).toEqual([]);
  });

  it("caps the batch to maxBatchSize and flags it (no silent truncation)", () => {
    const e = [entry("spec_a"), entry("spec_b"), entry("spec_c"), entry("spec_d")];
    const formation = formBatch(snapshot(e), 2);
    expect(formation.batch).toHaveLength(2);
    expect(formation.capped).toBe(true);
    expect(formation.eligibleCount).toBe(4);
  });

  it("rejects a non-positive cap", () => {
    expect(() => formBatch(snapshot([entry("spec_a")]), 0)).toThrow(/positive integer/u);
  });
});

// A check that FAILS iff the prefix contains a designated bad spec id — exactly the
// "passes alone, breaks the combined state" interaction.
function checkerFailingOn(batch: MergeQueueEntry[], badSpecId: string): (n: number) => Promise<"pass" | "fail"> {
  return async (prefixLength: number) =>
    batch.slice(0, prefixLength).some((e) => e.specId === badSpecId) ? "fail" : "pass";
}

describe("bisectCulprit (pure)", () => {
  it("isolates EXACTLY the offending PR (a sub-batch passes without it, fails with it)", async () => {
    const batch = [entry("spec_a"), entry("spec_b"), entry("spec_c"), entry("spec_d"), entry("spec_e")];
    const result = await bisectCulprit(batch, checkerFailingOn(batch, "spec_c"));
    expect(result.culprit.specId).toBe("spec_c");
    expect(result.culpritIndex).toBe(2);
    // The innocent prefix is everything BEFORE the culprit (they pass together).
    expect(result.innocentPrefix.map((e) => e.specId)).toEqual(["spec_a", "spec_b"]);
  });

  it("blames the FIRST PR when the bad PR is at the head", async () => {
    const batch = [entry("spec_x"), entry("spec_y"), entry("spec_z")];
    const result = await bisectCulprit(batch, checkerFailingOn(batch, "spec_x"));
    expect(result.culprit.specId).toBe("spec_x");
    expect(result.innocentPrefix).toEqual([]);
  });

  it("blames the LAST PR when the bad PR is at the tail", async () => {
    const batch = [entry("spec_p"), entry("spec_q"), entry("spec_r")];
    const result = await bisectCulprit(batch, checkerFailingOn(batch, "spec_r"));
    expect(result.culprit.specId).toBe("spec_r");
    expect(result.innocentPrefix.map((e) => e.specId)).toEqual(["spec_p", "spec_q"]);
  });

  it("NEVER blames an innocent PR — the culprit is the unique pass→fail boundary", async () => {
    // Only spec_c breaks the build; every other PR is innocent. Across many sizes the
    // bisect must always name spec_c, never a neighbor.
    for (const size of [2, 3, 4, 8, 16]) {
      const batch = Array.from({ length: size }, (_, i) => entry(`spec_${i}`));
      const badIndex = Math.min(2, size - 1);
      const badSpec = batch[badIndex]!.specId;
      const result = await bisectCulprit(batch, checkerFailingOn(batch, badSpec));
      expect(result.culprit.specId).toBe(badSpec);
    }
  });

  it("terminates in O(log n) probes (the suspect window strictly shrinks)", async () => {
    const batch = Array.from({ length: 16 }, (_, i) => entry(`spec_${i}`));
    const result = await bisectCulprit(batch, checkerFailingOn(batch, "spec_9"));
    expect(result.culprit.specId).toBe("spec_9");
    // ceil(log2(16)) = 4 probes max — proves it does not linear-scan or loop.
    expect(result.checks).toBeLessThanOrEqual(4);
    expect(result.checks).toBeGreaterThan(0);
  });

  it("throws on an empty batch (nothing to bisect)", async () => {
    await expect(bisectCulprit([], async () => "pass")).rejects.toThrow(/empty batch/u);
  });
});

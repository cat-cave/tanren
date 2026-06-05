// (autonomy-engine.md §2d) — the run-loop merge finalize. The CARDINAL-SIN
// fix: under `native_queue`, the first-pass `queued` outcome ENTERED the queue but
// did NOT merge (Tanren owns the merge — the coordinator's drive pass merges it
// later), so the spec must NOT be marked `merged` here. Every other mode lands the
// spec at `merged`: `direct_merge` `merged` → spec `merged`; an `external_reviewer`
// hand-off → spec `merged` (the actual git merge is left to an operator).

import { describe, expect, it } from "vitest";
import { finalizeMergeOutcome } from "../src/engine/workflow/plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { DispatchedIntegration, MergeOutcomeKind } from "../src/engine/workflow/reviewMerge/index.js";

/** A pool that records every UPDATE the finalize drives, so we can assert on them. */
class RecordingPool {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  asPgPool() {
    return this as never;
  }
  /** The status the LAST `UPDATE specs SET status = $2` wrote, or undefined if none. */
  specStatusWritten(): string | undefined {
    const last = this.queries.findLast((q) => q.sql.startsWith("UPDATE specs SET status"));
    return last === undefined ? undefined : String(last.params[1]);
  }
  /** Whether ANY `UPDATE specs` ran (proves the spec status was / was not touched). */
  touchedSpec(): boolean {
    return this.queries.some((q) => q.sql.startsWith("UPDATE specs SET status"));
  }
}

function ctx(): PlannerRunContext {
  // Only runId/specId are read by finalizeMergeOutcome; the rest is filler.
  return {
    runId: "run_1",
    specId: "spec_1",
    projectId: "project_1",
  } as unknown as PlannerRunContext;
}

async function run(pool: RecordingPool, outcome: MergeOutcomeKind, integration: DispatchedIntegration): Promise<void> {
  const input = { pool: pool.asPgPool() } as unknown as RunPlannerLoopInput;
  const finalizeRunState = async (
    _status: string,
    _outcome: string,
    _from: string[],
    sql: string,
    params: unknown[],
  ): Promise<void> => {
    await pool.query(sql, params);
  };
  await finalizeMergeOutcome(input, finalizeRunState, ctx(), { outcome, integration });
}

describe("finalizeMergeOutcome — native_queue spec status (P2d cardinal-sin fix)", () => {
  it("a native_queue first-pass `queued` enqueue leaves the spec NOT merged", async () => {
    const pool = new RecordingPool();
    await run(pool, "queued", "native_queue");
    // The spec status is NEVER written (it stays in its in-flight status until the
    // coordinator's drive pass merges it). This is the fix: no `merged`.
    expect(pool.touchedSpec()).toBe(false);
    // The RUN still finalizes completed/ok (the enqueue succeeded).
    expect(pool.queries.some((q) => q.sql.includes("UPDATE runs SET status = 'completed'"))).toBe(true);
  });

  it("a direct_merge `merged` marks the spec `merged` (unchanged)", async () => {
    const pool = new RecordingPool();
    await run(pool, "merged", "direct_merge");
    expect(pool.specStatusWritten()).toBe("merged");
  });

  it("an external_reviewer hand-off `handed_off` marks the spec `merged`", async () => {
    const pool = new RecordingPool();
    await run(pool, "handed_off", "external_reviewer");
    expect(pool.specStatusWritten()).toBe("merged");
  });

  it("a native_queue DRIVE-pass `merged` marks the spec `merged` (the merge landed)", async () => {
    const pool = new RecordingPool();
    await run(pool, "merged", "native_queue");
    expect(pool.specStatusWritten()).toBe("merged");
  });
});

// Unit test for the v55 #59 plane-split fix in `buildReplanEnqueuer`. The merge-queue
// gate-fail-rework router (and the base-shift / percolation routers) reach the production
// `buildReplanEnqueuer` to re-author a culprit; the pre-fix impl ran a raw `UPDATE specs`
// directly on the pool the data-plane worker holds (de-privileged `tanren_dataplane`,
// which lacks `UPDATE ON specs` per baseline migration 0000:919), so a real-world rework
// crashed with `permission denied for table specs` and stranded the spec at
// `needs_attention`. The fix: when a `RunStateWriter` is wired, route BOTH the steering
// append + the status reopen through the writer (the same plane-split shape
// `setSpecStatus` / `setSpecMetadata` / `finalizeLand` already use). This test pins that
// routing: a recording writer must see `appendSpecSteering` + `setSpecStatus`, and the
// pool must see NO `UPDATE specs`. The in-process dev fallback (no writer wired) keeps
// running the raw SQL on the bare pool — separately covered by the prior conflict-
// resolver tests that exercise the no-writer path.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { buildReplanEnqueuer } from "../src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import type {
  AppendSpecSteeringInput,
  CreateQueuedRunInput,
  RunStateWriter,
  SetSpecStatusInput,
} from "../src/engine/contracts/runStateWriter.js";

const ORG = "org_v55_fix";
const PROJECT = "project_v55_fix";

interface Calls {
  appendSpecSteering: AppendSpecSteeringInput[];
  setSpecStatus: SetSpecStatusInput[];
  createQueuedRun: CreateQueuedRunInput[];
  rawQueries: string[];
}

/**
 * A recording RunStateWriter capturing the three seam methods this enqueuer reaches
 * (the steering append + the status reopen + the run-create). Every other seam throws
 * loudly so any unexpected routing surfaces immediately rather than dropping silently.
 */
function recordingWriter(calls: Calls): RunStateWriter {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async appendSpecSteering(input: AppendSpecSteeringInput) {
      calls.appendSpecSteering.push(input);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async setSpecStatus(input: SetSpecStatusInput) {
      calls.setSpecStatus.push(input);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async createQueuedRun(input: CreateQueuedRunInput) {
      calls.createQueuedRun.push(input);
      return {
        runId: `run_${calls.createQueuedRun.length}`,
        plannerTaskId: `task_${calls.createQueuedRun.length}`,
      } as never;
    },
    // Everything else MUST be unreachable; throw if a path drifts in here.
    append: () => Promise.reject(new Error("unexpected append")),
    recordCost: () => Promise.reject(new Error("unexpected recordCost")),
    reconcileCost: () => Promise.reject(new Error("unexpected reconcileCost")),
    finalizeRun: () => Promise.reject(new Error("unexpected finalizeRun")),
    setRunStatus: () => Promise.reject(new Error("unexpected setRunStatus")),
    setRunPrUrl: () => Promise.reject(new Error("unexpected setRunPrUrl")),
    setRunAuthRef: () => Promise.reject(new Error("unexpected setRunAuthRef")),
    setSpecMetadata: () => Promise.reject(new Error("unexpected setSpecMetadata")),
    setRunSpeculativeBase: () => Promise.reject(new Error("unexpected setRunSpeculativeBase")),
    setRunPercolationReexecId: () => Promise.reject(new Error("unexpected setRunPercolationReexecId")),
    clearRunPercolationPending: () => Promise.reject(new Error("unexpected clearRunPercolationPending")),
    mergeRunVerifiedAncestorSha: () => Promise.reject(new Error("unexpected mergeRunVerifiedAncestorSha")),
    supersedeQueuedPlannerTask: () => Promise.reject(new Error("unexpected supersedeQueuedPlannerTask")),
    finalizeLand: () => Promise.reject(new Error("unexpected finalizeLand")),
    recordDraftPrCreated: () => Promise.reject(new Error("unexpected recordDraftPrCreated")),
    insertTask: () => Promise.reject(new Error("unexpected insertTask")),
    updateTask: () => Promise.reject(new Error("unexpected updateTask")),
    updateTaskWithEvent: () => Promise.reject(new Error("unexpected updateTaskWithEvent")),
    finalizeRunWithEvent: () => Promise.reject(new Error("unexpected finalizeRunWithEvent")),
    updateSpecWithEvent: () => Promise.reject(new Error("unexpected updateSpecWithEvent")),
    createSpec: () => Promise.reject(new Error("unexpected createSpec")),
  } as unknown as RunStateWriter;
}

/**
 * A recording pool capturing every `.query` so the test can assert NO raw `UPDATE specs`
 * touched the de-privileged data-plane pool (the v55 #59 bug shape). Any txn-control
 * SQL the writer-routed path might still issue (none expected) gets captured here too.
 */
function recordingPool(rawQueries: string[]): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    rawQueries.push(String(text));
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
}

describe("buildReplanEnqueuer — v55 #59 plane-split fix", () => {
  it("routes the steering append + the status reopen through the writer when wired (no raw UPDATE specs on the pool)", async () => {
    const calls: Calls = {
      appendSpecSteering: [],
      setSpecStatus: [],
      createQueuedRun: [],
      rawQueries: [],
    };
    const writer = recordingWriter(calls);
    const pool = recordingPool(calls.rawQueries);
    const enqueuer = buildReplanEnqueuer(pool, writer);

    const result = await enqueuer.enqueue({
      specId: "spec_rework",
      orgId: ORG,
      projectId: PROJECT,
      steeringNote: "[gate fail] step lint: missing-semicolon at vitest.config.ts:42",
      reopenStatus: "open",
    });

    // The writer saw BOTH seam calls — the steering append (the previously-broken raw
    // `UPDATE specs SET description = ...`) AND the guarded reopen (`status <> 'merged'`
    // ⇒ `notFromStatuses: ["merged"]`). The order matters: steering carries the gate
    // error the next planner reads, so it must commit before the reopen flips the spec
    // back to `open` and the new run-create's separate-connection claim picks it up.
    expect(calls.appendSpecSteering).toEqual([
      {
        specId: "spec_rework",
        orgId: ORG,
        steeringNote: "[gate fail] step lint: missing-semicolon at vitest.config.ts:42",
      },
    ]);
    expect(calls.setSpecStatus).toEqual([
      {
        specId: "spec_rework",
        orgId: ORG,
        status: "open",
        notFromStatuses: ["merged"],
      },
    ]);
    // The run-create was routed through the writer too (not in-process `createQueuedRunFromSpec`).
    expect(calls.createQueuedRun).toHaveLength(1);
    expect(calls.createQueuedRun[0]?.input).toEqual({ specId: "spec_rework", trigger: "replan_routed" });
    expect(calls.createQueuedRun[0]?.actor.orgId).toBe(ORG);
    expect(calls.createQueuedRun[0]?.actor.projectId).toBe(PROJECT);

    // The CRITICAL invariant the v55 #59 fix establishes: NO raw `UPDATE specs` ran on
    // the data-plane pool — every spec write tunneled through the writer's mTLS hop to
    // the privileged control plane. (The pool may still see txn-control SQL if a future
    // path wraps something here, but never a `UPDATE specs ...`.)
    expect(calls.rawQueries.some((q) => /UPDATE\s+specs/iu.test(q))).toBe(false);

    expect(result.replanRunId).toBe("run_1");
    expect(result.plannerTaskId).toBe("task_1");
  });
});

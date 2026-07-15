// Plane-split (autonomy loops) — the routing proof. Under remote-writes, the
// autonomy loops (DagWalker enqueuer + dag.* event emitter, plus the shared
// run-state writer's CREATE ops) MUST route their tenant writes through the
// control-plane `RunStateWriter` and NEVER issue a direct `INSERT INTO runs` /
// `INSERT INTO events` / `UPDATE specs` on the bare (de-privileged) pool. The
// `tanren_dataplane` role lost those write grants (migrations 0031/0035), so a
// direct write would be a 42501 in prod — these tests catch a regression that
// would re-introduce one, WITHOUT needing Postgres.
//
// Strategy: a pool whose `query` REJECTS any write to the de-privileged tables
// (it only answers the system-scoped org-resolution SELECTs the seams issue), and
// a recording `RunStateWriter`. A walk-equivalent enqueue + event-emit then proves
// the writes landed on the writer, and the pool's write-guard never fired.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type {
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  RunStateWriter,
  SetSpecStatusInput,
} from "../src/engine/contracts/runStateWriter.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import { PgDagEventEmitter, SpecRunDagEnqueuer } from "../src/engine/dag/walker.js";

const ORG = "org_autonomy";
const PROJECT = "proj_autonomy";

/**
 * A pool that answers ONLY the system-scoped reads the autonomy-loop seams issue
 * (the project→org resolution) and the scope-control statements. ANY direct write
 * to a de-privileged tenant table (`runs` / `events` / `specs` / `tasks` /
 * `cost_records`) THROWS — mirroring the 42501 the `tanren_dataplane` role would
 * raise. So a test passes only if the write went through the injected writer.
 */
function guardedReadOnlyPool(): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/u.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      // The project→org resolution the seams run system-scoped before any write.
      if (/SELECT org_id FROM projects WHERE project_id/u.test(sql)) {
        return { rows: [{ org_id: ORG }], rowCount: 1 };
      }
      if (
        /INSERT\s+INTO\s+(runs|events|tasks|cost_records|job_queue)/iu.test(sql) ||
        /UPDATE\s+(runs|specs|tasks|cost_records)/iu.test(sql)
      ) {
        throw Object.assign(
          new Error(`permission denied for table (direct write on the de-privileged pool): ${text.slice(0, 60)}`),
          {
            code: "42501",
          },
        );
      }
      // Any other read the seam might issue resolves empty (none expected here).
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
}

/** A recording RunStateWriter that captures the loop's control-plane writes. */
function recordingWriter(): {
  writer: RunStateWriter;
  createdRuns: CreateQueuedRunInput[];
  createdSpecs: CreateSpecRemoteInput[];
  specStatuses: SetSpecStatusInput[];
  events: AppendEventInput[];
} {
  const createdRuns: CreateQueuedRunInput[] = [];
  const createdSpecs: CreateSpecRemoteInput[] = [];
  const specStatuses: SetSpecStatusInput[] = [];
  const events: AppendEventInput[] = [];
  const writer = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async append(input: AppendEventInput) {
      events.push(input);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async createQueuedRun(input: CreateQueuedRunInput) {
      createdRuns.push(input);
      return { runId: `run_${createdRuns.length}` } as never;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async createSpec(input: CreateSpecRemoteInput) {
      createdSpecs.push(input);
      return { specId: `spec_${createdSpecs.length}` } as never;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async setSpecStatus(input: SetSpecStatusInput) {
      specStatuses.push(input);
    },
    // The remaining seam methods are not exercised here; throw if a path
    // unexpectedly reaches them so a missed routing surfaces loudly.
    recordCost: () => Promise.reject(new Error("unexpected recordCost")),
    reconcileCost: () => Promise.reject(new Error("unexpected reconcileCost")),
    finalizeRun: () => Promise.reject(new Error("unexpected finalizeRun")),
    setRunStatus: () => Promise.reject(new Error("unexpected setRunStatus")),
    setRunPrUrl: () => Promise.reject(new Error("unexpected setRunPrUrl")),
    setSpecMetadata: () => Promise.reject(new Error("unexpected setSpecMetadata")),
    appendSpecSteering: () => Promise.reject(new Error("unexpected appendSpecSteering")),
    prepareSpecForRecovery: () => Promise.reject(new Error("unexpected prepareSpecForRecovery")),
    supersedeQueuedPlannerTask: () => Promise.reject(new Error("unexpected supersede")),
    insertTask: () => Promise.reject(new Error("unexpected insertTask")),
    updateTask: () => Promise.reject(new Error("unexpected updateTask")),
  } as unknown as RunStateWriter;
  return { writer, createdRuns, createdSpecs, specStatuses, events };
}

describe("plane-split (autonomy loops) — the DagWalker routes its writes through the control plane", () => {
  it("the enqueuer CREATES the run through the writer, never a direct INSERT INTO runs", async () => {
    const { writer, createdRuns } = recordingWriter();
    const enqueuer = new SpecRunDagEnqueuer(guardedReadOnlyPool(), writer);

    const { runId } = await enqueuer.enqueueSpecRun({ projectId: PROJECT, specId: "spec_a" });

    // The run-CREATE landed on the control-plane writer (NOT a direct pool INSERT,
    // which the guard would have thrown as 42501).
    expect(runId).toBe("run_1");
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]?.input.specId).toBe("spec_a");
    expect(createdRuns[0]?.input.trigger).toBe("dag_walker");
    // The actor carries the resolved org so the server-side create is org-scoped.
    expect(createdRuns[0]?.actor.orgId).toBe(ORG);
    expect(createdRuns[0]?.actor.scopes).toContain("platform:admin");
  });

  it("a speculative enqueue threads the ANCESTOR STACK (the jj-local base) through the writer's createQueuedRun", async () => {
    const { writer, createdRuns } = recordingWriter();
    const enqueuer = new SpecRunDagEnqueuer(guardedReadOnlyPool(), writer);
    const stack = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" }];

    await enqueuer.enqueueSpecRun({
      projectId: PROJECT,
      specId: "spec_b",
      ancestorStack: stack,
    });

    // The presence of the `speculative` block (carrying the ancestor stack) is the
    // speculative-start signal; there is NO synthesized integration ref.
    expect(createdRuns[0]?.input.speculative?.ancestorStack).toEqual(stack);
  });

  it("the dag.* event emitter appends through the writer, never a direct INSERT INTO events", async () => {
    const { writer, events } = recordingWriter();
    const emitter = new PgDagEventEmitter(guardedReadOnlyPool(), writer);

    await emitter.emitSpecEnqueued({
      projectId: PROJECT,
      specId: "spec_a",
      runId: "run_1",
      satisfiedDependsOn: [],
      inFlightBefore: 0,
      concurrencyCeiling: 3,
    });
    await emitter.emitDrained({
      projectId: PROJECT,
      plan: { doneCount: 1, inFlightCount: 0, blockedCount: 0 } as never,
    });

    // Both events landed on the writer's `append` (NOT a direct pool INSERT INTO
    // events, which the guard would have thrown as 42501).
    expect(events.map((e) => e.eventType)).toEqual(["dag.spec.enqueued", "dag.drained"]);
    expect(events[0]?.projectId).toBe(PROJECT);
  });
});

describe("plane-split (autonomy loops) — without a writer the seams write the pool directly (default path)", () => {
  it("the enqueuer with NO writer goes to the in-process pool path (never a writer)", async () => {
    // With no writer wired (single-role dev), the enqueuer calls
    // `createQueuedRunFromSpec` ON THE POOL — it reaches the pool's spec load and
    // throws from there (the guarded pool has no spec row), never touching a writer.
    // This proves the DEFAULT path is the in-process direct write (byte-identical to
    // today), and the ONLY thing that diverts it to the control plane is a wired writer.
    const enqueuer = new SpecRunDagEnqueuer(guardedReadOnlyPool());
    // It fails on the pool path (spec load) — a control-plane writer is never involved.
    await expect(enqueuer.enqueueSpecRun({ projectId: PROJECT, specId: "spec_a" })).rejects.toThrow(/spec not found/u);
  });
});

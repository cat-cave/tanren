// §2c percolation SUPERSEDE (the self-conflict fix): when a change-percolation
// re-execution replaces a spec's prior speculative run, the PgPercolationReexecutor
// must RETIRE the prior run + DEQUEUE its merge-queue entry (`superseded`) so the spec
// has exactly ONE live run — the re-exec — and the speculative batch check never
// integrates the spec against ITSELF. Driven through in-memory seams (TEST FIXTURES —
// they live here, never src/): a fake pool for `resolveOrg`, a recording RunStateWriter
// (the plane-split control-plane path) so `createQueuedRunFromSpec`'s heavy SQL is not
// faked, the real InMemoryMergeQueueModel for the queue, and a recording dequeue-event
// emitter. Proves:
//   (a) the prior run's queued entry is dequeued `superseded` + a `merge.dequeued`
//       event is emitted, and the prior run is CANCELLED — only the re-exec remains;
//   (b) the batch check would now see ONE run for the spec (the prior entry is gone);
//   (c) a SECOND re-exec on the SAME prior run is idempotent (no entry to re-dequeue);
//   (d) the run-CREATE still happens (the re-exec run is produced).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { FinalizeRunInput, FinalizeRunResult } from "../src/engine/contracts/runStateWriter.js";
import { PgPercolationReexecutor } from "../src/engine/dag/percolationBuild.js";
import type { MergeQueueEntry, MergeQueueModel } from "../src/engine/contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "../src/engine/merge/coordinator.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { InMemoryMergeQueueModel } from "./conformance/fakes/inMemoryMergeQueue.js";
import type { SpecRunContract } from "../src/engine/workflow/projectSpec.js";

const ORG = "org_1";
const PROJECT = "project_1";
const PRIOR_RUN = "run_prior";
const SPEC = "spec_b";

/** A fake client answering only `resolveOrg`'s `SELECT org_id FROM projects` (+ tx noise). */
class FakeClient {
  release(): void {
    /* no-op */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }], rowCount: 1 };
    }
    throw new Error(`unexpected pool query in supersede test: ${text}`);
  }
}

/** A fake pool whose `connect()` + `query()` both route through FakeClient. */
class FakePool {
  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(): Promise<FakeClient> {
    return new FakeClient();
  }
  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    return new FakeClient().query(sql);
  }
}

/** Records the dequeued event the supersede emits. */
class RecordingDequeueEmitter implements MergeQueueEventEmitter {
  readonly dequeued: Array<{ reason: string; entry: MergeQueueEntry }> = [];
  async emitAdvanced(): Promise<void> {
    /* unused */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitDequeued(input: { entry: MergeQueueEntry; reason: string }): Promise<void> {
    this.dequeued.push({ reason: input.reason, entry: input.entry });
  }
  async emitInfraBlocked(): Promise<void> {
    /* unused */
  }
}

/**
 * A recording RunStateWriter — the plane-split control-plane path. Records the
 * finalize (the prior-run CANCEL) + the run-CREATE; the other reexecute writes are
 * recorded as no-ops. Any method the reexecutor must NOT call throws (keeps the test
 * honest). A test fixture — never src/.
 */
class RecordingWriter {
  readonly finalizes: FinalizeRunInput[] = [];
  /** Records every `setSpecStatus` (the spec reopen to `open`), in order. */
  readonly specStatuses: Array<{ specId: string; status: string }> = [];
  createdRuns = 0;
  /** When true, `finalizeRun` (the prior-run CANCEL step) THROWS — simulating an
   *  infra fault AT the cancel, to prove the spec is already `open` (recoverable). */
  failFinalize = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
    this.finalizes.push(input);
    if (this.failFinalize) throw new Error("injected infra fault at the prior-run cancel");
    return { updated: true, specId: SPEC, projectId: PROJECT };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async createQueuedRun(): Promise<SpecRunContract> {
    this.createdRuns += 1;
    return { runId: "run_reexec" } as unknown as SpecRunContract;
  }
  async setRunSpeculativeBase(): Promise<void> {
    /* recorded no-op */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async setSpecStatus(input: { specId: string; status: string }): Promise<void> {
    this.specStatuses.push({ specId: input.specId, status: input.status });
  }
  async setRunPercolationReexecId(): Promise<void> {
    /* recorded no-op */
  }
  // The reexecutor must not touch these on the supersede/re-exec path.
  append(): Promise<void> {
    throw new Error("unexpected append");
  }
  recordCost(): Promise<never> {
    throw new Error("unexpected recordCost");
  }
  reconcileCost(): Promise<never> {
    throw new Error("unexpected reconcileCost");
  }
  setRunStatus(): Promise<void> {
    throw new Error("unexpected setRunStatus");
  }
  setRunPrUrl(): Promise<void> {
    throw new Error("unexpected setRunPrUrl");
  }
  setSpecMetadata(): Promise<void> {
    throw new Error("unexpected setSpecMetadata");
  }
  clearRunPercolationPending(): Promise<void> {
    throw new Error("unexpected clearRunPercolationPending");
  }
  mergeRunVerifiedAncestorSha(): Promise<void> {
    throw new Error("unexpected mergeRunVerifiedAncestorSha");
  }
  supersedeQueuedPlannerTask(): Promise<void> {
    throw new Error("unexpected supersedeQueuedPlannerTask");
  }
  insertTask(): Promise<void> {
    throw new Error("unexpected insertTask");
  }
  updateTask(): Promise<void> {
    throw new Error("unexpected updateTask");
  }
  createSpec(): Promise<never> {
    throw new Error("unexpected createSpec");
  }
}

function dependent(): SpeculativeDependent {
  return {
    specId: SPEC,
    runId: PRIOR_RUN,
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

function buildReexecutor(queue: MergeQueueModel, events: MergeQueueEventEmitter, writer: RecordingWriter) {
  return new PgPercolationReexecutor(new FakePool() as unknown as pg.Pool, writer as unknown as RunStateWriter, {
    queue,
    queueEvents: events,
  });
}

describe("PgPercolationReexecutor supersede (§2c self-conflict fix)", () => {
  it("retires the prior run + dequeues its queue entry `superseded`, leaving ONE live run", async () => {
    const queue = new InMemoryMergeQueueModel();
    // The prior speculative run is `done` with an open PR + a QUEUED merge-queue entry.
    queue.seed({ runId: PRIOR_RUN, specId: SPEC, dependsOn: ["spec_a"], priority: "tbd" });
    const events = new RecordingDequeueEmitter();
    const writer = new RecordingWriter();
    const reexecutor = buildReexecutor(queue, events, writer);

    const { reexecRunId } = await reexecutor.reexecute({
      projectId: PROJECT,
      dependent: dependent(),
      decision: { ancestorSpecId: "spec_a", promptness: "immediate", fromSha: "sha-old", toSha: "sha-new" },
      integrationBranch: "tanren/integ/spec_b",
      ancestorHeadShas: { spec_a: "sha-new" },
      nonSpeculative: false,
    });

    // A NEW re-exec run was created.
    expect(reexecRunId).toBe("run_reexec");
    expect(writer.createdRuns).toBe(1);

    // NEVER-STRAND ORDER: the spec was reopened to `open` BEFORE the prior run was
    // cancelled — so a throw at the cancel always leaves a recoverable `open` spec.
    expect(writer.specStatuses).toEqual([{ specId: SPEC, status: "open" }]);

    // The prior run was CANCELLED (terminal — invisible to the walker + read model).
    expect(writer.finalizes).toHaveLength(1);
    expect(writer.finalizes[0]?.runId).toBe(PRIOR_RUN);
    expect(writer.finalizes[0]?.status).toBe("cancelled");
    expect(writer.finalizes[0]?.outcome).toBe("cancelled");

    // The prior run's queue entry was dequeued `superseded` (NOT conflict/failed) + an
    // observable merge.dequeued event fired.
    const snapshot = await queue.loadSnapshot(PROJECT);
    // (b) the batch check now sees ZERO queued entries for the spec (the prior one is
    //     gone; the re-exec has not re-enqueued yet — so NO self-conflict can form).
    expect(snapshot.entries.filter((e) => e.specId === SPEC)).toHaveLength(0);
    expect(events.dequeued).toHaveLength(1);
    expect(events.dequeued[0]?.reason).toBe("superseded");
    expect(events.dequeued[0]?.entry.runId).toBe(PRIOR_RUN);
  });

  it("is idempotent: a second supersede of the SAME prior run dequeues nothing more", async () => {
    const queue = new InMemoryMergeQueueModel();
    queue.seed({ runId: PRIOR_RUN, specId: SPEC, dependsOn: ["spec_a"], priority: "tbd" });
    const events = new RecordingDequeueEmitter();
    const writer = new RecordingWriter();
    const reexecutor = buildReexecutor(queue, events, writer);

    const args = {
      projectId: PROJECT,
      dependent: dependent(),
      decision: { ancestorSpecId: "spec_a", promptness: "immediate" as const, fromSha: "sha-old", toSha: "sha-new" },
      integrationBranch: "tanren/integ/spec_b",
      ancestorHeadShas: { spec_a: "sha-new" },
      nonSpeculative: false,
    };

    await reexecutor.reexecute(args);
    await reexecutor.reexecute(args);

    // The entry was dequeued exactly ONCE (the second pass found no active entry).
    expect(events.dequeued).toHaveLength(1);
    // The cancel finalize is GUARDED idempotent at the DB level; here both calls run
    // (the recording writer is unguarded), but no DOUBLE-dequeue can occur — the
    // load-bearing self-conflict guarantee.
  });

  it("a prior run with NO active queue entry (never queued) supersedes cleanly", async () => {
    // An empty queue — the prior run never reached the merge queue.
    const queue = new InMemoryMergeQueueModel();
    const events = new RecordingDequeueEmitter();
    const writer = new RecordingWriter();
    const reexecutor = buildReexecutor(queue, events, writer);

    const { reexecRunId } = await reexecutor.reexecute({
      projectId: PROJECT,
      dependent: dependent(),
      decision: { ancestorSpecId: "spec_a", promptness: "immediate", fromSha: "sha-old", toSha: "sha-new" },
      integrationBranch: "tanren/integ/spec_b",
      ancestorHeadShas: { spec_a: "sha-new" },
      nonSpeculative: false,
    });

    // The re-exec still happens + the prior run is still CANCELLED; no dequeue event
    // (there was no entry to retire).
    expect(reexecRunId).toBe("run_reexec");
    expect(writer.finalizes).toHaveLength(1);
    expect(events.dequeued).toHaveLength(0);
  });

  it("never-strand: a throw AT the prior-run cancel leaves the spec `open` (recoverable), NOT in_flight-with-a-cancelled-run", async () => {
    const queue = new InMemoryMergeQueueModel();
    queue.seed({ runId: PRIOR_RUN, specId: SPEC, dependsOn: ["spec_a"], priority: "tbd" });
    const events = new RecordingDequeueEmitter();
    const writer = new RecordingWriter();
    // Inject an infra fault AT the cancel step (`finalizeRun` throws).
    writer.failFinalize = true;
    const reexecutor = buildReexecutor(queue, events, writer);

    // The reexecute rejects (the cancel threw) — the percolation pass surfaces it and
    // retries on a later notification (no swallow).
    await expect(
      reexecutor.reexecute({
        projectId: PROJECT,
        dependent: dependent(),
        decision: { ancestorSpecId: "spec_a", promptness: "immediate", fromSha: "sha-old", toSha: "sha-new" },
        integrationBranch: "tanren/integ/spec_b",
        ancestorHeadShas: { spec_a: "sha-new" },
        nonSpeculative: false,
      }),
    ).rejects.toThrow("injected infra fault at the prior-run cancel");

    // THE INVARIANT: the spec was reopened to `open` BEFORE the cancel threw — so the
    // DagWalker re-enqueues it. It is NOT stranded `in_flight` with only a cancelled run.
    expect(writer.specStatuses).toEqual([{ specId: SPEC, status: "open" }]);
    // The cancel was ATTEMPTED (the throw point) and the re-exec run was NOT created
    // (the create comes after the cancel — the spec is recovered, not double-run).
    expect(writer.finalizes).toHaveLength(1);
    expect(writer.createdRuns).toBe(0);
  });
});

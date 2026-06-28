// task #82 — window-pause auto-resume. End-to-end CYCLE test:
//
//   writer/preflight hits window pressure
//     ↳ disposition → pause_for_capacity bucket
//     ↳ atomic seam flips run to `paused`, spec stays `in_flight`, emits run.paused
//   probe tick 1 finds the paused run
//     ↳ atomic seam flips run to `halted` + emits run.resumed
//     ↳ atomic seam flips spec to `open` + emits dag.spec.redriven
//   (the walker would now re-enqueue a successor; the next run's preflight is the
//   actual capacity probe — if still exhausted, the new run re-pauses)
//
// The prober's resume strategy is "re-drive is the probe": the orchestrator never
// shells out to the provider's CLI itself (no-host-process-spawn). The successor
// run's existing `checkWindowPreflight` is the actual capacity test. This test
// pins the prober's RESUME contract — that paused runs DO get woken (the v62
// wedge that this fix eradicates) and that the resume is observable on the
// timeline (run.resumed + dag.spec.redriven).

import { describe, expect, it } from "vitest";
import type {
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  FinalizeRunWithEventInput,
  FinalizeRunWithEventOutcome,
  RunStateWriter,
  UpdateSpecWithEventInput,
  UpdateSpecWithEventOutcome,
} from "../src/engine/contracts/runStateWriter.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { SpecContract, SpecRunContract } from "../src/engine/workflow/projectSpec.js";
import {
  startPausedRunResumeProber,
  type PausedRunResumeProberDeps,
} from "../src/engine/usage/pausedRunResumeProber.js";

interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
  status: string;
  outcome: string | null;
  endedAt: Date | null;
}

interface FinalizeCall {
  runId: string;
  status: string;
  outcome: string;
  event: AppendEventInput;
}

interface SpecFlipCall {
  specId: string;
  status: string;
  event: AppendEventInput;
}

/** Minimal pg.Pool fake the prober reads paused runs off of, swapping in for the
 *  loadPausedRuns SELECT. The prober calls `runWithSystemScope` which opens a
 *  client off `pool.connect()` and runs the SELECT; we mirror that shape. */
function buildPool(rows: RunRow[]): {
  pool: PausedRunResumeProberDeps["pool"];
  inspectRows: () => RunRow[];
} {
  const state = { rows };
  const client = {
    query: async (sql: string) => {
      const trimmed = sql.trim();
      if (
        trimmed.startsWith("SET LOCAL") ||
        trimmed.startsWith("BEGIN") ||
        trimmed.startsWith("COMMIT") ||
        trimmed.startsWith("ROLLBACK")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("SELECT r.run_id")) {
        const paused = state.rows.filter((row) => row.status === "paused");
        return {
          rows: paused.map((row) => ({
            run_id: row.runId,
            spec_id: row.specId,
            project_id: row.projectId,
            org_id: row.orgId,
            ended_at: row.endedAt,
          })),
          rowCount: paused.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    query: client.query,
    connect: async () => client,
  } as unknown as PausedRunResumeProberDeps["pool"];
  return { pool, inspectRows: () => state.rows };
}

/** Recording RunStateWriter that flips the fake row state on each call. Models
 *  the production atomic seams without a real Postgres. */
function buildRecordingWriter(rows: RunRow[]): {
  writer: RunStateWriter;
  finalizes: FinalizeCall[];
  specFlips: SpecFlipCall[];
} {
  const finalizes: FinalizeCall[] = [];
  const specFlips: SpecFlipCall[] = [];
  const writer: RunStateWriter = {
    append: async () => {},
    recordCost: async () => ({ id: 1, costRecord: {} as never }) as never,
    reconcileCost: async () => ({ updated: 0 }),
    finalizeRun: async () => ({ updated: false }),
    setRunStatus: async () => {},
    setRunPrUrl: async () => {},
    setRunAuthRef: async () => {},
    setSpecStatus: async () => {},
    setSpecMetadata: async () => {},
    appendSpecSteering: async () => {},
    setRunSpeculativeBase: async () => {},
    setRunPercolationReexecId: async () => {},
    clearRunPercolationPending: async () => {},
    mergeRunVerifiedAncestorSha: async () => {},
    supersedeQueuedPlannerTask: async () => {},
    finalizeLand: async () => ({ auditId: "a" }),
    insertTask: async () => {},
    updateTask: async () => {},
    updateTaskWithEvent: async () => ({ alreadyTerminal: false }),
    createQueuedRun: async (_: CreateQueuedRunInput): Promise<SpecRunContract> => ({}) as SpecRunContract,
    createSpec: async (_: CreateSpecRemoteInput): Promise<SpecContract> => ({}) as SpecContract,
    finalizeRunWithEvent: async (input: FinalizeRunWithEventInput): Promise<FinalizeRunWithEventOutcome> => {
      const row = rows.find((r) => r.runId === input.finalize.runId);
      finalizes.push({
        runId: input.finalize.runId,
        status: input.finalize.status,
        outcome: input.finalize.outcome,
        event: input.event,
      });
      if (row !== undefined && input.finalize.fromStatuses.includes(row.status)) {
        row.status = input.finalize.status;
        row.outcome = input.finalize.outcome;
        return { updated: true, specId: row.specId, projectId: row.projectId };
      }
      return { updated: false };
    },
    updateSpecWithEvent: async (input: UpdateSpecWithEventInput): Promise<UpdateSpecWithEventOutcome> => {
      specFlips.push({ specId: input.spec.specId, status: input.spec.status, event: input.event });
      return { flipped: true };
    },
  };
  return { writer, finalizes, specFlips };
}

describe("pausedRunResumeProber (task #82 — window-pause auto-resume)", () => {
  it("RESUMES one paused run: paused → halted + run.resumed + spec → open + dag.spec.redriven (the walker re-drive path)", async () => {
    const rows: RunRow[] = [
      {
        runId: "run_paused_1",
        specId: "spec_1",
        projectId: "proj_1",
        orgId: "org_1",
        status: "paused",
        outcome: "window_paused",
        endedAt: new Date(Date.now() - 60_000),
      },
    ];
    const { pool } = buildPool(rows);
    const { writer, finalizes, specFlips } = buildRecordingWriter(rows);

    // Long probeIntervalMs — we drive ticks manually via probeOnce().
    const prober = startPausedRunResumeProber({
      pool,
      runStateWriter: writer,
      probeIntervalMs: 60_000,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    // Wait out the initial fire-and-forget tick that startPausedRunResumeProber
    // schedules at construction (it races with our explicit probeOnce). probeOnce
    // coalesces if an in-flight tick is running, so awaiting it covers both.
    const result = await prober.probeOnce();
    prober.stop();

    // The atomic seams ran in the right order: run finalize (paused → halted +
    // run.resumed), then spec flip (in_flight → open + dag.spec.redriven). The
    // walker now picks up the `open` spec and enqueues a successor run; that
    // successor's preflight is the actual capacity test.
    expect(result.resumedRunIds).toContain("run_paused_1");
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]).toMatchObject({
      runId: "run_paused_1",
      status: "halted",
      outcome: "window_paused",
      event: { eventType: "run.resumed" },
    });
    expect(specFlips).toHaveLength(1);
    expect(specFlips[0]).toMatchObject({
      specId: "spec_1",
      status: "open",
      event: { eventType: "dag.spec.redriven" },
    });
    // The resume event carries a positive pausedDurationSeconds (the row was
    // ended a minute ago); the prober's diagnostic.
    const payload = finalizes[0]!.event.payload as { pausedDurationSeconds: number };
    expect(payload.pausedDurationSeconds).toBeGreaterThan(0);
  });

  it("STAYS PAUSED while no paused runs exist (probe is a NO-OP, never spuriously emits resume events)", async () => {
    const rows: RunRow[] = [
      // A completed run never enters the prober's scan.
      {
        runId: "run_done",
        specId: "spec_done",
        projectId: "p",
        orgId: "o",
        status: "completed",
        outcome: "ok",
        endedAt: null,
      },
    ];
    const { pool } = buildPool(rows);
    const { writer, finalizes, specFlips } = buildRecordingWriter(rows);
    const prober = startPausedRunResumeProber({
      pool,
      runStateWriter: writer,
      probeIntervalMs: 60_000,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    const result = await prober.probeOnce();
    prober.stop();
    expect(result.resumedRunIds).toEqual([]);
    expect(finalizes).toEqual([]);
    expect(specFlips).toEqual([]);
  });

  it("CYCLES paused→resumed→paused: a probe ALWAYS resumes a paused run, even if it pauses AGAIN (UNBOUNDED, sign-of-life)", async () => {
    // The cycle the user explicitly asked for: writer pauses, prober resumes,
    // if the window is still exhausted the next run re-pauses, prober resumes
    // again — capacity always returns and the prober NEVER gives up. Models the
    // run re-entering paused state across two probe ticks.
    const rows: RunRow[] = [
      {
        runId: "run_cycle",
        specId: "spec_cycle",
        projectId: "p",
        orgId: "o",
        status: "paused",
        outcome: "window_paused",
        endedAt: new Date(),
      },
    ];
    const { pool } = buildPool(rows);
    const { writer, finalizes, specFlips } = buildRecordingWriter(rows);
    const prober = startPausedRunResumeProber({
      pool,
      runStateWriter: writer,
      probeIntervalMs: 60_000,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    // Tick 1: resumes the paused run (paused → halted, spec → open).
    await prober.probeOnce();
    expect(rows[0]!.status).toBe("halted");
    // Simulate: the walker re-enqueued a successor (a fresh paused row appears
    // because the new run hit the still-exhausted window). The prober's next
    // tick MUST resume it again — UNBOUNDED, no give-up. (The same row is
    // re-flipped to paused for the test; in production the new run is a
    // different runId, but the prober's contract is "scan + resume" — it
    // doesn't care about run identity.)
    rows[0]!.status = "paused";
    rows[0]!.outcome = "window_paused";
    await prober.probeOnce();
    prober.stop();
    expect(finalizes.filter((f) => f.event.eventType === "run.resumed")).toHaveLength(2);
    expect(specFlips.filter((s) => s.event.eventType === "dag.spec.redriven")).toHaveLength(2);
  });
});

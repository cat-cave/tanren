// task #82 — window-pause auto-resume. End-to-end CYCLE test:
//
//   writer/preflight hits window pressure
//     ↳ disposition → pause_for_capacity bucket
//     ↳ atomic seam flips run to `paused`, spec stays `in_flight`, emits run.paused
//   probe tick 1 finds the paused run
//     ↳ ONE atomic transaction (audit finding #3): paused → halted + run.resumed
//       AND spec in_flight → open + dag.spec.redriven, all live-or-die together
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
  ResumePausedRunAtomicInput,
  ResumePausedRunAtomicOutcome,
  RunStateWriter,
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

interface ResumeCall {
  runId: string;
  specId: string;
  status: string;
  outcome: string;
  specStatus: string;
  resumedEvent: AppendEventInput;
  redrivenEvent: AppendEventInput;
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
        // Codex H3 #11: the prober's SELECT now filters to BOTH pause outcomes
        // (`window_paused` + `awaiting_review`), so the fake mirrors the filter
        // and returns the outcome column for the resume-preserves-outcome fix.
        const paused = state.rows.filter(
          (row) => row.status === "paused" && (row.outcome === "window_paused" || row.outcome === "awaiting_review"),
        );
        return {
          rows: paused.map((row) => ({
            run_id: row.runId,
            spec_id: row.specId,
            project_id: row.projectId,
            org_id: row.orgId,
            ended_at: row.endedAt,
            outcome: row.outcome,
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
 *  the production atomic seams without a real Postgres. Audit finding #3:
 *  the resume now routes through ONE atomic call `resumePausedRunAtomic`, so
 *  the recording surface mirrors that single-transaction contract — either
 *  both row+event pairs flip together or neither does. */
function buildRecordingWriter(rows: RunRow[]): {
  writer: RunStateWriter;
  resumes: ResumeCall[];
} {
  const resumes: ResumeCall[] = [];
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
    finalizeRunWithEvent: async () => ({ updated: false, alreadyTerminal: false }),
    updateSpecWithEvent: async () => ({ flipped: false, alreadyTerminal: false }),
    resumePausedRunAtomic: async (input: ResumePausedRunAtomicInput): Promise<ResumePausedRunAtomicOutcome> => {
      const row = rows.find((r) => r.runId === input.finalize.runId);
      resumes.push({
        runId: input.finalize.runId,
        specId: input.spec.specId,
        status: input.finalize.status,
        outcome: input.finalize.outcome,
        specStatus: input.spec.status,
        resumedEvent: input.resumedEvent,
        redrivenEvent: input.redrivenEvent,
      });
      if (row !== undefined && input.finalize.fromStatuses.includes(row.status)) {
        // The atomic-apply contract: both flips live or die together. Mirror
        // that by flipping the row state in the fake only on the through path.
        row.status = input.finalize.status;
        row.outcome = input.finalize.outcome;
        return {
          runFinalized: true,
          runEventAlreadyTerminal: false,
          specFlipped: true,
          specId: row.specId,
          projectId: row.projectId,
        };
      }
      return { runFinalized: false, runEventAlreadyTerminal: false, specFlipped: false };
    },
  };
  return { writer, resumes };
}

describe("pausedRunResumeProber (task #82 — window-pause auto-resume)", () => {
  it("RESUMES one paused run via ONE atomic call (paused → halted + run.resumed AND spec → open + dag.spec.redriven)", async () => {
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
    const { writer, resumes } = buildRecordingWriter(rows);

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

    // Audit finding #3 fix: the prober now drives ONE atomic call carrying
    // BOTH the run finalize (paused → halted + run.resumed) AND the spec
    // flip (in_flight → open + dag.spec.redriven). A crash mid-apply rolls
    // back the whole unit (no `halted` + `in_flight` split-write orphan).
    expect(result.resumedRunIds).toContain("run_paused_1");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      runId: "run_paused_1",
      specId: "spec_1",
      status: "halted",
      outcome: "window_paused",
      specStatus: "open",
      resumedEvent: { eventType: "run.resumed" },
      redrivenEvent: { eventType: "dag.spec.redriven" },
    });
    // The resume event carries a positive pausedDurationSeconds (the row was
    // ended a minute ago); the prober's diagnostic.
    const payload = resumes[0]!.resumedEvent.payload as { pausedDurationSeconds: number };
    expect(payload.pausedDurationSeconds).toBeGreaterThan(0);
    // Audit finding #13: the prober's redrive event carries the
    // `prober_resume` source discriminator so `buildRedriveHistoryReader`
    // filters it out of the structural convergence history.
    const redrivenPayload = resumes[0]!.redrivenEvent.payload as { source?: string };
    expect(redrivenPayload.source).toBe("prober_resume");
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
    const { writer, resumes } = buildRecordingWriter(rows);
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
    expect(resumes).toEqual([]);
  });

  it("Codex H3 #11 — RESUMES an `awaiting_review` paused run and PRESERVES the outcome through the resume", async () => {
    // The human-review durable-park path (Codex H3 #11) parks a run with
    // `outcome: "awaiting_review"`. The prober admits it (same seam that task
    // #82 window_paused rides), and the resume PRESERVES `awaiting_review` on
    // the halted row so the recovery surface still distinguishes "waiting on
    // capacity" (window pressure) from "waiting on a human verdict".
    const rows: RunRow[] = [
      {
        runId: "run_review_paused",
        specId: "spec_review",
        projectId: "proj_review",
        orgId: "org_review",
        status: "paused",
        outcome: "awaiting_review",
        endedAt: new Date(Date.now() - 30_000),
      },
    ];
    const { pool } = buildPool(rows);
    const { writer, resumes } = buildRecordingWriter(rows);
    const prober = startPausedRunResumeProber({
      pool,
      runStateWriter: writer,
      probeIntervalMs: 60_000,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    const result = await prober.probeOnce();
    prober.stop();

    expect(result.resumedRunIds).toContain("run_review_paused");
    expect(resumes).toHaveLength(1);
    // The distinguishing WHY on the recovery surface — the outcome is
    // preserved through the resume (halted + awaiting_review), NOT collapsed
    // to `window_paused` (which would misclassify a human-review park as a
    // capacity pause on the dashboard / operator triage).
    expect(resumes[0]).toMatchObject({
      runId: "run_review_paused",
      specId: "spec_review",
      status: "halted",
      outcome: "awaiting_review",
      specStatus: "open",
      resumedEvent: { eventType: "run.resumed" },
      redrivenEvent: { eventType: "dag.spec.redriven" },
    });
  });

  it("Codex H3 #11 — RESTART preserves the parked state: a fresh prober picks up a still-paused run and resumes it", async () => {
    // The core durability invariant of the fix: the prior in-process polling
    // loop lost its state on a restart, forcing the worker to poll from scratch.
    // The new durable-park path lives in `runs.status` + `runs.outcome`, so a
    // fresh prober (post-restart) sees the paused row on its FIRST tick and
    // resumes it — the state survives the restart boundary.
    const rows: RunRow[] = [
      {
        runId: "run_survives_restart",
        specId: "spec_survives",
        projectId: "proj_survives",
        orgId: "org_survives",
        status: "paused",
        outcome: "awaiting_review",
        // 1h ago — long before this "restart".
        endedAt: new Date(Date.now() - 3_600_000),
      },
    ];
    const { pool } = buildPool(rows);
    const { writer, resumes } = buildRecordingWriter(rows);
    // A "fresh" prober — a brand-new instance with no in-memory state about
    // this run. It reads the paused row via the SELECT and resumes it.
    const prober = startPausedRunResumeProber({
      pool,
      runStateWriter: writer,
      probeIntervalMs: 60_000,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    const result = await prober.probeOnce();
    prober.stop();

    expect(result.resumedRunIds).toContain("run_survives_restart");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.outcome).toBe("awaiting_review");
    // The resume-event payload's paused duration reflects the row's ended_at
    // — proof the state was DURABLE across the restart (the 1h pause survives).
    const payload = resumes[0]!.resumedEvent.payload as { pausedDurationSeconds: number };
    expect(payload.pausedDurationSeconds).toBeGreaterThanOrEqual(3600);
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
    const { writer, resumes } = buildRecordingWriter(rows);
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
    // Each tick drove ONE atomic resume call carrying BOTH pair-events.
    expect(resumes).toHaveLength(2);
    expect(resumes.every((r) => r.resumedEvent.eventType === "run.resumed")).toBe(true);
    expect(resumes.every((r) => r.redrivenEvent.eventType === "dag.spec.redriven")).toBe(true);
  });
});

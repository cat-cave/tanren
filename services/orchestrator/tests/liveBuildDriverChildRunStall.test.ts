// Task #21B — the live build driver HALTS LOUD on a stalled child template-build
// project (the sign-of-life circuit breaker over the child's append-only event-
// stream identity), and NEVER fires on a working-but-slow child. The root finding
// is apex v49: a pre-session tanren-code bug (runner-INSERT retry loop on
// `runners_pkey`) kept the spec perpetually `in_flight` — `tally.progressing >= 1`,
// NOT `isDeadlocked` — so the synchronous derive request hung for ~8 hours with no
// inner-failure circuit breaker. The fix extends the timeout-eradication doctrine
// with a PROGRESS / SIGN-OF-LIFE circuit breaker watching the child project's
// `MAX(events.id)` identity: identity-based, never elapsed-time-based.
//
// The breaker mirrors the deadlock-test layout (the SAME walker/ssh/allocator
// fakes) so the wiring shape is the only thing differentiating the cases.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { DagSnapshot, DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import {
  buildRunLoopBuildDriver,
  CHILD_PROGRESS_PROBE_CADENCE_MS,
  ChildRunStalledError,
  NON_ADVANCE_PROBES_BEFORE_STALL,
  type ChildRunStallSignal,
  type ConvergedProjectFacts,
} from "../src/engine/templates/index.js";

// A snapshot with a single `in_flight` spec — `progressing >= 1` so the deadlock
// predicate does NOT fire; only the breaker can halt this build. This is the
// EXACT apex v49 shape: the DAG looks alive even though no real work is happening.
function inFlightSnapshot(): DagSnapshot {
  return {
    projectId: "project_tmpl",
    archived: false,
    nodes: [
      {
        specId: "spec_running",
        phase: "in_flight",
        dependsOn: [],
        priority: "p1",
        orderKey: 0,
      },
    ],
  };
}

class RecordingWalker implements DagWalker {
  readonly walked: string[] = [];
  async walk(projectId: string): Promise<WalkResult> {
    this.walked.push(projectId);
    return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }
}

class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

const fakeAllocator = {
  async allocate() {
    return { runnerId: "runner_1", imageSha: "img@sha", target: { backend: "ssh" } as RunnerHandle };
  },
  async release() {},
};

const convergedFacts: ConvergedProjectFacts = {
  repoRef: "https://example.test/tmpl.git",
  builtSha: "a".repeat(40),
  runnerImage: "tanren/runner:latest",
};

const stubAuditor = {
  async openBlockingFindings() {
    return 0;
  },
};

// Build the driver deps with an injected `childRunProgressSignal`. The signal
// REPLACES the default `MAX(events.id)` probe, so the test is hermetic — no
// database, no pool, no schema. `convergence.pollIntervalMs` is set EQUAL to
// `CHILD_PROGRESS_PROBE_CADENCE_MS` so `probeTicksPerProbe = 1` — the probe ticks
// every poll cycle, letting the test exercise the IDENTITY logic without the
// real-world ratio between poll cadence and probe cadence. The injected `sleep`
// is a no-op so the loop runs synchronously.
function buildDriverDeps(overrides: {
  loadSnapshot: (p: string) => Promise<DagSnapshot>;
  childRunProgressSignal: ChildRunStallSignal;
}) {
  const ssh = new RecordingSsh();
  const walker = new RecordingWalker();
  return {
    ssh,
    walker,
    deps: {
      pool: {} as never,
      allocator: fakeAllocator,
      ssh,
      identitySecretRef: "id/ref",
      walker,
      loadSnapshot: overrides.loadSnapshot,
      resolveConverged: async () => convergedFacts,
      auditorFor: () => stubAuditor,
      convergence: { pollIntervalMs: CHILD_PROGRESS_PROBE_CADENCE_MS },
      childRunProgressSignal: overrides.childRunProgressSignal,
      sleep: async () => {},
    },
  };
}

describe("task #21B — driveToConvergence HALTS LOUD on a stalled child template-build (never hangs)", () => {
  it("HALTS LOUD when the child's events-table identity holds FLAT across the streak ceiling", async () => {
    // The apex v49 shape: a single spec is `in_flight` (the DAG looks alive) but the
    // child project emits ZERO new events between probes — the event-stream identity
    // is the SAME bigint on every probe. After `NON_ADVANCE_PROBES_BEFORE_STALL`
    // consecutive flat probes the breaker fires `ChildRunStalledError` (wrapped as
    // `TemplateBuildFailedError`), naming the stalled child project + the last
    // observed signature value + the streak length — never a silent hang.
    let probeCount = 0;
    const { deps } = buildDriverDeps({
      loadSnapshot: async () => inFlightSnapshot(),
      childRunProgressSignal: {
        probe: async () => {
          probeCount += 1;
          // Flat identity: the SAME value every probe (no audit-event progress).
          return BigInt(42);
        },
      },
    });
    let caught: unknown;
    try {
      await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    } catch (error) {
      caught = error;
    }
    // The OUTER error is the build-driver boundary error; the INNER `cause` is the
    // structured stall error the HTTP boundary maps to a 504.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/STALLED/u);
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(ChildRunStalledError);
    const stall = cause as ChildRunStalledError;
    expect(stall.childProjectId).toBe("project_tmpl");
    expect(stall.lastSignatureValue).toBe(BigInt(42));
    expect(stall.nonAdvancingProbes).toBe(NON_ADVANCE_PROBES_BEFORE_STALL);
    // The streak ceiling fired EXACTLY at the bound (the first probe sets the
    // signature, every subsequent flat probe increments the streak until the
    // ceiling). Probe count = ceiling: identity advancement on probe #1 resets
    // streak to 0; probes #2..N+1 all observe the same identity → streak hits N.
    expect(probeCount).toBe(NON_ADVANCE_PROBES_BEFORE_STALL + 1);
  });

  it("NEVER FIRES on a working-but-slow child (the event-stream identity monotonically advances)", async () => {
    // A legitimately-slow child emits events steadily — the identity ADVANCES on
    // every probe, RESETTING the non-advancing streak each tick. The breaker must
    // never fire on this trajectory regardless of wall-clock; the build keeps polling
    // INDEFINITELY (it would converge in reality). To terminate the test, the
    // snapshot fake transitions the spec to `done` after a synthetic threshold so the
    // build converges normally — proving the breaker stayed silent throughout.
    let snapshotPolls = 0;
    let probeCount = 0;
    const synthDoneAfterPolls = NON_ADVANCE_PROBES_BEFORE_STALL * 3;
    const { walker, deps } = buildDriverDeps({
      loadSnapshot: async () => {
        snapshotPolls += 1;
        if (snapshotPolls <= synthDoneAfterPolls) return inFlightSnapshot();
        return {
          projectId: "project_tmpl",
          archived: false,
          nodes: [{ specId: "spec_running", phase: "done", dependsOn: [], priority: "p1", orderKey: 0 }],
        };
      },
      childRunProgressSignal: {
        probe: async () => {
          probeCount += 1;
          // Monotonically advancing identity — the working child's audit stream.
          return BigInt(probeCount);
        },
      },
    });
    // No throw — the build converges via the synthetic `done` transition. The breaker
    // is silent because every probe advanced the identity (streak never accumulated).
    await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    // It polled past the streak ceiling (we ran 3× the ceiling worth of polls) —
    // proving the breaker would have fired if the signal had been flat.
    expect(probeCount).toBeGreaterThan(NON_ADVANCE_PROBES_BEFORE_STALL);
    expect(walker.walked.length).toBeGreaterThanOrEqual(synthDoneAfterPolls);
  });

  it("#640-class immunity — a worker ticking `job_queue.heartbeat_at` does NOT affect the events-table signal", async () => {
    // RESTATEMENT of case 1 with an explicit doctrine note: the signal is
    // `MAX(events.id)`, which is APPEND-ONLY and emitted ONLY on meaningful work.
    // A retry-looping worker that ticks `job_queue.heartbeat_at` on each requeue
    // (the #640 class — a lock-file heartbeat that defeats mtime-based watchdogs)
    // CANNOT advance the events.id signature; the breaker fires regardless. This
    // case proves the design — the probe is INSIDE the stall signal interface, so
    // the test exercises the same identity-stasis path case 1 does.
    const { deps } = buildDriverDeps({
      loadSnapshot: async () => inFlightSnapshot(),
      childRunProgressSignal: {
        // A flat events.id signature — the worker may be ticking other things (lease,
        // heartbeat_at, runs.updated_at on each requeue), but events.id is the audit
        // log and a retry loop emits zero events.
        probe: async () => BigInt(99),
      },
    });
    await expect(buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(
      /STALLED/u,
    );
  });
});

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
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import {
  buildRunLoopBuildDriver,
  CHILD_PROGRESS_PROBE_CADENCE_MS,
  ChildRunStalledError,
  NON_ADVANCE_PROBES_BEFORE_STALL,
  WORKER_PROGRESS_EVENT_PREFIXES,
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

  // -------------------------------------------------------------------
  // CONFORMANCE TESTS — the audit-blocker repro (the tests that should have
  // caught the original bug). The earlier cases above use a `RecordingWalker`
  // fake + a synthetic `childRunProgressSignal` returning a constant `BigInt(42)`
  // — that bypassed the real signal source and so could not detect the defect.
  //
  // These wire the REAL `EventEmittingDagWalker` (the production class) against a
  // focused in-memory event log, and use a `ChildRunStallSignal` whose `probe()`
  // applies the EXACT allowlist (`WORKER_PROGRESS_EVENT_PREFIXES`) the production
  // SQL `LIKE ANY` filter encodes — the exported constant is the SAME source the
  // production probe uses, so a drift between docs and the lived filter surfaces
  // as a test failure. We use a focused in-memory fake (not a real pg pool)
  // because the defect is the SQL filter; a real pg+RLS+`runWithOrgScope`
  // integration is materially heavier than this test needs to be.
  it("CONFORMANCE — breaker fires under the apex v49 shape even with the REAL walker emitting dag.drained on every poll", async () => {
    const { log, walker } = buildRealWalkerOnInMemoryLog();
    const probeSignal = buildAllowlistedProbe(log);
    const deps = buildRealWalkerDeps({ walker, loadSnapshot: async () => inFlightSnapshot(), probeSignal });

    let caught: unknown;
    try {
      await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    } catch (error) {
      caught = error;
    }
    // The breaker fired — without the allowlist filter the signal would advance
    // on every probe (the walker writes dag.drained each poll cycle) and this
    // would hang forever instead of throwing.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/STALLED/u);
    expect((caught as Error).cause).toBeInstanceOf(ChildRunStalledError);

    // Sanity: the walker DID write dag.* events into the log (proving the test
    // exercised the bug shape, not a vacuous pass against an empty log), AND the
    // log contains ZERO worker-progress events (the breaker fired purely because
    // the filter excluded the orchestrator's own emissions).
    expect(log.filter((e) => e.eventType.startsWith("dag.")).length).toBeGreaterThanOrEqual(
      NON_ADVANCE_PROBES_BEFORE_STALL,
    );
    const allowedPrefixes = WORKER_PROGRESS_EVENT_PREFIXES.map((p) => p.replace(/%$/u, ""));
    expect(log.filter((e) => allowedPrefixes.some((p) => e.eventType.startsWith(p)))).toHaveLength(0);
  });

  // Task #24 (apex v52/v53) + task #62 (apex v56) — INVARIANT on the const: the
  // cross-layer sign-of-life bridge `writer.%` (task #24) and the subtask-stage
  // families `checker.%`/`planner.%`/`triage.%`/`convergence.%`/`designOracle.%`
  // (task #62 — without them the v56 format-lint-gate iteration counted as zero
  // progress and the breaker false-fired) MUST stay on the allowlist; drift
  // between the documented surface and the lived filter is the defect class.
  it.each(["writer.%", "checker.%", "planner.%", "triage.%", "convergence.%", "designOracle.%"])(
    "INVARIANT (tasks #24/#62) — `%s` is on the worker-progress allowlist",
    (prefix) => {
      expect(WORKER_PROGRESS_EVENT_PREFIXES).toContain(prefix);
    },
  );

  // Task #62 (apex v56) — INTEGRATION SHAPE: a child project iterating purely
  // on a subtask-stage family (e.g. format-lint-gate emitting only checker /
  // triage / convergence rounds) must NOT trip the breaker.
  it.each([
    ["checker.rejected"],
    ["planner.subtasks.emitted"],
    ["triage.completed"],
    ["convergence.assessed"],
    ["designOracle.verdict"],
  ])("CONFORMANCE (task #62) — a child run posting ONLY `%s` keeps the breaker quiet", async (injectedEventType) => {
    const { log, walker } = buildRealWalkerOnInMemoryLog();
    let snapshotPolls = 0;
    const synthDoneAfterPolls = NON_ADVANCE_PROBES_BEFORE_STALL * 3;
    const probeSignal = buildAllowlistedProbe(log, injectedEventType);
    const deps = buildRealWalkerDeps({
      walker,
      probeSignal,
      loadSnapshot: async () => {
        snapshotPolls += 1;
        if (snapshotPolls <= synthDoneAfterPolls) return inFlightSnapshot();
        return {
          projectId: "project_tmpl",
          archived: false,
          nodes: [{ specId: "spec_running", phase: "done", dependsOn: [], priority: "p1", orderKey: 0 }] as const,
        } as DagSnapshot;
      },
    });
    await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    expect(log.filter((e) => e.eventType === injectedEventType).length).toBeGreaterThan(
      NON_ADVANCE_PROBES_BEFORE_STALL,
    );
    // ZERO previously-allowlisted progress events landed — the only signal
    // keeping the breaker quiet was the v56-added subtask-stage prefix.
    const v56Excluded = ["task.", "run.", "gate.", "auditor.", "audit.", "merge.", "writer."];
    expect(log.filter((e) => v56Excluded.some((p) => e.eventType.startsWith(p)))).toHaveLength(0);
  });

  // Task #24 (apex v52/v53) — INTEGRATION SHAPE: a child project that emits ONLY
  // `writer.subtask.progress` rows (the watchdog's cross-layer sign-of-life bridge) over
  // many probe windows must NOT trip the breaker. This is the v52/v53 shape: codex is
  // silent for minutes during a `pnpm install`, the workspace count+bytes signature
  // briefly plateaus mid-IO-burst, but the watchdog still emits progress every tick the
  // signature advances. Without the `writer.%` allowlist this hangs forever (no allowed
  // event ever lands) or the breaker fires — both wrong; the bridge fixes both.
  it("CONFORMANCE (task #24) — a child run posting ONLY `writer.subtask.progress` keeps the breaker quiet", async () => {
    const { log, walker } = buildRealWalkerOnInMemoryLog();
    let snapshotPolls = 0;
    const synthDoneAfterPolls = NON_ADVANCE_PROBES_BEFORE_STALL * 3;
    // Inject a writer.subtask.progress per probe — the breaker MUST stay silent because
    // `writer.%` is on the allowlist. Without that entry the signal would be flat and
    // the breaker would fire across the streak ceiling.
    const probeSignal = buildAllowlistedProbe(log, "writer.subtask.progress");
    const deps = buildRealWalkerDeps({
      walker,
      probeSignal,
      loadSnapshot: async () => {
        snapshotPolls += 1;
        if (snapshotPolls <= synthDoneAfterPolls) return inFlightSnapshot();
        return {
          projectId: "project_tmpl",
          archived: false,
          nodes: [{ specId: "spec_running", phase: "done", dependsOn: [], priority: "p1", orderKey: 0 }] as const,
        } as DagSnapshot;
      },
    });

    // No throw — the build converges via the `done` transition. The breaker stayed
    // silent because every probe observed a NEW writer.subtask.progress id (the
    // watchdog bridge keeping the streak alive on a slow writer turn).
    await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    expect(log.filter((e) => e.eventType === "writer.subtask.progress").length).toBeGreaterThan(
      NON_ADVANCE_PROBES_BEFORE_STALL,
    );
    // Sanity: the log contains NO worker events outside the bridge — the only signal that
    // kept the breaker quiet was `writer.subtask.progress`.
    const allowedExclWriter = ["task.", "run.", "gate.", "auditor.", "audit.", "merge."];
    expect(log.filter((e) => allowedExclWriter.some((p) => e.eventType.startsWith(p)))).toHaveLength(0);
  });

  // Pairs with the test above: when the worker IS genuinely advancing (it emits
  // `task.*` events between probes), the breaker stays silent regardless of how
  // many `dag.drained` rows the walker writes alongside. Together the two pin
  // the filter in BOTH directions — the dag.* exclusion is mandatory, the
  // worker-progress inclusion works.
  it("CONFORMANCE — breaker stays silent when worker.* events advance alongside the walker's dag.* self-emissions", async () => {
    const { log, walker } = buildRealWalkerOnInMemoryLog();
    let snapshotPolls = 0;
    const synthDoneAfterPolls = NON_ADVANCE_PROBES_BEFORE_STALL * 3;
    // Inject a worker-progress emission per probe — the breaker MUST stay silent.
    const probeSignal = buildAllowlistedProbe(log, "task.completed");
    const deps = buildRealWalkerDeps({
      walker,
      probeSignal,
      loadSnapshot: async () => {
        snapshotPolls += 1;
        if (snapshotPolls <= synthDoneAfterPolls) return inFlightSnapshot();
        return {
          projectId: "project_tmpl",
          archived: false,
          nodes: [{ specId: "spec_running", phase: "done", dependsOn: [], priority: "p1", orderKey: 0 }] as const,
        } as DagSnapshot;
      },
    });

    // No throw — the build converges via the `done` transition. The breaker
    // stayed silent because every probe observed a NEW task.* id even though the
    // walker also kept appending dag.drained beside it.
    await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    expect(log.filter((e) => e.eventType.startsWith("dag.")).length).toBeGreaterThan(0);
    expect(log.filter((e) => e.eventType.startsWith("task.")).length).toBeGreaterThan(NON_ADVANCE_PROBES_BEFORE_STALL);
  });
});

// ------------------------- Conformance-test helpers --------------------------

type InMemoryEvent = { id: bigint; eventType: string };

/** A `DagEventEmitter` that captures every dag.* emission into the supplied log. */
function buildInMemoryDagEventEmitter(log: InMemoryEvent[]): unknown {
  let nextId = log.reduce((m, e) => (e.id > m ? e.id : m), 0n);
  const append = (eventType: string): void => {
    nextId += 1n;
    log.push({ id: nextId, eventType });
  };
  return {
    async emitSpecEnqueued() {
      append("dag.spec.enqueued");
    },
    async emitSpecSpeculative() {
      append("dag.spec.speculative");
    },
    async emitSpeculationHeld() {
      append("dag.spec.speculation_held");
    },
    async emitAncestorNotReady() {
      append("dag.spec.ancestor_not_ready");
    },
    async emitDrained() {
      append("dag.drained");
    },
    async emitBudgetPaused() {
      append("dag.budget.paused");
    },
    async emitBudgetMilestone() {
      append("dag.budget.milestone");
      return false;
    },
    async emitConcurrencySaturated() {
      append("dag.concurrency.saturated");
    },
    async emitConfigCorrupt() {
      append("dag.config.corrupt");
    },
  };
}

/**
 * Build a real `EventEmittingDagWalker` wired against in-memory fakes for the
 * in_flight-only apex v49 snapshot. Returns the shared log alongside the walker
 * so the test can probe + assert against it.
 */
function buildRealWalkerOnInMemoryLog(): { log: InMemoryEvent[]; walker: EventEmittingDagWalker } {
  const log: InMemoryEvent[] = [];
  const events = buildInMemoryDagEventEmitter(log) as ConstructorParameters<typeof EventEmittingDagWalker>[0]["events"];
  const walker = new EventEmittingDagWalker({
    readModel: { loadSnapshot: async () => inFlightSnapshot() },
    lifecycleReadModel: {
      loadLifecycle: async () => ({ projectId: "project_tmpl", bySpecId: new Map() }),
    },
    enqueuer: {
      enqueueSpecRun: async () => {
        throw new Error("enqueueSpecRun should not run — the in_flight-only snapshot has no pending specs");
      },
    },
    events,
    budgetGate: {
      resolveBudget: async () => ({ ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0 }),
    },
    ancestorStackResolver: { resolveStack: async () => [] },
    speculationConfig: async () => ({ threshold: "moderate", depthCap: 3 }),
    concurrency: () => 4,
  });
  return { log, walker };
}

/**
 * A probe that mirrors the production `LIKE ANY` filter in JS using the SAME
 * `WORKER_PROGRESS_EVENT_PREFIXES` the production SQL uses (drift = test
 * failure). When `injectOnProbe` is set, each probe call appends one event of
 * that type to the log first — the second conformance test uses this to
 * synthesize worker forward motion alongside the walker's dag.* writes.
 */
function buildAllowlistedProbe(log: InMemoryEvent[], injectOnProbe?: string): ChildRunStallSignal {
  const allowedPrefixes = WORKER_PROGRESS_EVENT_PREFIXES.map((p) => p.replace(/%$/u, ""));
  let nextId = log.reduce((m, e) => (e.id > m ? e.id : m), 0n);
  return {
    probe: async () => {
      if (injectOnProbe !== undefined) {
        nextId += 1n;
        log.push({ id: nextId, eventType: injectOnProbe });
      }
      const matches = log.filter((e) => allowedPrefixes.some((p) => e.eventType.startsWith(p)));
      if (matches.length === 0) return;
      return matches.reduce((max, e) => (e.id > max ? e.id : max), matches[0]!.id);
    },
  };
}

/** Compose the build-driver deps wiring the real walker + the probe + an inert ssh/allocator. */
function buildRealWalkerDeps(input: {
  walker: EventEmittingDagWalker;
  loadSnapshot: (p: string) => Promise<DagSnapshot>;
  probeSignal: ChildRunStallSignal;
}) {
  const ssh = new RecordingSsh();
  return {
    pool: {} as never,
    allocator: fakeAllocator,
    ssh,
    identitySecretRef: "id/ref",
    walker: input.walker,
    loadSnapshot: input.loadSnapshot,
    resolveConverged: async () => convergedFacts,
    auditorFor: () => stubAuditor,
    convergence: { pollIntervalMs: CHILD_PROGRESS_PROBE_CADENCE_MS },
    childRunProgressSignal: input.probeSignal,
    sleep: async () => {},
  };
}

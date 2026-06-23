// apex v35 — Bug 2: the live build driver HALTS LOUD on a GENUINE deadlock, never
// HANGS. The old `driveToConvergence` counted `progressing = total - done - blocked`
// where `blocked` was only `terminal_blocked` specs — so a `pending` spec whose
// ancestor is terminal (`needs_attention`) was miscounted as "progressing" though it
// can NEVER run. A build whose only remaining specs were a `needs_attention` spec +
// its transitively-blocked dependents therefore HUNG forever.
//
// The fix routes the deadlock decision through the SHARED progress classification
// (specProgress.ts — the SAME vocabulary the orphan-slot reconciler uses): a spec is
// `progressing` iff it is in-flight or runnable-pending; a transitively-blocked
// pending spec is NOT progressing. When `progressing === 0` and the build has not
// converged, it HALTS LOUD (naming the genuine human-decision blocker). While ANY
// spec is still progressing it keeps polling indefinitely (no wall-clock).

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { DagSnapshot, DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import { buildRunLoopBuildDriver, type ConvergedProjectFacts } from "../src/engine/templates/index.js";

// A snapshot with explicit `dependsOn` edges — the shared classifier decides whether
// a pending spec is runnable or transitively blocked by a terminal ancestor.
function snapshotWithEdges(
  nodes: Array<{ specId: string; phase: DagSnapshot["nodes"][number]["phase"]; dependsOn?: string[] }>,
): DagSnapshot {
  return {
    projectId: "project_tmpl",
    archived: false,
    nodes: nodes.map((n, i) => ({
      specId: n.specId,
      phase: n.phase,
      dependsOn: n.dependsOn ?? [],
      priority: "p1",
      orderKey: i,
    })),
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

function buildDriverDeps(overrides: { loadSnapshot: (p: string) => Promise<DagSnapshot> }) {
  const ssh = new RecordingSsh();
  const walker = new RecordingWalker();
  // The deadlock cases fire BEFORE any progress probe — the genuine-deadlock
  // predicate halts on the first or second poll. We still inject a non-stalling
  // stub `childRunProgressSignal` so the build driver does not default-construct
  // the live `MAX(events.id)` probe over the test's `{} as never` pool (which
  // would throw on the first probe). The stub returns a monotonically advancing
  // identity, so even if the breaker IS consulted it would never fire — the
  // deadlock outcome must be the deadlock path's, not the breaker's.
  let probeId = 0;
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
      childRunProgressSignal: {
        probe: async () => {
          probeId += 1;
          return BigInt(probeId);
        },
      },
      convergence: { pollIntervalMs: 1 },
      sleep: async () => {},
    },
  };
}

describe("Bug 2 — driveToConvergence HALTS LOUD on a transitively-blocked deadlock (never hangs)", () => {
  it("HALTS LOUD when the only non-merged specs are a needs_attention spec + its transitively-blocked dependents", async () => {
    // The live failure shape: spec_A `terminal_blocked` (a genuine needs_attention),
    // spec_B depends on A (pending), spec_C depends on B (pending). B and C can NEVER
    // run, but the OLD `total - done - blocked` count called them "progressing" ⇒ the
    // build HUNG forever. The shared tally classifies B and C as transitively_blocked
    // ⇒ progressing === 0 ⇒ HALT LOUD, naming the genuine blocker spec_A.
    let poll = 0;
    const { deps } = buildDriverDeps({
      loadSnapshot: async () => {
        poll += 1;
        return snapshotWithEdges([
          { specId: "spec_A", phase: "terminal_blocked" },
          { specId: "spec_B", phase: "pending", dependsOn: ["spec_A"] },
          { specId: "spec_C", phase: "pending", dependsOn: ["spec_B"] },
        ]);
      },
    });
    await expect(buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(
      /STRANDED/u,
    );
    // It HALTED promptly (a single failing poll suffices) — it did NOT hang/poll forever.
    expect(poll).toBe(1);
    // The diagnostic names the GENUINE human-decision blocker (spec_A) — never a silent hang.
    await expect(buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(
      /spec_A/u,
    );
  });

  it("a re-driving / in-flight spec beside a transitively-blocked one KEEPS polling (a runnable spec is progressing)", async () => {
    // Distinguishes a GENUINE deadlock from a transient one: spec_A is terminal and
    // blocks spec_B (transitively_blocked), but spec_C is an INDEPENDENT spec still
    // making progress. Forward progress IS possible via spec_C, so the build must NOT
    // halt — it keeps polling until spec_C lands, THEN (with only A terminal + B
    // blocked left) it halts loud — proving it waited for the runnable spec first.
    const scripted = [
      [
        { specId: "spec_A", phase: "terminal_blocked" as const },
        { specId: "spec_B", phase: "pending" as const, dependsOn: ["spec_A"] },
        { specId: "spec_C", phase: "in_flight" as const },
      ],
      [
        { specId: "spec_A", phase: "terminal_blocked" as const },
        { specId: "spec_B", phase: "pending" as const, dependsOn: ["spec_A"] },
        { specId: "spec_C", phase: "done" as const },
      ],
    ];
    let poll = 0;
    const { walker, deps } = buildDriverDeps({
      loadSnapshot: async () => snapshotWithEdges(scripted[Math.min(poll++, scripted.length - 1)]),
    });
    await expect(buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(
      /STRANDED/u,
    );
    // It POLLED past poll 1 (spec_C was progressing) and only halted once spec_C landed.
    expect(walker.walked.length).toBeGreaterThanOrEqual(2);
  });
});

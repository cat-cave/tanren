// Unit tests for the drive-path conflict resolver's CLASSIFY-THEN-ESCALATE +
// percolation/cap guards (engine/merge/driveConflictResolve.ts). The §2b resolver
// CORE is tested in conflictResolver.test.ts; this proves the drive WRAPPER:
//
//   - a conflict the resolver RESOLVES → `{resolved:true}`
//     (the dispatcher retries the merge → it lands; autonomous);
//   - a conflict the resolver could not mechanically reconcile but whose intents
//     are COMPATIBLE → an unresolved result with a durable planner-run receipt;
//   - once the spec has been re-planned `MAX_CONFLICT_REPLANS` times and STILL
//     conflicts → an ownerless human-decision result; the resolver is NOT even invoked
//     again (no runner provisioned) — the two intents are genuinely incompatible;
//   - a live `percolation_pending` marker → the drive YIELDS (throws
//     PercolationOwnsSpecError) rather than racing percolation,
//     and provisions NO runner.
//
// Every seam is a fake under tests/ — no real LLM/runner/DB. The resolver itself is
// injected (the `buildResolver` test seam) so we assert the wrapper's classification
// without driving the live model/SSH machinery (which the resolver-core suite covers).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { AllocationRequest, RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { CommandResult, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildDriveConflictResolve,
  type DriveConflictResolveDeps,
  PercolationOwnsSpecError,
} from "../src/engine/merge/driveConflictResolve.js";
import type { ConflictContext, ConflictResolverHook } from "../src/engine/workflow/reviewMerge/index.js";
import {
  conflictSignatureOf,
  type ReplanEnqueuer,
  SpecStatusReplanRouter,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { inertGitHubHttp } from "./helpers/githubHttp.js";

const ORG_ID = "org_x";
const FACTS = {
  orgId: ORG_ID,
  projectId: "project_x",
  specId: "spec_x",
  runId: "run_x",
  githubCredentialRef: "",
};

const CONTEXT: ConflictContext = {
  runId: "run_x",
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  baseBranch: "main",
  message: "merge conflict in src/router.ts",
};

/**
 * A fake pool answering the drive resolver's two reads: the percolation marker
 * (`SELECT percolation_pending FROM runs`) under a per-job org scope (`pool.query`),
 * and the prior-replan event COUNT under an org scope (`connect()` → BEGIN/SET
 * LOCAL/COUNT/COMMIT). Plus the run-context join (only reached when no escalate/yield).
 */
function fakePool(opts: { percolationPending?: unknown; priorReplanSignatures?: string[] }): pg.Pool {
  const projectConfig = {
    version: 1,
    credentials: {
      githubCredentialRef: "credential/github/dev",
      defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
    },
  };
  const answer = (sql: string): { rows: unknown[]; rowCount: number } => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT percolation_pending FROM runs/u.test(sql)) {
      return { rows: [{ percolation_pending: opts.percolationPending ?? null }], rowCount: 1 };
    }
    if (/event_type = 'merge\.conflict\.replan_routed'/u.test(sql)) {
      const rows = (opts.priorReplanSignatures ?? []).map((conflictSignature) => ({ payload: { conflictSignature } }));
      return { rows, rowCount: rows.length };
    }
    // loadDriveRunContext: the runs⋈specs⋈projects⋈organizations join.
    if (/FROM runs r/u.test(sql) && /JOIN specs s/u.test(sql)) {
      return {
        rows: [
          {
            repo_url: "https://github.com/o/r",
            default_branch: "main",
            branch: "run_x",
            runner_image: "ghcr.io/o/runner:latest",
            config: projectConfig,
            org_config: { version: 1 },
            title: "Add analytics",
            description: "Expose per-link analytics",
            acceptance_criteria: ["GET /links/:id/analytics returns counts"],
          },
        ],
        rowCount: 1,
      };
    }
    // resolveCredentialsForRun: the org-default provider-mode read.
    if (/SELECT config FROM organizations WHERE id/u.test(sql)) {
      return { rows: [{ config: { version: 1 } }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in drive-resolver fake: ${text}`);
  };
  const client = {
    query: (sql: string) => Promise.resolve(answer(sql)),
    release: () => {},
  };
  return {
    query: (sql: string) => Promise.resolve(answer(sql)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
}

/** A spying allocator: records allocate calls so we can assert "no runner provisioned". */
class SpyAllocator extends FakeAllocator {
  allocateCalls = 0;
  releaseCalls = 0;
  readonly requests: AllocationRequest[] = [];
  readonly releases: string[] = [];
  override async allocate(request: Parameters<FakeAllocator["allocate"]>[0]) {
    this.allocateCalls += 1;
    this.requests.push(request);
    return super.allocate(request);
  }
  override async release(runnerId: string): Promise<void> {
    this.releaseCalls += 1;
    this.releases.push(runnerId);
  }
}

function makeDeps(
  pool: pg.Pool,
  allocator: SpyAllocator,
  buildResolver?: DriveConflictResolveDeps["buildResolver"],
  ssh: DriveConflictResolveDeps["ssh"] = new FakeCommandSubstrate(),
  eventStore: FakeEventStore = new FakeEventStore(),
): DriveConflictResolveDeps {
  return {
    pool,
    scopedPool: pool,
    facts: FACTS,
    allocator,
    ssh,
    secrets: new FakeSecretStore(),
    githubHttp: inertGitHubHttp(),
    eventStore,
    identitySecretRef: "secret/runner/identity",
    timeoutMs: 1000,
    ...(buildResolver !== undefined && { buildResolver }),
  };
}

/** A scripted resolver hook (the injected test seam) returning a fixed outcome. */
function scriptedResolver(resolved: boolean): DriveConflictResolveDeps["buildResolver"] {
  return () =>
    (async () =>
      resolved
        ? { resolved: true }
        : {
            resolved: false,
            recovery: { kind: "parking_required", message: "scripted resolver assigned no owner" },
          }) satisfies ConflictResolverHook;
}

/** Records the re-plan run enqueue (the never-discard re-author) — returns a fixed run id. */
class RecordingEnqueuer implements ReplanEnqueuer {
  calls = 0;
  constructor(private readonly replanRunId = "run_replan_drive") {}
  async enqueue(): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls += 1;
    return { replanRunId: this.replanRunId, plannerTaskId: `task_${this.replanRunId}` };
  }
}

/**
 * A resolver hook that — like the REAL `buildDefaultConflictResolver` the drive wires — routes
 * an irreconcilable conflict through the SHARED `SpecStatusReplanRouter` (so the routed replan
 * ACTUALLY enqueues + emits `recovery.replan_queued`) before returning `{resolved:false}`. The
 * router shares the drive's eventStore, so the disposition mapping + the enqueue are asserted
 * together (the production composition: drive → buildResolverForDrive → router → enqueuer).
 */
function replanRoutingResolver(
  eventStore: FakeEventStore,
  enqueuer: ReplanEnqueuer,
): DriveConflictResolveDeps["buildResolver"] {
  return () =>
    (async () => {
      // Recovery allowlist needs open/in_flight/review; empty status would park.
      const pool = {
        async query(sql: string) {
          if (String(sql).includes("SELECT status FROM specs")) {
            return { rows: [{ status: "in_flight" }] };
          }
          return { rows: [] };
        },
      } as never;
      const router = new SpecStatusReplanRouter({
        pool,
        orgId: ORG_ID,
        eventStore,
        runId: FACTS.runId,
        projectId: FACTS.projectId,
        enqueuer,
        priorReplans: { signatures: async () => [] },
        // Required writer for escalate paths; happy-path enqueue uses the enqueuer only.
        runStateWriter: {
          setSpecStatus: async () => {},
          prepareSpecForRecovery: async () => ({ prepared: true, fromStatus: "in_flight" }),
          updateSpecWithEvent: async () => {},
        } as never,
      });
      const recovery = await router.routeBackToPlanner({
        specId: FACTS.specId,
        newContext: "re-plan on the new base",
      });
      return { resolved: false, recovery };
    }) satisfies ConflictResolverHook;
}

/** A command substrate that records every command run (to assert the workspace mechanism). */
class RecordingSubstrate extends FakeCommandSubstrate {
  readonly commands: string[] = [];
  override async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return super.run(handle, command);
  }
}

describe("buildDriveConflictResolve — classify-then-escalate + percolation/cap guards", () => {
  it("RESOLVED: the resolver reconciles and the merge retries + lands", async () => {
    const pool = fakePool({});
    const allocator = new SpyAllocator();
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, scriptedResolver(true)));

    const result = await hook(CONTEXT);

    expect(result).toEqual({ resolved: true });
    // A runner WAS provisioned (the real resolution path) and released.
    expect(allocator.allocateCalls).toBe(1);
    expect(allocator.releaseCalls).toBe(1);
  });

  it("allocates the short-lived live-jj resolver with a unique synthetic handle, not the original run id", async () => {
    const pool = fakePool({});
    const allocator = new SpyAllocator();
    let workspacePath = "";
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, (_target, workspace) => {
        workspacePath = workspace;
        return (async () => ({ resolved: true })) satisfies ConflictResolverHook;
      }),
    );

    await hook(CONTEXT);

    // The live jj workspace allocates a RUNLESS synthetic `run_live_jj_*` handle (so a
    // retained `runner_<runId>` row from the real run can't collide) — never the run id.
    const handle = allocator.requests[0]?.runId;
    expect(handle).toMatch(/^run_live_jj_[0-9a-f]+$/u);
    expect(handle).not.toBe(FACTS.runId);
    expect(allocator.requests[0]).toMatchObject({
      runless: true,
      persistedRunId: null,
      persistedProjectId: FACTS.projectId,
    });
    expect(allocator.releases[0]).toBe(`runner_${handle}`);
    expect(workspacePath).toBe(`/workspace/runs/${handle}/repo`);
  });

  it("does not fabricate a replan receipt for an unresolved ownerless result", async () => {
    const pool = fakePool({});
    const allocator = new SpyAllocator();
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, scriptedResolver(false)));

    const result = await hook(CONTEXT);

    expect(result).toEqual({
      resolved: false,
      recovery: { kind: "parking_required", message: "scripted resolver assigned no owner" },
    });
    expect(allocator.allocateCalls).toBe(1);
    expect(allocator.releaseCalls).toBe(1);
  });

  // THE v35 UNIFY (the merge-coordinator drive path was the third replan site): a `replanned`
  // disposition must ACTUALLY enqueue a re-plan run + emit `recovery.replan_queued` — never a
  // bare `merge.conflict.replan_routed` that "relies on the next drive-pass" and strands. The
  // drive routes through the SAME shared `SpecStatusReplanRouter`/enqueuer #585 added, so the
  // resolver's irreconcilable route enqueues + the disposition maps to a recoverable conflict.
  it("RE-PLANNED enqueues a re-plan run + emits recovery.replan_queued (never a bare replan_routed strand)", async () => {
    const pool = fakePool({});
    const allocator = new SpyAllocator();
    const eventStore = new FakeEventStore();
    const enqueuer = new RecordingEnqueuer("run_replan_drive7");
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, replanRoutingResolver(eventStore, enqueuer), undefined, eventStore),
    );

    const result = await hook(CONTEXT);

    expect(result).toMatchObject({
      resolved: false,
      recovery: {
        kind: "owned",
        receipt: { kind: "planner_replan", run: { kind: "enqueued", replanRunId: "run_replan_drive7" } },
      },
    });
    // THE FIX: a fresh re-plan run was ENQUEUED (the never-discard re-author), not relied-upon.
    expect(enqueuer.calls).toBe(1);
    // It is OBSERVABLE: `recovery.replan_queued` carries the replanRunId the walker/worker drives.
    const queued = eventStore.events.find((e) => e.eventType === "recovery.replan_queued");
    if (queued === undefined) throw new Error("expected recovery.replan_queued");
    expect((queued.payload as Record<string, unknown>).replanRunId).toBe("run_replan_drive7");
    // The routing context event is also recorded (the carrier the next planner reads).
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(true);
  });

  it("FIXED POINT: returns an ownerless human decision and provisions no runner", async () => {
    // The spec was re-planned against THIS exact conflict REPEATEDLY (the drive keys the signature
    // off the conflict message) — the identical conflict recurring beyond a single transient repeat
    // is a proven cycle ⇒ re-planning would re-conflict identically (a fixed point).
    const pool = fakePool({
      priorReplanSignatures: [conflictSignatureOf(CONTEXT.message), conflictSignatureOf(CONTEXT.message)],
    });
    const allocator = new SpyAllocator();
    // The resolver should NOT be invoked at the cap — inject one that fails the test if called.
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, () => () => {
        throw new Error("resolver must NOT run once the re-plan cap is exhausted");
      }),
    );

    const result = await hook(CONTEXT);

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved fixed point");
    expect(result.recovery.kind).toBe("parking_required");
    if (result.recovery.kind !== "parking_required") throw new Error("expected parking_required fixed point");
    expect(result.recovery.message).toMatch(/FIXED POINT/u);
    expect(result.recovery.message).toMatch(/product\s+decision is needed/u);
    // NO runner provisioned — escalation short-circuits before allocation.
    expect(allocator.allocateCalls).toBe(0);
  });

  it("YIELD: a live percolation marker throws without provisioning a runner", async () => {
    const pool = fakePool({ percolationPending: { ancestorSpecId: "spec_anc", toSha: "abc" } });
    const allocator = new SpyAllocator();
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, () => () => {
        throw new Error("resolver must NOT run while percolation owns the spec");
      }),
    );

    await expect(hook(CONTEXT)).rejects.toBeInstanceOf(PercolationOwnsSpecError);
    // The drive yields BEFORE provisioning — percolation owns the re-exec + conflict route.
    expect(allocator.allocateCalls).toBe(0);
  });
});

// With NO `buildResolver` seam (the production shape), the drive provisions the live jj
// workspace as the WORKSPACE MECHANISM — asserted by the `jj git clone` it issues over
// the substrate (never a plain `git clone`).
describe("buildDriveConflictResolve — the workspace mechanism is the live jj workspace", () => {
  it("provisions the live jj workspace — the clone is `jj git clone`, never `git clone`", async () => {
    const pool = fakePool({});
    const allocator = new SpyAllocator();
    const ssh = new RecordingSubstrate();
    // No buildResolver seam → the real workspace mechanism runs. The fake substrate
    // returns exit 0 for everything, so the jj rebase probe reads "clean" → an empty
    // conflict → {resolved:false} (a real "nothing to resolve" state, NOT a swallow).
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, undefined, ssh));

    // The downstream resolver reads provenance over the fake pool (unscripted SQL) and
    // may reject AFTER the clone — we assert the clone the workspace mechanism issued,
    // so tolerate a later throw.
    await hook(CONTEXT).catch(() => {});

    expect(allocator.allocateCalls).toBe(1);
    expect(ssh.commands.some((c) => c.includes("jj git clone"))).toBe(true);
    // No PLAIN `git clone` — the jj workspace is the sole mechanism.
    expect(ssh.commands.some((c) => isPlainGitClone(c))).toBe(false);
  });
});

/** True for a PLAIN `git clone` — NOT the jj `jj git clone`. */
function isPlainGitClone(command: string): boolean {
  return /(?<!jj )(?<![A-Za-z])git clone\b/u.test(command);
}

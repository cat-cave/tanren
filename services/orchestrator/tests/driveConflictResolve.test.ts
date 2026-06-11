// Unit tests for the drive-path conflict resolver's CLASSIFY-THEN-ESCALATE +
// percolation/cap guards (engine/merge/driveConflictResolve.ts). The §2b resolver
// CORE is tested in conflictResolver.test.ts; this proves the drive WRAPPER:
//
//   - a conflict the resolver RESOLVES → `{resolved:true}` + verdict `resolved`
//     (the dispatcher retries the merge → it lands; autonomous);
//   - a conflict the resolver could not mechanically reconcile but whose intents
//     are COMPATIBLE → a bounded autonomous RE-PLAN (verdict `replanned`,
//     `{resolved:false}`), NOT an escalation — UNTIL the cap;
//   - once the spec has been re-planned `MAX_CONFLICT_REPLANS` times and STILL
//     conflicts → ESCALATE (verdict `escalate`); the resolver is NOT even invoked
//     again (no runner provisioned) — the two intents are genuinely incompatible;
//   - a live `percolation_pending` marker → the drive YIELDS (throws
//     PercolationOwnsSpecError, verdict `yield`) rather than racing percolation,
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
  type DriveConflictVerdict,
  MAX_CONFLICT_REPLANS,
  PercolationOwnsSpecError,
} from "../src/engine/merge/driveConflictResolve.js";
import type { ConflictContext, ConflictResolverHook } from "../src/engine/workflow/reviewMerge/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";

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
function fakePool(opts: { percolationPending?: unknown; priorReplans: number }): pg.Pool {
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
      return { rows: [{ count: String(opts.priorReplans) }], rowCount: 1 };
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
  verdict: DriveConflictVerdict,
  buildResolver?: DriveConflictResolveDeps["buildResolver"],
  ssh: DriveConflictResolveDeps["ssh"] = new FakeCommandSubstrate(),
): DriveConflictResolveDeps {
  return {
    pool,
    scopedPool: pool,
    facts: FACTS,
    allocator,
    ssh,
    secrets: new FakeSecretStore(),
    vcsProvider: new InMemoryVcsProvider(),
    eventStore: new FakeEventStore(),
    identitySecretRef: "secret/runner/identity",
    timeoutMs: 1000,
    verdict,
    ...(buildResolver !== undefined && { buildResolver }),
  };
}

/** A scripted resolver hook (the injected test seam) returning a fixed outcome. */
function scriptedResolver(resolved: boolean): DriveConflictResolveDeps["buildResolver"] {
  return () => (async () => ({ resolved })) satisfies ConflictResolverHook;
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
  it("RESOLVED: the resolver reconciles → {resolved:true} + verdict 'resolved' (the merge retries + lands)", async () => {
    const pool = fakePool({ priorReplans: 0 });
    const allocator = new SpyAllocator();
    const verdict: DriveConflictVerdict = {};
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, verdict, scriptedResolver(true)));

    const result = await hook(CONTEXT);

    expect(result).toEqual({ resolved: true });
    expect(verdict.disposition).toBe("resolved");
    // A runner WAS provisioned (the real resolution path) and released.
    expect(allocator.allocateCalls).toBe(1);
    expect(allocator.releaseCalls).toBe(1);
  });

  it("allocates the short-lived live-jj resolver with a unique synthetic handle, not the original run id", async () => {
    const pool = fakePool({ priorReplans: 0 });
    const allocator = new SpyAllocator();
    const verdict: DriveConflictVerdict = {};
    let workspacePath = "";
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, verdict, (_target, workspace) => {
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

  it("RE-PLANNED (under the cap): an unresolved-but-compatible conflict → {resolved:false} + verdict 'replanned' (recoverable, NOT escalation)", async () => {
    const pool = fakePool({ priorReplans: MAX_CONFLICT_REPLANS - 1 });
    const allocator = new SpyAllocator();
    const verdict: DriveConflictVerdict = {};
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, verdict, scriptedResolver(false)));

    const result = await hook(CONTEXT);

    expect(result).toEqual({ resolved: false });
    expect(verdict.disposition).toBe("replanned");
    // The resolver ran (the bounded autonomous re-plan): a runner was provisioned.
    expect(allocator.allocateCalls).toBe(1);
    expect(allocator.releaseCalls).toBe(1);
  });

  it("ESCALATE (cap exhausted): once re-planned MAX_CONFLICT_REPLANS times → verdict 'escalate', NO runner provisioned (genuinely incompatible)", async () => {
    const pool = fakePool({ priorReplans: MAX_CONFLICT_REPLANS });
    const allocator = new SpyAllocator();
    const verdict: DriveConflictVerdict = {};
    // The resolver should NOT be invoked at the cap — inject one that fails the test if called.
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, verdict, () => () => {
        throw new Error("resolver must NOT run once the re-plan cap is exhausted");
      }),
    );

    const result = await hook(CONTEXT);

    expect(result).toEqual({ resolved: false });
    expect(verdict.disposition).toBe("escalate");
    // The escalation message reads as a DECISION (a product clash), not "an error occurred".
    expect(verdict.message).toMatch(/genuinely conflict/u);
    expect(verdict.message).toMatch(/product\s+decision is needed/u);
    // NO runner provisioned — escalation short-circuits before allocation.
    expect(allocator.allocateCalls).toBe(0);
  });

  it("YIELD: a live percolation marker → throws PercolationOwnsSpecError + verdict 'yield', NO runner provisioned (mutual exclusion)", async () => {
    const pool = fakePool({ percolationPending: { ancestorSpecId: "spec_anc", toSha: "abc" }, priorReplans: 0 });
    const allocator = new SpyAllocator();
    const verdict: DriveConflictVerdict = {};
    const hook = buildDriveConflictResolve(
      makeDeps(pool, allocator, verdict, () => () => {
        throw new Error("resolver must NOT run while percolation owns the spec");
      }),
    );

    await expect(hook(CONTEXT)).rejects.toBeInstanceOf(PercolationOwnsSpecError);
    expect(verdict.disposition).toBe("yield");
    // The drive yields BEFORE provisioning — percolation owns the re-exec + conflict route.
    expect(allocator.allocateCalls).toBe(0);
  });
});

// With NO `buildResolver` seam (the production shape), the drive provisions the live jj
// workspace as the WORKSPACE MECHANISM — asserted by the `jj git clone` it issues over
// the substrate (never a plain `git clone`).
describe("buildDriveConflictResolve — the workspace mechanism is the live jj workspace", () => {
  it("provisions the live jj workspace — the clone is `jj git clone`, never `git clone`", async () => {
    const pool = fakePool({ priorReplans: 0 });
    const allocator = new SpyAllocator();
    const ssh = new RecordingSubstrate();
    // No buildResolver seam → the real workspace mechanism runs. The fake substrate
    // returns exit 0 for everything, so the jj rebase probe reads "clean" → an empty
    // conflict → {resolved:false} (a real "nothing to resolve" state, NOT a swallow).
    const hook = buildDriveConflictResolve(makeDeps(pool, allocator, {}, undefined, ssh));

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

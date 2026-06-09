// Focused unit test of the PgBatchChecker NATIVE GATE (the no-Actions delivery
// model) over fake pool + fake VcsProvider + fake Allocator + fake SSH (test
// fixtures — they live here, never src/). The batch checker builds the prospective
// merged state on an ephemeral integration ref, then runs Tanren's OWN gate over a
// fresh runner that clones + installs + gates that ref. Because the gate is
// SYNCHRONOUS (a pass/fail verdict on the runner, no async forge CI), there is NO
// "pending" / no-checks settle. It proves:
//   - a passing integration gate → `pass`;
//   - a failing integration gate → `fail` (a bad interaction blocks the batch);
//   - a SPEC-vs-SPEC integration conflict → `conflict` (conflictsWithBase=false);
//   - a base conflict → `conflict` (conflictsWithBase=true, preserved from #322);
//   - a runner/clone/bootstrap fault → `infra-error` (a retriable HOLD, never a bisect).

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgBatchChecker } from "../src/engine/merge/batchChecker.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type {
  Allocator,
  AllocationRequest,
  RunnerAllocation,
  RunnerHandle,
} from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type {
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  PullRequestMergeability,
  PullRequestRef,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";

const ORG = "org_1";
const PROJECT = "project_1";
const INSERT_INTO_PREFIX = "INSERT INTO ";
const EVENT_TABLE_TOKEN = "events";
const TARGET: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "fp",
  identitySecretRef: "id",
};

function isEventTableInsert(text: string): boolean {
  if (!text.startsWith(INSERT_INTO_PREFIX)) return false;
  const tableToken = text.slice(INSERT_INTO_PREFIX.length).trimStart().split(/[\s(]/u)[0]?.replaceAll('"', "");
  return tableToken === EVENT_TABLE_TOKEN;
}

/** A fake pool answering the checker's project/org/entry-branch reads. */
interface FakePoolOptions {
  rejectEventInserts?: boolean;
  requireScopedEventInserts?: boolean;
  queries?: string[];
  branchesByRunId?: Record<string, string>;
}

class FakePool {
  constructor(private readonly options: FakePoolOptions = {}) {}
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient(this.options).query(sql, params);
  }
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.options);
  }
}

class FakeClient {
  private inTransaction = false;
  private hasOrgScope = false;
  constructor(private readonly options: FakePoolOptions = {}) {}
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    this.options.queries?.push(text);
    if (text.startsWith("BEGIN")) {
      this.inTransaction = true;
      this.hasOrgScope = false;
      return { rows: [] };
    }
    if (text.startsWith("SET LOCAL app.current_org_id")) {
      this.hasOrgScope = true;
      return { rows: [] };
    }
    if (text.startsWith("SET LOCAL") || text.startsWith("NOTIFY")) {
      return { rows: [] };
    }
    if (text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
      this.inTransaction = false;
      this.hasOrgScope = false;
      return { rows: [] };
    }
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    if (text.includes("FROM projects p") && text.includes("default_branch")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/cat-cave/apex",
            default_branch: "main",
            runner_image: "ghcr.io/tanren/runner:test",
            project_config: { version: 1, credentials: { githubCredentialRef: "credential/github/project" } },
            org_config: { version: 1 },
          },
        ],
      };
    }
    if (text.includes("FROM runs r") && text.includes("r.run_id = ANY")) {
      const ids = (params?.[0] as string[]) ?? [];
      return {
        rows: ids.map((runId) => ({
          run_id: runId,
          spec_id: runId.replace(/^run_/u, "spec_"),
          branch: this.options.branchesByRunId?.[runId] ?? `tanren/${runId}`,
        })),
      };
    }
    // The native gate emits its gate.* records through PgEventStore; accept that append.
    if (isEventTableInsert(text) && this.options.rejectEventInserts === true) {
      throw Object.assign(new Error("permission denied for table events"), { code: "42501" });
    }
    if (
      isEventTableInsert(text) &&
      this.options.requireScopedEventInserts === true &&
      (!this.inTransaction || !this.hasOrgScope)
    ) {
      throw Object.assign(new Error("unscoped event insert"), { code: "42501" });
    }
    if (text.startsWith("INSERT INTO")) {
      return { rows: [{ id: "event_1" }] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release(): void {}
}

/** A fake VcsProvider: integration is configurable; token/repo resolution is canned. */
class FakeVcsProvider implements Partial<VcsProvider> {
  /** The ephemeral batch refs `deleteBranch` was asked to tear down. */
  readonly deletedBranches: string[] = [];
  readonly integrationInputs: BuildIntegrationBranchInput[] = [];
  readonly mergeabilityReads: number[] = [];
  constructor(
    private readonly integration: BuildIntegrationBranchResult,
    private readonly mergeabilityByPrNumber: Record<number, PullRequestMergeability["state"]> = {},
  ) {}
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "t", source: "static", refresh: async () => "t2" };
  }
  parseRepository(repoUrl: string): RepoRef {
    const m = /github\.com\/([^/]+)\/([^/]+)/u.exec(repoUrl)!;
    return { owner: m[1]!, name: m[2]! };
  }
  async buildIntegrationBranch(_input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    this.integrationInputs.push(_input);
    return this.integration;
  }
  async deleteBranch(_repo: RepoRef, branch: string, _token: ResolvedVcsToken): Promise<void> {
    this.deletedBranches.push(branch);
  }
  async readMergeability(pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestMergeability> {
    this.mergeabilityReads.push(pr.number);
    return {
      state: this.mergeabilityByPrNumber[pr.number] ?? "clean",
      behind: false,
      baseBranch: "main",
      headBranch: `tanren/pr-${pr.number}`,
    };
  }
}

/** A fake allocator that hands out a fixed target and records releases. */
class FakeAllocator implements Allocator {
  readonly allocations: AllocationRequest[] = [];
  readonly releases: string[] = [];
  constructor(private readonly fail = false) {}
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    this.allocations.push(_request);
    if (this.fail) throw new Error("allocator unavailable");
    return { runnerId: "runner_batch", imageSha: "sha256:batch", target: TARGET };
  }
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

/**
 * A fake SSH that drives the native gate. Every INFRA step (clone, the local-ignore
 * seed, the deps-ensure guard, the config `cat`) succeeds; the clone's `git rev-parse
 * HEAD` returns a 40-hex sha; the config `cat` returns no `.tanren/ci.yml` so the
 * stack-agnostic DEFAULT tiers run (the `pre_merge` tier is the single step `just
 * tier-3`). Only the actual GATE STEP command carries `gateExit` (0 ⇒ pass, nonzero
 * ⇒ fail at the step).
 */
class GateDrivingSsh implements CommandSubstrate {
  constructor(private readonly gateExit: number) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const cmd = command.command;
    if (cmd.includes("git rev-parse HEAD") || cmd.includes("git clone")) {
      return { exitCode: 0, stdout: "a".repeat(40), stderr: "", timedOut: false };
    }
    // The gate STEP command (stack-agnostic default pre_merge tier: `just tier-3`).
    if (cmd === "just tier-3") {
      return { exitCode: this.gateExit, stdout: "", stderr: "", timedOut: false };
    }
    // Every infra step (config cat, local-ignore seed, deps-ensure guard) succeeds.
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

const INTEGRATED: BuildIntegrationBranchResult = {
  outcome: "integrated",
  integrationBranch: "tanren/batch/spec_a",
  mergedAncestors: ["spec_a"],
  message: "ok",
};

function entry(specId: string): MergeQueueEntry {
  return {
    queueId: `q_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://github.com/cat-cave/apex/pull/1`,
    prNumber: 1,
    dependsOn: [],
    priority: "tbd",
    orderKey: 0,
  };
}

function entryForRun(specId: string, runId: string, prNumber = 1): MergeQueueEntry {
  return {
    queueId: `q_${runId}`,
    runId,
    specId,
    prUrl: `https://github.com/cat-cave/apex/pull/${prNumber}`,
    prNumber,
    dependsOn: [],
    priority: "tbd",
    orderKey: 0,
  };
}

function makeChecker(
  integration: BuildIntegrationBranchResult,
  ssh: CommandSubstrate,
  allocator: Allocator = new FakeAllocator(),
  options: {
    pool?: pg.Pool;
    runStateWriter?: RunStateWriter;
    mergeabilityByPrNumber?: Record<number, PullRequestMergeability["state"]>;
  } = {},
): { checker: PgBatchChecker; vcs: FakeVcsProvider } {
  const vcs = new FakeVcsProvider(integration, options.mergeabilityByPrNumber);
  const checker = new PgBatchChecker({
    pool: options.pool ?? (new FakePool() as unknown as pg.Pool),
    vcsProvider: vcs as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
    allocator,
    ssh,
    identitySecretRef: "id",
    ...(options.runStateWriter !== undefined && { runStateWriter: options.runStateWriter }),
    timeoutMs: 1000,
  });
  return { checker, vcs };
}

function unexpectedWriterMethod(method: string): Promise<never> {
  return Promise.reject(new Error(`unexpected writer method: ${method}`));
}

function recordingRunStateWriter(): { writer: RunStateWriter; events: AppendEventInput[] } {
  const events: AppendEventInput[] = [];
  const writer = {
    append(input: AppendEventInput) {
      events.push(input);
      return Promise.resolve();
    },
    recordCost: () => unexpectedWriterMethod("recordCost"),
    reconcileCost: () => unexpectedWriterMethod("reconcileCost"),
    finalizeRun: () => unexpectedWriterMethod("finalizeRun"),
    setRunStatus: () => unexpectedWriterMethod("setRunStatus"),
    setRunPrUrl: () => unexpectedWriterMethod("setRunPrUrl"),
    setSpecStatus: () => unexpectedWriterMethod("setSpecStatus"),
    setSpecMetadata: () => unexpectedWriterMethod("setSpecMetadata"),
    setRunSpeculativeBase: () => unexpectedWriterMethod("setRunSpeculativeBase"),
    setRunPercolationReexecId: () => unexpectedWriterMethod("setRunPercolationReexecId"),
    clearRunPercolationPending: () => unexpectedWriterMethod("clearRunPercolationPending"),
    mergeRunVerifiedAncestorSha: () => unexpectedWriterMethod("mergeRunVerifiedAncestorSha"),
    supersedeQueuedPlannerTask: () => unexpectedWriterMethod("supersedeQueuedPlannerTask"),
    insertTask: () => unexpectedWriterMethod("insertTask"),
    updateTask: () => unexpectedWriterMethod("updateTask"),
  } as unknown as RunStateWriter;
  return { writer, events };
}

describe("PgBatchChecker — native gate on the integration ref (no-Actions delivery)", () => {
  // These tests pin the FLAG-OFF (server-side `buildIntegrationBranch`) path — the
  // kill-switch behavior. The flag-ON (default) §3 integration-node drive (jj-local
  // integration + proof reuse) is asserted in batchIntegrationNodeDrive.test.ts and
  // exercised live by apex. Set the kill-switch so this suite drives the server build.
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env["INTEGRATION_NODES_DRIVE"];
    process.env["INTEGRATION_NODES_DRIVE"] = "0";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env["INTEGRATION_NODES_DRIVE"];
    else process.env["INTEGRATION_NODES_DRIVE"] = prev;
  });

  it("an empty batch passes (the bisect lower-bound — the base is green)", async () => {
    const { checker } = makeChecker(INTEGRATED, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [] });
    expect(verdict.result).toBe("pass");
  });

  it("a passing integration gate → pass + releases the runner + tears down the batch ref", async () => {
    const allocator = new FakeAllocator();
    const { checker, vcs } = makeChecker(INTEGRATED, new GateDrivingSsh(0), allocator);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pass");
    expect(allocator.releases).toEqual(["runner_batch"]);
    // The ephemeral batch ref is ALWAYS torn down (next batch/retry starts clean).
    expect(vcs.deletedBranches).toEqual(["tanren/batch/spec_a"]);
  });

  it("a dirty queued PR returns a base conflict before integration or runner allocation", async () => {
    const allocator = new FakeAllocator();
    const { checker, vcs } = makeChecker(INTEGRATED, new GateDrivingSsh(0), allocator, {
      mergeabilityByPrNumber: { 7: "dirty" },
    });

    const verdict = await checker.checkBatch({
      projectId: PROJECT,
      entries: [entryForRun("spec_a", "run_a", 7)],
    });

    expect(verdict).toEqual({
      result: "conflict",
      message: "batch entry spec_a conflicts with main",
      conflictsWithBase: true,
      conflictBetween: { specId: "spec_a", otherSpecId: "main" },
    });
    expect(vcs.mergeabilityReads).toEqual([7]);
    expect(vcs.integrationInputs).toEqual([]);
    expect(vcs.deletedBranches).toEqual([]);
    expect(allocator.allocations).toEqual([]);
  });

  it("integrates the queued run's branch, not the latest branch for the same spec", async () => {
    const pool = new FakePool({
      branchesByRunId: {
        run_queued: "tanren/spec_a-queued",
      },
    }) as unknown as pg.Pool;
    const { checker, vcs } = makeChecker(INTEGRATED, new GateDrivingSsh(0), new FakeAllocator(), { pool });

    const verdict = await checker.checkBatch({
      projectId: PROJECT,
      entries: [entryForRun("spec_a", "run_queued")],
    });

    expect(verdict.result).toBe("pass");
    expect(vcs.integrationInputs[0]?.ancestors).toEqual([{ specId: "spec_a", branch: "tanren/spec_a-queued" }]);
  });

  it("a failing integration gate → fail + tears down the batch ref", async () => {
    const { checker, vcs } = makeChecker(INTEGRATED, new GateDrivingSsh(1));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("fail");
    expect(vcs.deletedBranches).toEqual(["tanren/batch/spec_a"]);
  });

  it("routes fresh-runner gate events through the run-state writer, never the raw worker pool", async () => {
    const pool = new FakePool({ rejectEventInserts: true }) as unknown as pg.Pool;
    const { writer, events } = recordingRunStateWriter();
    const { checker } = makeChecker(INTEGRATED, new GateDrivingSsh(0), new FakeAllocator(), {
      pool,
      runStateWriter: writer,
    });

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });

    expect(verdict.result).toBe("pass");
    expect(events.map((event) => event.eventType)).toContain("gate.started");
    expect(events.map((event) => event.eventType)).toContain("gate.verdict");
    expect(events.every((event) => event.projectId === PROJECT && event.runId === "run_batch_spec_a")).toBe(true);
  });

  it("scopes direct fresh-runner gate event writes when no run-state writer is configured", async () => {
    const queries: string[] = [];
    const pool = new FakePool({ queries, requireScopedEventInserts: true }) as unknown as pg.Pool;
    const { checker } = makeChecker(INTEGRATED, new GateDrivingSsh(0), new FakeAllocator(), { pool });

    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });

    expect(verdict.result).toBe("pass");
    expect(queries).toContain("SET LOCAL app.current_org_id = 'org_1'");
    expect(queries.some((query) => isEventTableInsert(query))).toBe(true);
  });

  it("a SPEC-vs-SPEC integration conflict → conflict (conflictsWithBase=false)", async () => {
    const conflict: BuildIntegrationBranchResult = {
      outcome: "conflict",
      integrationBranch: "tanren/batch/spec_b",
      message: "spec_a vs spec_b clash",
      conflictBetween: { specId: "spec_b", otherSpecId: "spec_a" },
    };
    const { checker, vcs } = makeChecker(conflict, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a"), entry("spec_b")] });
    if (verdict.result !== "conflict") throw new Error("unreachable");
    expect(verdict.conflictsWithBase).toBe(false);
    // Even a conflict tears down the (already-reset-to-base) ref so it never lingers.
    expect(vcs.deletedBranches).toEqual(["tanren/batch/spec_b"]);
  });

  it("a base conflict → conflict (conflictsWithBase=true, preserved from #322)", async () => {
    const baseConflict: BuildIntegrationBranchResult = {
      outcome: "conflict",
      integrationBranch: "tanren/batch/spec_a",
      message: "spec_a dirty against main",
      // buildIntegrationBranch sets otherSpecId = default_branch for a first-merge-onto-base clash.
      conflictBetween: { specId: "spec_a", otherSpecId: "main" },
    };
    const { checker } = makeChecker(baseConflict, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    if (verdict.result !== "conflict") throw new Error("unreachable");
    expect(verdict.conflictsWithBase).toBe(true);
  });

  it("a runner-allocation fault → infra-error (a retriable hold) + still tears down the batch ref", async () => {
    const { checker, vcs } = makeChecker(INTEGRATED, new GateDrivingSsh(0), new FakeAllocator(true));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    if (verdict.result !== "infra-error") throw new Error("unreachable");
    expect(verdict.retriable).toBe(true);
    // Even on an infra-error the ephemeral ref is torn down (the finally always runs).
    expect(vcs.deletedBranches).toEqual(["tanren/batch/spec_a"]);
  });
});

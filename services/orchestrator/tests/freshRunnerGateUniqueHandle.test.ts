// Regression test for the v21 native-merge-queue keystone bug (the live apex
// blocker): the fresh-runner re-gate (`runFreshRunnerMergeGate`) must allocate its
// short-lived runner under a UNIQUE handle so it NEVER collides with the original
// run's RETAINED `runner_${runId}` row (release only flips status='released', it
// does NOT delete the row) — nor with a prior re-gate attempt. The live symptom was
// `merge.batch.infra_blocked: ... duplicate key value violates unique constraint
// "runners_pkey"`, which bricked the batch gate (3 attempts → blocked, never merged).
//
// These are TEST FIXTURES (fake allocator / ssh / vcs / secrets) — they live here,
// never src/. The fake allocator mirrors the real allocators' `runner_${runId}` pkey
// derivation AND a pre-seeded RELEASED row for the original run, so a re-gate that
// reused `ctx.runId` would throw the SAME pkey violation.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { runFreshRunnerMergeGate } from "../src/engine/merge/freshRunnerGate.js";
import type {
  Allocator,
  AllocationRequest,
  RunnerAllocation,
  RunnerHandle,
} from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import type { SecretValue } from "../src/engine/contracts/secretStore.js";
import type { EventStore } from "../src/engine/eventStore.js";

const RUN_ID = "run_apex_0001";

const TARGET: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "fp",
  identitySecretRef: "id",
};

/**
 * A fake allocator that mirrors the REAL allocators' `runner_${request.runId}` pkey
 * derivation and a persisted `runners` set that NEVER deletes on release (release
 * only marks released) — so re-allocating an existing id throws a pkey violation,
 * exactly like the live `runners_pkey` constraint.
 */
class PkeyEnforcingAllocator implements Allocator {
  readonly taxonomy = "fixed_pool" as const;
  readonly allocatedIds: string[] = [];
  readonly releases: string[] = [];
  /** The persisted runner rows (pre-seeded with the ORIGINAL run's retained row). */
  private readonly rows = new Set<string>([`runner_${RUN_ID}`]);

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const runnerId = `runner_${request.runId}`;
    if (this.rows.has(runnerId)) {
      throw new Error(`duplicate key value violates unique constraint "runners_pkey": ${runnerId}`);
    }
    this.rows.add(runnerId);
    this.allocatedIds.push(runnerId);
    return { runnerId, imageSha: "sha256:regate", target: TARGET };
  }
  async release(runnerId: string): Promise<void> {
    // Mirrors the real release: status flip, NOT a row delete (the row is retained).
    this.releases.push(runnerId);
  }
}

/** A fake SSH that drives the gate to a clean pass (clone sha + default tiers green). */
class GatePassingSsh implements CommandSubstrate {
  readonly workspacePaths: string[] = [];
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const cmd = command.command;
    // Capture the workspace dir the re-gate clones into (proves it is keyed on the
    // unique handle, not the original run id).
    const match = /\/workspace\/runs\/([^/]+)\/repo/u.exec(cmd);
    if (match?.[1] !== undefined) this.workspacePaths.push(match[1]);
    if (cmd.includes("git rev-parse HEAD") || cmd.includes("git clone")) {
      return { exitCode: 0, stdout: "a".repeat(40), stderr: "", timedOut: false };
    }
    // Task #64: the default merge tier declares junit evidence (minTests: 1) — the
    // harvester reads back the report via the shared `__TANREN_FILE_ABSENT__`-marked
    // `cat` script. Return a minimal valid JUnit document so the gate passes evidence.
    if (cmd.includes("__TANREN_FILE_ABSENT__") || cmd.includes("reports/junit.xml")) {
      return {
        exitCode: 0,
        stdout: '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>',
        stderr: "",
        timedOut: false,
      };
    }
    // Every infra + gate step succeeds (default pre_merge tiers pass).
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

/** The gate resolves a static push token via the standalone resolver — it never hits the
 * GitHub transport on this path (the push goes over SSH), so an inert client is fine. */
const inertGitHubHttp: GitHubHttpClient = {
  async request() {
    throw new Error("the fresh-runner gate must not reach the GitHub transport");
  },
};

/** Returns a stub `github_token` for the configured ref so static-credential resolution succeeds. */
class TokenSecretStore extends InMemorySecretStore {
  override async get(ref: string): Promise<SecretValue | undefined> {
    return { ref, value: "t" };
  }
}

/** A no-op event store (the gate's `gate.*` events are not under test here). */
const NOOP_EVENT_STORE: EventStore = {
  append: async () => {},
} as unknown as EventStore;

function makeDeps(allocator: Allocator, ssh: CommandSubstrate) {
  return {
    allocator,
    ssh,
    secrets: new TokenSecretStore(),
    githubHttp: inertGitHubHttp,
    eventStore: NOOP_EVENT_STORE,
    identitySecretRef: "id",
    timeoutMs: 1000,
  };
}

const CTX = {
  repoUrl: "https://github.com/cat-cave/apex",
  ref: "tanren/batch/spec_a",
  runnerImage: "ghcr.io/tanren/runner:test",
  governancePosture: "strict" as const,
  githubCredentialRef: "credential/github/project",
  orgId: "org_1",
  projectId: "project_1",
  runId: RUN_ID,
  specId: "spec_a",
};

describe("runFreshRunnerMergeGate — unique re-gate runner handle (v21 pkey-collision fix)", () => {
  it("re-gates without a runners_pkey violation when the original run's row already exists", async () => {
    const allocator = new PkeyEnforcingAllocator();
    const result = await runFreshRunnerMergeGate(makeDeps(allocator, new GatePassingSsh()), CTX);

    expect(result.outcome.passed).toBe(true);
    // The re-gate allocated exactly one runner under a DISTINCT id (never the
    // original `runner_${RUN_ID}` that the pre-seeded retained row holds).
    expect(allocator.allocatedIds).toHaveLength(1);
    expect(allocator.allocatedIds[0]).not.toBe(`runner_${RUN_ID}`);
    expect(allocator.allocatedIds[0]).toMatch(new RegExp(`^runner_${RUN_ID}-regate-`, "u"));
    // Release targets the allocation's ACTUAL (synthetic) runner id, not the original.
    expect(allocator.releases).toEqual(allocator.allocatedIds);
  });

  it("two back-to-back re-gates of the SAME run never collide (each gets a fresh id)", async () => {
    const allocator = new PkeyEnforcingAllocator();
    const ssh = new GatePassingSsh();
    await runFreshRunnerMergeGate(makeDeps(allocator, ssh), CTX);
    await runFreshRunnerMergeGate(makeDeps(allocator, ssh), CTX);

    expect(allocator.allocatedIds).toHaveLength(2);
    expect(new Set(allocator.allocatedIds).size).toBe(2);
    // Each clone landed in its OWN workspace dir, keyed on the unique handle.
    const cloneDirs = new Set(ssh.workspacePaths);
    expect(cloneDirs.size).toBe(2);
    for (const dir of cloneDirs) expect(dir).toMatch(new RegExp(`^${RUN_ID}-regate-`, "u"));
  });
});

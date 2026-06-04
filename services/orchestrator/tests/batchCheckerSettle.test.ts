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
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgBatchChecker } from "../src/engine/merge/batchChecker.js";
import type { Allocator, AllocationRequest, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type {
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";

const ORG = "org_1";
const PROJECT = "project_1";
const TARGET: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "fp",
  identitySecretRef: "id",
};

/** A fake pool answering the checker's project/org/entry-branch reads. */
class FakePool {
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient().query(sql, params);
  }
  async connect(): Promise<FakeClient> {
    return new FakeClient();
  }
}

class FakeClient {
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK") ||
      text.startsWith("NOTIFY")
    ) {
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
    if (text.includes("FROM runs r") && text.includes("DISTINCT ON")) {
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: ids.map((specId) => ({ spec_id: specId, branch: `tanren/${specId}` })) };
    }
    // The native gate emits its gate.* events through PgEventStore — accept the write.
    if (text.startsWith("INSERT INTO")) {
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release(): void {}
}

/** A fake VcsProvider: integration is configurable; token/repo resolution is canned. */
class FakeVcsProvider implements Partial<VcsProvider> {
  constructor(private readonly integration: BuildIntegrationBranchResult) {}
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "t", source: "static", refresh: async () => "t2" };
  }
  parseRepository(repoUrl: string): RepoRef {
    const m = /github\.com\/([^/]+)\/([^/]+)/u.exec(repoUrl)!;
    return { owner: m[1]!, name: m[2]! };
  }
  async buildIntegrationBranch(_input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    return this.integration;
  }
}

/** A fake allocator that hands out a fixed target and records releases. */
class FakeAllocator implements Allocator {
  readonly releases: string[] = [];
  constructor(private readonly fail = false) {}
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
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
 * DEFAULT tiers run (the `pre_merge` tier is `pnpm build` then `pnpm test`). Only the
 * actual GATE STEP commands carry `gateExit` (0 ⇒ pass, nonzero ⇒ fail at the step).
 */
class GateDrivingSsh implements SshSubstrate {
  constructor(private readonly gateExit: number) {}
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    const cmd = command.command;
    if (cmd.includes("git rev-parse HEAD") || cmd.includes("git clone")) {
      return { exitCode: 0, stdout: "a".repeat(40), stderr: "", timedOut: false };
    }
    // The gate STEP commands (default pre_merge tier: `pnpm build` / `pnpm test`).
    if (cmd === "pnpm build" || cmd === "pnpm test") {
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

function makeChecker(
  integration: BuildIntegrationBranchResult,
  ssh: SshSubstrate,
  allocator: Allocator = new FakeAllocator(),
): PgBatchChecker {
  return new PgBatchChecker({
    pool: new FakePool() as unknown as pg.Pool,
    vcsProvider: new FakeVcsProvider(integration) as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
    allocator,
    ssh,
    identitySecretRef: "id",
    timeoutMs: 1000,
  });
}

describe("PgBatchChecker — native gate on the integration ref (no-Actions delivery)", () => {
  it("an empty batch passes (the bisect lower-bound — the base is green)", async () => {
    const checker = makeChecker(INTEGRATED, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [] });
    expect(verdict.result).toBe("pass");
  });

  it("a passing integration gate → pass + releases the runner", async () => {
    const allocator = new FakeAllocator();
    const checker = makeChecker(INTEGRATED, new GateDrivingSsh(0), allocator);
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("pass");
    expect(allocator.releases).toEqual(["runner_batch"]);
  });

  it("a failing integration gate → fail (a bad interaction blocks the batch)", async () => {
    const checker = makeChecker(INTEGRATED, new GateDrivingSsh(1));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    expect(verdict.result).toBe("fail");
  });

  it("a SPEC-vs-SPEC integration conflict → conflict (conflictsWithBase=false)", async () => {
    const conflict: BuildIntegrationBranchResult = {
      outcome: "conflict",
      integrationBranch: "tanren/batch/spec_b",
      message: "spec_a vs spec_b clash",
      conflictBetween: { specId: "spec_b", otherSpecId: "spec_a" },
    };
    const checker = makeChecker(conflict, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a"), entry("spec_b")] });
    if (verdict.result !== "conflict") throw new Error("unreachable");
    expect(verdict.conflictsWithBase).toBe(false);
  });

  it("a base conflict → conflict (conflictsWithBase=true, preserved from #322)", async () => {
    const baseConflict: BuildIntegrationBranchResult = {
      outcome: "conflict",
      integrationBranch: "tanren/batch/spec_a",
      message: "spec_a dirty against main",
      // buildIntegrationBranch sets otherSpecId = default_branch for a first-merge-onto-base clash.
      conflictBetween: { specId: "spec_a", otherSpecId: "main" },
    };
    const checker = makeChecker(baseConflict, new GateDrivingSsh(0));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    if (verdict.result !== "conflict") throw new Error("unreachable");
    expect(verdict.conflictsWithBase).toBe(true);
  });

  it("a runner-allocation fault → infra-error (a retriable hold, never a bisect)", async () => {
    const checker = makeChecker(INTEGRATED, new GateDrivingSsh(0), new FakeAllocator(true));
    const verdict = await checker.checkBatch({ projectId: PROJECT, entries: [entry("spec_a")] });
    if (verdict.result !== "infra-error") throw new Error("unreachable");
    expect(verdict.retriable).toBe(true);
  });
});

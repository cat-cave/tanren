// Unit tests for the LIVE post-merge accept seam
// (docs/roadmap/tanren-method-benchmark.md §2.1). They prove the production
// `runAccept` injection runs the full allocate → clone@mergedSHA → bootstrap →
// accept-tier → release pipeline over a SCRIPTED SSH substrate (no live runner),
// resolves the merged sha from the run's merge events, emits the verdict event
// through the org-scoped store, and returns the AcceptResult.
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator, RunnerAllocation } from "../src/engine/contracts/allocator.js";
import type {
  RunnerCommand,
  CommandResult,
  CommandSubstrate,
  RunnerHandle,
} from "../src/engine/contracts/commandSubstrate.js";
import { buildLiveRunAccept } from "../src/engine/benchmark/liveAccept.js";
import type { CellWithExperiment } from "../src/engine/benchmark/index.js";
import { FrozenConfig } from "../src/engine/benchmark/entities.js";

const ORG = "org_bench";
const RUN = "run_trial1";
const MERGED_SHA = "0123456789abcdef0123456789abcdef01234567";

function frozenWithAccept(acceptSteps: { name: string; run: string }[] | undefined): FrozenConfig {
  return FrozenConfig.parse({
    routing: { write: { chain: [{ cli: "codex", model: "m", authRef: "credential/codex/org/x" }] } },
    ciTiers: {
      tiers: {
        fast: [{ name: "lint", run: "pnpm lint" }],
        slow: [{ name: "test", run: "pnpm test" }],
        ...(acceptSteps === undefined ? {} : { accept: acceptSteps }),
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit", "pre_merge"] },
    },
    governance: "strict",
    mergeIntegration: "direct_merge",
  });
}

function cell(acceptSteps?: { name: string; run: string }[]): CellWithExperiment {
  const fc = frozenWithAccept(acceptSteps);
  const seed = { repo: "cat-cave/fixture", sha: "seed0000", acceptTierHash: "sha256:oracle", corpusTier: 1 } as const;
  return {
    cell: { cellId: "cell_1", experimentId: "exp_1", label: "control", frozenConfig: fc, trialsTarget: 1 },
    experiment: {
      experimentId: "exp_1",
      orgId: ORG,
      title: "t",
      knob: "gate",
      hypothesis: "h",
      seedTaskRef: seed,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    },
    frozenConfig: fc,
    seedTaskRef: seed,
  };
}

// A scripted SSH substrate: records every command and returns 0 unless a matcher
// scripts a failure (e.g. a nonzero accept step). The clone/bootstrap/tanren-ci
// reads return empty/zero so the pipeline proceeds.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: string[] = [];
  constructor(private readonly script: (command: string) => Partial<CommandResult> = () => ({})) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...this.script(command.command) };
  }
}

class RecordingAllocator implements Allocator {
  allocated: AllocationRequest[] = [];
  released: { runnerId: string; reason?: string }[] = [];
  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.allocated.push(request);
    return {
      runnerId: `runner_${request.runId}`,
      imageSha: `${request.runnerImage}@sha256:fake`,
      target: {
        backend: "ssh",
        host: "runner",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "fp",
        identitySecretRef: "ref",
      },
    };
  }
  async release(runnerId: string, reason?: string): Promise<void> {
    this.released.push({ runnerId, ...(reason === undefined ? {} : { reason }) });
  }
}

// A fake pool that scripts the three org-scoped reads the seam runs (run facts,
// merge events, the event INSERT) without a real Postgres. Returns the captured
// event INSERTs so a test can assert the verdict was written.
function fakePool(opts: { mergeSha?: string; runVisible?: boolean }): {
  pool: pg.Pool;
  eventInserts: { eventType: string; payload: unknown }[];
} {
  const eventInserts: { eventType: string; payload: unknown }[] = [];
  const runVisible = opts.runVisible ?? true;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM runs r\s+JOIN projects p/u.test(sql)) {
        return runVisible
          ? {
              rows: [
                {
                  spec_id: "spec_1",
                  project_id: "project_1",
                  repo_url: "https://github.com/cat-cave/fixture",
                  runner_image: "img",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM events\s+WHERE run_id = \$1\s+AND event_type IN/u.test(sql)) {
        return opts.mergeSha === undefined
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{ payload: { mergeSha: opts.mergeSha, prUrl: "u", prNumber: 1, integration: "direct_merge" } }],
              rowCount: 1,
            };
      }
      // Match the event-store write by its column-list signature rather than the
      // raw INSERT phrase, which the single-event-writer architecture check
      // (correctly) forbids outside the event store itself.
      if (/events \(run_id/u.test(sql)) {
        // v68: [runId, taskId, specId, projectId, orgId, eventType, payloadJson]
        const eventType = String(params?.[5]);
        const payload = JSON.parse(String(params?.[6]));
        eventInserts.push({ eventType, payload });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("NOTIFY")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    query: client.query,
    connect: async () => client,
  };
  return { pool: pool as unknown as pg.Pool, eventInserts };
}

describe("buildLiveRunAccept", () => {
  it("allocates → clones@mergedSHA → bootstraps → runs the accept tier → releases, returns passed", async () => {
    const ssh = new ScriptedSsh();
    const allocator = new RecordingAllocator();
    const { pool, eventInserts } = fakePool({ mergeSha: MERGED_SHA });
    const runAccept = buildLiveRunAccept({ pool, allocator, ssh, identitySecretRef: "runner/identity" });

    const result = await runAccept({
      orgId: ORG,
      cell: cell([{ name: "oracle", run: "make accept" }]),
      runId: RUN,
      trialIndex: 0,
      taskId: "task_plan",
    });

    expect(result).toBe("passed");
    // Allocated exactly one runner for this trial's run, then released it.
    expect(allocator.allocated.map((a) => a.runId)).toEqual([RUN]);
    expect(allocator.released).toEqual([{ runnerId: `runner_${RUN}`, reason: "completed" }]);
    // The clone fetched the EXACT merged sha (detached), and the accept step ran.
    const joined = ssh.commands.join("\n");
    expect(joined).toContain(`git fetch --depth 1 -q origin '${MERGED_SHA}'`);
    expect(joined).toContain("git checkout -q FETCH_HEAD");
    expect(ssh.commands).toContain("make accept");
    // The verdict event was written through the org-scoped store.
    expect(eventInserts.map((e) => e.eventType)).toEqual(["benchmark.accept.passed"]);
  });

  it("runs steps in order and short-circuits on a nonzero accept step → failed", async () => {
    const ssh = new ScriptedSsh((c) => (c === "make accept" ? { exitCode: 1, stderr: "mismatch" } : {}));
    const allocator = new RecordingAllocator();
    const { pool, eventInserts } = fakePool({ mergeSha: MERGED_SHA });
    const runAccept = buildLiveRunAccept({ pool, allocator, ssh, identitySecretRef: "ref" });

    const result = await runAccept({
      orgId: ORG,
      cell: cell([
        { name: "oracle", run: "make accept" },
        { name: "never", run: "echo unreached" },
      ]),
      runId: RUN,
      trialIndex: 0,
    });

    expect(result).toBe("failed");
    expect(ssh.commands).toContain("make accept");
    expect(ssh.commands).not.toContain("echo unreached");
    // The runner is STILL released on a failed accept (the finally path).
    expect(allocator.released).toHaveLength(1);
    expect(eventInserts.map((e) => e.eventType)).toEqual(["benchmark.accept.failed"]);
  });

  it("a merged run with no resolvable merge sha is a FAILED accept — never allocates a runner", async () => {
    const ssh = new ScriptedSsh();
    const allocator = new RecordingAllocator();
    const { pool, eventInserts } = fakePool({ mergeSha: undefined });
    const runAccept = buildLiveRunAccept({ pool, allocator, ssh, identitySecretRef: "ref" });

    const result = await runAccept({
      orgId: ORG,
      cell: cell([{ name: "oracle", run: "make accept" }]),
      runId: RUN,
      trialIndex: 0,
    });

    expect(result).toBe("failed");
    expect(allocator.allocated).toHaveLength(0);
    expect(ssh.commands).toHaveLength(0);
    const failed = eventInserts[0];
    expect(failed).toBeDefined();
    expect(failed!.eventType).toBe("benchmark.accept.failed");
    expect((failed!.payload as { reason: string }).reason).toMatch(/no merge sha/u);
  });

  it("an empty (undefined) accept tier is a FAILED accept (no silent green), still releases", async () => {
    const ssh = new ScriptedSsh();
    const allocator = new RecordingAllocator();
    const { pool, eventInserts } = fakePool({ mergeSha: MERGED_SHA });
    const runAccept = buildLiveRunAccept({ pool, allocator, ssh, identitySecretRef: "ref" });

    const result = await runAccept({ orgId: ORG, cell: cell(), runId: RUN, trialIndex: 0 });

    expect(result).toBe("failed");
    // It DID allocate (a merge sha exists) but the empty tier short-circuits to a
    // failed verdict, and the runner is released.
    expect(allocator.allocated).toHaveLength(1);
    expect(allocator.released).toHaveLength(1);
    expect(eventInserts.map((e) => e.eventType)).toEqual(["benchmark.accept.failed"]);
  });

  it("throws loudly when the run is not visible under the org (mis-scoped accept)", async () => {
    const ssh = new ScriptedSsh();
    const allocator = new RecordingAllocator();
    const { pool } = fakePool({ mergeSha: MERGED_SHA, runVisible: false });
    const runAccept = buildLiveRunAccept({ pool, allocator, ssh, identitySecretRef: "ref" });

    await expect(
      runAccept({ orgId: ORG, cell: cell([{ name: "o", run: "make accept" }]), runId: RUN, trialIndex: 0 }),
    ).rejects.toThrow(/not visible under org/u);
    expect(allocator.allocated).toHaveLength(0);
  });
});

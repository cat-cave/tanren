import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import {
  RunnerLifecycle,
  type RunnerRecord,
  type RunnerStore,
  type StuckRunner,
  type StuckThresholds,
  type SweptAudit,
} from "../src/runnerLifecycle.js";
import { RunnerSweeper } from "../src/sweeper.js";

// allocate() fail-closes on a blank TANREN_RUNNER_AUTHORIZED_KEY; provide one.
const ORIGINAL_AUTHORIZED_KEY = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
beforeAll(() => {
  process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrchestratorPub orchestrator";
});
afterAll(() => {
  if (ORIGINAL_AUTHORIZED_KEY === undefined) {
    delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
  } else {
    process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = ORIGINAL_AUTHORIZED_KEY;
  }
});

class NoopDocker implements DockerEngineClient {
  readonly removed: string[] = [];
  async createVolume(): Promise<void> {}
  async removeVolume(name: string): Promise<void> {
    this.removed.push(name);
  }
  async createContainer(_spec: CreateContainerSpec): Promise<string> {
    return "container";
  }
  async startContainer(): Promise<void> {}
  async inspectContainer(): Promise<ContainerInspectResult> {
    return { id: "container", imageSha: "sha256:noop", running: true };
  }
  async readContainerFile(): Promise<Buffer> {
    return Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRunnerHostKey runner\n");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
}

const TERMINAL = new Set(["completed", "failed", "halted", "cancelled"]);

/**
 * In-memory store mirroring the PgRunnerStore stuck-state classification: a runner
 * is stuck iff (a) its owning run is terminal, (b) it is past the TTL threshold, or
 * (c) it is run-less AND past the grace threshold. A healthy in-flight runner (run
 * non-terminal, within TTL, claimed) matches none and is never returned.
 */
class MemoryStore implements RunnerStore {
  readonly records: RunnerRecord[] = [];
  /** runId → run status, for the terminal-run classification. */
  readonly runStatus = new Map<string, string>();
  readonly swept: SweptAudit[] = [];

  async insert(record: RunnerRecord): Promise<void> {
    this.records.push({ ...record });
  }
  async recordAllocated(): Promise<void> {}
  async recordSwept(audit: SweptAudit): Promise<void> {
    this.swept.push(audit);
  }
  async markReleased(runnerId: string): Promise<RunnerRecord | undefined> {
    const record = this.records.find((r) => r.runnerId === runnerId && !r.released);
    if (record === undefined) return undefined;
    record.released = true;
    return record;
  }
  async findActive(runnerId: string): Promise<RunnerRecord | undefined> {
    return this.records.find((r) => r.runnerId === runnerId && !r.released);
  }
  async listActiveOlderThan(threshold: Date): Promise<RunnerRecord[]> {
    return this.records.filter((r) => !r.released && r.createdAt < threshold);
  }
  async listStuck(thresholds: StuckThresholds): Promise<StuckRunner[]> {
    const stuck: StuckRunner[] = [];
    for (const r of this.records) {
      if (r.released) continue;
      const runTerminal = r.runId !== null && TERMINAL.has(this.runStatus.get(r.runId) ?? "");
      const pastTtl = r.createdAt < thresholds.ttlThreshold;
      const wedged = r.runId === null && r.createdAt < thresholds.graceThreshold;
      if (runTerminal) {
        stuck.push({ record: r, reason: "terminal_run" });
      } else if (pastTtl) {
        stuck.push({ record: r, reason: "ttl_exceeded" });
      } else if (wedged) {
        stuck.push({ record: r, reason: "unclaimed_grace" });
      }
    }
    return stuck;
  }

  /** Seed a runner row directly (bypasses allocate so we control run_id/created_at). */
  seed(record: Partial<RunnerRecord> & Pick<RunnerRecord, "runnerId" | "createdAt">): void {
    this.records.push({
      runId: record.runId ?? null,
      projectId: record.projectId ?? "proj",
      handle: record.handle ?? record.runnerId.replace(/^runner_/u, ""),
      orgId: record.orgId ?? "org_test",
      containerId: record.containerId ?? "container",
      workspaceVolume: record.workspaceVolume ?? "ws",
      codexHomeVolume: record.codexHomeVolume ?? "ch",
      sshHost: record.sshHost ?? "host",
      sshPort: record.sshPort ?? 22,
      hostKeyFingerprint: record.hostKeyFingerprint ?? "fp",
      imageSha: record.imageSha ?? "sha256:x",
      released: false,
      ...record,
    });
  }
}

function buildLifecycle(docker: DockerEngineClient, store: RunnerStore, nowMs: () => number): RunnerLifecycle {
  return new RunnerLifecycle({
    docker,
    store,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    sleep: () => Promise.resolve(),
    hostKeyReadAttempts: 1,
    hostKeyReadDelayMs: 0,
    now: () => new Date(nowMs()),
  });
}

describe("RunnerSweeper", () => {
  it("sweeps a runner whose owning run is terminal but was never released", async () => {
    const nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    // A FRESH runner (well within TTL) whose owning run has gone terminal.
    store.seed({ runnerId: "runner_run_term", runId: "run_term", createdAt: new Date(nowMs) });
    store.runStatus.set("run_term", "completed");

    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: (audit) => store.recordSwept(audit as SweptAudit),
      maxRunHours: 6,
      unclaimedGraceMs: 900_000,
    });

    const summary = await sweeper.tick();
    expect(summary.reclaimed.map((s) => [s.record.runnerId, s.reason])).toEqual([["runner_run_term", "terminal_run"]]);
    expect(summary.countsByReason).toEqual({ terminal_run: 1 });
    expect(store.swept).toEqual([
      expect.objectContaining({ runnerId: "runner_run_term", runId: "run_term", reason: "terminal_run" }),
    ]);
    // The runner row is now released (idempotent: a second tick reclaims nothing).
    const again = await sweeper.tick();
    expect(again.reclaimed).toEqual([]);
  });

  it("reclaims a runner past the run-hours TTL ceiling", async () => {
    let nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    // Allocated through the real lifecycle, then time advances past the 6h ceiling.
    await lifecycle.allocate({ runId: "run_a", projectId: "proj_a", orgId: "org_test", runnerImage: "img" });
    // Still non-terminal — only the TTL ceiling reclaims it.
    store.runStatus.set("run_a", "running");
    nowMs += 7 * 60 * 60 * 1000;

    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: (audit) => store.recordSwept(audit as SweptAudit),
      maxRunHours: 6,
      unclaimedGraceMs: 900_000,
    });

    const summary = await sweeper.tick();
    expect(summary.reclaimed.map((s) => [s.record.runnerId, s.reason])).toEqual([["runner_run_a", "ttl_exceeded"]]);
    expect(summary.countsByReason).toEqual({ ttl_exceeded: 1 });
    expect(store.swept).toEqual([
      expect.objectContaining({ runnerId: "runner_run_a", runId: "run_a", reason: "ttl_exceeded" }),
    ]);
  });

  it("reclaims a run-less allocation past the grace window (wedged)", async () => {
    let nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    // A run-LESS (run_id null) allocation that never got tied to a live run.
    store.seed({ runnerId: "runner_forge_x", runId: null, createdAt: new Date(nowMs) });
    // Past the 15min grace window, well within the 6h TTL.
    nowMs += 20 * 60 * 1000;

    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: (audit) => store.recordSwept(audit as SweptAudit),
      maxRunHours: 6,
      unclaimedGraceMs: 15 * 60 * 1000,
    });

    const summary = await sweeper.tick();
    expect(summary.reclaimed.map((s) => [s.record.runnerId, s.reason])).toEqual([
      ["runner_forge_x", "unclaimed_grace"],
    ]);
    expect(summary.countsByReason).toEqual({ unclaimed_grace: 1 });
    expect(store.swept).toEqual([
      expect.objectContaining({ runnerId: "runner_forge_x", runId: null, reason: "unclaimed_grace" }),
    ]);
  });

  it("never touches a healthy in-flight runner", async () => {
    let nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    // A fresh, claimed, non-terminal runner — the live apex run.
    await lifecycle.allocate({ runId: "run_live", projectId: "proj_live", orgId: "org_test", runnerImage: "img" });
    store.runStatus.set("run_live", "running");
    // 1 minute later: within TTL, within grace, run non-terminal.
    nowMs += 60 * 1000;

    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: (audit) => store.recordSwept(audit as SweptAudit),
      maxRunHours: 6,
      unclaimedGraceMs: 15 * 60 * 1000,
    });

    const summary = await sweeper.tick();
    expect(summary.reclaimed).toEqual([]);
    expect(store.swept).toEqual([]);
    // The runner row is still LIVE (un-released) — the sweeper left it alone.
    expect(await store.findActive("runner_run_live")).toBeDefined();
  });

  it("counts a runner.swept audit-write failure loudly (never silent)", async () => {
    const nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    store.seed({ runnerId: "runner_run_term", runId: "run_term", createdAt: new Date(nowMs) });
    store.runStatus.set("run_term", "failed");

    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: () => Promise.reject(new Error("events db down")),
      maxRunHours: 6,
      unclaimedGraceMs: 900_000,
    });

    const summary = await sweeper.tick();
    // The runner was still reclaimed (released), but the audit failure is COUNTED.
    expect(summary.reclaimed.map((s) => s.record.runnerId)).toEqual(["runner_run_term"]);
    expect(summary.recordErrors.map((e) => [e.runnerId, e.reason])).toEqual([["runner_run_term", "terminal_run"]]);
  });

  it("stop() awaits the in-flight tick", async () => {
    const nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const lifecycle = buildLifecycle(new NoopDocker(), store, () => nowMs);
    store.seed({ runnerId: "runner_run_term", runId: "run_term", createdAt: new Date(nowMs) });
    store.runStatus.set("run_term", "completed");

    // A recordSwept that resolves only when we release it, so the tick is provably
    // in flight when stop() is called.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recorded = false;
    const sweeper = new RunnerSweeper({
      lifecycle,
      recordSwept: async () => {
        await gate;
        recorded = true;
      },
      maxRunHours: 6,
      unclaimedGraceMs: 900_000,
    });

    const tick = sweeper.tick();
    // stop() must not resolve until the in-flight tick (blocked on the gate) finishes.
    const stop = sweeper.stop();
    let stopResolved = false;
    void stop.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(recorded).toBe(false);

    release();
    await tick;
    await stop;
    expect(stopResolved).toBe(true);
    expect(recorded).toBe(true);
  });
});

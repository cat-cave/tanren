import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import {
  SshUsageProbe,
  type AccountingRead,
  type CcusageAccounting,
  type SubscriptionWindow,
  type UsageAccountant,
  type UsageMonitor,
  type UsageReadFailure,
  type WindowRead,
  type WindowUsage,
} from "../src/engine/usage/index.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

function window(partial: Partial<SubscriptionWindow>): SubscriptionWindow {
  return {
    slot: "primary",
    usedPercent: 0,
    resetsAt: "2026-06-01T00:00:00Z",
    windowMinutes: 300,
    resetDescription: "soon",
    ...partial,
  };
}

function windowUsage(windows: SubscriptionWindow[], creditsRemaining: number | null = null): WindowUsage {
  return {
    provider: "codex",
    windows,
    creditsRemaining,
    accountEmail: null,
    source: "codex-cli",
    capturedAt: "2026-05-28T00:00:00Z",
  };
}

class FakeMonitor implements UsageMonitor {
  constructor(private readonly result: WindowUsage | null) {}
  async readWindowState(): Promise<WindowRead> {
    return { ok: this.result };
  }
}

// A monitor that returns a LOUD read failure (timeout / SSH / nonzero / malformed).
class FailingMonitor implements UsageMonitor {
  constructor(private readonly failure: UsageReadFailure) {}
  async readWindowState(): Promise<WindowRead> {
    return { failed: this.failure };
  }
}

class FakeAccountant implements UsageAccountant {
  constructor(private readonly result: CcusageAccounting | null) {}
  async readAccounting(): Promise<AccountingRead> {
    return { ok: this.result };
  }
}

class FailingAccountant implements UsageAccountant {
  constructor(private readonly failure: UsageReadFailure) {}
  async readAccounting(): Promise<AccountingRead> {
    return { failed: this.failure };
  }
}

function probe(monitor: UsageMonitor, accountant: UsageAccountant, thresholdPercent?: number): SshUsageProbe {
  return new SshUsageProbe({
    monitor,
    accountant,
    provider: "codex",
    cli: "codex",
    codexHome: "/home/tanren/.tanren/runs/run_x/codex-home",
    target,
    timeoutMs: 1000,
    pressureThresholdPercent: thresholdPercent,
  });
}

describe("SshUsageProbe.observeWindow", () => {
  it("flags the worst window at/over the threshold as pressure", async () => {
    const usage = windowUsage([
      window({ slot: "primary", usedPercent: 12 }),
      window({ slot: "secondary", usedPercent: 100 }),
    ]);
    const result = await probe(new FakeMonitor(usage), new FakeAccountant(null)).observeWindow();
    expect(result.usage).toBe(usage);
    expect(result.pressure?.slot).toBe("secondary");
    expect(result.pressure?.usedPercent).toBe(100);
  });

  it("returns no pressure when every window is below the threshold", async () => {
    const usage = windowUsage([window({ usedPercent: 40 }), window({ slot: "secondary", usedPercent: 88 })]);
    const result = await probe(new FakeMonitor(usage), new FakeAccountant(null), 90).observeWindow();
    expect(result.pressure).toBeNull();
  });

  it("treats a CLEAN-but-empty monitor read as no usage, no pressure, NO failure", async () => {
    const result = await probe(new FakeMonitor(null), new FakeAccountant(null)).observeWindow();
    expect(result.usage).toBeNull();
    expect(result.pressure).toBeNull();
    // legitimate-empty is QUIET — distinct from a read failure.
    expect(result.failure).toBeNull();
  });

  it("surfaces a window READ FAILURE as a loud discriminated failure (NOT empty, NOT pressure)", async () => {
    const failure: UsageReadFailure = {
      tool: "codexbar",
      target: "codex",
      reason: "timeout",
      exitCode: null,
      detail: "timed out",
    };
    const result = await probe(new FailingMonitor(failure), new FakeAccountant(null)).observeWindow();
    // A read failure is NEVER conflated with a legitimately-empty window.
    expect(result.failure).toEqual(failure);
    expect(result.usage).toBeNull();
    expect(result.pressure).toBeNull();
  });

  it("does NOT flag pressure on a maxed window when credits cover the overage", async () => {
    // Credits available → a 100% window is not a doomed call (overage draws
    // credits), so the pre-flight must let the run proceed.
    const usage = windowUsage([window({ slot: "secondary", usedPercent: 100 })], 1000);
    const result = await probe(new FakeMonitor(usage), new FakeAccountant(null)).observeWindow();
    expect(result.pressure).toBeNull();
  });

  it("flags pressure on a maxed window when credits are exhausted (0)", async () => {
    const usage = windowUsage([window({ slot: "secondary", usedPercent: 100 })], 0);
    const result = await probe(new FakeMonitor(usage), new FakeAccountant(null)).observeWindow();
    expect(result.pressure?.usedPercent).toBe(100);
  });

  it("MANAGED run (NO monitor wired): a clean-empty window read, NOT a loud failure", async () => {
    // A managed OpenRouter run has no codex subscription window — codexbar would
    // exit nonzero by design, so the probe wires NO monitor. observeWindow must be
    // QUIET (no window concept applies), never a spurious usage.read_failed.
    const managedProbe = new SshUsageProbe({
      accountant: new FakeAccountant(null),
      provider: "codex",
      cli: "codex",
      codexHome: "/home/tanren/.tanren/runs/run_x/codex-home",
      target,
      timeoutMs: 1000,
    });
    const result = await managedProbe.observeWindow();
    expect(result.usage).toBeNull();
    expect(result.pressure).toBeNull();
    expect(result.failure).toBeNull();
  });

  it("MANAGED run (NO monitor): ccusage accounting STILL works — token accounting is unaffected", async () => {
    // The TOKEN accountant (ccusage) is always wired — it reads the per-run session
    // logs and works in a managed run, so notional cost still has a source.
    const accounting: CcusageAccounting = {
      cli: "codex",
      totals: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 0,
        totalTokens: 150,
      },
      costUsd: null,
      perModel: [],
      capturedAt: "2026-06-08T00:00:00Z",
    };
    const managedProbe = new SshUsageProbe({
      accountant: new FakeAccountant(accounting),
      provider: "codex",
      cli: "codex",
      codexHome: "/home/tanren/.tanren/runs/run_x/codex-home",
      target,
      timeoutMs: 1000,
    });
    expect(await managedProbe.observeAccounting()).toEqual({ ok: accounting });
  });
});

describe("SshUsageProbe.observeAccounting", () => {
  it("passes ccusage accounting through as a `{ ok }` read", async () => {
    const accounting: CcusageAccounting = {
      cli: "codex",
      totals: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 2,
        totalTokens: 17,
      },
      costUsd: 0.5,
      perModel: [],
      capturedAt: "2026-05-28T00:00:00Z",
    };
    const read = await probe(new FakeMonitor(null), new FakeAccountant(accounting)).observeAccounting();
    expect(read).toEqual({ ok: accounting });
  });

  it("returns `{ ok: null }` (legitimately-empty) when ccusage has no data", async () => {
    const read = await probe(new FakeMonitor(null), new FakeAccountant(null)).observeAccounting();
    expect(read).toEqual({ ok: null });
  });

  it("surfaces a ccusage READ FAILURE as a loud `{ failed }` (distinct from empty)", async () => {
    const failure: UsageReadFailure = {
      tool: "ccusage",
      target: "codex",
      reason: "nonzero_exit",
      exitCode: 1,
      detail: "boom",
    };
    const read = await probe(new FakeMonitor(null), new FailingAccountant(failure)).observeAccounting();
    expect(read).toEqual({ failed: failure });
  });
});

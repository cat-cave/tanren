import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import {
  SshUsageProbe,
  type CcusageAccounting,
  type SubscriptionWindow,
  type UsageAccountant,
  type UsageMonitor,
  type WindowUsage,
} from "../src/engine/usage/index.js";

const target: SshTarget = {
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
  async readWindowState(): Promise<WindowUsage | null> {
    return this.result;
  }
}

class FakeAccountant implements UsageAccountant {
  constructor(private readonly result: CcusageAccounting | null) {}
  async readAccounting(): Promise<CcusageAccounting | null> {
    return this.result;
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

  it("treats no monitor data as no usage and no pressure (an allowed state)", async () => {
    const result = await probe(new FakeMonitor(null), new FakeAccountant(null)).observeWindow();
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
});

describe("SshUsageProbe.observeAccounting", () => {
  it("passes ccusage accounting through unchanged", async () => {
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
    expect(await probe(new FakeMonitor(null), new FakeAccountant(accounting)).observeAccounting()).toBe(accounting);
  });

  it("returns null when ccusage has no data", async () => {
    expect(await probe(new FakeMonitor(null), new FakeAccountant(null)).observeAccounting()).toBeNull();
  });
});

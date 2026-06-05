// The run-sandbox reaper's retention + cadence are GOVERNED CONFIG (AllocatorConfig),
// never env vars. Proves the resolver returns the schema defaults (60 min retention,
// 30 min sweep) in ms, and that an explicit AllocatorConfig override flows through.

import { describe, expect, it } from "vitest";
import { AllocatorConfig, resolveRunWorkspaceReaperConfig } from "../src/engine/config/index.js";

describe("resolveRunWorkspaceReaperConfig", () => {
  it("resolves the schema defaults (60 min retention, 30 min interval) in ms", () => {
    expect(resolveRunWorkspaceReaperConfig()).toEqual({
      retentionMs: 60 * 60_000,
      reapIntervalMs: 30 * 60_000,
    });
  });

  it("AllocatorConfig carries the knobs with their documented defaults", () => {
    const parsed = AllocatorConfig.parse({});
    expect(parsed.runWorkspaceRetentionMinutes).toBe(60);
    expect(parsed.runWorkspaceReapIntervalMinutes).toBe(30);
  });

  it("accepts explicit overrides on AllocatorConfig", () => {
    const parsed = AllocatorConfig.parse({ runWorkspaceRetentionMinutes: 15, runWorkspaceReapIntervalMinutes: 5 });
    expect(parsed.runWorkspaceRetentionMinutes).toBe(15);
    expect(parsed.runWorkspaceReapIntervalMinutes).toBe(5);
  });
});

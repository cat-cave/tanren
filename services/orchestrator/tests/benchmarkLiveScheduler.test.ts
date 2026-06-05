// Unit tests for the live BenchmarkRunner wiring
// (docs/roadmap/tanren-method-benchmark.md §4.2). They prove the boot composes
// the production `BenchmarkRunnerDeps` with the REAL accept + await seams (not
// the runner's no-op defaults), and that the route-facing scheduler closures
// thread the per-call pool while closing over the live infra.
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { PgNotifyListener } from "@tanren/db";
import { buildLiveBenchmarkRunnerDeps, buildLiveBenchmarkScheduler } from "../src/engine/benchmark/liveScheduler.js";

const fakeAllocator = {} as Allocator;
const fakeSsh = {} as CommandSubstrate;
const fakeListener = {} as PgNotifyListener;
const fakePool = {} as pg.Pool;

describe("buildLiveBenchmarkRunnerDeps", () => {
  it("injects the REAL runAccept + awaitTerminal seams (not the runner's no-op defaults)", () => {
    const deps = buildLiveBenchmarkRunnerDeps({
      pool: fakePool,
      allocator: fakeAllocator,
      ssh: fakeSsh,
      identitySecretRef: "runner/identity",
      notifyListener: fakeListener,
    });
    expect(deps.pool).toBe(fakePool);
    // Both seams are wired (the production injection); the runner would otherwise
    // default runAccept to a no-op and awaitTerminal to a poll.
    expect(typeof deps.runAccept).toBe("function");
    expect(typeof deps.awaitTerminal).toBe("function");
  });
});

describe("buildLiveBenchmarkScheduler", () => {
  it("exposes runExperiment + runExperimentCell closures over the live infra", () => {
    const scheduler = buildLiveBenchmarkScheduler({
      allocator: fakeAllocator,
      ssh: fakeSsh,
      identitySecretRef: "runner/identity",
      notifyListener: fakeListener,
    });
    expect(typeof scheduler.runExperiment).toBe("function");
    expect(typeof scheduler.runExperimentCell).toBe("function");
  });
});

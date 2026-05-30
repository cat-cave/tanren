// Plane-split P1: behavior tests for the standalone worker entrypoint boot.
//
// What they prove (observable outcomes, no mock-only assertions):
//   1. `bootRunWorker` builds the runtime pool from DATABASE_URL and STARTS the
//      claim loop (a live, draining-capable RunWorker bound to that pool) — the
//      construction the standalone `worker-main.ts` container relies on.
//   2. The API does NOT run an in-process worker by default: `runWorkerEnabled()`
//      is false unless TANREN_RUN_WORKER=1 (the only gate main.ts consults before
//      starting the in-process worker), so the data plane is the `worker`
//      service unless the dev/test flag is explicitly set.
//
// No real DB is needed: bootRunWorker builds a lazy pg.Pool (connects only when
// the loop claims), and we stop the worker immediately so the slot drains before
// any claim completes. TANREN_SECRET_STORE=memory avoids Vault.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSystemPool } from "@tanren/db";
import { bootRunWorker, runWorkerEnabled, RunWorker } from "../src/engine/worker/index.js";

const TEST_DB_URL = "postgres://tanren_app:tanren_app@127.0.0.1:5/tanren_planesplit_boot_test";

describe("plane-split P1 — standalone worker boot", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "DATABASE_URL",
    "TANREN_SYSTEM_DATABASE_URL",
    "TANREN_SECRET_STORE",
    "TANREN_RUN_WORKER",
    "TANREN_RUN_WORKER_CONCURRENCY",
    "TANREN_RUNNER_IDENTITY_PRIVATE_KEY",
    "TANREN_RUNNER_IDENTITY_KEY_PATH",
    "TANREN_ALLOCATOR_KIND",
  ];

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
    }
    process.env["DATABASE_URL"] = TEST_DB_URL;
    delete process.env["TANREN_SYSTEM_DATABASE_URL"];
    process.env["TANREN_SECRET_STORE"] = "memory";
    process.env["TANREN_ALLOCATOR_KIND"] = "static";
    // No identity to seed → bootRunWorker's seed step is a no-op (memory store).
    delete process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    resetSystemPool();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    resetSystemPool();
  });

  it("builds the runtime pool from DATABASE_URL and starts a worker loop that drains", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    const booted = await bootRunWorker();
    try {
      // The loop is live (started, not yet draining) and bound to the
      // DATABASE_URL runtime pool — exactly what the data-plane container runs.
      expect(booted.worker).toBeInstanceOf(RunWorker);
      expect(booted.worker.isDraining).toBe(false);
      expect((booted.pool.options as { connectionString?: string }).connectionString).toBe(TEST_DB_URL);
    } finally {
      // Drain BOTH the worker and the co-located reaper — the SIGTERM path the
      // standalone container uses. Proves graceful shutdown of the data plane.
      await booted.stop();
    }
    expect(booted.worker.isDraining).toBe(true);
  });

  it("does not enable the in-process worker by default (only TANREN_RUN_WORKER=1 does)", () => {
    delete process.env["TANREN_RUN_WORKER"];
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "0";
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "";
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "1";
    expect(runWorkerEnabled()).toBe(true);
  });
});

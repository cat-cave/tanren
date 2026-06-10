// Plane-split: behavior tests for the standalone worker entrypoint boot.
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "TANREN_RUNNER_IDENTITY_KEY_PATH",
    // Saved/restored so the custom-ref / blank-ref cases can set it without leaking.
    "TANREN_RUNNER_IDENTITY_SECRET_REF",
    // Saved/restored so the "inline env is IGNORED" case can set it without leaking.
    "TANREN_RUNNER_IDENTITY_PRIVATE_KEY",
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
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
    delete process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
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

  it("starts a co-located reaper alongside the worker (both drain on stop)", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    const booted = await bootRunWorker();
    try {
      // The boot wires BOTH the worker and the lease reaper — the data plane's
      // crash-recovery side. `stop` must drain both without throwing.
      expect(booted.reaper).toBeDefined();
    } finally {
      await booted.stop();
    }
    expect(booted.worker.isDraining).toBe(true);
  });

  it("seeds the runner identity secret from a key FILE (the MOUNTED secret) under the default ref", async () => {
    // The runner identity PRIVATE key is delivered as a MOUNTED SECRET FILE
    // (TANREN_RUNNER_IDENTITY_KEY_PATH), never a plaintext env value. The worker
    // reads the file and seeds the identity into the (shared) secret store at the
    // default ref so the workflow's SSH substrate can resolve it.
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "FILE-PRIVATE-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      expect((await booted.secrets.get("runner/local-docker/identity"))?.value).toBe("FILE-PRIVATE-KEY");
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
  });

  it("seeds the runner identity secret under a custom ref when TANREN_RUNNER_IDENTITY_SECRET_REF is set", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] = "runner/custom/key";
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "CUSTOM-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      // The custom ref is honored; the default ref is NOT seeded.
      expect((await booted.secrets.get("runner/custom/key"))?.value).toBe("CUSTOM-KEY");
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
  });

  it('a BLANK TANREN_RUNNER_IDENTITY_SECRET_REF fails-closed to the validated default (never a silent "")', async () => {
    // SECURITY BOUNDARY: a blank ref must NOT become the live secret ref. The old
    // `process.env[...] ?? "..."` let `""` through (`??` only catches null/undefined),
    // so a blank value seeded the identity under the empty ref. Routing through the
    // shared parsed env contract (`emptyToUndefined` + `.min(1)` + default) makes a
    // blank ref resolve to the validated default — observable here: the identity is
    // seeded under the default ref, and NOTHING is written under the empty ref "".
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] = "";
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "BLANK-REF-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      expect((await booted.secrets.get("runner/local-docker/identity"))?.value).toBe("BLANK-REF-KEY");
      // The blank ref is never honored — no secret lands under the empty ref.
      expect(await booted.secrets.get("")).toBeUndefined();
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
  });

  it("IGNORES a plaintext TANREN_RUNNER_IDENTITY_PRIVATE_KEY env (the inline path is deleted)", async () => {
    // The plaintext-env path was removed (secrets are secret-mounts, never env
    // VALUES). Setting the legacy env var must NOT seed anything — only the key
    // FILE path is honored.
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"] = "INLINE-PRIVATE-KEY";
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    const booted = await bootRunWorker();
    try {
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
      delete process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
    }
  });

  it("does not seed any identity secret when the key path is unset", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    const booted = await bootRunWorker();
    try {
      // No key configured → the seed step is a no-op (the API may seed the
      // shared store instead); nothing is written under the default ref.
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
  });

  it("does not seed when the key path is the empty string", async () => {
    process.env["TANREN_RUN_WORKER_CONCURRENCY"] = "1";
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = "";
    const booted = await bootRunWorker();
    try {
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
  });
});

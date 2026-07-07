import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Allocator, RunnerAllocation } from "../src/engine/contracts/allocator.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import {
  createEnvironment,
  type CreateEnvironmentDeps,
  EnvironmentValidationFailedError,
} from "../src/engine/environments/creation/createEnvironment.js";
import { EnvBuildFailedError, type EnvImageBuildDriver } from "../src/engine/environments/creation/envBuildDriver.js";
import { systemActor } from "../src/engine/state/actor.js";

// Environment management (env-management.md §4 + §7 P4) — the createEnvironment
// meta-flow: build→validate→publish + the fail-closed publish gate. A validated env
// PUBLISHES (status `validated` + image_ref + proof); a FAILED validation NEVER
// publishes (a LOUD EnvironmentValidationFailedError); a failed BUILD propagates LOUD.

const TOOLCHAIN = [{ name: "node", version: "18" }];

// A fake pool whose `query` records every INSERT and echoes back the inserted env row
// (mirroring EnvironmentStore.create's RETURNING shape) so the publish is observable
// without a real DB.
function fakePool(): { pool: pg.Pool; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (sql.includes("INSERT INTO environments")) {
      inserts.push(params ?? []);
      const p = params ?? [];
      return {
        rows: [
          {
            id: p[0],
            org_id: p[1],
            env_key: p[2],
            image_ref: p[3],
            capabilities: JSON.parse(String(p[4])),
            channel: p[5],
            status: p[6],
            provenance: JSON.parse(String(p[7])),
            validation_proof: p[8] === null ? null : JSON.parse(String(p[8])),
          },
        ],
      };
    }
    return { rows: [] };
  };
  return { pool: { query } as unknown as pg.Pool, inserts };
}

// A substrate that drives a PASSING validation (smoke green + both controls proven).
function passingSubstrate(): CommandSubstrate {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async run(_h: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      const c = command.command;
      if (c.includes("mise exec -- 'node' --version")) return ok("v18.20.4");
      if (c.includes("mise ls --installed 'node'")) return ok("node  18.20.4  ~/mise.toml");
      if (c.includes("mise which") || c.includes("mise exec '")) return ok("ABSENT");
      // mkdir / cat materialize.
      return ok("");
    },
  };
}

// A substrate that drives a FAILING validation (the undeclared tool leaked).
function leakySubstrate(): CommandSubstrate {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async run(_h: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      const c = command.command;
      if (c.includes("mise exec -- 'node' --version")) return ok("v18.20.4");
      if (c.includes("mise ls --installed 'node'")) return ok("node  18.20.4  ~/mise.toml");
      // The undeclared baseline tool RESOLVED — the golden base LEAKED.
      if (c.includes("mise which")) return ok("RESOLVED");
      if (c.includes("mise exec '")) return ok("ABSENT");
      return ok("");
    },
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function stubBuildDriver(imageRef = "registry:5000/tanren-env:env-abc"): EnvImageBuildDriver {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async build(request) {
      return { imageRef, envKey: request.envKey };
    },
  };
}

const NOW = (): Date => new Date("2026-06-12T00:00:00.000Z");

function deps(over: Partial<CreateEnvironmentDeps> & { pool: pg.Pool }): CreateEnvironmentDeps {
  return {
    actor: systemActor,
    buildDriver: stubBuildDriver(),
    allocator: new FakeAllocator(),
    ssh: passingSubstrate(),
    identitySecretRef: "ref",
    now: NOW,
    timeoutMs: 1000,
    ...over,
  };
}

describe("createEnvironment — build→validate→publish + the fail-closed gate", () => {
  it("PUBLISHES a validated env (status validated + image_ref + proof) on a green validation", async () => {
    const { pool, inserts } = fakePool();
    const result = await createEnvironment(deps({ pool }), {
      orgId: "org_1",
      projectId: "proj_1",
      toolchain: TOOLCHAIN,
      goldenBaseImage: "ghcr.io/cat-cave/tanren-runner:golden-deadbeef",
    });
    expect(result.environment.status).toBe("validated");
    expect(result.environment.imageRef).toBe("registry:5000/tanren-env:env-abc");
    expect(result.proof.positiveSmokePassed).toBe(true);
    expect(result.proof.negativeControls.undeclaredToolAbsent).toBe("proven");
    expect(result.environment.validationProof).not.toBeNull();
    // The env was actually written (status `validated`, the proof persisted).
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[6]).toBe("validated");
  });

  it("FAILS LOUD without publishing when validation fails (a leaked env)", async () => {
    const { pool, inserts } = fakePool();
    await expect(
      createEnvironment(deps({ pool, ssh: leakySubstrate() }), {
        orgId: "org_1",
        projectId: "proj_1",
        toolchain: TOOLCHAIN,
        goldenBaseImage: "ghcr.io/cat-cave/tanren-runner:golden-deadbeef",
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationFailedError);
    // NOTHING was published — the fail-closed gate held.
    expect(inserts).toHaveLength(0);
  });

  it("propagates a BUILD failure LOUD (never publishes the golden base as a degrade)", async () => {
    const { pool, inserts } = fakePool();
    const failingBuilder: EnvImageBuildDriver = {
      build: vi.fn<EnvImageBuildDriver["build"]>(async () => {
        throw new EnvBuildFailedError("abc", "buildkit exited non-zero");
      }),
    };
    await expect(
      createEnvironment(deps({ pool, buildDriver: failingBuilder }), {
        orgId: "org_1",
        projectId: "proj_1",
        toolchain: TOOLCHAIN,
        goldenBaseImage: "ghcr.io/cat-cave/tanren-runner:golden-deadbeef",
      }),
    ).rejects.toBeInstanceOf(EnvBuildFailedError);
    expect(inserts).toHaveLength(0);
  });

  it("RELEASES the validation runner (pass) — never leaks", async () => {
    const { pool } = fakePool();
    const released: string[] = [];
    const allocator: Allocator = {
      taxonomy: "fixed_pool" as const,
      async allocate(req): Promise<RunnerAllocation> {
        return new FakeAllocator().allocate(req);
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async release(runnerId): Promise<void> {
        released.push(runnerId);
      },
    };
    await createEnvironment(deps({ pool, allocator }), {
      orgId: "org_1",
      projectId: "proj_1",
      toolchain: TOOLCHAIN,
      goldenBaseImage: "ghcr.io/cat-cave/tanren-runner:golden-deadbeef",
    });
    expect(released).toHaveLength(1);
  });

  it("requires an org-scoped run (empty orgId is a LOUD failure)", async () => {
    const { pool } = fakePool();
    await expect(
      createEnvironment(deps({ pool }), {
        orgId: "",
        projectId: "proj_1",
        toolchain: TOOLCHAIN,
        goldenBaseImage: "ghcr.io/cat-cave/tanren-runner:golden-deadbeef",
      }),
    ).rejects.toThrow(/org-scoped/u);
  });
});

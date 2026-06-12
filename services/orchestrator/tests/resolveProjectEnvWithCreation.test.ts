import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import {
  NixTierNotBuiltError,
  resolveProjectEnvWithCreation,
  type EnvCreationDeps,
} from "../src/engine/environments/creation/resolveProjectEnvWithCreation.js";
import type { EnvImageBuildDriver } from "../src/engine/environments/creation/envBuildDriver.js";
import { GOLDEN_BASE_IMAGE } from "../src/engine/environments/index.js";
import { systemActor } from "../src/engine/state/actor.js";

// Environment management (env-management.md §4 + §7 P4) — the NO-MATCH ROUTER: a
// registry match uses it; a baseline-subset toolchain SHORT-CIRCUITS to the golden
// base (NO build); an off-baseline no-match JIT-builds→validates→publishes; a flake
// project routes to the Nix seam (loud not-yet-built).

// A passing validation substrate (smoke green + both isolation controls proven). The
// isolation probes are `if … then echo RESOLVED; … else echo ABSENT; fi` compounds —
// matched FIRST (on `echo ABSENT`) so they return ABSENT, before the smoke matchers.
// The smoke's `mise ls --installed '<tool>'` line echoes the declared tool at a
// version satisfying its spec (parsed from the command + the toolchain under test).
function passingSubstrate(toolchain: Record<string, string>): CommandSubstrate {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async run(_h: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      const c = command.command;
      // Isolation probes (undeclared-tool + forbidden-version): both echo ABSENT.
      if (c.includes("echo ABSENT")) return ok("ABSENT");
      // Positive smoke exec: `mise exec -- <tool> --version` exits 0.
      if (c.includes("mise exec -- ") && c.includes("--version")) return ok("ran");
      // Positive smoke version line: echo each declared tool at a satisfying version.
      if (c.includes("mise ls --installed")) {
        const lines = Object.entries(toolchain).map(([t, spec]) => `${t}  ${satisfyingVersion(spec)}  ~/mise.toml`);
        return ok(lines.join("\n"));
      }
      return ok("");
    },
  };
}

// A resolved version that satisfies a declared spec — the spec plus a patch suffix
// (`18` → `18.20.4`, `nightly` → `nightly` exactly), so resolvedVersionMatchesSpec
// matches (a dotted-prefix or exact match).
function satisfyingVersion(spec: string): string {
  return /^\d+(\.\d+)*$/u.test(spec) ? `${spec}.0.0` : spec;
}
function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

// A fake registry client's `query`: no rows on getByEnvKey (a no-match), echoes the
// env row on INSERT (the publish), so the router's JIT path runs end-to-end without a
// DB. Hoisted to module scope (it captures nothing) and wrapped by `fakeClient`.
// eslint-disable-next-line @typescript-eslint/require-await
async function fakeQuery(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
  if (sql.includes("INSERT INTO environments")) {
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
  // getByEnvKey + every other read: no match.
  return { rows: [] };
}

function fakeClient(): pg.Pool {
  return { query: fakeQuery } as unknown as pg.Pool;
}

// A stub build driver that counts invocations — so a test asserts the build fired
// (off-baseline) or did NOT (baseline short-circuit / flake seam).
function stubBuildDriver(): { driver: EnvImageBuildDriver; state: { built: number } } {
  const state = { built: 0 };
  const driver: EnvImageBuildDriver = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async build(request) {
      state.built += 1;
      return { imageRef: `registry:5000/tanren-env:env-${request.envKey.slice(0, 8)}`, envKey: request.envKey };
    },
  };
  return { driver, state };
}

function creationDeps(driver: EnvImageBuildDriver, toolchain: Record<string, string>): EnvCreationDeps {
  return {
    buildDriver: driver,
    allocator: new FakeAllocator(),
    ssh: passingSubstrate(toolchain),
    identitySecretRef: "ref",
    now: () => new Date("2026-06-12T00:00:00.000Z"),
    timeoutMs: 1000,
  };
}

const GOLDEN = "ghcr.io/cat-cave/tanren-runner:golden-deadbeef";

describe("resolveProjectEnvWithCreation — the P4 no-match router", () => {
  it("a BASELINE-SUBSET toolchain (node+pnpm) SHORT-CIRCUITS to the golden base — NO build", async () => {
    const stub = stubBuildDriver();
    const binding = await resolveProjectEnvWithCreation(
      fakeClient(),
      {
        toolchain: [
          { name: "node", version: "24" },
          { name: "pnpm", version: "11" },
        ],
        baseImage: GOLDEN,
        orgId: "org_1",
        projectId: "proj_1",
      },
      systemActor,
      creationDeps(stub.driver, { node: "24", pnpm: "11" }),
    );
    expect(binding.imageRef).toBe(GOLDEN);
    expect(binding.source).toBe("golden-base-no-match");
    // The build driver was NEVER invoked — apex-style baseline projects don't build.
    expect(stub.state.built).toBe(0);
  });

  it("an OFF-baseline no-match JIT-BUILDS→validates→publishes and seeds from the new env", async () => {
    const stub = stubBuildDriver();
    const binding = await resolveProjectEnvWithCreation(
      fakeClient(),
      { toolchain: [{ name: "node", version: "18" }], baseImage: GOLDEN, orgId: "org_1", projectId: "proj_1" },
      systemActor,
      creationDeps(stub.driver, { node: "18" }),
    );
    expect(binding.source).toBe("jit-created");
    expect(binding.imageRef).toMatch(/registry:5000\/tanren-env:env-/u);
    expect(binding.environmentRef).toMatch(/^env_/u);
    // The build DID fire for the off-baseline toolchain.
    expect(stub.state.built).toBe(1);
  });

  it("an off-baseline TOOL (rust) also JIT-builds", async () => {
    const stub = stubBuildDriver();
    const binding = await resolveProjectEnvWithCreation(
      fakeClient(),
      { toolchain: [{ name: "rust", version: "nightly" }], baseImage: GOLDEN, orgId: "org_1", projectId: "proj_1" },
      systemActor,
      creationDeps(stub.driver, { rust: "nightly" }),
    );
    expect(binding.source).toBe("jit-created");
    expect(stub.state.built).toBe(1);
  });

  it("NO toolchain resolves to the golden base unchanged (no build)", async () => {
    const stub = stubBuildDriver();
    const binding = await resolveProjectEnvWithCreation(
      fakeClient(),
      { toolchain: undefined, orgId: "org_1", projectId: "proj_1" },
      systemActor,
      creationDeps(stub.driver, {}),
    );
    expect(binding.imageRef).toBe(GOLDEN_BASE_IMAGE);
    expect(binding.source).toBe("golden-base-no-toolchain");
    expect(stub.state.built).toBe(0);
  });

  it("a flake.nix project with no match routes to the Nix SEAM (loud not-yet-built, no mise build)", async () => {
    const stub = stubBuildDriver();
    await expect(
      resolveProjectEnvWithCreation(
        fakeClient(),
        {
          toolchain: [{ name: "rust", version: "nightly" }],
          baseImage: GOLDEN,
          orgId: "org_1",
          projectId: "proj_1",
          flakePresent: true,
        },
        systemActor,
        creationDeps(stub.driver, { rust: "nightly" }),
      ),
    ).rejects.toBeInstanceOf(NixTierNotBuiltError);
    // The mise builder was NOT invoked for a flake-tier project.
    expect(stub.state.built).toBe(0);
  });

  it("a creation FAILURE (build throws) propagates LOUD (no silent golden-base degrade)", async () => {
    const failing: EnvImageBuildDriver = {
      build: vi.fn<EnvImageBuildDriver["build"]>(async () => {
        throw new Error("buildkit failed");
      }),
    };
    await expect(
      resolveProjectEnvWithCreation(
        fakeClient(),
        { toolchain: [{ name: "node", version: "18" }], baseImage: GOLDEN, orgId: "org_1", projectId: "proj_1" },
        systemActor,
        creationDeps(failing, { node: "18" }),
      ),
    ).rejects.toThrow(/buildkit failed/u);
  });
});

// Environment management (env-management.md §2.2 halt-loud, H1 finding #4) —
// tests for the `assertJitAvailableForToolchain` guard that closes the silent
// golden-base fallback for off-baseline toolchains when `TANREN_ENV_REGISTRY`
// is unset. The guard mirrors `refineRunnerImageForEnv`'s decision tree
// (no-op on empty / baseline-subset; throw on off-baseline + no registry).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertJitAvailableForToolchain,
  JitBuildRequiredError,
  jitEnvRegistryConfigured,
} from "../src/engine/environments/creation/index.js";
import type { ProjectToolchain } from "../src/engine/config/projectConfig.js";

describe("assertJitAvailableForToolchain — H1 #4 no silent golden-base fallback", () => {
  // Preserve + restore the ambient `TANREN_ENV_REGISTRY` around each test so an
  // ambient value in dev doesn't leak into the assertions (the guard reads
  // `process.env` on every call — no cache).
  const originalRegistry = process.env["TANREN_ENV_REGISTRY"];
  beforeEach(() => {
    delete process.env["TANREN_ENV_REGISTRY"];
  });
  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env["TANREN_ENV_REGISTRY"];
    } else {
      process.env["TANREN_ENV_REGISTRY"] = originalRegistry;
    }
  });

  it("no-ops on an UNDEFINED toolchain (the greenfield first-boot / no-mise.toml path)", () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- exercise the undefined-toolchain branch.
    expect(() => assertJitAvailableForToolchain(undefined)).not.toThrow();
  });

  it("no-ops on an EMPTY toolchain (a project that declared none)", () => {
    expect(() => assertJitAvailableForToolchain([])).not.toThrow();
  });

  it("no-ops on a BASELINE-SUBSET toolchain even when the registry is unset (apex-style node+pnpm)", () => {
    // The golden base ALREADY serves node 24 + pnpm 11 — no JIT build needed.
    const toolchain: ProjectToolchain = [
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ];
    expect(() => assertJitAvailableForToolchain(toolchain)).not.toThrow();
  });

  it("THROWS JitBuildRequiredError on an off-baseline TOOL (rust) when the registry is unset", () => {
    const toolchain: ProjectToolchain = [{ name: "rust", version: "nightly" }];
    expect(() => assertJitAvailableForToolchain(toolchain, { projectId: "proj_1" })).toThrow(JitBuildRequiredError);
  });

  it("THROWS on an off-baseline VERSION of a baseline tool (node 18 vs baseline 24)", () => {
    const toolchain: ProjectToolchain = [{ name: "node", version: "18" }];
    let caught: unknown;
    try {
      assertJitAvailableForToolchain(toolchain, { projectId: "proj_x" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JitBuildRequiredError);
    const jitError = caught as JitBuildRequiredError;
    expect(jitError.toolchain).toEqual(toolchain);
    expect(jitError.projectId).toBe("proj_x");
    expect(jitError.message).toMatch(/TANREN_ENV_REGISTRY/u);
    expect(jitError.message).toMatch(/node=18/u);
  });

  it("PASSES on an off-baseline toolchain when TANREN_ENV_REGISTRY IS configured (ambient env)", () => {
    process.env["TANREN_ENV_REGISTRY"] = "registry:5000";
    const toolchain: ProjectToolchain = [{ name: "rust", version: "nightly" }];
    expect(() => assertJitAvailableForToolchain(toolchain)).not.toThrow();
  });

  it("respects an explicit `registryConfigured: true` override (test injection)", () => {
    const toolchain: ProjectToolchain = [{ name: "rust", version: "nightly" }];
    expect(() => assertJitAvailableForToolchain(toolchain, { registryConfigured: true })).not.toThrow();
  });

  it("throws when explicit `registryConfigured: false` overrides an ambient set value", () => {
    // Even with the ambient env-var set, an explicit `false` override signals the
    // caller (typically the run-executor) has already established the JIT seams
    // are NOT wired — the assertion trusts the explicit signal over `process.env`.
    process.env["TANREN_ENV_REGISTRY"] = "registry:5000";
    const toolchain: ProjectToolchain = [{ name: "rust", version: "nightly" }];
    expect(() => assertJitAvailableForToolchain(toolchain, { registryConfigured: false })).toThrow(
      JitBuildRequiredError,
    );
  });

  it("A WHITESPACE-only TANREN_ENV_REGISTRY reads as UNSET (a trim + empty check)", () => {
    // Matches `buildEnvCreationFromEnv`'s trim + empty-string check so the two
    // never disagree about whether the registry is configured.
    process.env["TANREN_ENV_REGISTRY"] = "   ";
    expect(jitEnvRegistryConfigured()).toBe(false);
    const toolchain: ProjectToolchain = [{ name: "rust", version: "nightly" }];
    expect(() => assertJitAvailableForToolchain(toolchain)).toThrow(JitBuildRequiredError);
  });
});

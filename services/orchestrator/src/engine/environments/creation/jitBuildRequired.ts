// Environment management (env-management.md §2.2 + §4 + §7 P4) — the LOUD guard for
// an off-baseline toolchain with NO JIT env-creation seam wired.
//
// The doctrine (§2.2 "No from-scratch environment"): every workspace seeds from a
// VALIDATED environment image; a no-match triggers just-in-time environment creation
// OR HALTS LOUD. Before this guard, the executor silently degraded to the golden
// base when `TANREN_ENV_REGISTRY` was unset — presenting an off-baseline toolchain
// (rust, bun, node 18) as a mysterious runtime failure ("command not found") rather
// than a legible config error ("configure the registry"). H1 finding #4.
//
// The check is symmetric with `refineRunnerImageForEnv`: a NO-toolchain / EMPTY /
// BASELINE-SUBSET toolchain is fine (the golden base already serves it — apex-style
// node+pnpm lands here and never needs JIT). Only an OFF-baseline toolchain (a
// baseline-tool at a different version, or a tool the baseline never warmed) with
// no registry configured throws.
//
// This module is used at TWO sites:
//   1. `refineRunnerImageForEnv` — the RUN-TIME choke point (the single point where
//      the silent fallback used to happen). Fires on EVERY run's env-refinement.
//   2. Greenfield derive (`deriveFromCapture`) — the PROJECT-CREATE early-feedback
//      site. Fires ONCE at project creation so the operator learns the config gap
//      BEFORE the first run kicks off. The run-time check remains the safety net.

import type { ProjectToolchain } from "../../config/projectConfig.js";
import { toolchainCoveredByGoldenBaseline } from "../baselineCoverage.js";
import { jitEnvRegistryConfigured } from "./envCreationConfig.js";

// Thrown when a project's off-baseline toolchain would silently fall back to the
// golden base because `TANREN_ENV_REGISTRY` is unset. Typed so route layers +
// callers can dispatch to a `400 jit_build_required` / early-feedback response,
// mirroring `NixTierNotBuiltError` and the derive path's other typed-error dispatch.
export class JitBuildRequiredError extends Error {
  readonly toolchain: ProjectToolchain;
  readonly projectId: string | undefined;
  constructor(toolchain: ProjectToolchain, projectId?: string) {
    const tools = toolchain.map((t) => `${t.name}=${t.version}`).join(", ");
    const projectSuffix = projectId === undefined ? "" : ` (project ${projectId})`;
    super(
      `off-baseline toolchain [${tools}]${projectSuffix} requires JIT env-image creation, ` +
        `but the env-image registry is not configured. ` +
        `Set TANREN_ENV_REGISTRY to a self-hosted OCI registry (e.g. registry:5000) ` +
        `so the runner can seed from a validated env image. ` +
        `Silent golden-base fallback for off-baseline toolchains is disabled (env-management.md §2.2 — halt loud).`,
    );
    this.name = "JitBuildRequiredError";
    this.toolchain = toolchain;
    if (projectId !== undefined) {
      this.projectId = projectId;
    }
  }
}

/**
 * Assert that a project's declared toolchain either (a) needs no JIT env-image build
 * (empty / baseline-subset) OR (b) has a configured `TANREN_ENV_REGISTRY` to build
 * against. Throws `JitBuildRequiredError` when an off-baseline toolchain would have
 * silently degraded to the golden base. A no-op for a covered toolchain — never a
 * false positive on the apex-style node+pnpm path.
 *
 * The default reads `TANREN_ENV_REGISTRY` via `jitEnvRegistryConfigured` — the same
 * source `buildEnvCreationFromEnv` reads at boot, so the two are guaranteed in sync.
 * Tests can pass an explicit `registryConfigured` boolean to bypass the env-var read.
 */
export function assertJitAvailableForToolchain(
  toolchain: ProjectToolchain | undefined,
  options: { projectId?: string; registryConfigured?: boolean } = {},
): void {
  // No toolchain / empty toolchain ⇒ the golden base is the correct binding; no build
  // is needed, no JIT capability is required. Matches `refineRunnerImageForEnv`'s
  // empty-toolchain no-op.
  if (toolchain === undefined || toolchain.length === 0) {
    return;
  }
  // Baseline-subset toolchain ⇒ the golden base already serves it (SHORT-CIRCUIT).
  // apex-style node+pnpm lands here — never triggers a build, never needs JIT.
  if (toolchainCoveredByGoldenBaseline(toolchain)) {
    return;
  }
  // Off-baseline toolchain ⇒ JIT capability is REQUIRED. If the registry is
  // configured, the executor's env-refinement seam will build a validated env
  // image; if not, we fail LOUD here (doctrine §2.2) instead of degrading silently.
  const registryConfigured = options.registryConfigured ?? jitEnvRegistryConfigured();
  if (!registryConfigured) {
    throw new JitBuildRequiredError(toolchain, options.projectId);
  }
}

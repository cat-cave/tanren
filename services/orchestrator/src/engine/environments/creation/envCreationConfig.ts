// Environment management (env-management.md §4 + §7 P4) — the BOOT-WIRING of the JIT
// env-creation seams from the orchestrator's config surface. Builds the
// `EnvCreationDeps` (the build driver + the validation allocator/ssh + timeouts) the
// run executor threads to the no-match router.
//
// The env-image BUILD seam shells `scripts/dev/build-env-image.sh` on the
// orchestrator HOST (where docker/buildx + the registry live) — the same place the
// golden-image refresh builds. The registry + script path + push posture come from
// the env config surface (defaulted for local dev: the `registry:5000` the dev
// compose publishes). The allocator + ssh are the run worker's OWN shared seams (the
// validation runner is allocated FROM the built image just like a real run's runner).
//
// GATED: the JIT-build path is OFF unless a registry is configured
// (`TANREN_ENV_REGISTRY`). Off ⇒ `undefined` ⇒ the executor's env-refinement seam
// FAILS LOUD for an off-baseline toolchain (`JitBuildRequiredError`), never a silent
// golden-base degrade. A baseline-subset toolchain (node+pnpm) still
// resolves to the golden base without JIT — it does not need a build. This closes
// H1 finding #4: an off-baseline toolchain without a configured registry used to
// silently seed from the golden base, presenting as a mysterious runtime failure
// rather than a loud config error.
//
// This is the one place the env knobs are read (no scattered `process.env`).

import { resolve } from "node:path";
import type { Allocator } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { buildLiveEnvBuildDriver } from "./liveEnvBuildDriver.js";
import type { EnvCreationDeps } from "./resolveProjectEnvWithCreation.js";

// Resolve the build script path relative to THIS module — it lives at the repo's
// scripts/dev/build-env-image.sh. The orchestrator src tree is
// services/orchestrator/src/engine/environments/creation; the repo root is six levels
// up. Resolved deterministically so the wiring needs no env var for the script path.
function defaultScriptPath(): string {
  // …/services/orchestrator/src/engine/environments/creation → repo root (six up).
  return resolve(import.meta.dirname, "../../../../../../scripts/dev/build-env-image.sh");
}

export interface BuildEnvCreationInput {
  // The run worker's shared allocator — the validation runner is allocated from the
  // freshly-built env image.
  allocator: Allocator;
  // The run worker's shared command substrate (SSH) — the validation probes run over it.
  ssh: CommandSubstrate;
  // The runner identity key ref (the same value the worker seeds).
  identitySecretRef: string;
  // The clock (defaults to a real `Date`).
  now?: () => Date;
}

/**
 * Is the JIT env-image registry configured? A `true` return means the operator has
 * set `TANREN_ENV_REGISTRY` and the JIT-build path is wired; a `false` return means
 * an off-baseline toolchain will fail-loud at project-create / at run-refine time
 * (H1 #4 — never a silent golden-base fallback for an off-baseline toolchain).
 *
 * The read mirrors `buildEnvCreationFromEnv` (trim + empty-string check), so a
 * project-create's early-feedback assertion sees the SAME truth the boot wiring
 * does. Read at the point of assertion (not cached) so a late-set value on the
 * next call is picked up — a config-surface concern, not a hot path.
 */
export function jitEnvRegistryConfigured(): boolean {
  const registry = process.env["TANREN_ENV_REGISTRY"]?.trim();
  return registry !== undefined && registry !== "";
}

/**
 * Build the JIT env-creation seams from the env config surface, or `undefined` when
 * the JIT-build path is not configured (`TANREN_ENV_REGISTRY` unset) — in which case
 * the executor's env-refinement seam FAILS LOUD for an off-baseline toolchain
 * (`JitBuildRequiredError`), never silently degrading to the golden base. Reads the
 * env knobs in ONE place (registry / image name / push / timeouts / script path).
 */
export function buildEnvCreationFromEnv(input: BuildEnvCreationInput): EnvCreationDeps | undefined {
  const registry = process.env["TANREN_ENV_REGISTRY"]?.trim();
  if (registry === undefined || registry === "") {
    // JIT-build path OFF → the env-refinement seam fails-loud for off-baseline.
    return undefined;
  }
  const imageName = process.env["TANREN_ENV_IMAGE_NAME"]?.trim();
  // The live path PUSHES (the validation runner pulls the registry ref); a dry-run
  // operator can set TANREN_ENV_BUILD_PUSH=0 for a local-only build.
  const push = process.env["TANREN_ENV_BUILD_PUSH"] !== "0";
  const scriptPath = process.env["TANREN_ENV_BUILD_SCRIPT"]?.trim() ?? defaultScriptPath();

  // NO build/validate wall-clock timeouts (feedback_no_timeouts_progress_based): the
  // off-baseline image build runs to its own terminal exit (a cold toolchain install
  // streams progress for as long as it needs), and the validation harness's per-command
  // probes are governed by the ActivityWatchdog, never a duration kill.
  const buildDriver = buildLiveEnvBuildDriver({
    scriptPath,
    registry,
    ...(imageName === undefined || imageName === "" ? {} : { imageName }),
    push,
  });

  return {
    buildDriver,
    allocator: input.allocator,
    ssh: input.ssh,
    identitySecretRef: input.identitySecretRef,
    now: input.now ?? ((): Date => new Date()),
  };
}

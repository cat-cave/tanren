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
// (`TANREN_ENV_REGISTRY`). Off ⇒ `undefined` ⇒ the executor keeps P3's golden-base
// no-match fallback (byte-identical). On ⇒ an off-baseline no-match builds a real env.
// This is the one place the env knobs are read (no scattered `process.env`).

import { resolve } from "node:path";
import type { Allocator } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { buildLiveEnvBuildDriver } from "./liveEnvBuildDriver.js";
import type { EnvCreationDeps } from "./resolveProjectEnvWithCreation.js";

// The default off-baseline build timeout — a cold toolchain install (an off-baseline
// node/python/rust) can take a few minutes. Overridable via TANREN_ENV_BUILD_TIMEOUT_MS.
const DEFAULT_ENV_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
// The validation harness's per-command timeout (a `mise exec --version` probe is fast).
const DEFAULT_ENV_VALIDATE_TIMEOUT_MS = 2 * 60 * 1000;

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
 * Build the JIT env-creation seams from the env config surface, or `undefined` when
 * the JIT-build path is not configured (`TANREN_ENV_REGISTRY` unset) — in which case
 * the executor keeps P3's golden-base no-match fallback. Reads the env knobs in ONE
 * place (registry / image name / push / timeouts / script path).
 */
export function buildEnvCreationFromEnv(input: BuildEnvCreationInput): EnvCreationDeps | undefined {
  const registry = process.env["TANREN_ENV_REGISTRY"]?.trim();
  if (registry === undefined || registry === "") {
    // JIT-build path OFF → P3 golden-base no-match fallback.
    return undefined;
  }
  const imageName = process.env["TANREN_ENV_IMAGE_NAME"]?.trim();
  // The live path PUSHES (the validation runner pulls the registry ref); a dry-run
  // operator can set TANREN_ENV_BUILD_PUSH=0 for a local-only build.
  const push = process.env["TANREN_ENV_BUILD_PUSH"] !== "0";
  const buildTimeoutMs = parsePositiveInt(process.env["TANREN_ENV_BUILD_TIMEOUT_MS"]) ?? DEFAULT_ENV_BUILD_TIMEOUT_MS;
  const validateTimeoutMs =
    parsePositiveInt(process.env["TANREN_ENV_VALIDATE_TIMEOUT_MS"]) ?? DEFAULT_ENV_VALIDATE_TIMEOUT_MS;
  const scriptPath = process.env["TANREN_ENV_BUILD_SCRIPT"]?.trim() ?? defaultScriptPath();

  const buildDriver = buildLiveEnvBuildDriver({
    scriptPath,
    registry,
    ...(imageName === undefined || imageName === "" ? {} : { imageName }),
    push,
    timeoutMs: buildTimeoutMs,
  });

  return {
    buildDriver,
    allocator: input.allocator,
    ssh: input.ssh,
    identitySecretRef: input.identitySecretRef,
    now: input.now ?? ((): Date => new Date()),
    timeoutMs: validateTimeoutMs,
  };
}

// Parse a positive-integer env var, or undefined when absent/invalid (the caller then
// applies the default — never a silent 0/NaN).
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

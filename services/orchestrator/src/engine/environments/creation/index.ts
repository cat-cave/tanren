// Environment management (environment-management.md §4 + §7 P4) — the JIT ENV-IMAGE
// CREATION import surface. The env-layer counterpart of `templates/creation`:
// build→validate→publish, the fail-closed publish gate, the golden-base short-circuit,
// and the no-match router that wires it into P3's resolution.
//
//   - envBuildDriver / liveEnvBuildDriver — the BuildKit build SEAM + its live impl
//     (shells scripts/dev/build-env-image.sh: FROM golden-base, bake the off-baseline
//     toolchain, push by env_key).
//   - envValidationHarness / envNegativeControls / envValidationProof — the validation
//     (positive smoke + isolation negative controls) + the fail-closed verdict.
//   - createEnvironment — the build→validate→publish orchestration + the publish gate.
//   - resolveProjectEnvWithCreation — the no-match router (short-circuit vs JIT-build
//     vs the Nix seam), the P4 superset of `resolveProjectEnv`.

export {
  type BuiltEnvImage,
  type EnvBuildRequest,
  EnvBuildFailedError,
  type EnvImageBuildDriver,
} from "./envBuildDriver.js";
export { buildLiveEnvBuildDriver, type LiveEnvBuildDriverDeps } from "./liveEnvBuildDriver.js";
export {
  buildEnvNegativeControlPlan,
  type EnvNegativeControl,
  type EnvNegativeControlPlan,
  ABSENT_SENTINEL_TOOL,
} from "./envNegativeControls.js";
export {
  runEnvValidationHarness,
  type EnvValidationHarnessInput,
  resolvedVersionMatchesSpec,
} from "./envValidationHarness.js";
export { environmentValidates } from "./envValidationProof.js";
export {
  createEnvironment,
  type CreateEnvironmentDeps,
  type CreateEnvironmentRequest,
  type CreateEnvironmentResult,
  EnvironmentValidationFailedError,
} from "./createEnvironment.js";
export {
  resolveProjectEnvWithCreation,
  type ResolveWithCreationInput,
  type EnvCreationDeps,
  NixTierNotBuiltError,
} from "./resolveProjectEnvWithCreation.js";
export { buildEnvCreationFromEnv, type BuildEnvCreationInput } from "./envCreationConfig.js";

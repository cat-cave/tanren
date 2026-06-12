// Single import surface for environment management (environment-management.md §3
// Layer 4 + §5 + §6 + §7 P3). The env-layer counterpart of `engine/templates`:
//
//   - manifest.ts — the CONTRACT shapes for the registry jsonb columns
//     (capabilities/channel/provenance/validationProof), re-parsed on read.
//   - envKey.ts — the deterministic CONTENT KEY (`env_key`) computation.
//   - goldenBase.ts — P2's golden base_digest SOURCE + the no-match fallback image.
//   - resolveProjectEnv.ts — the PER-PROJECT resolution at the image seam.
//   - baselineCoverage.ts — the golden-base SUBSET check (P4 short-circuit).
//   - creation/ — JIT env-image creation (build→validate→publish + the no-match
//     router), the env-layer counterpart of `templates/creation` (P4).
//
// The registry STORE rides the `Repositories` seam
// (engine/repositories/environments.ts) like `TemplateStore`.

export {
  EnvironmentCapabilities,
  EnvironmentChannel,
  type EnvironmentChannelValue,
  EnvironmentProvenance,
  EnvironmentValidationProof,
  EnvNegativeControlResult,
} from "./manifest.js";
export { computeEnvKey, type EnvKeyInputs } from "./envKey.js";
export { GOLDEN_BASE_IMAGE, goldenBaseDigestFrom, resolveGoldenBaseDigest } from "./goldenBase.js";
export { resolveProjectEnv, type ProjectEnvBinding, type ResolveProjectEnvInput } from "./resolveProjectEnv.js";
export { toolchainCoveredByGoldenBaseline, GOLDEN_BASELINE_TOOLCHAIN } from "./baselineCoverage.js";
export {
  createEnvironment,
  type CreateEnvironmentDeps,
  type CreateEnvironmentRequest,
  type CreateEnvironmentResult,
  EnvironmentValidationFailedError,
  EnvBuildFailedError,
  type EnvImageBuildDriver,
  buildLiveEnvBuildDriver,
  type LiveEnvBuildDriverDeps,
  runEnvValidationHarness,
  environmentValidates,
  resolveProjectEnvWithCreation,
  type ResolveWithCreationInput,
  type EnvCreationDeps,
  NixTierNotBuiltError,
} from "./creation/index.js";

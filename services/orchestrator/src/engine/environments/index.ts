// Single import surface for environment management (environment-management.md §3
// Layer 4 + §5 + §6 + §7 P3). The env-layer counterpart of `engine/templates`:
//
//   - manifest.ts — the CONTRACT shapes for the registry jsonb columns
//     (capabilities/channel/provenance/validationProof), re-parsed on read.
//   - envKey.ts — the deterministic CONTENT KEY (`env_key`) computation.
//   - goldenBase.ts — P2's golden base_digest SOURCE + the no-match fallback image.
//   - resolveProjectEnv.ts — the PER-PROJECT resolution at the image seam.
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

// Environment management (environment-management.md §4 + §7 P4) — the ENV-IMAGE
// BUILD SEAM, the env-layer counterpart of `templates/creation/buildDriver.ts`.
//
// Given a project's toolchain (its rendered `mise.toml`) + the golden BASE image +
// the env_key, build a validated-CANDIDATE env image: a BuildKit build of a generated
// context (`FROM <golden-base>`; materialize the project's `mise.toml`; run
// `mise trust && mise install` as the `tanren` user so the OFF-baseline toolchain is
// baked into the image's shared mise dir), tagged by `env_key` (`env-<env_key>`),
// pushed to the registry (local `registry:5000` in dev / GHCR in prod). The driver
// returns the pushed image ref the validation harness then allocates a runner FROM.
//
// REUSE, never reinvent: the live impl drives the SAME BuildKit recipe P2's golden
// build uses (scripts/dev/build-env-image.sh — the env counterpart of
// build-golden-image.sh, with the same docker-container builder + insecure-local-
// registry buildkitd handling + mode=max cache). The seam is INJECTED so the creation
// orchestration is unit-testable without a live `docker buildx` (a stub returns a
// synthetic image ref); the production default shells the build script.
//
// FAIL LOUD, never silent: a build that does not produce a pushed image throws
// `EnvBuildFailedError` — the creation flow aborts WITHOUT publishing (an env that
// did not build cannot be validated). Nix-tier (flake.nix present) is NOT this
// driver's concern — it routes to a SEPARATE Nix builder (P5); see the seam note in
// createEnvironment.ts.

// The result of building an env image: the pushed image ref the validation harness
// allocates a runner FROM + the toolchain it baked (echoed back for the proof).
export interface BuiltEnvImage {
  // The registry image ref the env was pushed to (`registry/env-<env_key>` /
  // `registry/<name>@sha256:…`) — the workspace seeds from THIS on publish.
  imageRef: string;
  // The env_key the image was tagged by (the content key the registry resolves on).
  envKey: string;
}

// The inputs an env build takes: the project's rendered `mise.toml`, the golden base
// to layer on, the env_key, and where to push.
export interface EnvBuildRequest {
  // The project's rendered `mise.toml` content (renderMiseToml(toolchain)) — baked
  // into the image via `mise install` so the OFF-baseline toolchain is in the shared
  // mise dir.
  miseToml: string;
  // The golden BASE image the env FROMs (`FROM <goldenBaseImage>`). Never `scratch` —
  // every JIT build layers on the current golden base (the design's "always base a
  // JIT build on the current golden base, never scratch").
  goldenBaseImage: string;
  // The content key the image is tagged + pushed by (`env-<envKey>`).
  envKey: string;
}

// THE BUILD SEAM. Build + push the env image; return its pushed ref. A throw
// (`EnvBuildFailedError`) is LOUD — the creation flow aborts WITHOUT publishing.
export interface EnvImageBuildDriver {
  build(request: EnvBuildRequest): Promise<BuiltEnvImage>;
}

// Thrown when the env image could not be built/pushed — a LOUD failure surfaced by
// the creation flow (never a quiet "publish the golden base anyway" for an off-
// baseline toolchain that demanded a real env).
export class EnvBuildFailedError extends Error {
  readonly envKey: string;
  constructor(envKey: string, cause: string) {
    super(`env-image build did not produce a pushed image for env_key ${envKey}: ${cause}`);
    this.name = "EnvBuildFailedError";
    this.envKey = envKey;
  }
}

// FlyImageBuilder — the injected BUILD SEAM a Fly release uses to turn the merged
// commit into a per-commit image, so `FlyDeployApi.triggerDeploy` can release a
// MERGE-REFLECTING image instead of a static grant image. This is the deploy-layer
// counterpart of `engine/environments/creation/envBuildDriver.ts` (`EnvImageBuildDriver`):
// a typed injected build seam whose live impl shells `docker buildx --push` against the
// Fly registry, and whose fake (under tests/conformance/fakes/) returns a synthetic ref
// so the seam is EXERCISED in CI with no docker / no network.
//
// WHY A SEAM (not a hard-coded `docker` call): the merge-reflecting Fly release needs to
// (a) resolve the merged `owner/name` repo + ref, (b) clone+build a context, (c) tag by
// the SHA, and (d) `docker push` to `registry.fly.io/<app>`. All four are I/O the unit
// suite cannot perform. Mirroring `EnvImageBuildDriver`, the build is an INJECTED port:
// the orchestration (`triggerDeploy`) calls `builder.build(...)` and releases the returned
// `imageRef`; a live impl (PR3) drives the real docker/GitHub, and a scripted fake drives
// the tests. This keeps the release flow unit-testable AND keeps the merge-reflecting
// selection (builder present → build-from-source) observable from the test seam.
//
// The `flyToken` field is the Fly API token — it doubles as the registry PASSWORD for
// `docker login registry.fly.io` (Fly's registry authenticates with the same token the
// Machines API uses). The builder receives it ONLY to perform the push; it MUST never log
// or echo it (the same "only KEYS in errors" discipline `flyDeployProvisioner` keeps). The
// merged SHA (`ref`) is the per-commit tag, so `registry.fly.io/<app>:<sha>` IS the
// merge-reflecting artifact the release then runs.
//
// FAIL LOUD, never silent: a build that does not produce a pushed image throws
// {@link FlyImageBuildFailedError} — the release aborts WITHOUT running a stale image
// (an image that did not build cannot reflect the merge). There is NO fallback to the
// static grant image when a builder is configured: that would silently undo the
// merge-reflecting guarantee the seam exists to provide.

/**
 * The inputs a Fly image build takes: the merged repo (`owner/name`), the merged git
 * `ref` (the SHA the build tags + releases by — making the image per-commit), the
 * namespaced Fly `appName` (the registry namespace, e.g. `tanren-acme-web`), and the
 * `flyToken` (the Fly API token, which doubles as the registry push password). The
 * repo + ref make the build MERGE-REFLECTING; the appName + token make the push
 * authenticate against the right Fly registry namespace.
 */
export interface FlyImageBuildRequest {
  /** The merged repo, `owner/name` (the GitHub slug the run merged onto). */
  repo: string;
  /** The merged git ref (the SHA) the build tags + pushes by — the per-commit tag. */
  ref: string;
  /** The namespaced Fly app slug (registry namespace, e.g. `tanren-acme-web`). */
  appName: string;
  /** The Fly API token (doubles as the registry push password). NEVER logged/echoed. */
  flyToken: string;
}

/**
 * The result of building a Fly image: the pushed image ref the release then runs. This
 * is the per-commit artifact (`registry.fly.io/<app>:<sha>`) that makes a Fly release
 * merge-reflecting — the same shape as `BuiltEnvImage.imageRef`.
 */
export interface BuiltDeployImage {
  /**
   * The pushed registry image ref (`registry.fly.io/<app>:<sha>`). The release runs THIS
   * image, so the live product reflects the merged commit the build was tagged by.
   */
  imageRef: string;
}

/**
 * THE BUILD SEAM. Build + push a per-commit image for a Fly app from the merged source;
 * return its pushed ref. A throw ({@link FlyImageBuildFailedError}) is LOUD — the release
 * aborts without running a stale image. Mirrors `EnvImageBuildDriver.build`: a typed
 * injected build seam, live impl shells `docker buildx --push`, fake in tests returns a
 * synthetic ref.
 */
export interface FlyImageBuilder {
  build(request: FlyImageBuildRequest): Promise<BuiltDeployImage>;
}

/**
 * Thrown when a Fly image could not be built/pushed — a LOUD failure surfaced by
 * `triggerDeploy` (never a quiet "release the static image anyway" when a builder is
 * configured). Named + typed (mirrors `EnvBuildFailedError`) so callers can distinguish
 * a build failure from a transport failure. The message carries the app name + ref
 * (diagnostic coordinates), NEVER the `flyToken`.
 */
export class FlyImageBuildFailedError extends Error {
  readonly appName: string;
  readonly ref: string;
  constructor(appName: string, ref: string, cause: string) {
    super(`fly image build for '${appName}' at ref '${ref}' did not produce a pushed image: ${cause}`);
    this.name = "FlyImageBuildFailedError";
    this.appName = appName;
    this.ref = ref;
  }
}

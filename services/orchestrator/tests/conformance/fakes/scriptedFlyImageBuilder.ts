// A scripted `FlyImageBuilder` (TEST FIXTURE — tests/ only): returns a synthetic
// `registry.fly.io/<app>:<sha>` image ref derived from the request — NO docker, NO
// network — so the conformance suite can prove `triggerDeploy` calls `builder.build`
// with the right `{ repo, ref, appName, flyToken }` and releases the BUILT ref (the
// merge-reflecting selection) before the live docker/GitHub builder exists (PR3).
//
// Mirrors the other scripted fakes under tests/conformance/fakes/: it records every
// request it saw (so a test can assert the merged SHA + the token flowed in) and lets a
// test SCRIPT a failure to drive the `FlyImageBuildFailedError`-propagates-LOUD path.

import {
  FlyImageBuildFailedError,
  type BuiltDeployImage,
  type FlyImageBuildRequest,
  type FlyImageBuilder,
} from "../../../src/engine/provisioners/flyImageBuilder.js";

export interface ScriptedFlyImageBuilder extends FlyImageBuilder {
  /**
   * Every build request the builder received, in call order — so a test can assert
   * `triggerDeploy` handed the builder the merged `{ repo, ref, appName, flyToken }`
   * (the SHA flows in as `ref`; the token as `flyToken`). The `flyToken` value is
   * captured here ONLY because this is a test fixture asserting the value reached the
   * seam — the LIVE builder never records it.
   */
  buildRequests: FlyImageBuildRequest[];
  /**
   * Script the error message the next `build` throws (as a
   * {@link FlyImageBuildFailedError}). When set, `build` throws LOUD instead of
   * returning a ref — driving the "build failure aborts the release" path.
   */
  scriptFailure(cause: string): void;
}

/**
 * Build a scripted Fly image builder: `build` derives a synthetic
 * `registry.fly.io/<appName>:<ref>` from the request (no docker, no network) and records
 * the request. A test may call `scriptFailure(cause)` to make the next `build` throw a
 * {@link FlyImageBuildFailedError} instead — proving a build failure propagates LOUD.
 */
export function scriptedFlyImageBuilder(): ScriptedFlyImageBuilder {
  const buildRequests: FlyImageBuildRequest[] = [];
  let failureCause: string | undefined;
  return {
    buildRequests,
    scriptFailure: (cause) => {
      failureCause = cause;
    },
    async build(request: FlyImageBuildRequest): Promise<BuiltDeployImage> {
      buildRequests.push(request);
      if (failureCause !== undefined) {
        const cause = failureCause;
        failureCause = undefined;
        throw new FlyImageBuildFailedError(request.appName, request.ref, cause);
      }
      return { imageRef: `registry.fly.io/${request.appName}:${request.ref}` };
    },
  };
}

import { Hono } from "hono";
import type pg from "pg";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import type { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { BaselineReproductionStage, type BaselineProbe } from "../../engine/verification/resolutionStages/index.js";
import { createInternalClaimRoutes } from "./claimJob.js";
import { createInternalFixtureLeaseRoutes } from "./fixtureLeases.js";
import { createInternalResolutionAuthorityRoutes } from "./resolutionAuthority.js";
import { createInternalResolutionJobRoutes } from "./resolutionJobs.js";
import { createInternalRunStateWriteRoutes } from "./runStateWrites.js";
import { createInternalSourceSyncRoutes } from "./sourceSync.js";

export interface InternalControlAppDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  readonly baselineProbe?: BaselineProbe;
  readonly resolutionJobStore?: ResolutionJobStore;
}

/** Assemble every mTLS-only route in one dependency-bounded control-plane app. */
export function buildInternalControlApp(deps: InternalControlAppDeps): Hono {
  const app = new Hono();
  app.route("/", createInternalClaimRoutes({ pool: deps.pool, verifier: deps.verifier }));
  app.route("/", createInternalFixtureLeaseRoutes({ pool: deps.pool, verifier: deps.verifier }));
  app.route(
    "/",
    createInternalResolutionJobRoutes({
      pool: deps.pool,
      verifier: deps.verifier,
      ...(deps.resolutionJobStore === undefined ? {} : { store: deps.resolutionJobStore }),
      baselineStage: new BaselineReproductionStage({
        pool: deps.pool,
        ...(deps.baselineProbe === undefined ? {} : { probe: deps.baselineProbe }),
      }),
    }),
  );
  app.route("/", createInternalResolutionAuthorityRoutes({ pool: deps.pool, verifier: deps.verifier }));
  app.route("/", createInternalSourceSyncRoutes({ pool: deps.pool, verifier: deps.verifier }));
  app.route("/", createInternalRunStateWriteRoutes({ pool: deps.pool, verifier: deps.verifier }));
  return app;
}

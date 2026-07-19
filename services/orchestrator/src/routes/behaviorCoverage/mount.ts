import type { Hono } from "hono";
import type pg from "pg";
import { PgCasByteStore } from "../../engine/cas/pgCasByteStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createBehaviorRoutes } from "../behaviors/index.js";
import { createBehaviorCoverageRoutes } from "./index.js";
import { createProofBundleRoutes } from "./proofBundle.js";

/**
 * Mount the runtime-verification behavior surfaces on the org-scoping pool:
 *
 * 1. the persona/behavior-revision API (`createBehaviorRoutes`), and
 * 2. the rv-4 frozen behavior-coverage selection authority
 *    (`createBehaviorCoverageRoutes`) at
 *    `/orgs/:orgId/projects/:projectId/behavior-coverage`, with the SOLE
 *    production `PgCasByteStore` (IN-2/#961) for the immutable selection facts
 *    and the default `PgEventStore` path (the factory constructs
 *    `new PgEventStore(client)` per locked transaction). No fake recorder,
 *    in-memory CAS, or test-only mount — the durable digest is the
 *    `behavior.coverage.selection_analyzed` event's `analysisId`.
 *
 * Both are the same runtime-verification surface, so they share one sub-mount.
 * Extracted from `mountFeatureRoutes` purely to keep that aggregator under the
 * `import/max-dependencies` cap: a pure move — identical routes, mounted at the
 * same paths, with the same deps and registration order. No behavior change.
 */
export function mountBehaviorSurfaces(app: Hono<ActorContextEnv>, scopedPool: pg.Pool): void {
  app.route("/orgs", createBehaviorRoutes({ pool: scopedPool }));
  app.route("/orgs", createBehaviorCoverageRoutes({ pool: scopedPool, cas: new PgCasByteStore(scopedPool) }));
  // rv-24 read-only exportable proof bundle for one acceptance run.
  app.route("/v1/orgs", createProofBundleRoutes({ pool: scopedPool }));
}

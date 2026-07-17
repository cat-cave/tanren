import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createSpecRoutes } from "../specs/index.js";
import { createIssueLoopRoutes } from "./index.js";
import { createIssueLoopCommandRoutes } from "./commands.js";
import { createProductionVerificationRoutes } from "./productionVerification.js";

/**
 * Mount the project work-intake surfaces on the org-scoping pool:
 *
 * 1. the spec CRUD API (`createSpecRoutes`), and
 * 2. the bh-1 back-half IssueLoop aggregate read surface, and
 * 3. the bh-10 production-verification retry command
 *    (`createIssueLoopRoutes`) at
 *    `/orgs/:orgId/projects/:projectId/issue-loops` (+ `/:loopId`,
 *    `/:loopId/findings`).
 *
 * These are the project's org/project-scoped work surfaces — a triaged issue loop
 * becomes a spec and later receives its production replay — so they share one sub-mount. Extracted from
 * `mountFeatureRoutes` to keep that aggregator under the
 * `import/max-dependencies` cap (same pattern as `mountBehaviorSurfaces`): the
 * spec route mounts first, exactly as before, then the new issue-loop surface —
 * identical routes, same paths, same deps, same registration order.
 */
export function mountProjectWorkSurfaces(app: Hono<ActorContextEnv>, scopedPool: pg.Pool): void {
  app.route("/orgs", createSpecRoutes({ pool: scopedPool }));
  app.route("/orgs", createIssueLoopRoutes({ pool: scopedPool }));
  app.route("/v1/orgs", createIssueLoopCommandRoutes({ pool: scopedPool }));
  // This command is deliberately on the documented public v1 path. It leases
  // and executes the registered locked production stage synchronously.
  app.route("/v1/orgs", createProductionVerificationRoutes({ pool: scopedPool }));
}

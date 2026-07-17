import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createSpecRoutes } from "../specs/index.js";
import { createIssueLoopRoutes } from "./index.js";

/**
 * Mount the project work-intake surfaces on the org-scoping pool:
 *
 * 1. the spec CRUD API (`createSpecRoutes`), and
 * 2. the bh-1 back-half IssueLoop aggregate read surface
 *    (`createIssueLoopRoutes`) at
 *    `/orgs/:orgId/projects/:projectId/issue-loops` (+ `/:loopId`,
 *    `/:loopId/findings`).
 *
 * Both are the project's org/project-scoped work surfaces — a triaged issue loop
 * becomes a spec — so they share one sub-mount. Extracted from
 * `mountFeatureRoutes` to keep that aggregator under the
 * `import/max-dependencies` cap (same pattern as `mountBehaviorSurfaces`): the
 * spec route mounts first, exactly as before, then the new issue-loop surface —
 * identical routes, same paths, same deps, same registration order.
 */
export function mountProjectWorkSurfaces(app: Hono<ActorContextEnv>, scopedPool: pg.Pool): void {
  app.route("/orgs", createSpecRoutes({ pool: scopedPool }));
  app.route("/orgs", createIssueLoopRoutes({ pool: scopedPool }));
}

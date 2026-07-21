// Keep the merge-queue route composition in one dependency: read projections plus
// the scoped QueuePolicyV1 control surface.

import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createMergeQueueEagerBeamRoutes } from "./eagerBeams.js";
import { createMergeQueueScheduleRoutes } from "./schedule.js";
import { createQueuePolicyRoutes } from "./policy.js";

export function mountMergeQueueReadRoutes(app: Hono<ActorContextEnv>, pool: pg.Pool): void {
  app.route("/orgs", createMergeQueueEagerBeamRoutes({ pool }));
  app.route("/orgs", createMergeQueueScheduleRoutes({ pool }));
  app.route("/orgs", createQueuePolicyRoutes({ pool }));
}

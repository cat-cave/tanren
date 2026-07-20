// Keep the report-route composition in one dependency while preserving two explicit,
// read-only merge-queue projections.

import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createMergeQueueEagerBeamRoutes } from "./eagerBeams.js";
import { createMergeQueueScheduleRoutes } from "./schedule.js";

export function mountMergeQueueReadRoutes(app: Hono<ActorContextEnv>, pool: pg.Pool): void {
  app.route("/orgs", createMergeQueueEagerBeamRoutes({ pool }));
  app.route("/orgs", createMergeQueueScheduleRoutes({ pool }));
}

// Thin wire for gv-4 stack-retarget + gv-17 base-shift history (keeps runs/index
// under the import-dependency cap).

import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { registerBaseShiftHistoryRoute } from "./baseShiftHistoryRoute.js";
import { registerStackRetargetRoute } from "./stackRetargetRoute.js";

export function registerRunsLineageRoutes(app: Hono<ActorContextEnv>, options: { pool: pg.Pool }): void {
  registerStackRetargetRoute(app, options);
  registerBaseShiftHistoryRoute(app, options);
}

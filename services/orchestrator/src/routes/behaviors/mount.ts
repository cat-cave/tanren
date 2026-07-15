import type pg from "pg";
import { PgEventStore } from "../../engine/eventStore.js";
import { EventAffectedSelectionFactWriter } from "../../engine/runtimeVerification/affectedSelectionFacts.js";
import { createBehaviorCoverageRoutes } from "../behaviorCoverage/index.js";

export { createBehaviorRoutes } from "./index.js";

/** Production composition for the canonical behavior-coverage HTTP surface. */
export function createLiveBehaviorCoverageRoutes(pool: pg.Pool) {
  return createBehaviorCoverageRoutes({
    pool,
    facts: new EventAffectedSelectionFactWriter(new PgEventStore(pool)),
  });
}

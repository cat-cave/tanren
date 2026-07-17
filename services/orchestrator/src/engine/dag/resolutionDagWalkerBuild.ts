import { randomUUID } from "node:crypto";
import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { ResolutionJobStore } from "../repositories/resolutionJobs.js";
import { buildResolutionAuthority } from "../governance/resolutionAuthority.js";
import { createResolutionStageRegistry } from "../verification/resolutionStages/index.js";
import { ResolutionDagWalker } from "./resolutionDagWalker.js";

/** Production composition for the durable resolution claim → stage loop. */
export function buildResolutionDagWalker(pool: pg.Pool): ResolutionDagWalker {
  const store = new ResolutionJobStore(pool);
  return new ResolutionDagWalker({
    store,
    orgIds: () => runWithSystemScope(pool, (client) => ResolutionJobStore.listDistinctRunnableOrgIds(client)),
    stages: createResolutionStageRegistry({ pool }),
    leaseOwner: `resolution-walker-${randomUUID()}`,
    authority: buildResolutionAuthority(pool),
  });
}

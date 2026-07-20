// The real scheduler assembly, kept separate so the coordinator factory remains
// a small composition root with one explicit candidate-selection binding.

import { resolveMaxBatchSize } from "./batchMaxSize.js";
import type { BuildMergeCoordinatorDeps } from "./coordinatorBuild.js";
import { IntegrationGraphScheduler } from "./integrationGraphScheduler.js";
import { PgIntegrationGraphSchedulerFacts } from "./integrationGraphSchedulerPg.js";
import { buildMultiMemberCodeHost } from "./multiMemberAuthorityPgHost.js";

/** Build the sole production IntegrationGraphScheduler; no test/default fact path exists. */
export function buildIntegrationGraphScheduler(deps: BuildMergeCoordinatorDeps): IntegrationGraphScheduler {
  return new IntegrationGraphScheduler({
    resolveMaximumBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
    facts: new PgIntegrationGraphSchedulerFacts({
      pool: deps.pool,
      buildCodeHost: (project, orgId) => buildMultiMemberCodeHost(deps, project, orgId),
    }),
  });
}

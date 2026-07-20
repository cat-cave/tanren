import { IntegrationGraphScheduler } from "../../src/engine/merge/integrationGraphScheduler.js";

/** Explicit unit-test scheduler; production construction always uses PgIntegrationGraphSchedulerFacts. */
export function makeTestIntegrationGraphScheduler(maximum = 5): IntegrationGraphScheduler {
  return new IntegrationGraphScheduler({
    resolveMaximumBatchSize: async () => maximum,
    facts: {
      resolve: async (_snapshot, candidates) => ({
        kind: "resolved" as const,
        baseSha: "a".repeat(40),
        members: candidates.map((entry) => ({
          queueId: entry.queueId,
          runId: entry.runId,
          specId: entry.specId,
          branch: `branch-${entry.runId}`,
          baseSha: "a".repeat(40),
          headSha: entry.orderKey.toString(16).padStart(40, "b"),
          diff: `diff --git a/work/${entry.specId}.ts b/work/${entry.specId}.ts\n+++ b/work/${entry.specId}.ts`,
          reusableProofNode: false,
        })),
        activeLeases: [],
      }),
    },
  });
}

/**
 * Failure-aware project page reads for chat-primary + DAG-primary modes.
 * Uses OrchestratorClient Maybe variants so unavailable is distinct from empty.
 */

import type { OrchestratorClient } from "../../api/orchestrator.js";
import type { InsightSummary } from "../../api/types.js";
import { buildProjectViewModel, sumRunCosts } from "../../components/project/projectViewData.js";
import type { ProjectViewModel } from "../../components/project/projectViewData.js";

export async function loadProjectPageData(
  client: OrchestratorClient,
  orgId: string,
  projectId: string,
  projectName: string,
): Promise<{ model: ProjectViewModel; insights: InsightSummary[] }> {
  const [runs, insights, milestones, feed] = await Promise.all([
    client.listRunsMaybe(orgId, projectId),
    client.listInsightsMaybe(orgId, projectId),
    client.listMilestonesMaybe(orgId, projectId),
    client.listFeedMaybe(orgId, projectId),
  ]);
  return {
    model: buildProjectViewModel({
      projectId,
      projectName,
      runs,
      insights,
      milestones,
      feed,
      narration: undefined,
      weekSpendUsd: runs === undefined ? undefined : sumRunCosts(runs),
    }),
    // Empty when unavailable — subopt callouts omit rather than fabricate.
    insights: insights ?? [],
  };
}

export async function loadSpecListData(client: OrchestratorClient, orgId: string, projectId: string) {
  const [specs, runs] = await Promise.all([
    client.listSpecsMaybe(orgId, projectId),
    client.listRunsMaybe(orgId, projectId),
  ]);
  const runBySpec: Record<string, string | undefined> = {};
  for (const run of runs ?? []) {
    if (runBySpec[run.specId] === undefined) runBySpec[run.specId] = run.runId;
  }
  return {
    specs: specs ?? [],
    specsUnavailable: specs === undefined,
    runsUnavailable: runs === undefined,
    runBySpec,
  };
}

export async function loadSpecCreateData(client: OrchestratorClient, orgId: string, projectId: string) {
  const [milestones, behaviors, specs] = await Promise.all([
    client.listMilestonesMaybe(orgId, projectId),
    client.listAllBehaviorsMaybe(orgId, projectId),
    client.listSpecsMaybe(orgId, projectId),
  ]);
  return {
    milestones: milestones ?? [],
    milestonesUnavailable: milestones === undefined,
    behaviors: behaviors ?? [],
    behaviorsUnavailable: behaviors === undefined,
    specs: specs ?? [],
    specsUnavailable: specs === undefined,
  };
}

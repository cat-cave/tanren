/**
 * Merge-queue route. Mounts ONE GET through the shell:
 *   GET /merge-queue?windowDays=30 — org-level native-delivery metrics panel.
 *
 * Two aggregate views (rebase-vs-rebuild + native queue stats) are computed
 * orchestrator-side from the engine's own events (`GET .../integration-metrics`,
 * `GET .../queue-stats`); this route resolves the active project, fetches both
 * payloads, and renders them through the shell. Reported, not targeted — no new
 * collection, no engine change.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts. Reuses
 * loadShellContext + renderShell; never touches the chrome.
 */

import type { Context, Hono } from "hono";
import { MergeQueueClient } from "../../api/mergeQueueClient.js";
import type { IntegrationMetrics, QueueStats } from "../../api/mergeQueue.js";
import {
  MergeQueueAuthorityEvaluationsClient,
  type MergeQueueAuthorityEvaluationsListResponse,
} from "../../api/mergeQueueAuthorityEvaluations.js";
import {
  MergeQueueAuthoritySignalsClient,
  type MergeQueueAuthoritySignalsListResponse,
} from "../../api/mergeQueueAuthoritySignals.js";
import {
  MergeQueueRepairRoutesClient,
  type MergeQueueRepairRoutesListResponse,
} from "../../api/mergeQueueRepairRoutes.js";
import { MergeQueueTrainClient, type MergeTrainListResponse } from "../../api/mergeQueueTrain.js";
import {
  MergeQueueEvidenceContractsClient,
  type MergeQueueEvidenceContractResponse,
} from "../../api/mergeQueueEvidenceContracts.js";
import { MergeQueueEagerBeamsClient, type MergeQueueEagerBeamsResponse } from "../../api/mergeQueueEagerBeams.js";
import { MergeQueueScheduleClient, type MergeQueueScheduleResponse } from "../../api/mergeQueueSchedule.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { MergeQueueBody } from "../../components/mergeQueue/MergeQueueBody.js";

const VALID_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_WINDOW_DAYS = 30;

/** Parse the `windowDays` pill, falling back to 30d for anything unexpected. */
function parseWindowDays(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return VALID_WINDOWS.has(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

export function mountMergeQueueScreen(app: Hono, deps: ShellDeps): void {
  app.get("/merge-queue", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "mergeQueue" });
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    const project = ctx.projects[0];

    let metrics: IntegrationMetrics | undefined;
    let stats: QueueStats | undefined;
    let authoritySignals: MergeQueueAuthoritySignalsListResponse | undefined;
    let authorityEvaluations: MergeQueueAuthorityEvaluationsListResponse | undefined;
    let repairRoutes: MergeQueueRepairRoutesListResponse | undefined;
    let mergeTrain: MergeTrainListResponse | undefined;
    let evidenceContract: MergeQueueEvidenceContractResponse | undefined;
    let eagerBeams: MergeQueueEagerBeamsResponse | undefined;
    let semanticSchedule: MergeQueueScheduleResponse | undefined;
    if (ctx.org !== undefined && project !== undefined) {
      const client = new MergeQueueClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const signalClient = new MergeQueueAuthoritySignalsClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const evaluationClient = new MergeQueueAuthorityEvaluationsClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const repairClient = new MergeQueueRepairRoutesClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const trainClient = new MergeQueueTrainClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const eagerBeamClient = new MergeQueueEagerBeamsClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      // mq-8 beams + mq-9 semantic schedule join the parallel read fan-out. mq-12's evidence
      // contract is a DEPENDENT read (it needs the merge-train's node id), so it stays a
      // follow-up await after the fan-out resolves.
      const scheduleClient = new MergeQueueScheduleClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      [metrics, stats, authoritySignals, authorityEvaluations, repairRoutes, mergeTrain, eagerBeams, semanticSchedule] =
        await Promise.all([
          client.getIntegrationMetrics(ctx.org.id, project.projectId, windowDays),
          client.getQueueStats(ctx.org.id, project.projectId, windowDays),
          signalClient.listAuthoritySignals(ctx.org.id, project.projectId),
          evaluationClient.listAuthorityEvaluations(ctx.org.id, project.projectId),
          repairClient.listRepairRoutes(ctx.org.id, project.projectId),
          trainClient.listTrain(ctx.org.id, project.projectId),
          eagerBeamClient.listEagerBeams(ctx.org.id, project.projectId),
          scheduleClient.getSchedule(ctx.org.id, project.projectId),
        ]);
      const nodeId = mergeTrain?.artifacts?.[0]?.integrationNodeId;
      if (nodeId !== undefined) {
        const evidenceClient = new MergeQueueEvidenceContractsClient({
          orchestratorUrl: deps.orchestratorUrl,
          cookieHeader: c.req.header("cookie"),
        });
        evidenceContract = await evidenceClient.getEvidenceContract(ctx.org.id, project.projectId, nodeId);
      }
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · merge queue" },
      <MergeQueueBody
        metrics={metrics}
        stats={stats}
        authoritySignals={authoritySignals}
        authorityEvaluations={authorityEvaluations}
        repairRoutes={repairRoutes}
        mergeTrain={mergeTrain}
        evidenceContract={evidenceContract}
        eagerBeams={eagerBeams}
        semanticSchedule={semanticSchedule}
        orgId={ctx.org?.id ?? ""}
        projectId={project?.projectId ?? ""}
        windowDays={windowDays}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
      />,
    );
  });
}

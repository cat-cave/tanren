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

import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { clientDepsFor } from "../../api/clientDeps.js";
import {
  MergeQueueClient,
  type IntegrationMetrics,
  type QueueStats,
  MergeQueueAuthorityEvaluationsClient,
  type MergeQueueAuthorityEvaluationsListResponse,
  MergeQueueAuthoritySignalsClient,
  type MergeQueueAuthoritySignalsListResponse,
  MergeQueueRepairRoutesClient,
  type MergeQueueRepairRoutesListResponse,
  MergeQueueTrainClient,
  type MergeTrainListResponse,
  MergeQueueGroupDeliveryClient,
  type LandGroupDeliveryListResponse,
  MergeQueueEvidenceContractsClient,
  type MergeQueueEvidenceContractResponse,
  MergeQueueEagerBeamsClient,
  type MergeQueueEagerBeamsResponse,
  MergeQueueScheduleClient,
  type MergeQueueScheduleResponse,
  MergeQueuePolicyClient,
  type MergeQueuePolicyResponse,
  type MergeQueueWindowsResponse,
} from "../../api/mergeQueueScreen.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { MergeQueueBody } from "../../components/mergeQueue/MergeQueueBody.js";
import { formField } from "../formField.js";

const VALID_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_WINDOW_DAYS = 30;
const QUEUE_COMMANDS = new Set(["freeze", "unfreeze", "pause", "resume", "drain"]);

/** Parse the `windowDays` pill, falling back to 30d for anything unexpected. */
function parseWindowDays(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return VALID_WINDOWS.has(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

function commandNotice(raw: string | undefined): string | undefined {
  if (raw === "applied") return "Queue command recorded; it remains subject to the final claim-time policy fence.";
  if (raw === "rejected") return "Queue command was rejected by the orchestrator; no success is implied.";
  if (raw === "invalid") return "Invalid command input was rejected before an orchestrator write.";
  if (raw === "no_project") return "The requested project was not visible; no command was sent.";
  return undefined;
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
    let groupDelivery: LandGroupDeliveryListResponse | undefined;
    let evidenceContract: MergeQueueEvidenceContractResponse | undefined;
    let eagerBeams: MergeQueueEagerBeamsResponse | undefined;
    let semanticSchedule: MergeQueueScheduleResponse | undefined;
    let queuePolicy: MergeQueuePolicyResponse | undefined;
    let queueWindows: MergeQueueWindowsResponse | undefined;
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
      // mq-8 eager beams + mq-9 semantic schedule + mq-13 group deliveries all join the single
      // parallel read fan-out. mq-12's evidence contract is a DEPENDENT read (it needs the
      // merge-train's node id), so it stays a follow-up await after the fan-out resolves.
      const scheduleClient = new MergeQueueScheduleClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const groupDeliveryClient = new MergeQueueGroupDeliveryClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const policyClient = new MergeQueuePolicyClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      [
        metrics,
        stats,
        authoritySignals,
        authorityEvaluations,
        repairRoutes,
        mergeTrain,
        eagerBeams,
        semanticSchedule,
        groupDelivery,
        queuePolicy,
        queueWindows,
      ] = await Promise.all([
        client.getIntegrationMetrics(ctx.org.id, project.projectId, windowDays),
        client.getQueueStats(ctx.org.id, project.projectId, windowDays),
        signalClient.listAuthoritySignals(ctx.org.id, project.projectId),
        evaluationClient.listAuthorityEvaluations(ctx.org.id, project.projectId),
        repairClient.listRepairRoutes(ctx.org.id, project.projectId),
        trainClient.listTrain(ctx.org.id, project.projectId),
        eagerBeamClient.listEagerBeams(ctx.org.id, project.projectId),
        scheduleClient.getSchedule(ctx.org.id, project.projectId),
        groupDeliveryClient.listDeliveries(ctx.org.id, project.projectId),
        policyClient.getPolicy(ctx.org.id, project.projectId),
        policyClient.listWindows(ctx.org.id, project.projectId),
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
        groupDelivery={groupDelivery}
        evidenceContract={evidenceContract}
        eagerBeams={eagerBeams}
        semanticSchedule={semanticSchedule}
        queuePolicy={queuePolicy}
        queueWindows={queueWindows}
        queuePolicyNotice={commandNotice(c.req.query("queuePolicy"))}
        orgId={ctx.org?.id ?? ""}
        projectId={project?.projectId ?? ""}
        windowDays={windowDays}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
      />,
    );
  });

  app.post("/merge-queue/commands/:command", async (c: Context) => {
    const command = c.req.param("command");
    const form = await c.req.parseBody();
    const projectId = formField(form, "projectId").trim();
    const reason = formField(form, "reason").trim();
    if (
      command === undefined ||
      !QUEUE_COMMANDS.has(command) ||
      projectId === "" ||
      reason === "" ||
      reason.length > 500
    ) {
      return c.redirect("/merge-queue?queuePolicy=invalid", 303);
    }
    const ctx = await loadShellContext(c, deps, { activeNavId: "mergeQueue", projectId });
    const project = ctx.projects.find((candidate) => candidate.projectId === projectId);
    if (ctx.org === undefined || project === undefined) {
      return c.redirect("/merge-queue?queuePolicy=no_project", 303);
    }
    const client = new MergeQueuePolicyClient(await clientDepsFor(c, deps));
    const result = await client.applyCommand(ctx.org.id, projectId, {
      schemaVersion: "queue_command.v1",
      command,
      idempotencyKey: `dashboard:${randomUUID()}`,
      scope: { projectId },
      reason,
    });
    return c.redirect(`/merge-queue?queuePolicy=${result.ok ? "applied" : "rejected"}`, 303);
  });
}

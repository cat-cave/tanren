/**
 * Org Overview command deck. Mounts ONE GET through the shell:
 *   GET /overview — projects grid, portfolio budget, forge-org card, activity.
 *
 * Reuses shell project list, BudgetClient (org default + per-project), and the
 * project feed read surface (`GET .../projects/:id/feed`). Forge-org has no
 * ready API — the body renders an honest unavailable card. Mounted via ONE
 * append to SCREEN_MOUNTS; reuses loadShellContext + renderShell.
 */

import type { Context, Hono } from "hono";
import type { ProjectBudgetView } from "../../api/budget.js";
import { BudgetClient } from "../../api/budgetClient.js";
import { OrchestratorHttpClient } from "../../api/httpClient.js";
import {
  fetchIntegrationCatalog,
  validateIntegrationRequirement,
  type FetchCatalogResult,
  type FetchValidateResult,
} from "../../api/integrationContracts.js";
import type { ProjectFeedItem, ProjectSummary } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { IntegrationContractPanelProps } from "../../components/integrations/IntegrationContractPanel.js";
import { aggregateOrgMtd, type OrgMtdBudget } from "../../components/overview/format.js";
import { OverviewBody, type OverviewActivityItem } from "../../components/overview/OverviewBody.js";

/** Golden samples mirrored from orchestrator in-2 contract vectors (UI live exercise). */
const SAMPLE_PRODUCT = {
  version: 1 as const,
  capability: "messaging.send",
  plane: "product" as const,
  direction: "outbound" as const,
  providerPolicy: { preferred: ["slack"], allowed: ["slack"], forbidden: ["twilio"] },
  environments: ["test", "production"] as const,
  trigger: {
    version: 1 as const,
    kind: "threshold" as const,
    description: "when any short link crosses 100 clicks",
    given: "a short link exists with 99 clicks",
    when: "the 100th click is recorded",
    behaviorKey: "celebrate_100_clicks",
  },
  expectedEffect: {
    version: 1 as const,
    plane: "product" as const,
    provider: "slack",
    observation: "message_in_channel",
    correlationFields: ["behaviorKey", "correlationId", "bindingGeneration", "deploySha"],
    independent: true as const,
  },
  requiredOperations: ["chat.postMessage", "conversations.history"],
  requiredScopes: ["chat:write", "channels:history"],
  bindingOutputs: [
    {
      version: 1 as const,
      kind: "product.messaging.relay_binding_id" as const,
      logicalKey: "SLACK_PRODUCT_BINDING_ID",
      classification: "handle" as const,
      required: true,
      description: "Managed relay binding; token never reaches product code",
    },
    {
      version: 1 as const,
      kind: "product.messaging.channel_id" as const,
      logicalKey: "SLACK_PRODUCT_CHANNEL_ID",
      classification: "plain" as const,
      required: true,
    },
  ],
  validation: {
    version: 1 as const,
    preMerge: {
      contractTests: true,
      recordingFake: true,
      negativeControls: true,
      liveProviderInMergeGate: false as const,
    },
    postDeploy: { liveStimulus: true, independentObservation: true },
    negativeControls: ["99_clicks_no_message", "retry_no_duplicate", "cross_org_denied"],
  },
  criticality: "release_required" as const,
};

const SAMPLE_CONTROL = {
  version: 1 as const,
  capability: "control.notify",
  plane: "control" as const,
  direction: "outbound" as const,
  providerPolicy: { preferred: ["slack"], allowed: ["slack"] },
  environments: ["production"] as const,
  trigger: {
    version: 1 as const,
    kind: "event" as const,
    description: "Tanren operator notification on run failure",
    when: "run.status becomes failed",
  },
  expectedEffect: {
    version: 1 as const,
    plane: "control" as const,
    provider: "slack",
    observation: "operator_channel_message",
    correlationFields: ["runId", "orgId"],
    independent: true as const,
  },
  requiredOperations: ["chat.postMessage"],
  requiredScopes: ["chat:write"],
  bindingOutputs: [
    {
      version: 1 as const,
      kind: "control.notify.bot_token_ref" as const,
      logicalKey: "TANREN_SLACK_BOT_TOKEN_REF",
      classification: "secret_ref" as const,
      required: true,
    },
    {
      version: 1 as const,
      kind: "control.notify.channel_id" as const,
      logicalKey: "TANREN_SLACK_CHANNEL_ID",
      classification: "plain" as const,
      required: true,
    },
  ],
  validation: {
    version: 1 as const,
    preMerge: {
      contractTests: true,
      recordingFake: true,
      negativeControls: true,
      liveProviderInMergeGate: false as const,
    },
    postDeploy: { liveStimulus: false, independentObservation: false },
    negativeControls: ["revoked_token_fails_closed"],
  },
  criticality: "best_effort" as const,
};

const SAMPLE_CROSS_PLANE = {
  ...SAMPLE_PRODUCT,
  bindingOutputs: [
    {
      version: 1 as const,
      kind: "control.notify.bot_token_ref" as const,
      logicalKey: "SLACK_BOT_TOKEN",
      classification: "secret_ref" as const,
      required: true,
    },
  ],
};

async function loadIntegrationContracts(
  deps: ShellDeps,
  c: Context,
  orgId: string,
): Promise<IntegrationContractPanelProps> {
  const headers: Record<string, string> = {};
  const cookie = c.req.header("cookie");
  if (cookie !== undefined && cookie !== "") {
    headers["cookie"] = cookie;
  }
  const fetchDeps = {
    orchestratorUrl: deps.orchestratorUrl,
    headers,
    fetchImpl: fetch,
  };
  const [catalog, productSample, controlSample, crossPlaneSample] = await Promise.all([
    fetchIntegrationCatalog(fetchDeps, orgId),
    // R3: overview samples are read-only live exercises — they must NOT mutate
    // cas_artifacts on every page load. persist:false runs full parse + digests
    // without a CAS write; the panel reports the honest checked-not-persisted state.
    validateIntegrationRequirement(fetchDeps, orgId, SAMPLE_PRODUCT, { persist: false }),
    validateIntegrationRequirement(fetchDeps, orgId, SAMPLE_CONTROL, { persist: false }),
    validateIntegrationRequirement(fetchDeps, orgId, SAMPLE_CROSS_PLANE, { persist: false }),
  ]);
  return { catalog, productSample, controlSample, crossPlaneSample };
}

function unavailableContracts(): IntegrationContractPanelProps {
  const unavailable: FetchCatalogResult = { kind: "unavailable", reason: "upstream" };
  const vUnavailable: FetchValidateResult = { kind: "unavailable", reason: "upstream" };
  return {
    catalog: unavailable,
    productSample: vUnavailable,
    controlSample: vUnavailable,
    crossPlaneSample: vUnavailable,
  };
}

const ACTIVITY_LIMIT = 20;

/**
 * Failure-aware overview reads. Shell `listProjects` / product `listFeed`
 * collapse failure to `[]`; overview must distinguish empty vs unavailable.
 */
class OverviewReadClient extends OrchestratorHttpClient {
  async listProjectsMaybe(orgId: string): Promise<ProjectSummary[] | undefined> {
    const json = await this.getJson<{ projects?: ProjectSummary[] }>(`/orgs/${encodeURIComponent(orgId)}/projects`);
    if (json === undefined || !Array.isArray(json.projects)) return undefined;
    return json.projects;
  }

  async listFeedMaybe(orgId: string, projectId: string): Promise<ProjectFeedItem[] | undefined> {
    const json = await this.getJson<{ items?: ProjectFeedItem[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/feed`,
    );
    if (json === undefined || !Array.isArray(json.items)) return undefined;
    return json.items;
  }
}

function budgetClientFor(c: Context, deps: ShellDeps): BudgetClient {
  return new BudgetClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function readClientFor(c: Context, deps: ShellDeps): OverviewReadClient {
  return new OverviewReadClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function loadActivity(
  client: OverviewReadClient,
  orgId: string,
  projects: ProjectSummary[],
): Promise<{
  activity: OverviewActivityItem[];
  activityUnavailable: boolean;
  activityFailedReads: number;
}> {
  if (projects.length === 0) {
    return { activity: [], activityUnavailable: false, activityFailedReads: 0 };
  }

  const results = await Promise.all(
    projects.map(async (project) => {
      const items = await client.listFeedMaybe(orgId, project.projectId);
      return { project, items };
    }),
  );

  const okResults = results.filter((r) => r.items !== undefined);
  const activityFailedReads = results.length - okResults.length;
  if (okResults.length === 0) {
    return { activity: [], activityUnavailable: true, activityFailedReads };
  }

  const activity: OverviewActivityItem[] = [];
  for (const { project, items } of okResults) {
    for (const item of items ?? []) {
      activity.push({
        ts: item.ts,
        projectId: project.projectId,
        projectName: project.name,
        runId: item.runId,
        eventType: item.eventType,
        specId: item.specId,
      });
    }
  }

  activity.sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  return {
    activity: activity.slice(0, ACTIVITY_LIMIT),
    activityUnavailable: false,
    activityFailedReads,
  };
}

async function loadMtd(
  budget: BudgetClient,
  orgId: string,
  projects: ProjectSummary[],
): Promise<{ mtd: OrgMtdBudget | undefined; orgBudgetUnavailable: boolean }> {
  const orgBudget = await budget.getOrgBudget(orgId);
  const orgBudgetUnavailable = orgBudget === undefined;

  const projectBudgets: Array<ProjectBudgetView | undefined> = await Promise.all(
    projects.map((p) => budget.getProjectBudget(orgId, p.projectId)),
  );

  const mtd = aggregateOrgMtd(orgBudget, projectBudgets);

  // Full unavailable only when org failed AND every project budget failed.
  if (orgBudgetUnavailable && projects.length > 0 && mtd.failedReads === projects.length) {
    return { mtd: undefined, orgBudgetUnavailable };
  }
  if (orgBudgetUnavailable && projects.length === 0) {
    return { mtd: undefined, orgBudgetUnavailable };
  }

  return { mtd, orgBudgetUnavailable };
}

export function mountOverviewScreen(app: Hono, deps: ShellDeps): void {
  app.get("/overview", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "overview" });
    const orgLogin = ctx.org?.login ?? ctx.org?.displayName ?? "";

    let mtd: OrgMtdBudget | undefined;
    let orgBudgetUnavailable = false;
    let activity: OverviewActivityItem[] = [];
    let activityUnavailable = false;
    let activityFailedReads = 0;
    let projects: ProjectSummary[] = [];
    let projectsUnavailable = false;
    let integrationContracts: IntegrationContractPanelProps | undefined;

    const org = ctx.org;
    if (org) {
      const budget = budgetClientFor(c, deps);
      const reads = readClientFor(c, deps);
      // Failure-aware project list (shell listProjects collapses failure to []).
      const maybeProjects = await reads.listProjectsMaybe(org.id);
      if (maybeProjects === undefined) {
        projectsUnavailable = true;
        projects = [];
      } else {
        projects = maybeProjects;
      }

      const [budgetResult, activityResult, contracts] = await Promise.all([
        loadMtd(budget, org.id, projects),
        // When projects are unavailable, do not claim an empty activity feed.
        projectsUnavailable
          ? Promise.resolve({
              activity: [] as OverviewActivityItem[],
              activityUnavailable: true,
              activityFailedReads: 0,
            })
          : loadActivity(reads, org.id, projects),
        // in-2: live catalog + plane-separation samples against orchestrator.
        loadIntegrationContracts(deps, c, org.id),
      ]);
      mtd = budgetResult.mtd;
      orgBudgetUnavailable = budgetResult.orgBudgetUnavailable;
      activity = activityResult.activity;
      activityUnavailable = activityResult.activityUnavailable;
      activityFailedReads = activityResult.activityFailedReads;
      integrationContracts = contracts;
    } else {
      orgBudgetUnavailable = true;
      activityUnavailable = true;
      projectsUnavailable = true;
      integrationContracts = unavailableContracts();
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · overview" },
      <OverviewBody
        orgLogin={orgLogin}
        projects={projects}
        projectsUnavailable={projectsUnavailable}
        mtd={mtd}
        orgBudgetUnavailable={orgBudgetUnavailable}
        activity={activity}
        activityUnavailable={activityUnavailable}
        activityFailedReads={activityFailedReads}
        integrationContracts={integrationContracts}
      />,
    );
  });
}

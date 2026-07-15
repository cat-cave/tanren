import type { OrgGrant } from "../../engine/contracts/integrationProvisioner.js";
import type { NotLinkedResult, SelectionRequiredResult } from "../../engine/integrations/provisioningEngine.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import { OrganizationsStore } from "../../engine/repositories/organizations.js";

type DeployProviderKind = "deploy.vercel" | "deploy.flyio";

interface GreenfieldGrantInput {
  client: IntegrationQueryClient;
  orgId: string;
  providerKind: DeployProviderKind;
  actorId: string;
  connectionId?: string;
  grantId?: string;
}

function notLinked(orgId: string, providerKind: DeployProviderKind): NotLinkedResult {
  return {
    status: "not_linked",
    capability: "deploy",
    providerKind,
    message:
      `link ${providerKind} at the org level first — greenfield/apex creation requires a real ` +
      `deploy target, but org ${orgId} has no active ${providerKind} control grant.`,
    linkAffordance: { kind: "org_integration_link", providerKind, orgId },
  };
}

function selectionRequired(
  providerKind: DeployProviderKind,
  reason: SelectionRequiredResult["reason"],
  candidates: Awaited<ReturnType<typeof IntegrationConnectionsStore.listControlGrants>>,
): SelectionRequiredResult {
  return {
    status: "selection_required",
    capability: "deploy",
    providerKind,
    reason,
    message: `choose an exact active ${providerKind} account before greenfield provider operations run.`,
    candidates: candidates.map((candidate) => ({
      connectionId: candidate.connectionId,
      grantId: candidate.grantId,
      providerKind: candidate.providerKind,
      upstreamAccountId: candidate.upstreamAccountId,
      health: candidate.health,
      authGeneration: candidate.authGeneration,
      grantGeneration: candidate.grantGeneration,
    })),
  };
}

export async function resolveGreenfieldDeployGrant(
  input: GreenfieldGrantInput,
): Promise<OrgGrant | NotLinkedResult | SelectionRequiredResult> {
  const actor = { kind: "operator" as const, id: input.actorId };
  const candidates = (await IntegrationConnectionsStore.listControlGrants(input.client, input.orgId, actor)).filter(
    (candidate) => candidate.providerKind === input.providerKind,
  );
  if (candidates.length === 0) return notLinked(input.orgId, input.providerKind);
  const hasExactChoice = input.connectionId !== undefined && input.grantId !== undefined;
  if (!hasExactChoice && candidates.length > 1) {
    return selectionRequired(input.providerKind, "multiple_eligible", candidates);
  }
  if ((input.connectionId === undefined) !== (input.grantId === undefined)) {
    return selectionRequired(input.providerKind, "selection_missing", candidates);
  }
  const candidate = hasExactChoice
    ? candidates.find((item) => item.connectionId === input.connectionId && item.grantId === input.grantId)
    : candidates[0];
  if (candidate === undefined) {
    return selectionRequired(input.providerKind, "selected_grant_unavailable", candidates);
  }
  const grant = await IntegrationConnectionsStore.getControlGrantByIds(
    input.client,
    input.orgId,
    input.providerKind,
    candidate.connectionId,
    candidate.grantId,
    actor,
  );
  return grant ?? selectionRequired(input.providerKind, "selected_grant_unavailable", candidates);
}

export async function preflightGreenfieldDeploy(
  input: GreenfieldGrantInput,
): Promise<NotLinkedResult | SelectionRequiredResult | undefined> {
  const resolved = await resolveGreenfieldDeployGrant(input);
  return "status" in resolved ? resolved : undefined;
}

export function greenfieldOrgLogin(client: IntegrationQueryClient, orgId: string, actorId: string): Promise<string> {
  return OrganizationsStore.getLogin(client, orgId, { kind: "operator", id: actorId });
}

export async function persistGreenfieldDeploySelection(
  client: IntegrationQueryClient,
  input: {
    orgId: string;
    projectId: string;
    providerKind: string;
    connectionId: string;
    grantId: string;
  },
  actorId: string,
): Promise<void> {
  const selected = await IntegrationConnectionsStore.selectControlGrant(client, input, {
    kind: "operator",
    id: actorId,
  });
  if (selected === undefined) {
    throw new Error("greenfield deploy account became unavailable before project selection persisted");
  }
}

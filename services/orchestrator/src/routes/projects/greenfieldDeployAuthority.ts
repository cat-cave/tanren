import type { OrgGrant } from "../../engine/contracts/integrationProvisioner.js";
import type {
  IneligibleResult,
  NotLinkedResult,
  SelectionRequiredResult,
} from "../../engine/integrations/provisioningEngine.js";
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

function asCandidates(
  candidates: Awaited<ReturnType<typeof IntegrationConnectionsStore.listExactControlGrants>>,
): SelectionRequiredResult["candidates"] {
  return candidates.map((candidate) => ({
    connectionId: candidate.connectionId,
    grantId: candidate.grantId,
    providerKind: candidate.providerKind,
    providerPrincipalId: candidate.providerPrincipalId,
    displayName: candidate.displayName,
    health: candidate.health,
    authGeneration: candidate.authGeneration,
    grantGeneration: candidate.grantGeneration,
    ineligibilityReasons: [],
  }));
}

function selectionRequired(
  providerKind: DeployProviderKind,
  reason: SelectionRequiredResult["reason"],
  candidates: Awaited<ReturnType<typeof IntegrationConnectionsStore.listExactControlGrants>>,
): SelectionRequiredResult {
  return {
    status: "selection_required",
    capability: "deploy",
    providerKind,
    reason,
    message: `choose an exact active ${providerKind} account before greenfield provider operations run.`,
    candidates: asCandidates(candidates),
  };
}

export async function resolveGreenfieldDeployGrant(
  input: GreenfieldGrantInput,
): Promise<OrgGrant | NotLinkedResult | SelectionRequiredResult | IneligibleResult> {
  const candidates = await IntegrationConnectionsStore.listExactControlGrants(
    input.client,
    input.orgId,
    input.providerKind,
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
  const grant = await IntegrationConnectionsStore.resolveExactControlGrant(input.client, {
    orgId: input.orgId,
    providerKind: input.providerKind,
    connectionId: candidate.connectionId,
    grantId: candidate.grantId,
    capability: "deploy",
    operation: "provision",
  });
  if (grant === undefined) {
    return {
      status: "ineligible",
      capability: "deploy",
      providerKind: input.providerKind,
      reasons: ["grant_not_eligible"],
      message: `deploy grant is not eligible for provision`,
    };
  }
  return grant;
}

export async function preflightGreenfieldDeploy(
  input: GreenfieldGrantInput,
): Promise<NotLinkedResult | SelectionRequiredResult | IneligibleResult | undefined> {
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
    authGeneration: number;
    grantGeneration: number;
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

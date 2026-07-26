import type { OrgGrant } from "../../engine/contracts/integrationProvisioner.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../engine/contracts/integrationAuthority.js";
import { PgIntegrationAuthority } from "../../engine/integrations/integrationAuthorityImpl.js";
import type {
  IneligibleResult,
  NotLinkedResult,
  SelectionRequiredResult,
} from "../../engine/integrations/provisioningEngine.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import { OrganizationsStore } from "../../engine/repositories/organizations.js";
import { systemActor } from "../../engine/state/actor.js";

type DeployProviderKind = "deploy.vercel" | "deploy.flyio";
type GreenfieldProviderKind = DeployProviderKind | "slack";
type GreenfieldCapability = "deploy" | "notify";

interface GreenfieldSelectionInput {
  client: IntegrationQueryClient;
  orgId: string;
  providerKind: GreenfieldProviderKind;
  capability?: GreenfieldCapability;
  actorId: string;
  connectionId?: string;
  grantId?: string;
}

interface GreenfieldAuthorizeInput {
  client: IntegrationQueryClient;
  orgId: string;
  projectId: string;
  providerKind: GreenfieldProviderKind;
  capability?: GreenfieldCapability;
  actorId: string;
  operation: IntegrationPrivilegedOperation;
  target: IntegrationOperationTarget;
}

function capabilityOf(input: { capability?: GreenfieldCapability }): GreenfieldCapability {
  return input.capability ?? "deploy";
}

function notLinked(
  orgId: string,
  providerKind: GreenfieldProviderKind,
  capability: GreenfieldCapability,
): NotLinkedResult {
  return {
    status: "not_linked",
    capability,
    providerKind,
    message:
      `link ${providerKind} at the org level first — greenfield creation requires a real ${capability} ` +
      `provider, but org ${orgId} has no active ${providerKind} control grant.`,
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
  providerKind: GreenfieldProviderKind,
  capability: GreenfieldCapability,
  reason: SelectionRequiredResult["reason"],
  candidates: Awaited<ReturnType<typeof IntegrationConnectionsStore.listExactControlGrants>>,
): SelectionRequiredResult {
  return {
    status: "selection_required",
    capability,
    providerKind,
    reason,
    message: `choose an exact active ${providerKind} account before greenfield provider operations run.`,
    candidates: asCandidates(candidates),
  };
}

/**
 * Inventory-only preflight. Never issues a lease and never sole-candidate guesses.
 * Missing connectionId+grantId always returns selection_required (even for one account).
 */
export async function preflightGreenfieldDeploy(
  input: GreenfieldSelectionInput,
): Promise<NotLinkedResult | SelectionRequiredResult | IneligibleResult | undefined> {
  const candidates = await IntegrationConnectionsStore.listExactControlGrants(
    input.client,
    input.orgId,
    input.providerKind,
  );
  const capability = capabilityOf(input);
  if (candidates.length === 0) return notLinked(input.orgId, input.providerKind, capability);
  if (input.connectionId === undefined || input.grantId === undefined) {
    return selectionRequired(input.providerKind, capability, "selection_missing", candidates);
  }
  const match = candidates.find((item) => item.connectionId === input.connectionId && item.grantId === input.grantId);
  if (match === undefined) {
    return selectionRequired(input.providerKind, capability, "selected_grant_unavailable", candidates);
  }
  return undefined;
}

/**
 * Resolve the selected inventory row (generations) without issuing a lease.
 * Used only to persist project selection before authorizeOperation.
 */
export async function resolveGreenfieldSelectionCandidate(input: GreenfieldSelectionInput): Promise<
  | {
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
      providerPrincipalId: string;
    }
  | NotLinkedResult
  | SelectionRequiredResult
> {
  const candidates = await IntegrationConnectionsStore.listExactControlGrants(
    input.client,
    input.orgId,
    input.providerKind,
  );
  const capability = capabilityOf(input);
  if (candidates.length === 0) return notLinked(input.orgId, input.providerKind, capability);
  if (input.connectionId === undefined || input.grantId === undefined) {
    return selectionRequired(input.providerKind, capability, "selection_missing", candidates);
  }
  const match = candidates.find((item) => item.connectionId === input.connectionId && item.grantId === input.grantId);
  if (match === undefined) {
    return selectionRequired(input.providerKind, capability, "selected_grant_unavailable", candidates);
  }
  return {
    connectionId: match.connectionId,
    grantId: match.grantId,
    authGeneration: match.authGeneration,
    grantGeneration: match.grantGeneration,
    providerPrincipalId: match.providerPrincipalId,
  };
}

/**
 * Prove every Slack notify operation the provisioner may select before the
 * derivation shell, repository, project selection, or provider is touched.
 * This is read-only and checks the current policy revision, exact scopes,
 * capability, operation, and grant generation through the authority.
 */
export async function preflightGreenfieldNotifyEligibility(
  input: GreenfieldSelectionInput,
): Promise<NotLinkedResult | SelectionRequiredResult | IneligibleResult | undefined> {
  const candidate = await resolveGreenfieldSelectionCandidate(input);
  if ("status" in candidate) return candidate;
  const authority = new PgIntegrationAuthority();
  for (const operation of ["discover", "provision", "bind"] as const) {
    const result = await authority.preflightExactOperation(input.client, {
      orgId: input.orgId,
      providerKind: input.providerKind,
      capability: capabilityOf(input),
      operation,
      target: operation === "discover" ? {} : { projectName: "greenfield-preflight", orgSlug: "greenfield-preflight" },
      connectionId: candidate.connectionId,
      grantId: candidate.grantId,
    });
    if (result.status === "eligible") continue;
    if (result.status === "not_linked") return notLinked(input.orgId, input.providerKind, capabilityOf(input));
    if (result.status === "selection_required") {
      const candidates = await IntegrationConnectionsStore.listExactControlGrants(
        input.client,
        input.orgId,
        input.providerKind,
      );
      return selectionRequired(input.providerKind, capabilityOf(input), "selected_grant_unavailable", candidates);
    }
    return {
      status: "ineligible",
      capability: capabilityOf(input),
      providerKind: input.providerKind,
      reasons: result.reasons,
      message: `${capabilityOf(input)} grant is not eligible for ${operation}: ${result.reasons.join(",")}`,
    };
  }
  return undefined;
}

/**
 * Sole production path for greenfield deploy provider I/O: authorizeOperation after
 * an exact project selection is persisted.
 */
export async function authorizeGreenfieldDeploy(
  input: GreenfieldAuthorizeInput,
): Promise<OrgGrant | NotLinkedResult | SelectionRequiredResult | IneligibleResult> {
  const authority = new PgIntegrationAuthority();
  const resolution = await authority.authorizeOperation(input.client, {
    orgId: input.orgId,
    projectId: input.projectId,
    providerKind: input.providerKind,
    capability: capabilityOf(input),
    operation: input.operation,
    target: input.target,
    actor: input.actorId === "system" ? systemActor : { kind: "operator", id: input.actorId },
  });
  const capability = capabilityOf(input);
  if (resolution.status === "not_linked") return notLinked(input.orgId, input.providerKind, capability);
  if (resolution.status === "selection_required") {
    return {
      status: "selection_required",
      capability,
      providerKind: input.providerKind,
      reason: resolution.reason,
      message: `choose an exact active ${input.providerKind} account for project ${input.projectId} before provider operations run.`,
      candidates: resolution.candidates,
    };
  }
  if (resolution.status === "ineligible") {
    return {
      status: "ineligible",
      capability,
      providerKind: input.providerKind,
      reasons: resolution.reasons,
      message: `${capability} grant is not eligible for ${input.operation}: ${resolution.reasons.join(",")}`,
    };
  }
  return IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
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

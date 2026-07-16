import type pg from "pg";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  type ProvisionedArtifact,
} from "../../engine/contracts/integrationProvisioner.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { PreparedGreenfieldDeploy } from "../../engine/forge/interview/index.js";
import {
  productionProvisionerDeps,
  type IneligibleResult,
  type NotLinkedResult,
  type ProvisionedResult,
  type SelectionRequiredResult,
} from "../../engine/integrations/provisioningEngine.js";
import {
  authorizeGreenfieldDeploy,
  greenfieldOrgLogin,
  persistGreenfieldDeploySelection,
  resolveGreenfieldSelectionCandidate,
} from "./greenfieldDeployAuthority.js";

export async function prepareGreenfieldDeploy(input: {
  pool: pg.Pool;
  secrets: SecretStore;
  orgId: string;
  /** Real project id — required so authorizeOperation can use project selection. */
  projectId: string;
  actorId: string;
  projectKey: string;
  projectName: string;
  deploy: {
    providerKind: "deploy.vercel" | "deploy.flyio";
    mode: "greenfield" | "brownfield";
    connectionId?: string;
    grantId?: string;
    chosenResourceId?: string;
    stack?: string;
    name?: string;
  };
}): Promise<NotLinkedResult | SelectionRequiredResult | IneligibleResult | PreparedGreenfieldDeploy> {
  const providerKind = input.deploy.providerKind;
  // Exact selection must land before any lease/provider I/O — never sole-candidate guess.
  const candidate = await resolveGreenfieldSelectionCandidate({
    client: input.pool,
    orgId: input.orgId,
    providerKind,
    actorId: input.actorId,
    ...(input.deploy.connectionId === undefined ? {} : { connectionId: input.deploy.connectionId }),
    ...(input.deploy.grantId === undefined ? {} : { grantId: input.deploy.grantId }),
  });
  if ("status" in candidate) return candidate;
  await persistGreenfieldDeploySelection(
    input.pool,
    {
      orgId: input.orgId,
      projectId: input.projectId,
      providerKind,
      connectionId: candidate.connectionId,
      grantId: candidate.grantId,
      authGeneration: candidate.authGeneration,
      grantGeneration: candidate.grantGeneration,
    },
    input.actorId,
  );
  // Sole lease authority after selection.
  const resolved = await authorizeGreenfieldDeploy({
    client: input.pool,
    orgId: input.orgId,
    projectId: input.projectId,
    providerKind,
    actorId: input.actorId,
    operation: "provision",
  });
  if ("status" in resolved) return resolved;
  const grant = resolved;
  const provisioner = buildIntegrationProvisioner(providerKind, productionProvisionerDeps(input.secrets));
  const orgSlug = await greenfieldOrgLogin(input.pool, input.orgId, input.actorId);
  const projectCtx = {
    projectId: input.projectId,
    orgId: input.orgId,
    orgSlug,
    ...(input.deploy.stack === undefined ? {} : { stack: input.deploy.stack }),
    name: input.deploy.name ?? input.projectName,
  };
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  try {
    if (input.deploy.chosenResourceId !== undefined && input.deploy.chosenResourceId !== "") {
      action = "bind";
      artifact = await provisioner.bind(grant, input.deploy.chosenResourceId, projectCtx);
    } else {
      const discovered = await provisioner.discover(grant);
      const smart = resolveSmartDefault(discovered, input.deploy.mode, { name: projectCtx.name });
      if (smart.action === "bind") {
        action = "bind";
        artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
      } else {
        action = "provision";
        artifact = await provisioner.provision(grant, projectCtx);
      }
    }
  } catch (error) {
    throw new Error(`deploy provision failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const projectConfig = artifact.projectConfig ?? {};
  if (
    artifact.deployRef === undefined ||
    projectConfig["deployProvider"] === undefined ||
    projectConfig["deployAppId"] === undefined
  ) {
    throw new Error(`deploy provision failed: ${providerKind} returned no deploy target config`);
  }
  const outcome: ProvisionedResult = {
    status: "provisioned",
    capability: "deploy",
    providerKind,
    action,
    mode: input.deploy.mode,
    authority: {
      connectionId: grant.connectionId,
      grantId: grant.grantId,
      providerPrincipalId: grant.providerPrincipalId,
      authGeneration: grant.authGeneration,
      grantGeneration: grant.grantGeneration,
    },
    secretRefNames: Object.values(artifact.secretRefs ?? {}),
    surfaces: {
      projectConfigKeys: Object.keys(projectConfig),
      deployRef: `${artifact.deployRef.provider}:${artifact.deployRef.appId}`,
    },
  };
  return { outcome, projectConfig };
}

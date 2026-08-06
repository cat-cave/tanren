import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  type IntegrationProvisioner,
  type OrgGrant,
  type ProvisionedArtifact,
} from "../../engine/contracts/integrationProvisioner.js";
import { projectIntegrationOperationTarget } from "../../engine/contracts/integrationAuthority.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { PreparedGreenfieldDeploy } from "../../engine/forge/interview/index.js";
import {
  productionProvisionerDeps,
  type IneligibleResult,
  type NotLinkedResult,
  type ProvisionedResult,
  type SelectionRequiredResult,
} from "../../engine/integrations/provisioningEngine.js";
import { persistProvisionedArtifact } from "../../engine/integrations/provisioningPersistence.js";
import { systemActor } from "../../engine/state/actor.js";
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
  /** Durable intent identity; provider reconciliation remains keyed by the stable app name. */
  idempotencyKey?: string;
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
  const orgSlug = await greenfieldOrgLogin(input.pool, input.orgId, input.actorId);
  const projectCtx = {
    projectId: input.projectId,
    orgId: input.orgId,
    orgSlug,
    ...(input.deploy.stack === undefined ? {} : { stack: input.deploy.stack }),
    name: input.deploy.name ?? input.projectName,
  };
  const authorize = (
    operation: "discover" | "provision" | "bind",
    target: Parameters<typeof authorizeGreenfieldDeploy>[0]["target"],
  ) =>
    authorizeGreenfieldDeploy({
      client: input.pool,
      orgId: input.orgId,
      projectId: input.projectId,
      providerKind,
      actorId: input.actorId,
      operation,
      target,
    });
  const provisioner = buildIntegrationProvisioner(providerKind, productionProvisionerDeps(input.secrets));
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  let grant: OrgGrant;
  try {
    if (input.deploy.chosenResourceId !== undefined && input.deploy.chosenResourceId !== "") {
      action = "bind";
      const resolved = await authorize(
        "bind",
        projectIntegrationOperationTarget(projectCtx, input.deploy.chosenResourceId),
      );
      if ("status" in resolved) return resolved;
      grant = resolved;
      artifact = await provisioner.bind(grant, input.deploy.chosenResourceId, projectCtx);
    } else {
      const discovery = await authorize("discover", {});
      if ("status" in discovery) return discovery;
      const discovered = await provisioner.discover(discovery, projectCtx);
      const smart = resolveSmartDefault(discovered, input.deploy.mode, { name: projectCtx.name });
      if (smart.action === "bind") {
        action = "bind";
        const resolved = await authorize("bind", projectIntegrationOperationTarget(projectCtx, smart.resourceId));
        if ("status" in resolved) return resolved;
        grant = resolved;
        artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
      } else {
        action = "provision";
        const resolved = await authorize("provision", projectIntegrationOperationTarget(projectCtx));
        if ("status" in resolved) return resolved;
        grant = resolved;
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

export interface PreparedGreenfieldNotify {
  outcome: ProvisionedResult;
  projectConfig: Record<string, unknown>;
}

/**
 * Prepare Tanren's greenfield notification capability through the same exact
 * persisted grant selection and per-effect authority path as deploy. This is a
 * separate entrypoint because the project creation lifecycle still requires a
 * deploy target; notify must never be coerced into that deploy-only contract.
 */
export async function prepareGreenfieldNotify(input: {
  pool: pg.Pool;
  secrets: SecretStore;
  orgId: string;
  projectId: string;
  actorId: string;
  projectName: string;
  /** Test seam; production omits this and uses the registered Slack provisioner. */
  buildProvisioner?: (kind: "slack") => IntegrationProvisioner;
  notify: {
    providerKind: "slack";
    mode: "greenfield" | "brownfield";
    connectionId?: string;
    grantId?: string;
    chosenResourceId?: string;
    name?: string;
  };
}): Promise<NotLinkedResult | SelectionRequiredResult | IneligibleResult | PreparedGreenfieldNotify> {
  if (input.notify.providerKind !== "slack") {
    throw new Error("greenfield notify requires providerKind 'slack'");
  }
  const candidate = await runWithOrgScope(input.pool, input.orgId, (client) =>
    resolveGreenfieldSelectionCandidate({
      client,
      orgId: input.orgId,
      providerKind: "slack",
      capability: "notify",
      actorId: input.actorId,
      ...(input.notify.connectionId === undefined ? {} : { connectionId: input.notify.connectionId }),
      ...(input.notify.grantId === undefined ? {} : { grantId: input.notify.grantId }),
    }),
  );
  if ("status" in candidate) return candidate;
  await runWithOrgScope(input.pool, input.orgId, (client) =>
    persistGreenfieldDeploySelection(
      client,
      {
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: "slack",
        connectionId: candidate.connectionId,
        grantId: candidate.grantId,
        authGeneration: candidate.authGeneration,
        grantGeneration: candidate.grantGeneration,
      },
      input.actorId,
    ),
  );
  const orgSlug = await runWithOrgScope(input.pool, input.orgId, (client) =>
    greenfieldOrgLogin(client, input.orgId, input.actorId),
  );
  const projectCtx = {
    projectId: input.projectId,
    orgId: input.orgId,
    orgSlug,
    name: input.notify.name ?? input.projectName,
  };
  const authorize = (
    operation: "discover" | "provision" | "bind",
    target: Parameters<typeof authorizeGreenfieldDeploy>[0]["target"],
  ) =>
    runWithOrgScope(input.pool, input.orgId, (client) =>
      authorizeGreenfieldDeploy({
        client,
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: "slack",
        capability: "notify",
        actorId: input.actorId,
        operation,
        target,
      }),
    );
  const provisioner =
    input.buildProvisioner === undefined
      ? buildIntegrationProvisioner("slack", productionProvisionerDeps(input.secrets))
      : input.buildProvisioner("slack");
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  let grant: OrgGrant;
  if (input.notify.chosenResourceId !== undefined && input.notify.chosenResourceId !== "") {
    action = "bind";
    const resolved = await authorize(
      "bind",
      projectIntegrationOperationTarget(projectCtx, input.notify.chosenResourceId),
    );
    if ("status" in resolved) return resolved;
    grant = resolved;
    artifact = await provisioner.bind(grant, input.notify.chosenResourceId, projectCtx);
  } else {
    const discovery = await authorize("discover", {});
    if ("status" in discovery) return discovery;
    const discovered = await provisioner.discover(discovery, projectCtx);
    const smart = resolveSmartDefault(discovered, input.notify.mode, { name: projectCtx.name });
    if (smart.action === "bind") {
      action = "bind";
      const resolved = await authorize("bind", projectIntegrationOperationTarget(projectCtx, smart.resourceId));
      if ("status" in resolved) return resolved;
      grant = resolved;
      artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
    } else {
      action = "provision";
      const resolved = await authorize("provision", projectIntegrationOperationTarget(projectCtx));
      if ("status" in resolved) return resolved;
      grant = resolved;
      artifact = await provisioner.provision(grant, projectCtx);
    }
  }
  const projectConfig = artifact.projectConfig ?? {};
  if (artifact.notificationTarget?.kind !== "slack" || typeof projectConfig["slackChannelId"] !== "string") {
    throw new Error("notify provision failed: slack returned no notification target config");
  }
  const surfaces = await runWithOrgScope(input.pool, input.orgId, (client) =>
    persistProvisionedArtifact(
      client,
      { orgId: input.orgId, projectId: input.projectId, name: projectCtx.name },
      artifact,
      input.actorId === "system" ? systemActor : { kind: "operator", id: input.actorId },
    ),
  );
  return {
    outcome: {
      status: "provisioned",
      capability: "notify",
      providerKind: "slack",
      action,
      mode: input.notify.mode,
      authority: {
        connectionId: grant.connectionId,
        grantId: grant.grantId,
        providerPrincipalId: grant.providerPrincipalId,
        authGeneration: grant.authGeneration,
        grantGeneration: grant.grantGeneration,
      },
      secretRefNames: Object.values(artifact.secretRefs ?? {}),
      surfaces,
    },
    projectConfig,
  };
}

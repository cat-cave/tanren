// Capability onboarding resolves one exact, persisted project grant; releases the
// scoped DB transaction; performs discover/provision/bind; then durably writes the
// artifact and `integration.resource.provisioned` through EventStore in a fresh
// short scope.
// Missing links and ambiguous/stale selections are structured no-effect outcomes.
//
// SECRET DISCIPLINE: this engine never reads, returns, or logs a secret value.
// Provisioners write DSNs/tokens into the SecretStore and surface only `secretRefs`
// (the manager ref NAMES); this engine persists/echoes those names alone. The
// returned `ProvisionOutcome` and the emitted event carry ref NAMES, never values.

import { z } from "zod";
import {
  projectIntegrationOperationTarget,
  type AuthorizeOperationResult,
  type IntegrationAuthority,
  type IntegrationOperationTarget,
} from "../contracts/integrationAuthority.js";
import type { IntegrationStateWriter } from "../contracts/integrationStateWriter.js";
import { IntegrationConnectionsStore } from "../repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import type { EventStore } from "../eventStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { FetchSentryProvisionHttpClient } from "../providers/sentryProvisioner.js";
import { fetchDeployTransport } from "../provisioners/deployTransport.js";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  type IntegrationProvisioner,
  type IntegrationProvisionerDeps,
  type OrgGrant,
  type ProvisionedArtifact,
  type ProvisionMode,
} from "../contracts/integrationProvisioner.js";
import type { ActorRef } from "../state/actor.js";
import { persistProvisionedArtifact, runProvisioningLifecycle } from "./provisioningPersistence.js";

/**
 * The canonical capability → provider-kind correspondence. Onboarding asks for a
 * CAPABILITY; this maps it to the provider kind whose grant we resolve and whose
 * provisioner we build. `deploy` is intentionally ambiguous (Vercel OR Fly) — the
 * caller MUST disambiguate by passing an explicit `providerKind`; the other two
 * have a single canonical provider. A new provider for a new capability slots in
 * here (and the registry's `buildIntegrationProvisioner` case) — never a refactor.
 */
const CAPABILITY_DEFAULT_PROVIDER: Readonly<Record<string, string>> = {
  errors: "sentry",
  notify: "slack",
  // `deploy` has no single default — the caller names deploy.vercel | deploy.flyio.
};

/** The deploy provider kinds a `deploy` capability may resolve to. */
const DEPLOY_PROVIDER_KINDS = new Set(["deploy.vercel", "deploy.flyio"]);

/**
 * Resolve the provider kind for a (capability, optional explicit provider). An
 * explicit `providerKind` always wins (and is validated against the capability for
 * deploy); otherwise the single canonical provider is used. Throws on an
 * unresolvable pairing — a programmer error the route surfaces as a 400, distinct
 * from the (expected) not-linked case which is a structured response.
 */
export function resolveProviderKind(capability: string, providerKind?: string): string {
  if (providerKind !== undefined && providerKind !== "") {
    if (capability === "deploy" && !DEPLOY_PROVIDER_KINDS.has(providerKind)) {
      throw new Error(`capability 'deploy' requires a deploy provider kind, got '${providerKind}'`);
    }
    return providerKind;
  }
  const fallback = CAPABILITY_DEFAULT_PROVIDER[capability];
  if (fallback === undefined) {
    throw new Error(
      `capability '${capability}' has no single default provider — pass an explicit providerKind ` +
        `(e.g. 'deploy' → 'deploy.vercel' | 'deploy.flyio')`,
    );
  }
  return fallback;
}

/**
 * Build the PRODUCTION `IntegrationProvisionerDeps` the registry needs: the real
 * fetch transports + the configured SecretStore (`TANREN_SECRET_STORE`). This is
 * the single prod wiring point — sentry gets `{ http: fetch-backed, secrets }`,
 * deploy gets `{ transport: fetch-backed, secrets }`; slack resolves its own
 * SecretStore inside `buildIntegrationProvisioner('slack')`. Mirrors how the other
 * production seams (the secret-store factory, the deploy transport) resolve deps
 * from config. The `secrets` here is the SAME configured store the rest of the app
 * uses, so DSN/token refs the provisioner writes are visible to the runtime
 * adapters that later resolve them.
 */
export function productionProvisionerDeps(secrets: SecretStore): IntegrationProvisionerDeps {
  return {
    sentry: { http: new FetchSentryProvisionHttpClient(), secrets },
    transport: fetchDeployTransport(),
    secrets,
  };
}

/** The provisioning mode + chosen-resource the onboarding flow supplies. */
export interface ProvisionRequest {
  projectId: string;
  orgId: string;
  capability: string;
  /** Disambiguates a multi-provider capability (deploy) / overrides the default. */
  providerKind?: string;
  mode: ProvisionMode;
  /** Operator override of the smart default — bind THIS discovered resource. */
  chosenResourceId?: string;
  /** Discovered stack/platform (so the provisioner picks the right platform/region). */
  stack?: string;
  /** Human label used to name the created leaf resource + match in brownfield. */
  name?: string;
  /**
   * Present only for a first-class lifecycle reconciliation. Legacy onboarding
   * has no requirement row and deliberately leaves this absent; it must not
   * manufacture a compatibility reconciliation identity.
   */
  reconciliation?: {
    reconciliationId: string;
    claimOwner: string;
    leaseMs: number;
  };
}

/** A structured "the org hasn't linked this provider yet" response (not a throw). */
export interface NotLinkedResult {
  status: "not_linked";
  capability: string;
  providerKind: string;
  /** A clear operator-facing message. */
  message: string;
  /** The deep link / affordance the dashboard renders to link the provider at the org level. */
  linkAffordance: { kind: "org_integration_link"; providerKind: string; orgId: string };
}

/** No provider call was attempted because this project has no usable exact account choice. */
export interface SelectionRequiredResult {
  status: "selection_required";
  capability: string;
  providerKind: string;
  reason: "selection_missing" | "multiple_eligible" | "selected_grant_unavailable";
  message: string;
  candidates: Array<{
    connectionId: string;
    grantId: string;
    providerKind: string;
    providerPrincipalId: string;
    displayName: string;
    health: string;
    authGeneration: number;
    grantGeneration: number;
    ineligibilityReasons: string[];
  }>;
}

export interface IneligibleResult {
  status: "ineligible";
  capability: string;
  providerKind: string;
  reasons: string[];
  message: string;
}

/** A successful provision/bind, by REFERENCE only — no secret values. */
export interface ProvisionedResult {
  status: "provisioned";
  capability: string;
  providerKind: string;
  action: "provision" | "bind";
  mode: ProvisionMode;
  authority: {
    connectionId: string;
    grantId: string;
    providerPrincipalId: string;
    authGeneration: number;
    grantGeneration: number;
  };
  /** The secret-manager ref NAMES the provisioner stored (never values). */
  secretRefNames: string[];
  surfaces: {
    inboxSourceId?: string;
    notificationTargetId?: string;
    projectConfigKeys: string[];
    deployRef?: string;
  };
}

export type ProvisionOutcome = NotLinkedResult | SelectionRequiredResult | IneligibleResult | ProvisionedResult;

/**
 * The legacy capability-onboarding request predates the lifecycle requirement
 * row, but it still has a stable project+capability identity. Keep that
 * compatibility identity in the frozen resource event without pretending that
 * the path derived an `integration.requirement.*` event.
 */
function provisioningRequirementId(request: ProvisionRequest): string {
  return `provisioning:${request.projectId}:${request.capability}`;
}

/**
 * Resolve the provider resource identity already returned by today's live
 * provisioners. The artifact contract intentionally has no provider-neutral
 * resource-id field, so use the concrete fields each current producer owns:
 * deploy app id, Sentry project slug, or an explicitly bound resource id.
 * Persisted Tanren surface ids are the final compatibility fallback for an
 * artifact that only exposes a project surface.
 */
function provisionedResourceId(
  request: ProvisionRequest,
  artifact: ProvisionedArtifact,
  persisted: { inboxSourceId?: string; notificationTargetId?: string; deployRef?: string },
): string {
  if (request.chosenResourceId !== undefined && request.chosenResourceId !== "") {
    return request.chosenResourceId;
  }
  if (artifact.deployRef?.appId !== undefined && artifact.deployRef.appId !== "") {
    return artifact.deployRef.appId;
  }
  const projectConfig = artifact.projectConfig;
  for (const key of ["sentryProjectSlug", "slackChannelId", "deployAppId"] as const) {
    const value = projectConfig?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const persistedId = persisted.inboxSourceId ?? persisted.notificationTargetId ?? persisted.deployRef;
  if (persistedId !== undefined && persistedId !== "") return persistedId;
  throw new Error(
    `integration provisioner '${request.capability}' returned no resource identity for project '${request.projectId}'`,
  );
}

function unresolvedAuthorization(
  resolution: Exclude<AuthorizeOperationResult, { status: "eligible" }>,
  request: ProvisionRequest,
  providerKind: string,
): NotLinkedResult | SelectionRequiredResult | IneligibleResult {
  if (resolution.status === "not_linked") {
    return {
      status: "not_linked",
      capability: request.capability,
      providerKind,
      message:
        `link ${providerKind} at the org level first — onboarding requests the '${request.capability}' ` +
        `capability, but org ${request.orgId} has no active ${providerKind} control grant.`,
      linkAffordance: { kind: "org_integration_link", providerKind, orgId: request.orgId },
    };
  }
  if (resolution.status === "selection_required") {
    return {
      status: "selection_required",
      capability: request.capability,
      providerKind,
      reason: resolution.reason,
      message: `select an active ${providerKind} account for project ${request.projectId} before provider operations run.`,
      candidates: resolution.candidates,
    };
  }
  return {
    status: "ineligible",
    capability: request.capability,
    providerKind,
    reasons: resolution.reasons,
    message: `integration grant is not eligible for ${providerKind}/${request.capability}: ${resolution.reasons.join(",")}`,
  };
}

/** The engine's injected collaborators. `buildProvisioner` defaults to the real
 * registry wired with production deps; tests inject a fake provisioner + an
 * in-memory SecretStore. Nothing here is a production default stand-in — the
 * default IS the real registry. */
export interface ProvisioningEngineDeps {
  database: {
    withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
  };
  secrets: SecretStore;
  events: EventStore;
  actor: ActorRef;
  /** Sole eligibility authority — required for any secret/provider construction. */
  authority: IntegrationAuthority;
  /** Control-plane lifecycle writer; reconciliation workers require this seam. */
  integrationStateWriter?: IntegrationStateWriter;
  /** Override the provisioner construction (tests pass a fake); prod uses the registry. */
  buildProvisioner?: (kind: string) => IntegrationProvisioner;
}

/**
 * Run the capability → grant → discover → smart-default → provision/bind → persist
 * → event flow for one capability on one project. Returns the structured outcome
 * (provisioned-by-ref OR link-first), never leaking a secret value.
 */
export async function provisionCapability(
  deps: ProvisioningEngineDeps,
  request: ProvisionRequest,
): Promise<ProvisionOutcome> {
  const reconciliation = request.reconciliation;
  if (reconciliation !== undefined) {
    const writer = deps.integrationStateWriter;
    if (writer === undefined) {
      throw new Error("integration reconciliation requires an IntegrationStateWriter");
    }
    const capabilityRequest = { ...request, reconciliation: undefined };
    const lifecycle = await runProvisioningLifecycle({
      writer,
      claim: { orgId: request.orgId, ...reconciliation },
      work: () => provisionCapability(deps, capabilityRequest),
      completion: (outcome) => ({
        status: outcome.status === "provisioned" ? "succeeded" : "needs_attention",
        ...(outcome.status === "provisioned" ? {} : { failureClassification: "provisioning_unresolved" }),
      }),
      stateUnknown: { failureClassification: "provider_or_persistence_unknown" },
    });
    if (lifecycle.status === "not_claimed") {
      throw new Error(`integration reconciliation '${reconciliation.reconciliationId}' is not claimable`);
    }
    return lifecycle.result;
  }
  const providerKind = resolveProviderKind(request.capability, request.providerKind);
  // Resolve the immutable project coordinates first. Each provider stage below
  // obtains its own lease in a fresh short transaction immediately before I/O.
  const orgSlug = await deps.database.withOrgScope(request.orgId, async (client) => {
    const project = await client.query(
      `SELECT p.project_id, o.login AS org_slug
       FROM projects p JOIN organizations o ON o.id = p.org_id
       WHERE p.org_id = $1 AND p.project_id = $2`,
      [request.orgId, request.projectId],
    );
    const parsed = z.object({ project_id: z.string(), org_slug: z.string() }).safeParse(project.rows[0]);
    if (!parsed.success) {
      throw new Error(`project '${request.projectId}' is not owned by org '${request.orgId}'`);
    }
    return parsed.data.org_slug;
  });
  const projectCtx = {
    projectId: request.projectId,
    orgId: request.orgId,
    orgSlug,
    ...(request.stack === undefined ? {} : { stack: request.stack }),
    ...(request.name === undefined ? {} : { name: request.name }),
  };
  const authorize = (operation: "discover" | "provision" | "bind", target: IntegrationOperationTarget) =>
    deps.database.withOrgScope(request.orgId, (client) =>
      deps.authority.authorizeOperation(client, {
        orgId: request.orgId,
        projectId: request.projectId,
        providerKind,
        capability: request.capability,
        operation,
        target,
        actor: deps.actor,
      }),
    );

  const provisioner =
    deps.buildProvisioner === undefined
      ? buildIntegrationProvisioner(providerKind, productionProvisionerDeps(deps.secrets))
      : deps.buildProvisioner(providerKind);

  // 3. Confirm-with-smart-default (O-3). An explicit operator choice overrides the
  //    default; otherwise discover → resolveSmartDefault picks create/bind.
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  let grant: OrgGrant;
  if (request.chosenResourceId !== undefined && request.chosenResourceId !== "") {
    action = "bind";
    const resolution = await authorize("bind", projectIntegrationOperationTarget(projectCtx, request.chosenResourceId));
    if (resolution.status !== "eligible") return unresolvedAuthorization(resolution, request, providerKind);
    grant = IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
    artifact = await provisioner.bind(grant, request.chosenResourceId, projectCtx);
  } else {
    const discovery = await authorize("discover", {});
    if (discovery.status !== "eligible") return unresolvedAuthorization(discovery, request, providerKind);
    const discovered = await provisioner.discover(
      IntegrationConnectionsStore.orgGrantFromLease(discovery.lease),
      projectCtx,
    );
    const smart = resolveSmartDefault(discovered, request.mode, { name: request.name ?? request.projectId });
    if (smart.action === "bind") {
      action = "bind";
      const resolution = await authorize("bind", projectIntegrationOperationTarget(projectCtx, smart.resourceId));
      if (resolution.status !== "eligible") return unresolvedAuthorization(resolution, request, providerKind);
      grant = IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
      artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
    } else {
      action = "provision";
      const resolution = await authorize("provision", projectIntegrationOperationTarget(projectCtx));
      if (resolution.status !== "eligible") return unresolvedAuthorization(resolution, request, providerKind);
      grant = IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
      artifact = await provisioner.provision(grant, projectCtx);
    }
  }

  const secretRefNames = Object.values(artifact.secretRefs ?? {});
  // Commit Tanren state and its event atomically in a fresh short transaction,
  // after the idempotent provider operation has returned.
  const surfaces = await deps.database.withOrgScope(request.orgId, async (client) => {
    const persisted = await persistProvisionedArtifact(client, request, artifact, deps.actor);
    await deps.events.append({
      projectId: request.projectId,
      orgId: request.orgId,
      eventType: "integration.resource.provisioned",
      payload: {
        requirementId: provisioningRequirementId(request),
        providerKind,
        externalResourceId: provisionedResourceId(request, artifact, persisted),
        ownership: action === "provision" ? "created" : "adopted",
      },
    });
    return persisted;
  });

  return {
    status: "provisioned",
    capability: request.capability,
    providerKind,
    action,
    mode: request.mode,
    authority: {
      connectionId: grant.connectionId,
      grantId: grant.grantId,
      providerPrincipalId: grant.providerPrincipalId,
      authGeneration: grant.authGeneration,
      grantGeneration: grant.grantGeneration,
    },
    secretRefNames,
    surfaces,
  };
}

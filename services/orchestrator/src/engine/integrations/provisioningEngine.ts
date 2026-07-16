// Capability onboarding resolves one exact, persisted project grant; releases the
// scoped DB transaction; performs discover/provision/bind; then durably writes the
// artifact and `integration.provisioned` through EventStore in a fresh short scope.
// Missing links and ambiguous/stale selections are structured no-effect outcomes.
//
// SECRET DISCIPLINE: this engine never reads, returns, or logs a secret value.
// Provisioners write DSNs/tokens into the SecretStore and surface only `secretRefs`
// (the manager ref NAMES); this engine persists/echoes those names alone. The
// returned `ProvisionOutcome` and the emitted event carry ref NAMES, never values.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mutateProjectConfig } from "../config/projectConfigMutate.js";
import type { IntegrationAuthority } from "../contracts/integrationAuthority.js";
import { IntegrationConnectionsStore } from "../repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { ChannelKind } from "../notifications/schemas.js";
import type { EventStore } from "../eventStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { FetchSentryProvisionHttpClient } from "../providers/sentryProvisioner.js";
import { fetchDeployTransport } from "../provisioners/deployTransport.js";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  type IntegrationProvisioner,
  type IntegrationProvisionerDeps,
  type ProvisionedArtifact,
  type ProvisionMode,
} from "../contracts/integrationProvisioner.js";
import type { ActorRef } from "../state/actor.js";

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

export class SlackDeliveryAdapterUnavailableError extends Error {
  public override readonly name = "SlackDeliveryAdapterUnavailableError";
}

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
  const providerKind = resolveProviderKind(request.capability, request.providerKind);
  if (providerKind === "slack") {
    // The current Slack notification channel accepts incoming-webhook refs; a
    // linked bot token + channel id is a different credential model. Fail before
    // authority/provider I/O until chat.postMessage is the real delivery adapter.
    throw new SlackDeliveryAdapterUnavailableError("slack_bot_delivery_adapter_unavailable");
  }

  // Complete all authority reads in a short transaction, then release it before
  // any provider network I/O. A foreign/missing project cannot reach a provider.
  const authorized = await deps.database.withOrgScope(request.orgId, async (client) => {
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
    const operation =
      request.chosenResourceId !== undefined && request.chosenResourceId !== ""
        ? "bind"
        : request.mode === "brownfield"
          ? "discover"
          : "provision";
    const resolution = await deps.authority.authorizeOperation(client, {
      orgId: request.orgId,
      projectId: request.projectId,
      providerKind,
      capability: request.capability,
      operation: operation === "discover" ? "provision" : operation,
      actor: deps.actor,
    });
    return { resolution, orgSlug: parsed.data.org_slug };
  });
  const { resolution } = authorized;
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
  if (resolution.status === "ineligible") {
    return {
      status: "ineligible",
      capability: request.capability,
      providerKind,
      reasons: resolution.reasons,
      message: `integration grant is not eligible for ${providerKind}/${request.capability}: ${resolution.reasons.join(",")}`,
    };
  }
  const grant = IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);

  const provisioner =
    deps.buildProvisioner === undefined
      ? buildIntegrationProvisioner(providerKind, productionProvisionerDeps(deps.secrets))
      : deps.buildProvisioner(providerKind);

  const projectCtx = {
    projectId: request.projectId,
    orgId: request.orgId,
    orgSlug: authorized.orgSlug,
    ...(request.stack === undefined ? {} : { stack: request.stack }),
    ...(request.name === undefined ? {} : { name: request.name }),
  };

  // 3. Confirm-with-smart-default (O-3). An explicit operator choice overrides the
  //    default; otherwise discover → resolveSmartDefault picks create/bind.
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  if (request.chosenResourceId !== undefined && request.chosenResourceId !== "") {
    action = "bind";
    artifact = await provisioner.bind(grant, request.chosenResourceId, projectCtx);
  } else {
    const discovered = await provisioner.discover(grant);
    const smart = resolveSmartDefault(discovered, request.mode, { name: request.name ?? request.projectId });
    if (smart.action === "bind") {
      action = "bind";
      artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
    } else {
      action = "provision";
      artifact = await provisioner.provision(grant, projectCtx);
    }
  }

  const secretRefNames = Object.values(artifact.secretRefs ?? {});
  // Commit Tanren state and its event atomically in a fresh short transaction,
  // after the idempotent provider operation has returned.
  const surfaces = await deps.database.withOrgScope(request.orgId, async (client) => {
    const persisted = await persistArtifact(client, request, artifact, deps.actor);
    await deps.events.append({
      projectId: request.projectId,
      orgId: request.orgId,
      eventType: "integration.provisioned",
      payload: {
        capability: request.capability,
        providerKind,
        action,
        mode: request.mode,
        secretRefNames,
        surfaces: {
          ...(persisted.inboxSourceId === undefined ? {} : { inboxSourceId: persisted.inboxSourceId }),
          ...(persisted.notificationTargetId === undefined
            ? {}
            : { notificationTargetId: persisted.notificationTargetId }),
          projectConfigKeys: persisted.projectConfigKeys,
          ...(persisted.deployRef === undefined ? {} : { deployRef: persisted.deployRef }),
        },
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

interface PersistedSurfaces {
  inboxSourceId?: string;
  notificationTargetId?: string;
  projectConfigKeys: string[];
  deployRef?: string;
}

/**
 * Persist each populated artifact surface. projectConfig is merged (read-modify-
 * write) into projects.config; the inbox source + notification target are
 * upserted keyed on (project, kind) so a re-onboard never creates a duplicate
 * runtime source. Secret refs are already in the manager (the provisioner wrote
 * them) — we never touch values here.
 */
async function persistArtifact(
  client: IntegrationQueryClient,
  request: ProvisionRequest,
  artifact: ProvisionedArtifact,
  actor: ActorRef,
): Promise<PersistedSurfaces> {
  const result: PersistedSurfaces = { projectConfigKeys: [] };

  const projectConfig = artifact.projectConfig;
  if (projectConfig !== undefined && Object.keys(projectConfig).length > 0) {
    await mutateProjectConfig(client, request.projectId, actor, (rawCurrent) => ({
      ...asRecord(rawCurrent),
      ...projectConfig,
    }));
    result.projectConfigKeys = Object.keys(projectConfig);
  }

  if (artifact.inboxSource !== undefined) {
    result.inboxSourceId = await upsertInboxSource(client, request, artifact.inboxSource);
  }

  if (artifact.notificationTarget !== undefined) {
    result.notificationTargetId = await upsertNotificationTarget(client, request, artifact.notificationTarget);
  }

  if (artifact.deployRef !== undefined) {
    result.deployRef = `${artifact.deployRef.provider}:${artifact.deployRef.appId}`;
  }

  return result;
}
/** The marker every provisioner-managed artifact row carries, so the idempotency
 * unique indexes (migration 0054) are PARTIAL — scoped to provisioner-managed rows
 * only. This keeps operator-created inbox sources (which may legitimately repeat a
 * kind per project) and audit-system sources free of the constraint; only the
 * onboarding-provisioner's own rows are deduped on re-onboard. The runtime
 * connectors ignore this extra non-secret config key. */
const MANAGED_BY = "integration-provisioner";
/**
 * Idempotent upsert of the inbox source for this (project, kind): a re-onboard
 * updates the existing row's config/name rather than inserting a second source.
 * ATOMIC — `INSERT ... ON CONFLICT` against the PARTIAL unique index
 * `inbox_sources_provisioned_unique` (migration 0054; predicate: the `managedBy`
 * marker), so two concurrent re-onboards across separate scoped transactions
 * converge to ONE row (a prior SELECT-then-INSERT could both miss and both insert).
 * The conflict target repeats the index predicate so it binds to that partial index.
 */
async function upsertInboxSource(
  client: IntegrationQueryClient,
  request: ProvisionRequest,
  inboxSource: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const name = `${inboxSource.kind} (${request.name ?? request.projectId})`;
  const id = `src_${randomUUID()}`;
  const config = { ...inboxSource.config, managedBy: MANAGED_BY };
  const result = await client.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, detail, config, enabled, auto_route)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (org_id, project_id, kind) WHERE (config->>'managedBy') = '${MANAGED_BY}' DO UPDATE SET
       name = EXCLUDED.name,
       config = EXCLUDED.config
     RETURNING id`,
    [id, request.orgId, request.projectId, inboxSource.kind, name, "", JSON.stringify(config), "true", "false"],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `inbox_sources upsert returned no row for (${request.orgId}, ${request.projectId}, ${inboxSource.kind})`,
    );
  }
  return z.object({ id: z.string() }).parse(row).id;
}
/**
 * Idempotent upsert of the notification target for this org+channel+destination.
 * The provisioner's `notificationTarget` carries `{ kind, config }`; we map the
 * channel kind + a stable destination (the channel id / webhook ref) onto the
 * notification-targets surface. ATOMIC — `INSERT ... ON CONFLICT` against the
 * PARTIAL unique index `notification_targets_provisioned_unique` (migration 0054;
 * predicate `scope='org' AND user_id IS NULL` — exactly the org-scoped shape the
 * provisioner always writes), so concurrent re-onboards converge to ONE target
 * while leaving user-scoped targets (which may share a destination) unconstrained.
 * Secret REFS in config (botTokenRef) are refs only — never values.
 */
async function upsertNotificationTarget(
  client: IntegrationQueryClient,
  request: ProvisionRequest,
  notificationTarget: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const channelKind = ChannelKind.parse(notificationTarget.kind);
  const destination = notificationTargetDestination(notificationTarget.config);
  const label = `${notificationTarget.kind} (${request.name ?? request.projectId})`;
  const id = `notif_target_${randomUUID()}`;
  const result = await client.query(
    `INSERT INTO notification_targets
       (id, org_id, scope, user_id, channel_kind, destination, label, enabled, weekend_mute)
     VALUES ($1, $2, 'org', NULL, $3, $4, $5, 1, 0)
     ON CONFLICT (org_id, channel_kind, destination) WHERE scope = 'org' AND user_id IS NULL DO UPDATE SET
       label = EXCLUDED.label
     RETURNING id`,
    [id, request.orgId, channelKind, destination, label],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `notification_targets upsert returned no row for (${request.orgId}, ${channelKind}, ${destination})`,
    );
  }
  return z.object({ id: z.string() }).parse(row).id;
}
/**
 * Derive the notification-target `destination` from the provisioner's target
 * config: prefer an explicit credential ref (a webhook secret ref the send adapter
 * resolves), else the channel id. Always a non-secret REF/identifier, never a
 * secret value.
 */
function notificationTargetDestination(config: Record<string, unknown>): string {
  const ref = config["botTokenRef"] ?? config["webhookRef"] ?? config["channelId"] ?? config["destination"];
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("notification target config carried no destination/channelId/credential ref");
  }
  return ref;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

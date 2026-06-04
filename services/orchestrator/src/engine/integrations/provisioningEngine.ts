// P-INT-2: the capability → provisioner onboarding engine (orchestrator side).
//
// The onboarding/greenfield/brownfield flow requests a CAPABILITY ("enable error
// tracking", "notify on Slack", "deploy") for a project — NOT a leaf secret. For
// each enabled capability this engine:
//   1. Resolves the org grant from the `org_integrations` registry
//      (`OrgIntegrationsStore.getGrant`). If the org hasn't linked that provider,
//      it returns a structured "link <provider> first" response (with a deep-link
//      affordance) — NOT a thrown error — so the route/dashboard renders the
//      link-first prompt instead of a crash.
//   2. Builds the provisioner via `buildIntegrationProvisioner(kind, deps)` with
//      the PRODUCTION deps (the real fetch transport + the configured SecretStore)
//      — see `productionProvisionerDeps` below. This is where the registry's deps
//      are actually supplied in prod (until now only tests passed them).
//   3. Applies confirm-with-smart-default (O-3): `discover(grant)` →
//      `resolveSmartDefault(discovered, mode, project)` (greenfield→create,
//      brownfield→bind-match-else-create); the operator can override with an
//      explicit `chosenResourceId`. Then `provision`/`bind`.
//   4. Persists the resulting `ProvisionedArtifact` over the EXISTING surfaces:
//      `inboxSource` → inbox_sources; `notificationTarget` → notification targets;
//      `projectConfig` → projects.config; `secretRefs` are already in the secret
//      manager (written by the provisioner). All org-scoped under RLS via the
//      caller's scoped QueryClient.
//   5. Emits `integration.provisioned` (refs only — never secret values) and
//      returns what was created/bound by REFERENCE.
//
// SECRET DISCIPLINE: this engine never reads, returns, or logs a secret value.
// Provisioners write DSNs/tokens into the SecretStore and surface only `secretRefs`
// (the manager ref NAMES); this engine persists/echoes those names alone. The
// returned `ProvisionOutcome` and the emitted event carry ref NAMES, never values.
//
// IDEMPOTENCY: re-running a capability for the same project is safe — `provision`
// is the provider's find-or-create (it never mints a second Sentry project / Slack
// channel), and the inbox-source / notification-target persistence is upsert-keyed
// on (project, kind) so a re-onboard updates rather than duplicating.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { OrgIntegrationsStore } from "../repositories/orgIntegrations.js";
import { ProjectStore } from "../repositories/projects.js";
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

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

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
 * The capability a provider kind satisfies — the inverse of
 * {@link CAPABILITY_DEFAULT_PROVIDER}, used by the integration-LINK route to record
 * the grant's `capabilities`. A deploy provider kind maps to `deploy`; the canonical
 * single-provider capabilities map back from their default. An unknown provider kind
 * is REJECTED (throws) — linking a provider Tanren has no provisioner for is an
 * operator error, surfaced as a 400, never a silent empty-capability grant.
 */
export function capabilitiesForProviderKind(providerKind: string): string[] {
  if (DEPLOY_PROVIDER_KINDS.has(providerKind)) {
    return ["deploy"];
  }
  for (const [capability, kind] of Object.entries(CAPABILITY_DEFAULT_PROVIDER)) {
    if (kind === providerKind) {
      return [capability];
    }
  }
  throw new Error(
    `unknown provider kind '${providerKind}' — expected one of: ` +
      `${[...DEPLOY_PROVIDER_KINDS, ...Object.values(CAPABILITY_DEFAULT_PROVIDER)].join(", ")}`,
  );
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

/** A successful provision/bind, by REFERENCE only — no secret values. */
export interface ProvisionedResult {
  status: "provisioned";
  capability: string;
  providerKind: string;
  action: "provision" | "bind";
  mode: ProvisionMode;
  /** The secret-manager ref NAMES the provisioner stored (never values). */
  secretRefNames: string[];
  surfaces: {
    inboxSourceId?: string;
    notificationTargetId?: string;
    projectConfigKeys: string[];
    deployRef?: string;
  };
}

export type ProvisionOutcome = NotLinkedResult | ProvisionedResult;

/** The engine's injected collaborators. `buildProvisioner` defaults to the real
 * registry wired with production deps; tests inject a fake provisioner + an
 * in-memory SecretStore. Nothing here is a production default stand-in — the
 * default IS the real registry. */
export interface ProvisioningEngineDeps {
  client: QueryClient;
  secrets: SecretStore;
  events: EventStore;
  actor: ActorRef;
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

  // 1. Resolve the org grant. Not-linked is an EXPECTED outcome (a structured
  //    response with a link affordance), not an error.
  const grant = await OrgIntegrationsStore.getGrant(deps.client, request.orgId, providerKind, deps.actor);
  if (grant === undefined) {
    return {
      status: "not_linked",
      capability: request.capability,
      providerKind,
      message:
        `link ${providerKind} at the org level first — onboarding requests the '${request.capability}' ` +
        `capability, but org ${request.orgId} has no ${providerKind} grant in org_integrations.`,
      linkAffordance: { kind: "org_integration_link", providerKind, orgId: request.orgId },
    };
  }

  // 2. Build the provisioner with PRODUCTION deps (or the test override).
  const provisioner =
    deps.buildProvisioner === undefined
      ? buildIntegrationProvisioner(providerKind, productionProvisionerDeps(deps.secrets))
      : deps.buildProvisioner(providerKind);

  const projectCtx = {
    projectId: request.projectId,
    orgId: request.orgId,
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

  // 4. Persist the artifact over the existing surfaces (org-scoped under RLS).
  const surfaces = await persistArtifact(deps, request, artifact);

  // 5. Emit the event (refs only) + return by reference.
  const secretRefNames = Object.values(artifact.secretRefs ?? {});
  await deps.events.append({
    projectId: request.projectId,
    eventType: "integration.provisioned",
    payload: {
      capability: request.capability,
      providerKind,
      action,
      mode: request.mode,
      secretRefNames,
      surfaces: {
        ...(surfaces.inboxSourceId === undefined ? {} : { inboxSourceId: surfaces.inboxSourceId }),
        ...(surfaces.notificationTargetId === undefined ? {} : { notificationTargetId: surfaces.notificationTargetId }),
        projectConfigKeys: surfaces.projectConfigKeys,
        ...(surfaces.deployRef === undefined ? {} : { deployRef: surfaces.deployRef }),
      },
    },
  });

  return {
    status: "provisioned",
    capability: request.capability,
    providerKind,
    action,
    mode: request.mode,
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
  deps: ProvisioningEngineDeps,
  request: ProvisionRequest,
  artifact: ProvisionedArtifact,
): Promise<PersistedSurfaces> {
  const result: PersistedSurfaces = { projectConfigKeys: [] };

  if (artifact.projectConfig !== undefined && Object.keys(artifact.projectConfig).length > 0) {
    const current = asRecord(await ProjectStore.getConfig(deps.client, request.projectId, deps.actor));
    const next = { ...current, ...artifact.projectConfig };
    await ProjectStore.updateConfig(deps.client, request.projectId, next, deps.actor);
    result.projectConfigKeys = Object.keys(artifact.projectConfig);
  }

  if (artifact.inboxSource !== undefined) {
    result.inboxSourceId = await upsertInboxSource(deps.client, request, artifact.inboxSource);
  }

  if (artifact.notificationTarget !== undefined) {
    result.notificationTargetId = await upsertNotificationTarget(deps.client, request, artifact.notificationTarget);
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
  client: QueryClient,
  request: ProvisionRequest,
  inboxSource: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const name = `${inboxSource.kind} (${request.name ?? request.projectId})`;
  const id = `src_${randomUUID()}`;
  const config = { ...inboxSource.config, managedBy: MANAGED_BY };
  const result = await client.query<{ id: string }>(
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
  return row.id;
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
  client: QueryClient,
  request: ProvisionRequest,
  notificationTarget: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const channelKind = ChannelKind.parse(notificationTarget.kind);
  const destination = notificationTargetDestination(notificationTarget.config);
  const label = `${notificationTarget.kind} (${request.name ?? request.projectId})`;
  const id = `notif_target_${randomUUID()}`;
  const result = await client.query<{ id: string }>(
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
  return row.id;
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

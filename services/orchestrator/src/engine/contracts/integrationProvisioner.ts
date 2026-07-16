// The IntegrationProvisioner port (the keystone of Plane A): one
// contract every project-INTEGRATION provider implements, behind a registry, with
// a conformance suite — exactly the shape `Allocator` / `VcsProvider` /
// `SecretStore` already have. NO provider impl lives here: this wave proves the
// SEAM with an in-memory fake (under tests/) only; the concrete providers land in
// later provider waves.
//
// SCOPE — what this port IS and IS NOT:
//   - IS: project-INTEGRATION providers (sentry | slack | linear | jira |
//     deploy.vercel | deploy.flyio | pagerduty | …) that yield a
//     `ProvisionedArtifact` over the EXISTING project surfaces — `projectConfig`
//     (→ projects.config), `secretRefs` (→ secret manager), `inboxSource`
//     (→ inbox_sources), `notificationTarget` (→ notification targets),
//     `deployRef` (→ deploy metadata). Sentry/Slack/Deploy fit these cleanly:
//     Sentry → projectConfig + secretRefs(DSN) + inboxSource; Slack →
//     notificationTarget + secretRefs; Deploy → deployRef + secretRefs.
//   - IS NOT: cloud-ALLOCATOR provisioning (Hetzner/DO/AWS/GCP/K8s). A
//     cloud allocator yields a per-run SSH key pair + a pinned host-key fingerprint
//     + cloud-init / runner labels — NONE of which fit `ProvisionedArtifact`.
//     That SSH/host-key automation is a separate extension of the EXISTING
//     `Allocator` seam (engine/contracts/allocator.ts), NOT this port. We do NOT
//     bloat `ProvisionedArtifact` to carry it. (So `allocator.*` is deliberately
//     absent from the provider-kind list below.)
//
// A provisioner is a WRITER against an external provider API: it CREATES the
// project-level leaf resource (a Sentry project, a Slack channel, a deploy app)
// from the org-level grant. It is DISTINCT from the runtime poll/send adapters
// (`inbox/*Connector`, `notifications/channels/*`), which stay read/deliver-only
// — a provisioner creates the artifact; the runtime adapter then uses it.
//
// See docs/operator-guide/integration-provisioning.md (the boundary model + the
// two planes) and docs/operator-guide/integration-provisioning.md (the build sequence).
//
// The registry (`buildIntegrationProvisioner`) is the single append point real
// providers register here: each adds ONE `case` arm + its dep-slice on
// `IntegrationProvisionerDeps`, exactly like `buildVcsProvider`'s case arms.

// LAYOUT NOTE (Codex H3 #25 unified registry): the concrete provisioner impls live
// in provider-specific directories rather than a single `provisioners/` tree,
// because each provider carries its own transport module + fake:
//   - `providers/sentryProvisioner.ts` — the Sentry HTTP client is Sentry-specific
//     (project + client-key API surface), so it co-lives with the runtime Sentry
//     connector in `providers/`.
//   - `integrations/slack/slackProvisioner.ts` + `.../slackApiTransport.ts` — the
//     Slack Web API transport is Slack-specific, so it co-lives with the runtime
//     Slack integration in `integrations/slack/`.
//   - `provisioners/{fly,vercel}DeployProvisioner.ts` — Vercel + Fly share ONE
//     base class (`DeployProvisioner`) so a single `provisioners/` directory hosts
//     both + the shared `deployProvisioner.ts` + `deployTransport.ts`.
// The DIRECTORY differs so the transport + fake for each provider sit next to their
// impl; the REGISTRY below (`PROVISIONER_REGISTRY`) is the SINGLE seam that unifies
// them — a new provider lands as ONE new entry in the Map (+ its impl wherever it
// fits), never a refactor of the layout. This is the "single append point" the
// module header refers to, materialized as a Map instead of a switch.

import { SentryProvisioner, type SentryProvisionerDeps } from "../providers/sentryProvisioner.js";

import type { EligibleOperationLease } from "./integrationAuthority.js";
import type { SecretStore } from "./secretStore.js";
import { DeployProvisioner } from "../provisioners/deployProvisioner.js";
import { FlyDeployProvisioner, FLY_PROVIDER_KIND } from "../provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner, VERCEL_PROVIDER_KIND } from "../provisioners/vercelDeployProvisioner.js";
import { fetchDeployTransport, type DeployHttpTransport } from "../provisioners/deployTransport.js";
import type { FlyImageBuilder } from "../provisioners/flyImageBuilder.js";

/**
 * The capability ids a provisioner can satisfy. Kept a free `string` (not a closed
 * enum) so a new provider's capability slots in without a contract edit; the three
 * the matrix names today (`errors` | `notify` | `deploy`) are the canonical values
 * documented here, but the type does not constrain to them.
 */
import { buildSecretStore } from "./secretStoreFactory.js";
import { FetchSlackApiTransport, type SlackApiTransport } from "../integrations/slack/slackApiTransport.js";
import { SlackProvisioner, secretStoreSlackTransportFactory } from "../integrations/slack/slackProvisioner.js";

export type CapabilityId = string;

/** The provisioning mode onboarding picks per the greenfield/brownfield rule. */
export type ProvisionMode = "greenfield" | "brownfield";

/**
 * The org-level active control grant resolved ONLY from IntegrationAuthority.
 * No naked credential ref — secret reads require the opaque eligible operation
 * lease through IntegrationSecretStore.getExact.
 */
export interface OrgGrant {
  orgId: string;
  projectId: string;
  connectionId: string;
  grantId: string;
  providerKind: string;
  /** Provider-verified principal id (Slack team_id, Sentry org id, …). */
  providerPrincipalId: string;
  authGeneration: number;
  grantGeneration: number;
  /** Non-secret principal metadata (display names, slugs). Never tokens. */
  metadata: Record<string, unknown>;
  /** Opaque lease — sole credential coordinate for secret/provider construction. */
  eligibleOperation: EligibleOperationLease;
}

/**
 * The Tanren project a leaf resource is being provisioned/bound FOR, plus the
 * discovered stack/platform (so the provisioner can pick the right Sentry
 * platform, Fly region, etc.).
 *
 * `orgSlug` is REQUIRED — it carries the Tanren ORG's hostname-safe slug (the
 * `organizations.login` column, resolved by `OrganizationsStore.getLogin`).
 * Deploy provisioners (Fly + Vercel) namespace every created app as
 * `<orgSlug>-<projectName>` so a project named `linkly` cannot collide on
 * Fly's GLOBAL app-name namespace. The field is mandatory at the type level
 * (the `provisioningEngine.ts` call site resolves it before constructing the
 * context) so a fresh provisioner call cannot accidentally skip the
 * namespacing — no silent un-prefixed fallback.
 */
export interface ProjectContext {
  projectId: string;
  orgId: string;
  /** The Tanren org's hostname-safe slug (`organizations.login`). REQUIRED — see above. */
  orgSlug: string;
  /** The discovered stack/platform (e.g. "node", "next", "python"), when known. */
  stack?: string;
  /** A human label for the project (used to name the created leaf resource). */
  name?: string;
}

/**
 * An existing provider-side resource discovered during brownfield onboarding (a
 * Sentry project, a Slack channel, a Fly app the org already has). `id` is the
 * provider's stable handle `bind()` takes; `label` is the human name shown in the
 * smart-default picker; `metadata` carries provider-specific non-secret detail.
 */
export interface ExistingResource {
  id: string;
  label: string;
  metadata: Record<string, unknown>;
}

/**
 * The uniform output of `provision`/`bind`: the project-level config + managed
 * secret refs + the runtime surfaces to wire. Every field is optional because
 * different providers populate different surfaces (Sentry → projectConfig +
 * secretRefs + inboxSource; Slack → notificationTarget; a deploy provider →
 * deployRef). Secret VALUES never appear here — only `secretRefs` (manager refs).
 */
export interface ProvisionedArtifact {
  /** Non-secret project config to merge into `projects.config`. */
  projectConfig?: Record<string, unknown>;
  /** Secret-manager refs the provisioner stored (DSN, webhook secret, …). Never values. */
  secretRefs?: Record<string, string>;
  /** The inbox source to create for this project (Sentry/Linear intake). */
  inboxSource?: { kind: string; config: Record<string, unknown> };
  /** The notification target to create (Slack channel/webhook, PagerDuty service). */
  notificationTarget?: { kind: string; config: Record<string, unknown> };
  /** The deploy reference (Vercel/Fly app + preview-URL pattern). */
  deployRef?: { provider: string; appId: string; previewUrlPattern?: string };
}

/**
 * The port every integration provider implements. `discover` (brownfield) lists
 * what the org already has; `provision` is the idempotent find-or-create
 * (greenfield / create-if-absent); `bind` links an already-discovered resource.
 * Idempotency of `provision` is MANDATORY: re-running onboarding must never create
 * a second leaf resource — it finds the stable-named one and returns the SAME
 * artifact (mirrors the merge-queue / post-merge-claim atomic-claim pattern).
 */
export interface IntegrationProvisioner {
  /** The capability id(s) this provisioner satisfies (e.g. ["errors"]). */
  capability(): CapabilityId[];
  /** Brownfield: list the org's existing resources of this kind. */
  discover(grant: OrgGrant, projectCtx: ProjectContext): Promise<ExistingResource[]>;
  /** Greenfield / create-if-absent: idempotent find-or-create of the leaf resource. */
  provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact>;
  /** Brownfield link: bind an already-discovered resource to the Tanren project. */
  bind(grant: OrgGrant, existingResourceId: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact>;
}

/**
 * The smart-default onboarding (O-3) resolves per the greenfield/brownfield rule:
 * greenfield → always "create"; brownfield → "bind" the discovered resource that
 * matches the project (else "create" a fresh one). A pure function so onboarding
 * can show the default before any provider write. The match heuristic is a simple
 * name/label correspondence (case-insensitive); a provider with a richer match
 * can override by pre-filtering its `discovered` list before calling this.
 */
export type SmartDefault = { action: "create" } | { action: "bind"; resourceId: string };

export interface SmartDefaultProject {
  /** The project name/slug used to match a discovered resource by label. */
  name: string;
}

/**
 * Resolve the smart default for the onboarding picker (pure; no I/O). Greenfield
 * always creates. Brownfield binds the discovered resource whose label matches
 * the project name (case-insensitive, trimmed); with no match it creates.
 */
export function resolveSmartDefault(
  discovered: ReadonlyArray<ExistingResource>,
  mode: ProvisionMode,
  project: SmartDefaultProject,
): SmartDefault {
  if (mode === "greenfield") {
    return { action: "create" };
  }
  const target = project.name.trim().toLowerCase();
  const match = discovered.find((resource) => resource.label.trim().toLowerCase() === target);
  return match === undefined ? { action: "create" } : { action: "bind", resourceId: match.id };
}

/**
 * A HARD-THROW provisioner for a provider kind the registry does NOT register.
 * Selecting it constructs this and any operation throws loudly — the correct
 * "unconfigured" default (failing loud is not a stand-in), exactly like
 * `UnconfiguredAllocator` / `UnconfiguredVcsProvider`. The name carries no
 * stub/fake/noop stem, so it is the CORRECT unconfigured default — not a
 * production stub.
 *
 * The throw text is deliberately DIAGNOSTIC — it names the unregistered kind + the
 * REGISTERED kinds off {@link registeredIntegrationProviderKinds()} — so a
 * misconfigured provider surfaces as a clear "kind X is not registered, expected
 * one of …" instead of the generic pre-fix "no provider is registered yet".
 */
export class UnconfiguredIntegrationProvisioner implements IntegrationProvisioner {
  constructor(private readonly kind: string) {}

  private fail(): never {
    const registered = registeredIntegrationProviderKinds();
    const listed = registered.length === 0 ? "(none)" : registered.map((kind) => `'${kind}'`).join(", ");
    throw new Error(
      `Integration provisioner kind '${this.kind}' is not registered — ` +
        `no factory for that kind in PROVISIONER_REGISTRY. Registered kinds: ${listed}. ` +
        `To add a new provider, register a factory in the PROVISIONER_REGISTRY Map ` +
        `(services/orchestrator/src/engine/contracts/integrationProvisioner.ts).`,
    );
  }

  capability(): CapabilityId[] {
    return this.fail();
  }
  async discover(_grant: OrgGrant, _projectCtx: ProjectContext): Promise<ExistingResource[]> {
    return this.fail();
  }
  async provision(_grant: OrgGrant, _projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    return this.fail();
  }
  async bind(_grant: OrgGrant, _existingResourceId: string, _projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    return this.fail();
  }
}

/**
 * Selectable project-INTEGRATION provisioner backends (sentry | slack | linear |
 * jira | deploy.vercel | deploy.flyio | pagerduty | …). EMPTY in this wave — no
 * provider is registered yet — so every kind resolves to
 * {@link UnconfiguredIntegrationProvisioner}. A provider lands as a NEW case here
 * (+ its impl + a conformance entry), not a refactor, exactly like
 * `buildAllocator` / `buildVcsProvider`. Cloud-ALLOCATOR kinds (`allocator.*`,
 *) do NOT belong here — see the SCOPE note in the module header: their
 * SSH/host-key automation extends the `Allocator` seam, not this port.
 */
export type IntegrationProviderKind = string;

/**
 * Per-call wiring a real provisioner needs (the injected transports/stores its
 * impl composes). Optional + additive — each provider draws ONLY the deps it
 * uses, so a new provider extends this interface without disturbing the others.
 * Foundation (unconfigured) kinds ignore it.
 */
export interface IntegrationProvisionerDeps {
  /** Sentry's injected `{ http: SentryProvisionHttpClient; secrets: SecretStore }`. */
  sentry?: SentryProvisionerDeps;
  /** The HTTP transport the deploy provisioners run over (scripted fake in tests). */
  transport?: DeployHttpTransport;
  /** The SecretStore deploy-token aliases / DSNs are written into. */
  secrets?: SecretStore;
  /**
   * Fly-only opt-in flag that flows through to the {@link FlyDeployProvisioner}'s
   * static-image deploy path. Named on `DeployProvisionerDeps` too; carried here so
   * the unified registry can propagate the same value the pre-fix
   * `deployProvisionerFor` used to accept directly. Ignored by every non-Fly
   * factory in the registry (Sentry / Slack / Vercel).
   */
  allowFlyStaticDeploy?: boolean;
  /**
   * Fly-only: the injected image-build seam that turns the merged commit into a
   * per-commit image so `triggerDeploy` releases a merge-reflecting image. Named on
   * `DeployProvisionerDeps` too; carried here so the unified registry can propagate
   * it the same way `allowFlyStaticDeploy` flows. Ignored by every non-Fly factory
   * (Sentry / Slack / Vercel). When present, this is the DEFAULT release path; the
   * static-image `allowFlyStaticDeploy` becomes the flagged escape hatch.
   */
  flyImageBuilder?: FlyImageBuilder;
}

/**
 * Construct the real Sentry provisioner. Kept a tiny factory (rather than a bare
 * `new` at the registry entry) so the concrete provider import is the single line
 * below and a parallel provider PR never touches this one's wiring.
 */
function makeSentryProvisioner(deps: SentryProvisionerDeps | undefined): IntegrationProvisioner {
  if (deps === undefined) {
    throw new Error("buildIntegrationProvisioner('sentry') requires deps.sentry ({ http, secrets })");
  }
  return new SentryProvisioner(deps.http, deps.secrets);
}

/**
 * Construct one of the two `DeployProvisioner` subclasses (Vercel | Fly). Kept a
 * shared factory so the deploy registry entries never duplicate the transport /
 * secret-store wiring — the SAME shape reaches both providers, and the
 * `providerKind` chooses the subclass.
 */
function makeDeployProvisioner(kind: string, deps: IntegrationProvisionerDeps): IntegrationProvisioner {
  const transport = deps.transport ?? fetchDeployTransport();
  if (deps.secrets === undefined) {
    throw new Error(`integration provisioner '${kind}' requires a SecretStore in deps.secrets`);
  }
  // `allowFlyStaticDeploy` + `flyImageBuilder` propagate only when set; the Fly
  // provisioner applies its own defaults when omitted. Every non-Fly path ignores them.
  const deployDeps = {
    transport,
    secrets: deps.secrets,
    ...(deps.allowFlyStaticDeploy === undefined ? {} : { allowFlyStaticDeploy: deps.allowFlyStaticDeploy }),
    ...(deps.flyImageBuilder === undefined ? {} : { flyImageBuilder: deps.flyImageBuilder }),
  };
  return kind === VERCEL_PROVIDER_KIND ? new VercelDeployProvisioner(deployDeps) : new FlyDeployProvisioner(deployDeps);
}

/**
 * The factory shape every registry entry has: given the shared
 * {@link IntegrationProvisionerDeps}, construct the concrete provisioner. Each
 * factory pulls ONLY the slice of deps it uses (sentry pulls `deps.sentry`; the
 * deploy providers pull `deps.transport` + `deps.secrets`; slack resolves its own
 * SecretStore). This is the SINGLE seam the registry is built out of.
 */
type IntegrationProvisionerFactory = (deps: IntegrationProvisionerDeps) => IntegrationProvisioner;

/**
 * The UNIFIED provisioner registry: a Map from every registered `IntegrationProviderKind`
 * to its factory. This replaces the prior scattered selection (a switch here + a hardcoded
 * `deployProvisionerFor` switch elsewhere) that Codex H3 #25 flagged — every REAL
 * provisioner (Sentry, Slack, Vercel-deploy, Fly-deploy) now lives in ONE Map, and
 * both `buildIntegrationProvisioner` (the general seam) and `deployProvisionerFor`
 * (the deploy-narrow seam) read from it.
 *
 * A new provider lands as ONE new entry here — never a refactor of two switches. An
 * unregistered kind resolves to the hard-throw {@link UnconfiguredIntegrationProvisioner}
 * (a clear "kind X is not registered" diagnostic, not a silent no-op).
 *
 * NB — Cloud-ALLOCATOR kinds (`allocator.hetzner` / `allocator.digitalocean` / …) do
 * NOT belong here — see the module-header SCOPE note: their SSH/host-key automation
 * extends the `Allocator` seam (engine/contracts/allocator.ts), not this port.
 */
const PROVISIONER_REGISTRY: ReadonlyMap<string, IntegrationProvisionerFactory> = new Map<
  string,
  IntegrationProvisionerFactory
>([
  ["sentry", (deps) => makeSentryProvisioner(deps.sentry)],
  [VERCEL_PROVIDER_KIND, (deps) => makeDeployProvisioner(VERCEL_PROVIDER_KIND, deps)],
  [FLY_PROVIDER_KIND, (deps) => makeDeployProvisioner(FLY_PROVIDER_KIND, deps)],
  // Plane-A Slack `notify` provisioner (bot `chat.postMessage` model);
  // `buildSlackProvisioner` resolves the grant's bot-token ref against the
  // configured SecretStore.
  ["slack", (_deps) => buildSlackProvisioner()],
]);

/**
 * The registered provider kinds. Introspection helper for callers that need to
 * enumerate registered kinds (the unconfigured-throw diagnostic, the
 * `deployProvisionerFor` guard, tests). ORDERED as the Map is (registration order),
 * so the emitted diagnostic is stable.
 */
export function registeredIntegrationProviderKinds(): readonly string[] {
  return [...PROVISIONER_REGISTRY.keys()];
}

/**
 * Select + construct the IntegrationProvisioner for a provider kind. Reads from
 * the shared {@link PROVISIONER_REGISTRY} — a new provider lands as ONE new entry
 * there. An unregistered kind resolves to the hard-throw
 * {@link UnconfiguredIntegrationProvisioner}.
 */
export function buildIntegrationProvisioner(
  kind: IntegrationProviderKind,
  deps: IntegrationProvisionerDeps = {},
): IntegrationProvisioner {
  const factory = PROVISIONER_REGISTRY.get(kind);
  if (factory === undefined) {
    return new UnconfiguredIntegrationProvisioner(kind);
  }
  return factory(deps);
}

/**
 * Registered kinds that produce a {@link DeployProvisioner} subclass. Derived from
 * the shared {@link PROVISIONER_REGISTRY} by the `deploy.` naming convention (the
 * SAME convention the deploy provider kinds are stamped with on `deploy.triggered` /
 * `deploy.verified`), so a new deploy provider registered in the Map is
 * automatically visible to `buildDeployProvisioner` — the two seams cannot silently
 * diverge (Codex H3 #25).
 */
function registeredDeployProviderKinds(): readonly string[] {
  return registeredIntegrationProviderKinds().filter((kind) => kind.startsWith("deploy."));
}

/**
 * Narrow the registry to the deploy provisioners: the {@link DeployProvisioner}
 * subclass for a `deploy.<provider>` kind. Reads from the SAME
 * {@link PROVISIONER_REGISTRY} that `buildIntegrationProvisioner` uses — the pre-fix
 * hardcoded switch in `workflow/deployProvisionerFor.ts` (which silently diverged
 * from `buildIntegrationProvisioner` — Codex H3 #25) is now impossible.
 *
 * The kind check runs FIRST (before the factory) so a non-deploy kind (e.g. `sentry`)
 * fails LOUD with a "not a deploy provisioner" diagnostic — without triggering the
 * sentry factory's own "requires deps.sentry" error that would obscure the real
 * misuse. An unregistered kind fails with the same diagnostic (it isn't a deploy
 * provisioner either).
 *
 * SHARED FACTORY, NARROW SEAM: returns the `DeployProvisioner` base type so callers
 * get `attachRuntimeEnv` / `deploy` / `deploymentStatus` without an
 * extra cast. The `deployProvisionerFor` selector in `workflow/` now delegates here.
 */
export function buildDeployProvisioner(kind: string, deps: IntegrationProvisionerDeps): DeployProvisioner {
  const deployKinds = registeredDeployProviderKinds();
  if (!deployKinds.includes(kind)) {
    const listed = deployKinds.length === 0 ? "(none)" : deployKinds.map((k) => `'${k}'`).join(", ");
    throw new Error(
      `buildDeployProvisioner: provider kind '${kind}' is not a deploy provisioner ` +
        `(registered deploy kinds: ${listed})`,
    );
  }
  const provisioner = buildIntegrationProvisioner(kind, deps);
  // A defensive re-check: the deploy-kinds set was derived from the registry, so a
  // registered `deploy.*` kind MUST produce a DeployProvisioner. If a future refactor
  // registers a non-deploy provisioner under a `deploy.*` name (a bug), this throws
  // rather than silently returning the wrong type.
  if (!(provisioner instanceof DeployProvisioner)) {
    throw new Error(
      `buildDeployProvisioner: registry factory for '${kind}' returned a non-DeployProvisioner ` +
        `— a 'deploy.*' kind must produce a DeployProvisioner subclass`,
    );
  }
  return provisioner;
}

/**
 * Construct the production Plane-A Slack provisioner: a transport factory that, per
 * org grant, resolves the bot-token credential ref against the configured
 * SecretStore (`TANREN_SECRET_STORE`) and builds a fetch-backed Slack Web API
 * transport for it. The bot token lives only inside the transport for the duration
 * of a call — it is never embedded in a `ProvisionedArtifact` (only its ref is).
 */
function buildSlackProvisioner(): IntegrationProvisioner {
  const secrets = buildSecretStore();
  const transportFactory = secretStoreSlackTransportFactory(
    secrets,
    (tokenForAttempt): SlackApiTransport => new FetchSlackApiTransport(tokenForAttempt),
  );
  return new SlackProvisioner({ transportFactory });
}

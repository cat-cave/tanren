// The IntegrationProvisioner port (P-INT-0, the keystone of Plane A): one
// contract every project-INTEGRATION provider implements, behind a registry, with
// a conformance suite — exactly the shape `Allocator` / `VcsProvider` /
// `SecretStore` already have. NO provider impl lives here: this wave proves the
// SEAM with an in-memory fake (under tests/) only; the concrete providers land in
// the next wave (P-INT-1+).
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
//   - IS NOT: cloud-ALLOCATOR provisioning (P-INT-5: Hetzner/DO/AWS/GCP/K8s). A
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
// two planes) and docs/roadmap/integration-provisioning.md (the build sequence).
//
// The registry (`buildIntegrationProvisioner`) is the single append point real
// providers register at (P-INT-1+): each adds ONE `case` arm + its dep-slice on
// `IntegrationProvisionerDeps`, exactly like `buildVcsProvider`'s case arms.

import { SentryProvisioner, type SentryProvisionerDeps } from "../providers/sentryProvisioner.js";

import type { SecretStore } from "./secretStore.js";
import { FlyDeployProvisioner } from "../provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../provisioners/vercelDeployProvisioner.js";
import { fetchDeployTransport, type DeployHttpTransport } from "../provisioners/deployTransport.js";

/**
 * The capability ids a provisioner can satisfy. Kept a free `string` (not a closed
 * enum) so a new provider's capability slots in without a contract edit; the three
 * the matrix names today (`errors` | `notify` | `deploy`) are the canonical values
 * documented here, but the type does not constrain to them.
 */
export type CapabilityId = string;

/** The provisioning mode onboarding picks per the greenfield/brownfield rule. */
export type ProvisionMode = "greenfield" | "brownfield";

/**
 * The org-level grant resolved from the `org_integrations` registry: the managed
 * credential REF (resolved against the SecretStore by the provider — never the
 * secret value) plus the NON-SECRET org metadata (sentry org slug, slack
 * workspace id, …). This is what every provisioner method runs under.
 */
export interface OrgGrant {
  providerKind: string;
  /** Secret-manager ref for the org credential. NEVER the secret value itself. */
  credentialRef: string;
  /** Non-secret org metadata (sentry org slug, slack workspace id, hetzner project, …). */
  metadata: Record<string, unknown>;
}

/**
 * The Tanren project a leaf resource is being provisioned/bound FOR, plus the
 * discovered stack/platform (so the provisioner can pick the right Sentry
 * platform, Fly region, etc.).
 */
export interface ProjectContext {
  projectId: string;
  orgId: string;
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
 * (greenfield / create-if-absent); `bind` links an already-discovered resource;
 * `teardown` is best-effort cleanup. Idempotency of `provision` is MANDATORY:
 * re-running onboarding must never create a second leaf resource — it finds the
 * stable-named one and returns the SAME artifact (mirrors the merge-queue /
 * post-merge-claim atomic-claim pattern).
 */
export interface IntegrationProvisioner {
  /** The capability id(s) this provisioner satisfies (e.g. ["errors"]). */
  capability(): CapabilityId[];
  /** Brownfield: list the org's existing resources of this kind. */
  discover(grant: OrgGrant): Promise<ExistingResource[]>;
  /** Greenfield / create-if-absent: idempotent find-or-create of the leaf resource. */
  provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact>;
  /** Brownfield link: bind an already-discovered resource to the Tanren project. */
  bind(grant: OrgGrant, existingResourceId: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact>;
  /** Best-effort cleanup (project delete / unlink). Optional — not every provider supports it. */
  teardown?(artifact: ProvisionedArtifact): Promise<void>;
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
 * A HARD-THROW provisioner for a provider kind that is named but not yet
 * implemented. Selecting it constructs this and any operation throws loudly — the
 * correct "unconfigured" default (failing loud is not a stand-in), exactly like
 * `UnconfiguredAllocator` / `UnconfiguredVcsProvider`. No provider is registered
 * in this foundation wave, so EVERY kind resolves to this until P-INT-1+ wire the
 * real impls. The name carries no stub/fake/noop stem, so it is the CORRECT
 * unconfigured default — not a production stub.
 */
export class UnconfiguredIntegrationProvisioner implements IntegrationProvisioner {
  constructor(private readonly kind: string) {}

  private fail(): never {
    throw new Error(
      `Integration provisioner kind '${this.kind}' was selected but is not implemented. ` +
        `No provider is registered yet (the foundation wave is provider-free; P-INT-1+ wire them).`,
    );
  }

  capability(): CapabilityId[] {
    return this.fail();
  }
  async discover(_grant: OrgGrant): Promise<ExistingResource[]> {
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
 * P-INT-5) do NOT belong here — see the SCOPE note in the module header: their
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
  /** The HTTP transport the deploy provisioners (P-INT-4) run over (scripted fake in tests). */
  transport?: DeployHttpTransport;
  /** The SecretStore deploy-token aliases / DSNs are written into. */
  secrets?: SecretStore;
}

/**
 * Construct the real Sentry provisioner. Kept a tiny factory (rather than a bare
 * `new` in the switch) so the concrete provider import is the single line below
 * and a parallel provider PR's case arm never touches this one's wiring.
 */
function makeSentryProvisioner(deps: SentryProvisionerDeps | undefined): IntegrationProvisioner {
  if (deps === undefined) {
    throw new Error("buildIntegrationProvisioner('sentry') requires deps.sentry ({ http, secrets })");
  }
  return new SentryProvisioner(deps.http, deps.secrets);
}

/**
 * Select + construct the IntegrationProvisioner for a provider kind. Real
 * project-integration impls slot in as new `case` arms (P-INT-1+, each pulling
 * its own slice of {@link IntegrationProvisionerDeps}) — exactly like
 * `buildAllocator` / `buildVcsProvider`; an unregistered kind resolves to the
 * hard-throw {@link UnconfiguredIntegrationProvisioner}. Cloud-ALLOCATOR kinds
 * (`allocator.*`, P-INT-5) do NOT belong here — they extend the Allocator seam.
 */
export function buildIntegrationProvisioner(
  kind: IntegrationProviderKind,
  deps: IntegrationProvisionerDeps = {},
): IntegrationProvisioner {
  switch (kind) {
    case "sentry":
      return makeSentryProvisioner(deps.sentry);
    // --- P-INT-4 deploy provisioners (Vercel + Fly) --------------------------
    case "deploy.vercel":
    case "deploy.flyio": {
      const transport = deps.transport ?? fetchDeployTransport();
      if (deps.secrets === undefined) {
        throw new Error(`integration provisioner '${kind}' requires a SecretStore in deps.secrets`);
      }
      const deployDeps = { transport, secrets: deps.secrets };
      return kind === "deploy.vercel" ? new VercelDeployProvisioner(deployDeps) : new FlyDeployProvisioner(deployDeps);
    }
    // Other real impls (slack, linear, jira) slot in here as new cases in P-INT-1+.
    // Cloud-allocator (`allocator.*`, P-INT-5) is NOT one of these — it extends the
    // Allocator seam, not this port (see the module-header SCOPE note).
    default:
      return new UnconfiguredIntegrationProvisioner(kind);
  }
}

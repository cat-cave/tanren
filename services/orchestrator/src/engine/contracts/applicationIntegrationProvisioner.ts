// in-12: the PRODUCT-plane ApplicationIntegrationProvisioner port + registry.
//
// This is the DISTINCT product-plane sibling of the control-plane
// `IntegrationProvisioner` (contracts/integrationProvisioner.ts). The integrations
// node spec (§C of nodes/integrations.md) is explicit: "Retain today's
// control-plane provisioner for Tanren notifications, inboxes, and deployment
// providers. Add a distinct `ApplicationIntegrationProvisioner` for the built
// product." A control-plane provisioner yields a `ProvisionedArtifact` over
// Tanren's OWN surfaces (projects.config / inbox_sources / notification targets);
// a PRODUCT-plane provisioner yields typed `AppBindingOutputV1[]` (in-2) the built
// application consumes at runtime — the two planes must never share credentials
// (the classic wrong-plane Slack bot-token-vs-webhook bug this port exists to make
// mechanically impossible).
//
// SEAM SHAPE — identical to the control-plane port + `buildIntegrationProvisioner`:
// one contract every product-integration provider implements, behind a registry
// (`PRODUCT_PROVISIONER_REGISTRY`), with a VERTICAL conformance suite
// (tests/conformance/applicationIntegrationProvisioner.conformance.test.ts). A new
// product provider (e.g. in-13's `slack.product.message.v1`) lands as ONE new
// registry entry + its impl, NEVER a refactor of the layout.
//
// FAIL-CLOSED: an unregistered kind resolves to the hard-throw
// `UnconfiguredApplicationIntegrationProvisioner`; a concrete provisioner that
// cannot complete (missing relay/secret deps, provider error, plane violation)
// throws a typed `ProductProvisionFailedError` — it NEVER fabricates a success.

import type { IntegrationRequirementV1 } from "./integrationRequirement.js";
import type { AppBindingOutputV1 } from "./integrationBindingOutput.js";
import type { ExactSecretCoordinate } from "./integrationSecretStore.js";
import type { IntegrationEnvironment } from "./integrationRequirement.js";
import type { SecretStore } from "./secretStore.js";
import type { CapabilityId, ExistingResource, OrgGrant, ProjectContext } from "./integrationProvisioner.js";
import { ProductProvisionFailedError } from "../integrations/product/applicationProvisionerKit.js";
import {
  RelayMessagingProvisioner,
  RELAY_MESSAGING_PROVIDER_KIND,
  type ProductRelayTransport,
} from "../integrations/product/relayMessagingProvisioner.js";
import {
  SlackProductProvisioner,
  SLACK_PRODUCT_MESSAGE_PROVIDER_KIND,
  type SlackProductTransportFactory,
} from "../integrations/product/slackProductProvisioner.js";

/**
 * The provider-neutral provisioning plan compiled from a typed
 * `IntegrationRequirementV1` (in-2) for a chosen product provider. It is the
 * pre-write, side-effect-free description onboarding can show before any provider
 * call: which provider serves the capability, the desired resource name, the
 * declared app-env outputs, and the least-privilege operations/scopes needed.
 */
export interface ProductProvisionPlan {
  /** Stable requirement identity (the in-2 requirement digest). */
  readonly requirementId: string;
  /** The product capability this plan serves (e.g. `messaging.send`). */
  readonly capability: string;
  /** The registry kind that builds the provisioner (e.g. `product.messaging.relay`). */
  readonly providerKind: string;
  /** The concrete provider the kind fronts, chosen from the policy (e.g. `slack`). */
  readonly providerName: string;
  /** The environment this plan provisions (test/preview/production). */
  readonly environment: IntegrationEnvironment;
  /** The stable name of the leaf resource to find-or-create. */
  readonly desiredResourceName: string;
  /** The least-privilege provider operations this provider needs. */
  readonly requiredOperations: readonly string[];
  /** The least-privilege provider scopes this provider needs. */
  readonly requiredScopes: readonly string[];
  /** The typed app-env outputs (all PRODUCT-plane; in-2 validated). */
  readonly bindingOutputs: readonly AppBindingOutputV1[];
}

/**
 * One resolved app-env output the provisioner produced. Carries the typed
 * `AppBindingOutputV1` plus EXACTLY ONE resolution coordinate: a `plainValue` for
 * non-secret (`plain` / `handle`) outputs, or a `secretSource` (a scoped Vault
 * generation coordinate) for `secret_ref` outputs. A secret VALUE is never carried.
 */
export interface ResolvedApplicationOutput {
  readonly output: AppBindingOutputV1;
  /** Non-secret (`plain`/`handle`) value. Mutually exclusive with `secretSource`. */
  readonly plainValue?: string;
  /** `secret_ref` source coordinate. Mutually exclusive with `plainValue`. */
  readonly secretSource?: ExactSecretCoordinate;
}

/**
 * The uniform product-plane provisioning result. Unlike the control-plane
 * `ProvisionedArtifact`, it projects into the BUILT APPLICATION's runtime via the
 * typed `outputs` (which the in-14 BindingMaterializer turns into
 * `project_app_env`). No secret value ever appears — only refs/coordinates.
 */
export interface ProvisionedApplicationArtifact {
  readonly providerKind: string;
  /** The provider-adapter version stamped into the immutable binding (in-15). */
  readonly adapterVersion: string;
  /** The provider's stable handle for the leaf resource. */
  readonly externalResourceId: string;
  /** The human resource name (channel/app label). */
  readonly externalResourceName: string;
  /** Whether Tanren created the resource (`created`) or adopted an existing one. */
  readonly ownership: "created" | "adopted";
  /** The resolved typed app-env outputs — all PRODUCT-plane. */
  readonly outputs: readonly ResolvedApplicationOutput[];
  /**
   * A durable, non-secret provider receipt (ids/times only — never bodies or
   * tokens) proving the provider-side effect. The A3 probe (a sibling node) reads
   * it; here it is the auditable evidence a real provision occurred.
   */
  readonly receipt?: Readonly<Record<string, string>>;
}

/** Desired-vs-observed reconciliation snapshot for a product binding. */
export interface ApplicationObservation {
  /** True when the leaf resource exists provider-side. */
  readonly present: boolean;
  /** The provider handle when present. */
  readonly externalResourceId?: string;
  /** Human-readable drift descriptors; empty when converged. */
  readonly drift: readonly string[];
}

// The typed failed state (`ProductProvisionFailedError`) lives in the leaf kit
// module so both this registry and every concrete impl throw the SAME type without
// a contract↔impl runtime cycle. Re-exported here for port consumers.
export { ProductProvisionFailedError } from "../integrations/product/applicationProvisionerKit.js";

/**
 * The product-plane provisioner port. `plan` is a pure compile from the typed
 * requirement (no I/O); every other method is a fail-closed provider writer/reader.
 * `provision` MUST be idempotent find-or-create (re-running never mints a second
 * resource). `bind` links an already-discovered resource and rejects an unknown id.
 */
export interface ApplicationIntegrationProvisioner {
  /** The product capability id(s) this provisioner satisfies (e.g. `["messaging.send"]`). */
  capability(): CapabilityId[];
  /** Pure compile of a typed requirement into a provider plan (no provider call). */
  plan(requirement: IntegrationRequirementV1, projectCtx: ProjectContext): ProductProvisionPlan;
  /** Brownfield: list the org's existing product resources of this kind. */
  discover(grant: OrgGrant, projectCtx: ProjectContext): Promise<ExistingResource[]>;
  /** Greenfield / create-if-absent: idempotent find-or-create of the leaf resource. */
  provision(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact>;
  /** Brownfield link: bind an already-discovered resource to the product. */
  bind(
    grant: OrgGrant,
    existingResourceId: string,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact>;
  /** Read desired-vs-observed provider state (no mutation). */
  observe(grant: OrgGrant, projectCtx: ProjectContext): Promise<ApplicationObservation>;
  /** Converge provider state to the plan (idempotent; repairs drift). */
  reconcile(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact>;
  /** Rotate the binding's workload credential generation (managed-relay owned). */
  rotate(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact>;
  /** Ownership-aware teardown of a Tanren-created leaf resource. */
  teardown(grant: OrgGrant, projectCtx: ProjectContext): Promise<void>;
}

/**
 * Per-call wiring a real product provisioner needs. Optional + additive — each
 * provider draws ONLY the slice it uses, so a new provider extends this without
 * disturbing the others (mirrors `IntegrationProvisionerDeps`).
 */
export interface ApplicationIntegrationProvisionerDeps {
  /** The managed-relay transport the relay-messaging provisioner runs over. */
  relay?: ProductRelayTransport;
  /** Factory for a lease-scoped direct PRODUCT Slack API transport. */
  slackProductTransportFactory?: SlackProductTransportFactory;
  /** The SecretStore that resolves the lease-authorized product credential. */
  secrets?: SecretStore;
}

/**
 * A HARD-THROW provisioner for a product-provider kind the registry does NOT
 * register. Selecting it constructs this and any operation throws loudly — the
 * correct "unconfigured" default (failing loud is not a stand-in), exactly like
 * `UnconfiguredIntegrationProvisioner`. The name carries no stub/fake/noop stem.
 */
export class UnconfiguredApplicationIntegrationProvisioner implements ApplicationIntegrationProvisioner {
  constructor(private readonly kind: string) {}

  private fail(): never {
    const registered = registeredApplicationProviderKinds();
    const listed = registered.length === 0 ? "(none)" : registered.map((kind) => `'${kind}'`).join(", ");
    throw new ProductProvisionFailedError(
      "plan",
      `product provider kind '${this.kind}' is not registered — no factory in PRODUCT_PROVISIONER_REGISTRY. ` +
        `Registered kinds: ${listed}. To add a provider, register a factory in ` +
        `applicationIntegrationProvisioner.ts (one new Map entry + its impl).`,
    );
  }

  capability(): CapabilityId[] {
    return this.fail();
  }
  plan(): ProductProvisionPlan {
    return this.fail();
  }
  async discover(): Promise<ExistingResource[]> {
    return this.fail();
  }
  async provision(): Promise<ProvisionedApplicationArtifact> {
    return this.fail();
  }
  async bind(): Promise<ProvisionedApplicationArtifact> {
    return this.fail();
  }
  async observe(): Promise<ApplicationObservation> {
    return this.fail();
  }
  async reconcile(): Promise<ProvisionedApplicationArtifact> {
    return this.fail();
  }
  async rotate(): Promise<ProvisionedApplicationArtifact> {
    return this.fail();
  }
  async teardown(): Promise<void> {
    return this.fail();
  }
}

type ApplicationProvisionerFactory = (deps: ApplicationIntegrationProvisionerDeps) => ApplicationIntegrationProvisioner;

/** Construct the managed-relay messaging provisioner from the shared deps slice. */
function makeRelayMessagingProvisioner(deps: ApplicationIntegrationProvisionerDeps): ApplicationIntegrationProvisioner {
  if (deps.relay === undefined) {
    throw new ProductProvisionFailedError(
      "provision",
      `buildApplicationIntegrationProvisioner('${RELAY_MESSAGING_PROVIDER_KIND}') requires deps.relay (a ProductRelayTransport)`,
    );
  }
  if (deps.secrets === undefined) {
    throw new ProductProvisionFailedError(
      "provision",
      `buildApplicationIntegrationProvisioner('${RELAY_MESSAGING_PROVIDER_KIND}') requires deps.secrets (a SecretStore)`,
    );
  }
  return new RelayMessagingProvisioner(deps.relay, deps.secrets);
}

/** Construct the direct PRODUCT Slack provisioner from its isolated deps slice. */
function makeSlackProductProvisioner(deps: ApplicationIntegrationProvisionerDeps): ApplicationIntegrationProvisioner {
  if (deps.slackProductTransportFactory === undefined) {
    throw new ProductProvisionFailedError(
      "provision",
      `buildApplicationIntegrationProvisioner('${SLACK_PRODUCT_MESSAGE_PROVIDER_KIND}') requires ` +
        "deps.slackProductTransportFactory (a lease-scoped product Slack transport factory)",
    );
  }
  if (deps.secrets === undefined) {
    throw new ProductProvisionFailedError(
      "provision",
      `buildApplicationIntegrationProvisioner('${SLACK_PRODUCT_MESSAGE_PROVIDER_KIND}') requires deps.secrets (a SecretStore)`,
    );
  }
  return new SlackProductProvisioner(deps.slackProductTransportFactory, deps.secrets);
}

/**
 * The UNIFIED product-provisioner registry: a Map from every registered product
 * provider kind to its factory. A new product provider lands as ONE new entry here
 * — never a refactor. An unregistered kind resolves to the hard-throw
 * `UnconfiguredApplicationIntegrationProvisioner`.
 */
const PRODUCT_PROVISIONER_REGISTRY: ReadonlyMap<string, ApplicationProvisionerFactory> = new Map<
  string,
  ApplicationProvisionerFactory
>([
  [RELAY_MESSAGING_PROVIDER_KIND, (deps) => makeRelayMessagingProvisioner(deps)],
  [SLACK_PRODUCT_MESSAGE_PROVIDER_KIND, (deps) => makeSlackProductProvisioner(deps)],
]);

/** The registered product provider kinds, in registration order (stable diagnostics). */
export function registeredApplicationProviderKinds(): readonly string[] {
  return [...PRODUCT_PROVISIONER_REGISTRY.keys()];
}

/**
 * Select + construct the ApplicationIntegrationProvisioner for a product provider
 * kind. Reads from the shared registry; an unregistered kind resolves to the
 * hard-throw `UnconfiguredApplicationIntegrationProvisioner`.
 */
export function buildApplicationIntegrationProvisioner(
  kind: string,
  deps: ApplicationIntegrationProvisionerDeps = {},
): ApplicationIntegrationProvisioner {
  const factory = PRODUCT_PROVISIONER_REGISTRY.get(kind);
  if (factory === undefined) {
    return new UnconfiguredApplicationIntegrationProvisioner(kind);
  }
  return factory(deps);
}

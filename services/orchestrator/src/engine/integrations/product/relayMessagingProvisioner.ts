// in-12: the managed-relay product messaging provisioner — the concrete reference
// impl of the product-plane `ApplicationIntegrationProvisioner` port. It realizes
// the spec's DEFAULT managed mode (nodes/integrations.md §C): "the product receives
// a binding ID … Tanren's relay owns the Slack token, enforces
// channel/operation/idempotency policy, and returns a durable provider receipt."
// The built product NEVER receives the provider token — only a `relay_binding_id`
// handle + the target `channel_id`. That is why a managed-relay artifact carries NO
// product secret: the token stays inside Tanren's relay. in-13 lands the Slack
// `direct` mode (a separately authorized product Slack app token) as ONE new
// registry entry on top of this kit — never a refactor.
//
// SEAM SHAPE — like `SentryProvisioner`: a REAL impl over an INJECTABLE transport
// (`ProductRelayTransport`) so it is exercised against a scripted fake with no live
// relay call in CI. The relay control token is resolved per-operation from the org
// grant's lease (`secretValueForLease`) and passed to the transport for the call
// only — it never enters the returned artifact.
//
// FAIL-CLOSED: a missing binding on bind/rotate/teardown, a relay transport error,
// or a plan output kind this provisioner does not produce all throw a typed
// `ProductProvisionFailedError`. No fabricated success.

import type { SecretStore } from "../../contracts/secretStore.js";
import type {
  ApplicationIntegrationProvisioner,
  ApplicationObservation,
  ProductProvisionPlan,
  ProvisionedApplicationArtifact,
  ResolvedApplicationOutput,
} from "../../contracts/applicationIntegrationProvisioner.js";
import type {
  CapabilityId,
  ExistingResource,
  OrgGrant,
  ProjectContext,
} from "../../contracts/integrationProvisioner.js";
import {
  projectIntegrationOperationTarget,
  type EligibleOperationExpectation,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../../contracts/integrationAuthority.js";
import type { AppBindingOutputV1 } from "../../contracts/integrationBindingOutput.js";
import type { IntegrationRequirementV1 } from "../../contracts/integrationRequirement.js";
import {
  deriveProductProvisionPlan,
  finalizeProductArtifact,
  PRODUCT_ADAPTER_VERSION,
  ProductProvisionFailedError,
} from "./applicationProvisionerKit.js";

/** The registry kind for the managed-relay product messaging provisioner. */
export const RELAY_MESSAGING_PROVIDER_KIND = "product.messaging.relay";
/** The product capability this provisioner satisfies. */
const CAPABILITY_MESSAGING = "messaging.send";

/** The relay-side record of a managed product binding (never carries a token). */
export interface RelayBinding {
  /** The relay's stable binding handle the product references. */
  readonly bindingId: string;
  /** The resolved target channel id. */
  readonly channelId: string;
  /** The human channel name. */
  readonly channelName: string;
  /** The org-scoped idempotency key the relay dedups create-or-find on. */
  readonly stableKey: string;
  /** The relay-owned workload credential generation (bumped by rotate). */
  readonly workloadGeneration: number;
  /** A durable, non-secret provider receipt id proving the relay-side effect. */
  readonly receiptId: string;
  /** True when Tanren's relay created the channel (vs adopted an existing one). */
  readonly created: boolean;
}

/** The register-or-find request the relay dedups on `stableKey`. */
export interface RegisterRelayBindingRequest {
  readonly orgId: string;
  readonly projectId: string;
  readonly stableKey: string;
  readonly providerName: string;
  readonly channelName: string;
  readonly providerPrincipalId: string;
  readonly requiredOperations: readonly string[];
  readonly requiredScopes: readonly string[];
}

/**
 * The injectable managed-relay transport. Every method takes the resolved relay
 * control `token` (never stored on the transport) so a scripted fake can assert the
 * token was resolved through the lease. `registerBinding` is idempotent find-or-
 * create keyed on `stableKey`.
 */
export interface ProductRelayTransport {
  registerBinding(token: string, req: RegisterRelayBindingRequest): Promise<RelayBinding>;
  getBinding(token: string, orgId: string, stableKey: string): Promise<RelayBinding | undefined>;
  listBindings(token: string, orgId: string): Promise<readonly RelayBinding[]>;
  rotateWorkloadCredential(token: string, orgId: string, bindingId: string): Promise<RelayBinding>;
  revokeBinding(token: string, orgId: string, bindingId: string): Promise<void>;
}

/** Map a lifecycle method to the privileged operation the lease is checked against. */
function operationFor(stage: "discover" | "provision" | "bind"): IntegrationPrivilegedOperation {
  return stage;
}

/**
 * The managed-relay implementation of {@link ApplicationIntegrationProvisioner}.
 * Constructed with the injectable {@link ProductRelayTransport} + the `SecretStore`
 * the org grant's relay control credential is resolved from — both injected so the
 * impl runs against a scripted fake with no live relay call.
 */
export class RelayMessagingProvisioner implements ApplicationIntegrationProvisioner {
  constructor(
    private readonly relay: ProductRelayTransport,
    private readonly secrets: SecretStore,
  ) {}

  capability(): CapabilityId[] {
    return [CAPABILITY_MESSAGING];
  }

  plan(requirement: IntegrationRequirementV1, projectCtx: ProjectContext): ProductProvisionPlan {
    return deriveProductProvisionPlan(requirement, projectCtx, {
      providerKind: RELAY_MESSAGING_PROVIDER_KIND,
      capabilities: [CAPABILITY_MESSAGING],
    });
  }

  async discover(grant: OrgGrant, projectCtx: ProjectContext): Promise<ExistingResource[]> {
    const token = await this.resolveRelayToken(grant, projectCtx, "discover", projectDiscoverTarget(projectCtx));
    const bindings = await this.relay.listBindings(token, grant.orgId).catch((error: unknown) => {
      throw new ProductProvisionFailedError("discover", relayError(error));
    });
    return bindings.map((binding) => ({
      id: binding.bindingId,
      label: binding.channelName,
      metadata: { channelId: binding.channelId, stableKey: binding.stableKey },
    }));
  }

  async provision(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const stableKey = relayStableKey(grant, projectCtx);
    const target = projectIntegrationOperationTarget(projectCtx);
    const token = await this.resolveRelayToken(grant, projectCtx, "provision", target);
    // Idempotent find-or-create: a second provision for the same stableKey returns
    // the SAME relay binding, never a duplicate channel.
    const existing = await this.relay.getBinding(token, grant.orgId, stableKey).catch((error: unknown) => {
      throw new ProductProvisionFailedError("provision", relayError(error));
    });
    const binding =
      existing ??
      (await this.relay
        .registerBinding(token, this.registerRequest(grant, plan, projectCtx, stableKey))
        .catch((error: unknown) => {
          throw new ProductProvisionFailedError("provision", relayError(error));
        }));
    return this.artifactFor(binding, plan, "provision");
  }

  async bind(
    grant: OrgGrant,
    existingResourceId: string,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const target = projectIntegrationOperationTarget(projectCtx, existingResourceId);
    const token = await this.resolveRelayToken(grant, projectCtx, "bind", target);
    const bindings = await this.relay.listBindings(token, grant.orgId).catch((error: unknown) => {
      throw new ProductProvisionFailedError("bind", relayError(error));
    });
    const found = bindings.find((binding) => binding.bindingId === existingResourceId);
    if (found === undefined) {
      // Never bind a phantom — the contract requires bind of an unknown id to reject.
      throw new ProductProvisionFailedError("bind", `cannot bind unknown relay binding '${existingResourceId}'`);
    }
    return this.artifactFor({ ...found, created: false }, plan, "bind");
  }

  async observe(grant: OrgGrant, projectCtx: ProjectContext): Promise<ApplicationObservation> {
    const stableKey = relayStableKey(grant, projectCtx);
    const token = await this.resolveRelayToken(grant, projectCtx, "discover", projectDiscoverTarget(projectCtx));
    const binding = await this.relay.getBinding(token, grant.orgId, stableKey).catch((error: unknown) => {
      throw new ProductProvisionFailedError("observe", relayError(error));
    });
    if (binding === undefined) {
      return { present: false, drift: ["relay binding absent"] };
    }
    const drift: string[] = [];
    if (binding.channelId === "") {
      drift.push("relay binding has no resolved channel");
    }
    return { present: true, externalResourceId: binding.bindingId, drift };
  }

  async reconcile(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    // Converge to desired: provision is idempotent find-or-create, so re-running it
    // repairs an absent binding and is a no-op for a healthy one.
    return this.provision(grant, plan, projectCtx);
  }

  async rotate(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const stableKey = relayStableKey(grant, projectCtx);
    const target = projectIntegrationOperationTarget(projectCtx);
    const token = await this.resolveRelayToken(grant, projectCtx, "provision", target);
    const current = await this.relay.getBinding(token, grant.orgId, stableKey).catch((error: unknown) => {
      throw new ProductProvisionFailedError("rotate", relayError(error));
    });
    if (current === undefined) {
      throw new ProductProvisionFailedError("rotate", "cannot rotate a relay binding that does not exist");
    }
    const rotated = await this.relay
      .rotateWorkloadCredential(token, grant.orgId, current.bindingId)
      .catch((error: unknown) => {
        throw new ProductProvisionFailedError("rotate", relayError(error));
      });
    return this.artifactFor(rotated, plan, "rotate");
  }

  async teardown(grant: OrgGrant, projectCtx: ProjectContext): Promise<void> {
    const stableKey = relayStableKey(grant, projectCtx);
    const target = projectIntegrationOperationTarget(projectCtx);
    const token = await this.resolveRelayToken(grant, projectCtx, "provision", target);
    const binding = await this.relay.getBinding(token, grant.orgId, stableKey).catch((error: unknown) => {
      throw new ProductProvisionFailedError("teardown", relayError(error));
    });
    if (binding === undefined) {
      // Nothing to tear down is a converged success, not a fabricated one.
      return;
    }
    if (!binding.created) {
      // Ownership-aware: never delete a channel Tanren adopted rather than created.
      throw new ProductProvisionFailedError(
        "teardown",
        `relay binding '${binding.bindingId}' was adopted, not created — refusing to tear down a resource Tanren does not own`,
      );
    }
    // A KNOWN-created binding whose delete is not positively confirmed (404 / any
    // non-2xx) fails-closed as `teardown_unconfirmed` — never a fabricated success.
    await this.relay.revokeBinding(token, grant.orgId, binding.bindingId).catch((error: unknown) => {
      throw new ProductProvisionFailedError("teardown", `teardown_unconfirmed: ${relayError(error)}`);
    });
  }

  private registerRequest(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
    stableKey: string,
  ): RegisterRelayBindingRequest {
    return {
      orgId: grant.orgId,
      projectId: projectCtx.projectId,
      stableKey,
      providerName: plan.providerName,
      channelName: plan.desiredResourceName,
      providerPrincipalId: grant.providerPrincipalId,
      requiredOperations: plan.requiredOperations,
      requiredScopes: plan.requiredScopes,
    };
  }

  /**
   * Build the uniform product artifact from a relay binding + the plan's declared
   * outputs. The managed-relay provisioner produces exactly the relay binding id
   * (a handle) and the channel id (plain) — any OTHER declared output kind is a
   * fail-closed error (this provisioner cannot honestly produce it). No token ever
   * enters the artifact.
   */
  private artifactFor(
    binding: RelayBinding,
    plan: ProductProvisionPlan,
    stage: "provision" | "bind" | "rotate",
  ): ProvisionedApplicationArtifact {
    // Fail-closed FIRST: a mutation is a confirmed success only when the relay
    // returned every confirmation-of-external-effect field non-empty. This guards
    // ANY transport (not only the fetch client's parse) from a fabricated success.
    assertConfirmedRelayBinding(binding, stage);
    const outputs = plan.bindingOutputs.map((output) => this.resolveOutput(output, binding, stage));
    // Route through the kit-boundary finalizer so the plane guard is re-asserted.
    return finalizeProductArtifact(
      {
        providerKind: RELAY_MESSAGING_PROVIDER_KIND,
        adapterVersion: PRODUCT_ADAPTER_VERSION,
        externalResourceId: binding.bindingId,
        externalResourceName: binding.channelName,
        ownership: binding.created ? "created" : "adopted",
        outputs,
        receipt: {
          relayReceiptId: binding.receiptId,
          workloadGeneration: String(binding.workloadGeneration),
        },
      },
      stage,
    );
  }

  private resolveOutput(
    output: AppBindingOutputV1,
    binding: RelayBinding,
    stage: "provision" | "bind" | "rotate",
  ): ResolvedApplicationOutput {
    switch (output.kind) {
      case "product.messaging.relay_binding_id":
        return { output, plainValue: binding.bindingId };
      case "product.messaging.channel_id":
        return { output, plainValue: binding.channelId };
      default:
        throw new ProductProvisionFailedError(
          stage,
          `managed-relay provisioner does not produce output kind '${output.kind}' ` +
            `(supports product.messaging.relay_binding_id + product.messaging.channel_id)`,
        );
    }
  }

  /**
   * Resolve the org grant's relay control token from the SecretStore via the
   * lease. Read here + passed to the transport for the call only — NEVER returned
   * in the artifact, logged, or persisted. Mirrors `SentryProvisioner.resolveToken`.
   */
  private async resolveRelayToken(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    stage: "discover" | "provision" | "bind",
    target: IntegrationOperationTarget,
  ): Promise<string> {
    const { GenerationAddressedIntegrationSecretStore } = await import("../integrationSecretStoreImpl.js");
    const { assertOrgGrantMatchesLease, secretValueForLease } =
      await import("../../repositories/integrationConnectionResolve.js");
    assertOrgGrantMatchesLease(grant);
    const expected: EligibleOperationExpectation = {
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: grant.providerKind,
      capability: CAPABILITY_MESSAGING,
      operation: operationFor(stage),
      target,
    };
    return secretValueForLease(
      new GenerationAddressedIntegrationSecretStore(this.secrets),
      grant.eligibleOperation,
      expected,
    );
  }
}

/**
 * Assert a relay binding carries every field that CONFIRMS the external effect —
 * a NON-BLANK binding id, idempotency key, channel id, channel name, and provider
 * receipt. `bindingId`/`stableKey` are re-asserted HERE (not only in the fetch
 * parser) so NO transport — fetch or injected — can produce a confirmed artifact
 * with an empty external resource id. Whitespace-only is treated as blank: a relay
 * response with a `"   "` channel is incomplete evidence, not a success.
 */
function assertConfirmedRelayBinding(binding: RelayBinding, stage: "provision" | "bind" | "rotate"): void {
  const missing: string[] = [];
  if (isBlank(binding.bindingId)) missing.push("bindingId");
  if (isBlank(binding.stableKey)) missing.push("stableKey");
  if (isBlank(binding.channelId)) missing.push("channelId");
  if (isBlank(binding.channelName)) missing.push("channelName");
  if (isBlank(binding.receiptId)) missing.push("receiptId");
  if (missing.length > 0) {
    throw new ProductProvisionFailedError(
      stage,
      `incomplete_relay_evidence: relay binding '${binding.bindingId}' has missing/blank confirmation field(s): ${missing.join(", ")}`,
    );
  }
}

/** True when a string is empty or whitespace-only (not a confirmed value). */
function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** The relay-side idempotency key: one managed binding per (org, project, capability). */
function relayStableKey(grant: OrgGrant, projectCtx: ProjectContext): string {
  return `${grant.orgId}:${projectCtx.projectId}:${grant.eligibleOperation.capability}`;
}

function projectDiscoverTarget(_projectCtx: ProjectContext): IntegrationOperationTarget {
  return {};
}

function relayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// in-12: shared kit for the product-plane ApplicationIntegrationProvisioner —
// the typed failed-state error, the pure plan compiler, the plane guard, and the
// VERTICAL seam that turns a `ProvisionedApplicationArtifact` into the in-14
// BindingMaterializer's `ResolvedBinding`. Kept a leaf module (imports the port
// contract TYPE-ONLY) so the contract's registry can import the concrete impl
// without a runtime import cycle — exactly the shape the control-plane
// `SentryProvisioner` has relative to `integrationProvisioner.ts`.

import { integrationRequirementDigest, type IntegrationRequirementV1 } from "../../contracts/integrationRequirement.js";
import { planeOfBindingKind } from "../../contracts/integrationBindingOutput.js";
import type { AppEnvScope } from "../../repositories/appEnvironment.js";
import type { ResolvedBinding, ResolvedBindingOutput } from "../bindingMaterializer.js";
import type { BindingEnvironment, BindingOwnership, BindingTeardownPolicy } from "../bindingMaterializerStore.js";
import type { OrgGrant, ProjectContext } from "../../contracts/integrationProvisioner.js";
import type {
  ProductProvisionPlan,
  ProvisionedApplicationArtifact,
  ResolvedApplicationOutput,
} from "../../contracts/applicationIntegrationProvisioner.js";

/** The lifecycle stage a product provision failed at. */
export type ProductProvisionStage =
  | "plan"
  | "discover"
  | "provision"
  | "bind"
  | "observe"
  | "reconcile"
  | "rotate"
  | "teardown";

/**
 * A product provision/bind/reconcile/rotate/teardown could NOT complete — the
 * typed failed state (never a fabricated success). Lives in the kit (a leaf) so
 * both the port registry and every concrete impl throw the SAME error type without
 * a contract↔impl runtime cycle.
 */
export class ProductProvisionFailedError extends Error {
  public override readonly name = "ProductProvisionFailedError";
  constructor(
    public readonly stage: ProductProvisionStage,
    public readonly reason: string,
  ) {
    super(`product provisioner failed at ${stage}: ${reason}`);
  }
}

/** The product-adapter version stamped into the artifact + immutable binding (in-15). */
export const PRODUCT_ADAPTER_VERSION = "1.0.0" as const;

/** Environment preference for eager preparation — reversible test/canary first. */
const ENVIRONMENT_PRIORITY = ["test", "preview", "production"] as const;

/**
 * Choose the concrete provider NAME from the requirement's provider policy:
 * the first preferred provider that is allowed and not forbidden, else the first
 * allowed-not-forbidden, else fail-closed. Never silently defaults.
 */
function chooseProviderName(requirement: IntegrationRequirementV1): string {
  const forbidden = new Set(requirement.providerPolicy.forbidden ?? []);
  const allowed = requirement.providerPolicy.allowed ?? [];
  const allowedSet = new Set(allowed);
  const preferred = requirement.providerPolicy.preferred ?? [];
  const isEligible = (name: string): boolean => !forbidden.has(name) && (allowedSet.size === 0 || allowedSet.has(name));
  for (const name of preferred) {
    if (isEligible(name)) return name;
  }
  for (const name of allowed) {
    if (isEligible(name)) return name;
  }
  throw new ProductProvisionFailedError(
    "plan",
    `no eligible provider in policy (preferred=[${preferred.join(",")}] allowed=[${allowed.join(",")}] ` +
      `forbidden=[${[...forbidden].join(",")}])`,
  );
}

/** Pick the eager environment (test → preview → production) from the requirement. */
function chooseEnvironment(requirement: IntegrationRequirementV1): BindingEnvironment {
  for (const env of ENVIRONMENT_PRIORITY) {
    if (requirement.environments.includes(env)) return env;
  }
  // environments is min(1); the priority set is exhaustive over the enum, so this
  // is unreachable — but fail-closed rather than assume.
  throw new ProductProvisionFailedError("plan", "requirement declares no supported environment");
}

/**
 * Compile a typed `IntegrationRequirementV1` (in-2) into a provider-neutral
 * {@link ProductProvisionPlan} for a provisioner of `self.providerKind`. Pure — no
 * provider call. Fail-closed on: a non-product requirement, a capability outside
 * this provisioner's set, or no eligible provider. The requirement's bindingOutputs
 * are already product-plane-validated by in-2's `parseIntegrationRequirement`;
 * {@link assertProductBindingOutputs} re-guards here so a hand-built plan cannot
 * smuggle a control-plane credential kind onto the product plane.
 */
export function deriveProductProvisionPlan(
  requirement: IntegrationRequirementV1,
  projectCtx: ProjectContext,
  self: { readonly providerKind: string; readonly capabilities: readonly string[] },
): ProductProvisionPlan {
  if (requirement.plane !== "product") {
    throw new ProductProvisionFailedError("plan", `requirement plane '${requirement.plane}' is not 'product'`);
  }
  if (!self.capabilities.includes(requirement.capability)) {
    throw new ProductProvisionFailedError(
      "plan",
      `provider '${self.providerKind}' does not serve capability '${requirement.capability}' ` +
        `(serves: ${self.capabilities.join(", ")})`,
    );
  }
  assertProductBindingOutputs(
    requirement.bindingOutputs.map((output) => ({ output })),
    "plan",
  );
  const desiredResourceName = (projectCtx.name ?? projectCtx.projectId).trim();
  if (desiredResourceName === "") {
    throw new ProductProvisionFailedError("plan", "project context has no usable name for the leaf resource");
  }
  return {
    requirementId: integrationRequirementDigest(requirement),
    capability: requirement.capability,
    providerKind: self.providerKind,
    providerName: chooseProviderName(requirement),
    environment: chooseEnvironment(requirement),
    desiredResourceName,
    requiredOperations: [...requirement.requiredOperations],
    requiredScopes: [...requirement.requiredScopes],
    bindingOutputs: requirement.bindingOutputs,
  };
}

/**
 * Guard: EVERY output must be a PRODUCT-plane binding kind. A control-plane kind
 * (e.g. `control.notify.bot_token_ref`) reaching a product artifact is the classic
 * wrong-plane Slack bug (a Tanren operator bot token used as a product webhook) —
 * this throws it closed BEFORE any materialization.
 */
export function assertProductBindingOutputs(
  outputs: ReadonlyArray<Pick<ResolvedApplicationOutput, "output">>,
  stage: ProductProvisionStage,
): void {
  for (const { output } of outputs) {
    if (planeOfBindingKind(output.kind) !== "product") {
      throw new ProductProvisionFailedError(
        stage,
        `binding kind '${output.kind}' is control-plane and cannot appear on a product artifact ` +
          `(control credentials never validate as product bindings)`,
      );
    }
  }
}

/**
 * Kit-boundary finalizer EVERY concrete provisioner routes its mutation artifact
 * through: it re-asserts the plane guard on the returned outputs so the wrong-plane
 * invariant is enforced HERE, not per-impl. A future provider copying an
 * `artifactFor` without the guard still cannot emit a control-plane binding kind on
 * a product artifact — the invariant lives at the kit boundary.
 */
export function finalizeProductArtifact(
  artifact: ProvisionedApplicationArtifact,
  stage: ProductProvisionStage,
): ProvisionedApplicationArtifact {
  assertProductBindingOutputs(artifact.outputs, stage);
  return artifact;
}

/** A stable, generation-independent binding id for a product requirement + env. */
export function stableProductBindingId(plan: ProductProvisionPlan): string {
  return `app-binding:${plan.requirementId}:${plan.environment}`;
}

const RUNTIME_SCOPES: readonly AppEnvScope[] = ["runtime"];

/**
 * The VERTICAL seam: convert a {@link ProvisionedApplicationArtifact} into the
 * in-14 BindingMaterializer's `ResolvedBinding`. Proves the artifact a product
 * provisioner produces is ACCEPTED by its materializer (spec §C: "the artifact
 * produced by a provisioner must be accepted by its materializer, runtime adapter,
 * and validation probe"). Fail-closed: re-guards the plane, and requires each
 * output carry exactly one of a plain value (`plain`/`handle`) or a secret source
 * (`secret_ref`) — the same invariant the materializer enforces, surfaced here as a
 * typed provision failure rather than a late materializer throw.
 */
export function applicationArtifactToResolvedBinding(
  artifact: ProvisionedApplicationArtifact,
  grant: OrgGrant,
  projectCtx: ProjectContext,
  plan: ProductProvisionPlan,
): ResolvedBinding {
  assertProductBindingOutputs(artifact.outputs, "provision");
  if (artifact.externalResourceId === "" || artifact.externalResourceName === "") {
    throw new ProductProvisionFailedError("provision", "artifact has no provisioned external resource");
  }
  const outputs: ResolvedBindingOutput[] = artifact.outputs.map((resolved) => {
    const secret = resolved.output.classification === "secret_ref";
    if (secret && resolved.secretSource === undefined) {
      throw new ProductProvisionFailedError(
        "provision",
        `secret output '${resolved.output.logicalKey}' is missing its secret source coordinate`,
      );
    }
    if (!secret && (resolved.plainValue === undefined || resolved.plainValue === "")) {
      // An empty plain value (e.g. an unconfirmed, coerced-to-"" channel_id) must
      // NOT reach project_app_env — the in-14 materializer accepts any defined
      // plainValue, so this seam is the fail-closed choke point for empty evidence.
      throw new ProductProvisionFailedError(
        "provision",
        `non-secret output '${resolved.output.logicalKey}' has no value (empty is not a confirmed binding)`,
      );
    }
    return {
      logicalKey: resolved.output.logicalKey,
      secret,
      required: resolved.output.required,
      scopes: RUNTIME_SCOPES,
      ...(secret ? { secretSource: resolved.secretSource } : { plainValue: resolved.plainValue }),
    };
  });
  const ownership: BindingOwnership = artifact.ownership;
  const teardownPolicy: BindingTeardownPolicy = artifact.ownership === "created" ? "delete" : "retain";
  return {
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
    requirementId: plan.requirementId,
    environment: plan.environment,
    bindingId: stableProductBindingId(plan),
    providerKind: artifact.providerKind,
    connectionId: grant.connectionId,
    authGeneration: grant.authGeneration,
    grantId: grant.grantId,
    grantGeneration: grant.grantGeneration,
    adapterVersion: artifact.adapterVersion,
    externalResourceId: artifact.externalResourceId,
    externalResourceName: artifact.externalResourceName,
    ownership,
    teardownPolicy,
    outputs,
  };
}

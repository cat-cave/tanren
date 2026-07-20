// In-memory ApplicationIntegrationProvisioner fake — a TEST FIXTURE (tests/ only)
// that satisfies the product-plane contract behaviorally so the conformance suite
// has a second implementation to hold to the SAME spec. Unlike the managed-relay
// provisioner (which produces its two specific outputs), this fake is generic: it
// resolves ANY declared product output — a `secret_ref` output to a scoped Vault
// coordinate, a `plain`/`handle` output to a plain value — so the suite exercises
// the SECRET path the relay impl does not. No external I/O; never a production stub.

import type {
  ApplicationIntegrationProvisioner,
  ApplicationObservation,
  ProductProvisionPlan,
  ProvisionedApplicationArtifact,
  ResolvedApplicationOutput,
} from "../../../src/engine/contracts/applicationIntegrationProvisioner.js";
import type {
  CapabilityId,
  ExistingResource,
  OrgGrant,
  ProjectContext,
} from "../../../src/engine/contracts/integrationProvisioner.js";
import type { IntegrationRequirementV1 } from "../../../src/engine/contracts/integrationRequirement.js";
import type { AppBindingOutputV1 } from "../../../src/engine/contracts/integrationBindingOutput.js";
import {
  deriveProductProvisionPlan,
  PRODUCT_ADAPTER_VERSION,
  ProductProvisionFailedError,
} from "../../../src/engine/integrations/product/applicationProvisionerKit.js";

const FAKE_PROVIDER_KIND = "product.memory-fake";

interface FakeResourceState extends ExistingResource {
  readonly stableKey: string;
  workloadGeneration: number;
  created: boolean;
}

export interface InMemoryApplicationProvisionerOptions {
  readonly capabilities: readonly string[];
  readonly existing?: readonly FakeResourceState[];
}

function stableKey(grant: OrgGrant, capability: string, projectCtx: ProjectContext): string {
  return `${grant.orgId}:${projectCtx.projectId}:${capability}`;
}

export class InMemoryApplicationIntegrationProvisioner implements ApplicationIntegrationProvisioner {
  private readonly capabilities: readonly string[];
  private readonly resources = new Map<string, FakeResourceState>();

  constructor(options: InMemoryApplicationProvisionerOptions) {
    this.capabilities = options.capabilities;
    for (const resource of options.existing ?? []) {
      this.resources.set(resource.id, resource);
    }
  }

  capability(): CapabilityId[] {
    return [...this.capabilities];
  }

  plan(requirement: IntegrationRequirementV1, projectCtx: ProjectContext): ProductProvisionPlan {
    return deriveProductProvisionPlan(requirement, projectCtx, {
      providerKind: FAKE_PROVIDER_KIND,
      capabilities: this.capabilities,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async discover(_grant: OrgGrant, _projectCtx: ProjectContext): Promise<ExistingResource[]> {
    return [...this.resources.values()].map((resource) => ({
      id: resource.id,
      label: resource.label,
      metadata: resource.metadata,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async provision(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const key = stableKey(grant, plan.capability, projectCtx);
    const existing = [...this.resources.values()].find((resource) => resource.stableKey === key);
    const resource = existing ?? this.create(key, plan.desiredResourceName);
    return this.artifactFor(resource, plan);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async bind(
    grant: OrgGrant,
    existingResourceId: string,
    plan: ProductProvisionPlan,
    _projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const resource = this.resources.get(existingResourceId);
    if (resource === undefined) {
      throw new ProductProvisionFailedError("bind", `cannot bind unknown resource '${existingResourceId}'`);
    }
    return this.artifactFor({ ...resource, created: false }, plan);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async observe(grant: OrgGrant, projectCtx: ProjectContext): Promise<ApplicationObservation> {
    const key = stableKey(grant, grant.eligibleOperation.capability, projectCtx);
    const resource = [...this.resources.values()].find((r) => r.stableKey === key);
    return resource === undefined
      ? { present: false, drift: ["resource absent"] }
      : { present: true, externalResourceId: resource.id, drift: [] };
  }

  async reconcile(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    return this.provision(grant, plan, projectCtx);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rotate(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    const key = stableKey(grant, plan.capability, projectCtx);
    const resource = [...this.resources.values()].find((r) => r.stableKey === key);
    if (resource === undefined) {
      throw new ProductProvisionFailedError("rotate", "cannot rotate a resource that does not exist");
    }
    resource.workloadGeneration += 1;
    return this.artifactFor(resource, plan);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async teardown(grant: OrgGrant, projectCtx: ProjectContext): Promise<void> {
    const key = stableKey(grant, grant.eligibleOperation.capability, projectCtx);
    const resource = [...this.resources.values()].find((r) => r.stableKey === key);
    if (resource === undefined) {
      return;
    }
    if (!resource.created) {
      throw new ProductProvisionFailedError("teardown", `refusing to tear down adopted resource '${resource.id}'`);
    }
    this.resources.delete(resource.id);
  }

  private create(key: string, name: string): FakeResourceState {
    const id = `${FAKE_PROVIDER_KIND}:${this.resources.size + 1}`;
    const resource: FakeResourceState = {
      id,
      label: name,
      metadata: { stableKey: key },
      stableKey: key,
      workloadGeneration: 1,
      created: true,
    };
    this.resources.set(id, resource);
    return resource;
  }

  private artifactFor(resource: FakeResourceState, plan: ProductProvisionPlan): ProvisionedApplicationArtifact {
    return {
      providerKind: FAKE_PROVIDER_KIND,
      adapterVersion: PRODUCT_ADAPTER_VERSION,
      externalResourceId: resource.id,
      externalResourceName: resource.label,
      ownership: resource.created ? "created" : "adopted",
      outputs: plan.bindingOutputs.map((output) => resolveGenericOutput(output, resource.id)),
      receipt: { workloadGeneration: String(resource.workloadGeneration) },
    };
  }
}

/** Resolve any product output: secret_ref → a scoped coordinate; else a plain value. */
function resolveGenericOutput(output: AppBindingOutputV1, resourceId: string): ResolvedApplicationOutput {
  if (output.classification === "secret_ref") {
    return {
      output,
      secretSource: { ref: `secret://fake/${resourceId}/${output.logicalKey}/g/1`, generation: 1 },
    };
  }
  return { output, plainValue: `${output.logicalKey.toLowerCase()}-${resourceId}` };
}

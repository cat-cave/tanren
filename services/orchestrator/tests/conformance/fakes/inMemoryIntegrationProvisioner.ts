// In-memory IntegrationProvisioner fake — a TEST FIXTURE (tests/ only) that
// satisfies the contract behaviorally so the conformance suite has something real
// to drive. It models a provider with a small set of pre-existing resources
// (brownfield discovery) and an idempotent find-or-create keyed on the project's
// stable name (re-running provision never creates a second resource). No external
// I/O: everything lives in a Map. This is the shape a real provider's behavior is
// held to — NOT a production stub (it never reaches a production src/ path).

import type {
  CapabilityId,
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../../../src/engine/contracts/integrationProvisioner.js";
import type { IntegrationStateWriter } from "../../../src/engine/contracts/integrationStateWriter.js";
import { runProvisioningLifecycle } from "../../../src/engine/integrations/provisioningPersistence.js";

export interface InMemoryProvisionerOptions {
  /** The capability id(s) this fake satisfies (default ["errors"]). */
  capabilities?: CapabilityId[];
  /** Pre-existing provider resources for brownfield discover() (default none). */
  existing?: ExistingResource[];
}

export interface InMemoryProvisioningReconciliation {
  writer: IntegrationStateWriter;
  reconciliationId: string;
  claimOwner: string;
  leaseMs: number;
  grant: OrgGrant;
  projectCtx: ProjectContext;
}

export type InMemoryProvisioningReconciliationResult =
  | { status: "not_claimed" }
  | { status: "completed"; artifact: ProvisionedArtifact };

/**
 * A behavioral IntegrationProvisioner over an in-memory resource set. `provision`
 * is find-or-create keyed on the project name (the stable idempotency key); `bind`
 * links a discovered resource by id; `discover` lists the current set; `teardown`
 * removes the artifact's created resource.
 */
export class InMemoryIntegrationProvisioner implements IntegrationProvisioner {
  private readonly capabilities: CapabilityId[];
  private readonly resources = new Map<string, ExistingResource>();

  constructor(options: InMemoryProvisionerOptions = {}) {
    this.capabilities = options.capabilities ?? ["errors"];
    for (const resource of options.existing ?? []) {
      this.resources.set(resource.id, resource);
    }
  }

  capability(): CapabilityId[] {
    return [...this.capabilities];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async discover(_grant: OrgGrant): Promise<ExistingResource[]> {
    return [...this.resources.values()];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const stableId = `${grant.providerKind}:${projectCtx.projectId}`;
    // Find-or-create: a second provision for the same project returns the SAME
    // resource (idempotent) rather than creating a duplicate.
    if (!this.resources.has(stableId)) {
      this.resources.set(stableId, {
        id: stableId,
        label: projectCtx.name ?? projectCtx.projectId,
        metadata: { stack: projectCtx.stack ?? "unknown" },
      });
    }
    return this.artifactFor(stableId, grant);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async bind(grant: OrgGrant, existingResourceId: string, _projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    if (!this.resources.has(existingResourceId)) {
      throw new Error(`cannot bind unknown resource '${existingResourceId}'`);
    }
    return this.artifactFor(existingResourceId, grant);
  }

  /**
   * Fixture data-plane path: external provider state lives in this fake, while
   * every durable reconciliation transition goes through the writer seam. The
   * fake intentionally exposes no query/direct-lifecycle mutation method.
   */
  async reconcile(input: InMemoryProvisioningReconciliation): Promise<InMemoryProvisioningReconciliationResult> {
    const lifecycle = await runProvisioningLifecycle({
      writer: input.writer,
      claim: {
        orgId: input.projectCtx.orgId,
        reconciliationId: input.reconciliationId,
        claimOwner: input.claimOwner,
        leaseMs: input.leaseMs,
      },
      work: () => this.provision(input.grant, input.projectCtx),
      completion: () => ({ status: "succeeded" }),
      stateUnknown: { failureClassification: "fake_provider_or_persistence_unknown" },
    });
    return lifecycle.status === "not_claimed" ? lifecycle : { status: "completed", artifact: lifecycle.result };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async teardown(artifact: ProvisionedArtifact): Promise<void> {
    const id = artifact.projectConfig?.["resourceId"];
    if (typeof id === "string") {
      this.resources.delete(id);
    }
  }

  private artifactFor(resourceId: string, grant: OrgGrant): ProvisionedArtifact {
    return {
      projectConfig: { resourceId, providerKind: grant.providerKind },
      // A managed secret REF (never a value) — the artifact carries refs only.
      secretRefs: { dsn: `secret://${resourceId}/dsn` },
      inboxSource: { kind: "errors", config: { resourceId } },
    };
  }
}

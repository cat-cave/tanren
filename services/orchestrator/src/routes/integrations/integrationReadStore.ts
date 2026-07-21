// in-20 — the DB read side of the integration HTTP read surface. Every query
// runs on the caller-provided org-scoped client (RLS confines reads to the
// caller's org → a cross-org request sees ZERO rows), is read-only (no writes,
// no state mutation), and decodes each row through the contract's Zod schemas
// so an off-shape DB row fails closed (the route handler surfaces 500, never a
// laundered or partial body). REDACTION is structural: the requirement response
// omits the raw `desired_state` JSONB (its canonical source is identified by
// `sourceDigest`).
//
// The heavier binding + delivery reads live in their own modules
// (`integrationBindingsRead.ts`, `deliveryReadStore.ts`) so each store file
// stays under the 500-line ceiling. This module owns the simpler lifecycle,
// requirement, and capability-node reads and re-exports the heavier ones so
// the route layer has a single import surface.

import { IntegrationLifecycleInventoryStore } from "../../engine/repositories/integrationLifecycleInventory.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import {
  CapabilityNodeView,
  CapabilityNodesResponse,
  INTEGRATION_READ_SURFACE_VERSION,
  IntegrationLifecycleInventoryResponse,
  IntegrationRequirementsResponse,
  IntegrationRequirementView,
} from "./contract.js";
import { asDate, asNonNegativeInt, asPositiveIntOrNull, type IntegrationReadScope } from "./shared.js";
import { listIntegrationBindings } from "./integrationBindingsRead.js";
import { readDeliveryDagStatus } from "./deliveryReadStore.js";

export type { IntegrationReadScope };

/**
 * Reads the integration lifecycle from the already-shipped inventory store
 * (in-3) and re-shapes to the versioned read response. Returns `undefined` if
 * the project row is absent — the route handler surfaces 404.
 */
export async function readLifecycleInventory(
  client: IntegrationQueryClient,
  scope: IntegrationReadScope,
): Promise<IntegrationLifecycleInventoryResponse | undefined> {
  const inventory = await IntegrationLifecycleInventoryStore.getForProject(client, scope.orgId, scope.projectId, {
    kind: "operator",
    id: "integration-read-surface",
  });
  if (inventory === undefined) return undefined;
  return IntegrationLifecycleInventoryResponse.parse({
    version: INTEGRATION_READ_SURFACE_VERSION,
    orgId: scope.orgId,
    projectId: scope.projectId,
    requirements: inventory.requirements,
    capabilityNodes: inventory.capabilityNodes,
    bindings: inventory.bindings,
    deliveries: inventory.deliveries,
  });
}

/** Reads the project's integration_requirements lifecycle rows. */
export async function listIntegrationRequirements(
  client: IntegrationQueryClient,
  scope: IntegrationReadScope,
): Promise<IntegrationRequirementsResponse> {
  const result = await client.query(
    `SELECT id, capability, plane, direction, source_kind, source_revision_id,
            source_digest, policy_version, criticality, status, superseded_by, created_at
       FROM integration_requirements
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at DESC, id`,
    [scope.orgId, scope.projectId],
  );
  const requirements = (result.rows as Record<string, unknown>[]).map((row) =>
    IntegrationRequirementView.parse({
      requirementId: row["id"],
      capability: row["capability"],
      plane: row["plane"],
      direction: row["direction"],
      sourceKind: row["source_kind"],
      sourceRevisionId: row["source_revision_id"],
      sourceDigest: row["source_digest"],
      policyVersion: row["policy_version"],
      criticality: row["criticality"],
      status: row["status"],
      supersededBy: row["superseded_by"],
      createdAt: asDate(row["created_at"]),
    }),
  );
  return IntegrationRequirementsResponse.parse({
    version: INTEGRATION_READ_SURFACE_VERSION,
    orgId: scope.orgId,
    projectId: scope.projectId,
    requirements,
  });
}

/** Reads the project's capability_nodes lifecycle rows. */
export async function listCapabilityNodes(
  client: IntegrationQueryClient,
  scope: IntegrationReadScope,
): Promise<CapabilityNodesResponse> {
  const result = await client.query(
    `SELECT id, requirement_id, environment, executor_kind, desired_state_hash,
            status, wait_reason, priority, generation, created_at, updated_at
       FROM capability_nodes
      WHERE org_id = $1 AND project_id = $2
      ORDER BY priority DESC, id`,
    [scope.orgId, scope.projectId],
  );
  const capabilityNodes = (result.rows as Record<string, unknown>[]).map((row) =>
    CapabilityNodeView.parse({
      nodeId: row["id"],
      requirementId: row["requirement_id"],
      environment: row["environment"],
      executorKind: row["executor_kind"],
      desiredStateHash: row["desired_state_hash"],
      status: row["status"],
      waitReason: row["wait_reason"],
      priority: asNonNegativeInt(row["priority"]),
      generation: asPositiveIntOrNull(row["generation"]) ?? 1,
      createdAt: asDate(row["created_at"]),
      updatedAt: asDate(row["updated_at"]),
    }),
  );
  return CapabilityNodesResponse.parse({
    version: INTEGRATION_READ_SURFACE_VERSION,
    orgId: scope.orgId,
    projectId: scope.projectId,
    capabilityNodes,
  });
}

export { listIntegrationBindings, readDeliveryDagStatus };

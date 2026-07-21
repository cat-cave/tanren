import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { IntegrationOperationTarget, IntegrationPrivilegedOperation } from "../contracts/integrationAuthority.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { PgIntegrationAuthority } from "../integrations/integrationAuthorityImpl.js";
import { IntegrationConnectionsStore } from "../repositories/integrationConnections.js";
import { systemActor } from "../state/actor.js";
// Re-exported so mq-13's group-delivery deployer imports the deploy grant helpers AND the audit
// envelope from ONE module (the max-dependencies cap).
export { deployAuditEnvelope } from "./deployOnMergeReads.js";

interface DeployAuthorityTarget {
  provider: string;
  orgId: string;
}

/** Issue one fresh exact-operation deploy grant immediately before its stage. */
export async function loadDeployOperationGrant(
  pool: pg.Pool,
  projectId: string,
  target: DeployAuthorityTarget,
  operation: IntegrationPrivilegedOperation,
  operationTarget: IntegrationOperationTarget,
): Promise<OrgGrant | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const resolution = await new PgIntegrationAuthority().authorizeOperation(client, {
      orgId: target.orgId,
      projectId,
      providerKind: target.provider,
      capability: "deploy",
      operation,
      target: operationTarget,
      actor: systemActor,
    });
    if (resolution.status === "selection_required") {
      throw new Error(
        `deployOnMerge: project '${projectId}' requires an explicit active '${target.provider}' account selection (${resolution.reason})`,
      );
    }
    if (resolution.status === "ineligible") {
      throw new Error(
        `deployOnMerge: project '${projectId}' deploy grant ineligible for '${operation}' (${resolution.reasons.join(",")})`,
      );
    }
    return resolution.status === "eligible"
      ? IntegrationConnectionsStore.orgGrantFromLease(resolution.lease)
      : undefined;
  });
}

export function missingDeployGrantError(
  projectId: string,
  target: DeployAuthorityTarget,
  operation: IntegrationPrivilegedOperation,
): Error {
  return new Error(
    `deployOnMerge: project '${projectId}' configures deploy '${target.provider}' but org ` +
      `'${target.orgId}' has no matching grant eligible for '${operation}' in the active connection authority`,
  );
}

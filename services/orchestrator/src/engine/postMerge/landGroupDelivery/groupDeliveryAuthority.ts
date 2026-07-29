// Group-delivery authority seam.  Provider effects receive a grant only after this
// boundary resolves the exact, org-scoped operation; it never invents a grant.

import type pg from "pg";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../contracts/integrationAuthority.js";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import { loadDeployOperationGrant, missingDeployGrantError } from "../deployOnMergeAuthority.js";
import type { GroupDeliveryPlan, ResolvedGroupDeployTarget } from "./groupDeliveryCore.js";

export interface GroupDeliveryAuthority {
  require(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    operation: IntegrationPrivilegedOperation,
    operationTarget: IntegrationOperationTarget,
  ): Promise<OrgGrant>;
}

/** Resolves one fresh, exact-operation grant immediately before its external effect. */
export class PgGroupDeliveryAuthority implements GroupDeliveryAuthority {
  constructor(private readonly pool: pg.Pool) {}

  async require(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    operation: IntegrationPrivilegedOperation,
    operationTarget: IntegrationOperationTarget,
  ): Promise<OrgGrant> {
    const grant = await loadDeployOperationGrant(
      this.pool,
      plan.projectId,
      { provider: target.provider, orgId: plan.orgId },
      operation,
      operationTarget,
    );
    if (grant === undefined) {
      throw missingDeployGrantError(plan.projectId, { provider: target.provider, orgId: plan.orgId }, operation);
    }
    return grant;
  }
}

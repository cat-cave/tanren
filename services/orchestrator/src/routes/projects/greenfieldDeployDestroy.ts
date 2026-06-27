// DERIVE TRANSACTIONAL ROLLBACK — the greenfield deploy-DESTROY companion to
// `prepareGreenfieldDeploy` (task #78). The derive registers a compensation for
// each deploy app it provisions; this is the route-layer wiring that resolves
// the org grant and delegates to `DeployProvisioner.destroyApp` (which itself
// resolves the org token + delegates to Vercel/Fly delete primitives).
// IDEMPOTENT: an app that no longer exists is a successful no-op.
//
// NEVER call this from a regular run path — deploy-app destruction is
// irreversible and exists ONLY to compensate a partially-failed derive.

import type pg from "pg";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  buildIntegrationProvisioner,
  type IntegrationProvisioner,
} from "../../engine/contracts/integrationProvisioner.js";
import { OrgIntegrationsStore } from "../../engine/repositories/orgIntegrations.js";
import { productionProvisionerDeps } from "../../engine/integrations/provisioningEngine.js";
import { DeployProvisioner } from "../../engine/provisioners/deployProvisioner.js";

export interface GreenfieldDeployDestroyDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  orgId: string;
  actorId: string;
  target: { providerKind: "deploy.vercel" | "deploy.flyio"; appId: string };
}

/**
 * Destroy a greenfield-provisioned deploy app via `DeployProvisioner.destroyApp`.
 * IDEMPOTENT — an app that no longer exists is a successful no-op (the contract).
 * A missing grant (the org's deploy integration was unlinked between provision +
 * rollback) is a LOUD throw — the rollback gap surfaces on the derive error so
 * the operator sees exactly which resource may be orphaned. Production-only
 * (the in-memory test fakes inject their own destroy closures).
 */
export async function destroyGreenfieldDeployApp(deps: GreenfieldDeployDestroyDeps): Promise<void> {
  const { pool, secrets, orgId, actorId, target } = deps;
  const grant = await OrgIntegrationsStore.getGrant(pool, orgId, target.providerKind, {
    kind: "operator",
    id: actorId,
  });
  if (grant === undefined) {
    throw new Error(
      `${target.providerKind}: cannot destroy deploy app '${target.appId}' — the org grant is gone ` +
        `(unlinked between provision + rollback). The deploy app may be orphaned and need manual cleanup.`,
    );
  }
  const provisioner: IntegrationProvisioner = buildIntegrationProvisioner(
    target.providerKind,
    productionProvisionerDeps(secrets),
  );
  if (!(provisioner instanceof DeployProvisioner)) {
    throw new Error(
      `${target.providerKind}: registry returned a non-DeployProvisioner — cannot destroy deploy app ` +
        `'${target.appId}' (rollback impossible; resource may be orphaned).`,
    );
  }
  await provisioner.destroyApp(grant, target.appId);
}

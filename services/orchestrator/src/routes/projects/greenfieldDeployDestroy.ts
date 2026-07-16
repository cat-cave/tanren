// DERIVE TRANSACTIONAL ROLLBACK — the greenfield deploy-DESTROY companion to
// `prepareGreenfieldDeploy` (task #78). The derive registers a compensation for
// each deploy app it provisions; this is the route-layer wiring that resolves
// the org grant via authorizeOperation and delegates to `DeployProvisioner.destroyApp`.
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
import { productionProvisionerDeps } from "../../engine/integrations/provisioningEngine.js";
import { DeployProvisioner } from "../../engine/provisioners/deployProvisioner.js";
import { authorizeGreenfieldDeploy } from "./greenfieldDeployAuthority.js";

export interface GreenfieldDeployDestroyDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  orgId: string;
  projectId: string;
  actorId: string;
  /**
   * Carries BOTH `appId` and `appName` (audit finding D4): Vercel keys destroy by
   * id, Fly by name. The two are distinct under Fly's `listApps` shape (which
   * returns `appId: app.id ?? app.name`), so dropping one silently mis-routes
   * the DELETE and lets the 404 swallow hide the gap.
   */
  target: {
    providerKind: "deploy.vercel" | "deploy.flyio";
    appId: string;
    appName: string;
    connectionId: string;
    grantId: string;
  };
}

/**
 * Destroy a greenfield-provisioned deploy app via `DeployProvisioner.destroyApp`.
 * Uses authorizeOperation after project selection — never naked grant resolve.
 */
export async function destroyGreenfieldDeployApp(deps: GreenfieldDeployDestroyDeps): Promise<void> {
  const { pool, secrets, orgId, projectId, actorId, target } = deps;
  const resolved = await authorizeGreenfieldDeploy({
    client: pool,
    orgId,
    projectId,
    providerKind: target.providerKind,
    actorId,
    operation: "teardown",
  });
  if ("status" in resolved) {
    throw new Error(
      `${target.providerKind}: cannot destroy deploy app '${target.appName}' (id '${target.appId}') — ` +
        `authorizeOperation returned ${resolved.status}. The deploy app may be orphaned and need manual cleanup.`,
    );
  }
  const grant = resolved;
  if (grant.connectionId !== target.connectionId || grant.grantId !== target.grantId) {
    throw new Error(
      `${target.providerKind}: selected grant does not match destroy target connection/grant — refusing teardown`,
    );
  }
  const provisioner: IntegrationProvisioner = buildIntegrationProvisioner(
    target.providerKind,
    productionProvisionerDeps(secrets),
  );
  if (!(provisioner instanceof DeployProvisioner)) {
    throw new Error(
      `${target.providerKind}: registry returned a non-DeployProvisioner — cannot destroy deploy app ` +
        `'${target.appName}' (id '${target.appId}'; rollback impossible; resource may be orphaned).`,
    );
  }
  await provisioner.destroyApp(grant, { appId: target.appId, appName: target.appName });
}

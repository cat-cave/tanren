// Boot wiring for the FLY-MACHINE ORPHAN SWEEPER (apex-v96 guard). Constructs the
// concrete reconciler ports over the runtime pool + deploy transport + secrets, then
// starts the durable out-of-band Fly-machine reconciler.
//
// ALWAYS ON (cheap when idle): unlike the runner-row sweeper (gated on the allocator
// kind), this sweeper needs no gate — its live-deployment enumeration is a single
// system-scope SELECT that returns ZERO rows when no Fly deployment is live, so the
// tick is a clean no-op on any stack with no Fly product. Wiring it unconditionally
// keeps the apex-v96 guard live whenever a Fly deploy exists.

import type pg from "pg";
import { runWithSystemScope } from "@tanren/db";
import type { SecretStore } from "../contracts/secretStore.js";
import { PgEventStore } from "../eventStore.js";
import { EventReapFailureReporter } from "../deploy/reapFailureReporter.js";
import { fetchDeployTransport } from "../provisioners/deployTransport.js";
import { deployProvisionerFor } from "../workflow/deployProvisionerFor.js";
import { FLY_PROVIDER_KIND } from "../provisioners/flyDeployProvisioner.js";
import {
  FlyMachineOrphanSweeper,
  type LiveFlyDeployment,
  type LiveFlyDeploymentSource,
  type FlyReapGrantResolver,
} from "../provisioners/flyMachineOrphanSweeper.js";
import { loadDeployOperationGrant } from "../postMerge/deployOnMergeAuthority.js";

export type { FlyMachineOrphanSweeper } from "../provisioners/flyMachineOrphanSweeper.js";

export interface BuildFlyMachineOrphanSweeperDeps {
  pool: pg.Pool;
  secrets: SecretStore;
}

interface LiveFlyDeploymentRow {
  org_id: string;
  project_id: string;
  app_id: string;
  deployment_id: string;
}

/** The system-scope live-Fly-deployment enumeration (cross-tenant; RLS-bypassing read). */
function pgLiveFlyDeploymentSource(pool: pg.Pool): LiveFlyDeploymentSource {
  return {
    async list(): Promise<LiveFlyDeployment[]> {
      return runWithSystemScope(pool, async (client) => {
        const result = await client.query<LiveFlyDeploymentRow>(
          `SELECT org_id, project_id, app_id, deployment_id
             FROM release_instances
            WHERE provider = $1 AND state = 'live' AND environment = 'production'`,
          [FLY_PROVIDER_KIND],
        );
        return result.rows.map((row) => ({
          orgId: row.org_id,
          projectId: row.project_id,
          appId: row.app_id,
          deploymentId: row.deployment_id,
        }));
      });
    },
  };
}

/** Resolve a fresh per-deployment Fly deploy grant via the integration authority. */
function pgFlyReapGrantResolver(pool: pg.Pool): FlyReapGrantResolver {
  return {
    async resolve(deployment: LiveFlyDeployment) {
      return loadDeployOperationGrant(
        pool,
        deployment.projectId,
        { provider: FLY_PROVIDER_KIND, orgId: deployment.orgId },
        "verify",
        { resourceId: deployment.appId, deploymentId: deployment.deploymentId },
      );
    },
  };
}

/**
 * Build + start the Fly-machine orphan sweeper. The returned handle's `stop()` is
 * folded into the worker's drain (mirrors `startRunnerRowOrphanSweeper`).
 */
export function startFlyMachineOrphanSweeper(deps: BuildFlyMachineOrphanSweeperDeps): FlyMachineOrphanSweeper {
  const sweeper = new FlyMachineOrphanSweeper({
    liveDeployments: pgLiveFlyDeploymentSource(deps.pool),
    grants: pgFlyReapGrantResolver(deps.pool),
    provisioner: deployProvisionerFor(FLY_PROVIDER_KIND, {
      transport: fetchDeployTransport(),
      secrets: deps.secrets,
    }),
    reporter: new EventReapFailureReporter(new PgEventStore(deps.pool)),
  });
  sweeper.start();
  return sweeper;
}

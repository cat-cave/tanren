// Production factory for the delivery DAG driver — a thin wiring seam so the
// autonomy-loops boot imports ONE symbol (mirrors buildDeployOnMergeWatcher /
// buildDemoOnDeployWatcher, keeping that boot file under its dependency cap).

import type pg from "pg";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { VaultTokenMinter } from "../../contracts/vaultTokenMinter.js";
import { orgScopingPool } from "../../data/orgScopedDb.js";
import { PgEventStore } from "../../eventStore.js";
import { ReconciliationSagaDriver } from "../../integrations/reconciliationSaga.js";
import type { RunMergeWatcher } from "../subscriber.js";
import { DeliveryDagDriver } from "./deliveryDagDriver.js";
import { contentAddressedEvidenceSigner } from "./deliveryEvidence.js";
import { PgDeliverySignals } from "./deliverySignals.js";

export function buildDeliveryDagDriver(deps: {
  pool: pg.Pool;
  secrets: SecretStore;
  /** The idempotent deploy-on-merge watcher — the delivery DAG's deploy-cluster effect runner. */
  deployWatcher: RunMergeWatcher;
  /** The idempotent demo-on-deploy watcher — the delivery DAG's demo-cluster effect runner. */
  demoWatcher: RunMergeWatcher;
  runStateWriter?: RunStateWriter;
  /** Optional activation-scoped Vault lease minter; absent ⇒ mint_lease no-ops unless product secrets exist. */
  minter?: VaultTokenMinter;
}): DeliveryDagDriver {
  // Wrap the pool with `orgScopingPool` so the delivery-evidence appends (which run under
  // `runWithJobOrgId`) resolve the job-org scope and satisfy RLS on `events` (mirrors the
  // jobReaper eventStore). A control-plane `runStateWriter` scopes its own writes.
  const eventStore = deps.runStateWriter ?? new PgEventStore(orgScopingPool(deps.pool));
  const saga = new ReconciliationSagaDriver(deps.pool);
  return new DeliveryDagDriver({
    pool: deps.pool,
    signals: new PgDeliverySignals(deps.pool),
    deployRunner: deps.deployWatcher,
    demoRunner: deps.demoWatcher,
    saga,
    evidence: { eventStore, signer: contentAddressedEvidenceSigner },
    ...(deps.minter !== undefined && { minter: deps.minter }),
  });
}

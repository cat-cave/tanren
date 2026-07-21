// mq-13 production factory for the LandGroupDeliveryLoop — a thin composition root so the
// autonomy-loops boot imports ONE symbol (keeps that file under the dependency cap; mirrors
// buildDeliveryDagDriver / buildMergeTrainArtifactWatcher). It wires the REAL deployer
// (DeployAdapter SP-6 lifecycle + ProofBackedWebDemo) + the conservative-but-honest attribution
// (causal-replay-gated mq-10 repair routing).

import type pg from "pg";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { fetchDeployTransport, type SecretStore } from "../deployOnMergeDeployDeps.js";
import { contentAddressedEvidenceSigner } from "../delivery/deliveryEvidence.js";
import { PgDeliveryBindingSetSealer } from "../delivery/deliveryBindingSet.js";
import { DeliveryRunStore } from "../delivery/deliveryRunStore.js";
import { PgDeliverySignals } from "../delivery/deliverySignals.js";
import { LandGroupDeliveryLoop } from "./landGroupDeliveryLoop.js";
import { groupDeliveryCompletionEvidenceReader, ProductionGroupDeliveryA3Gate } from "./groupDeliveryA3Gate.js";
import { ProductionGroupDeliveryDeployer } from "./groupDeliveryDeployer.js";
import { PgLandGroupDeliveryStore } from "./landGroupDeliveryStore.js";
import { ConservativeGroupCausalReplay, RepairRoutingGroupAttribution } from "./groupRegressionAttribution.js";

export interface BuildLandGroupDeliveryLoopDeps {
  readonly pool: pg.Pool;
  readonly secrets: SecretStore;
  /** Plane-split control-plane writer; when present the delivery events route through it. */
  readonly runStateWriter?: RunStateWriter;
}

/** Build the production LandGroupDeliveryLoop for the worker boot. */
export function buildLandGroupDeliveryLoop(deps: BuildLandGroupDeliveryLoopDeps): LandGroupDeliveryLoop {
  const eventStore: EventStore = deps.runStateWriter ?? new PgEventStore(deps.pool);
  // ONE shared store: the loop's claim/heartbeat/finalize AND the deployer's intent markers key on
  // the SAME land_group_delivery_loops row (the intent write is fenced on the loop's claim token).
  const store = new PgLandGroupDeliveryStore(deps.pool);
  const deployer = new ProductionGroupDeliveryDeployer({
    pool: deps.pool,
    secrets: deps.secrets,
    transport: fetchDeployTransport(),
    eventStore,
    intentStore: store,
  });
  const a3Gate = new ProductionGroupDeliveryA3Gate({
    store: new DeliveryRunStore(deps.pool),
    bindingSetSealer: new PgDeliveryBindingSetSealer(deps.pool),
    signals: new PgDeliverySignals(deps.pool),
    evidence: { eventStore, signer: contentAddressedEvidenceSigner },
    completionEvidenceExists: groupDeliveryCompletionEvidenceReader(deps.pool),
  });
  const attribution = new RepairRoutingGroupAttribution(new ConservativeGroupCausalReplay(), {
    pool: deps.pool,
    events: eventStore,
  });
  return new LandGroupDeliveryLoop({ pool: deps.pool, deployer, a3Gate, attribution, store });
}

// Focused production composition for the group A3 gate. Keeping the delivery
// proof dependencies here lets the outer group-loop factory stay beneath the
// architectural import cap.

import type pg from "pg";
import type { EventStore } from "../../eventStore.js";
import { contentAddressedEvidenceSigner } from "../delivery/deliveryEvidence.js";
import { PgDeliveryBindingSetSealer } from "../delivery/deliveryBindingSet.js";
import {
  IntegrationEvidenceAttester,
  type IntegrationEvidenceDsseSigner,
} from "../delivery/integrationEvidenceAttester.js";
import { PgIntegrationEvidenceReaders } from "../delivery/integrationEvidence.js";
import { PgIntegrationRuntimeAttachmentRecorder } from "../delivery/integrationRuntimeAttachment.js";
import { DeliveryRunStore } from "../delivery/deliveryRunStore.js";
import { PgDeliverySignals } from "../delivery/deliverySignals.js";
import { groupDeliveryCompletionEvidenceReader, ProductionGroupDeliveryA3Gate } from "./groupDeliveryA3Gate.js";

export function buildGroupDeliveryA3Gate(input: {
  readonly pool: pg.Pool;
  readonly eventStore: EventStore;
  readonly proofSubstrate: IntegrationEvidenceDsseSigner;
}): ProductionGroupDeliveryA3Gate {
  return new ProductionGroupDeliveryA3Gate({
    store: new DeliveryRunStore(input.pool),
    bindingSetSealer: new PgDeliveryBindingSetSealer(input.pool),
    runtimeAttachmentRecorder: new PgIntegrationRuntimeAttachmentRecorder(input.pool, input.eventStore),
    signals: new PgDeliverySignals(input.pool),
    integrationEvidenceAttester: new IntegrationEvidenceAttester(
      input.pool,
      new PgIntegrationEvidenceReaders(input.pool),
      input.proofSubstrate,
    ),
    evidence: { eventStore: input.eventStore, signer: contentAddressedEvidenceSigner },
    completionEvidenceExists: groupDeliveryCompletionEvidenceReader(input.pool),
  });
}

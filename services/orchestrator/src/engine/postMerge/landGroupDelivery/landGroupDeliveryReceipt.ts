// mq-13 receipt assembly — folds a terminal group-delivery outcome + its plan into the
// strict, frozen `LandGroupDeliveryReceiptV1`. Pure (DB-free), so the receipt shape is
// unit-testable and the store simply persists what this builds.

import {
  landGroupDeliveryIdempotencyKey,
  LAND_GROUP_DELIVERY_SCHEMA_VERSION,
  type LandGroupDeliveryReceiptV1,
  validateLandGroupDeliveryReceipt,
} from "../../contracts/landGroupDeliveryReceipt.js";
import type { GroupDeliveryOutcome, GroupDeliveryPlan } from "./groupDeliveryCore.js";

/** Assemble + strictly validate the receipt for a terminal group delivery. */
export function buildDeliveryReceipt(
  plan: GroupDeliveryPlan,
  outcome: GroupDeliveryOutcome,
): LandGroupDeliveryReceiptV1 {
  return validateLandGroupDeliveryReceipt({
    version: 1,
    schemaVersion: LAND_GROUP_DELIVERY_SCHEMA_VERSION,
    orgId: plan.orgId,
    projectId: plan.projectId,
    landGroupId: plan.landGroupId,
    mainSha: plan.mainSha,
    memberRunIds: [...plan.memberRunIds],
    artifactDigest: outcome.artifactDigest,
    previewReleaseInstanceId: outcome.previewReleaseInstanceId,
    productionReleaseInstanceId: outcome.productionReleaseInstanceId,
    rollbackReleaseInstanceId: outcome.rollbackReleaseInstanceId,
    state: outcome.state,
    disposition: outcome.disposition,
    attributedRunId: outcome.attributedRunId,
    idempotencyKey: landGroupDeliveryIdempotencyKey(plan.landGroupId, plan.mainSha),
  });
}

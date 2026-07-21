// mq-13 — the frozen LandGroupDeliveryReceiptV1 strict-schema + internal-invariant validation.

import { describe, expect, it } from "vitest";
import {
  landGroupDeliveryIdempotencyKey,
  LAND_GROUP_DELIVERY_SCHEMA_VERSION,
  LandGroupDeliveryReceiptInvalidError,
  validateLandGroupDeliveryReceipt,
} from "../src/engine/contracts/landGroupDeliveryReceipt.js";
import { buildDeliveryReceipt } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryReceipt.js";
import type {
  GroupDeliveryOutcome,
  GroupDeliveryPlan,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

const PLAN: GroupDeliveryPlan = {
  orgId: "org-1",
  projectId: "proj-1",
  landGroupId: "lg-1",
  mainSha: "sha-main",
  tailRunId: "run-tail",
  tailSpecId: "spec-tail",
  memberRunIds: ["run-a", "run-tail"],
  memberSpecIds: ["spec-a", "spec-tail"],
};
const DIGEST = `sha256:${"a".repeat(64)}`;

function completedOutcome(): GroupDeliveryOutcome {
  return {
    state: "completed",
    disposition: "none",
    artifactDigest: DIGEST,
    previewReleaseInstanceId: "rel-preview",
    productionReleaseInstanceId: "rel-prod",
    rollbackReleaseInstanceId: null,
    attributedRunId: null,
  };
}

describe("LandGroupDeliveryReceiptV1", () => {
  it("builds a strict, frozen completed receipt with the ordered member run ids", () => {
    const receipt = buildDeliveryReceipt(PLAN, completedOutcome());
    expect(receipt.schemaVersion).toBe(LAND_GROUP_DELIVERY_SCHEMA_VERSION);
    expect(receipt.version).toBe(1);
    expect(receipt.memberRunIds).toEqual(["run-a", "run-tail"]);
    expect(receipt.idempotencyKey).toBe(landGroupDeliveryIdempotencyKey("lg-1", "sha-main"));
    expect(receipt.state).toBe("completed");
  });

  it("rejects a completed receipt that lacks a production release id or artifact digest", () => {
    expect(() => buildDeliveryReceipt(PLAN, { ...completedOutcome(), productionReleaseInstanceId: null })).toThrow(
      LandGroupDeliveryReceiptInvalidError,
    );
    expect(() => buildDeliveryReceipt(PLAN, { ...completedOutcome(), artifactDigest: null })).toThrow(
      LandGroupDeliveryReceiptInvalidError,
    );
  });

  it("rejects a rolled_back receipt with no rollback release id", () => {
    expect(() =>
      buildDeliveryReceipt(PLAN, {
        state: "rolled_back",
        disposition: "needs_attention",
        artifactDigest: DIGEST,
        previewReleaseInstanceId: "rel-preview",
        productionReleaseInstanceId: "rel-prod",
        rollbackReleaseInstanceId: null,
        attributedRunId: null,
      }),
    ).toThrow(LandGroupDeliveryReceiptInvalidError);
  });

  it("rejects an unknown key (strict) and a bad artifact digest", () => {
    const base = buildDeliveryReceipt(PLAN, completedOutcome());
    expect(() => validateLandGroupDeliveryReceipt({ ...base, extra: 1 })).toThrow(LandGroupDeliveryReceiptInvalidError);
    expect(() => validateLandGroupDeliveryReceipt({ ...base, artifactDigest: "not-a-digest" })).toThrow(
      LandGroupDeliveryReceiptInvalidError,
    );
  });

  it("round-trips a valid preview_failed receipt", () => {
    const receipt = buildDeliveryReceipt(PLAN, {
      state: "preview_failed",
      disposition: "none",
      artifactDigest: DIGEST,
      previewReleaseInstanceId: "rel-preview",
      productionReleaseInstanceId: null,
      rollbackReleaseInstanceId: null,
      attributedRunId: null,
    });
    expect(validateLandGroupDeliveryReceipt(receipt)).toEqual(receipt);
  });
});

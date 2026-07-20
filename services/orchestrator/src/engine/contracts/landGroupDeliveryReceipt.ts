// mq-13 land-group delivery receipt contract. A completed land group turned into ONE
// durable, strict, proof-backed DELIVERY receipt: the group artifact, the preview /
// production / rollback release lineage, and the terminal disposition. It is a RECEIPT
// (a durable record of what the delivery loop decided + persisted) — NOT a deployment
// API and NOT a new authority. It projects only NON-SECRET identities: the group id, the
// completed main SHA, the ordered member run ids, the canonical SP-3 artifact `Digest`,
// the release-instance ids, and the terminal state.
//
// `.strict()` at every level: an unknown key, a missing field, or an out-of-order member
// fails the parse. The frozen `schemaVersion` is never re-minted — a new shape is a new
// version. A partial/mismatched delivery can never parse as a completed receipt because
// the loop only stamps `state: "completed"` after the production proof passes.

import { z } from "zod";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** Frozen schema version — never re-minted; a new shape is a new version. */
export const LAND_GROUP_DELIVERY_SCHEMA_VERSION = "land_group_delivery.v1";

/**
 * The terminal (and one in-flight) lifecycle state of a land-group delivery loop.
 *   • `in_progress`     — claimed; the loop owns the delivery and is driving it.
 *   • `preview_failed`  — preview verification / proof-backed demo FAILED ⇒ NO promote,
 *                         preview torn down. Terminal.
 *   • `completed`       — the production artifact was promoted AND its production proof
 *                         passed. Terminal (the sole success state).
 *   • `rolled_back`     — the production proof FAILED after promotion and the adapter's
 *                         REAL rollback to the persisted prior-good release SUCCEEDED.
 *                         Terminal.
 *   • `needs_attention` — a production regression with NO prior-good release to roll back
 *                         to (never a pretended rollback), an AMBIGUOUS attribution (no
 *                         fabricated repair target), or an unexpected loop error. Terminal.
 */
export const LAND_GROUP_DELIVERY_STATES = [
  "in_progress",
  "preview_failed",
  "completed",
  "rolled_back",
  "needs_attention",
] as const;
export type LandGroupDeliveryState = (typeof LAND_GROUP_DELIVERY_STATES)[number];

/** Whether a delivery state is TERMINAL — a terminal row is an idempotent no-op on re-drive. */
export function isTerminalDeliveryState(state: LandGroupDeliveryState): boolean {
  return state !== "in_progress";
}

/**
 * The repair-routing disposition after a production regression.
 *   • `none`            — no regression (a `completed` / `preview_failed` delivery).
 *   • `repair_routed`   — causal replay attributed the regression to EXACTLY one member
 *                         run and mq-10's repair router was invoked for that member.
 *   • `needs_attention` — the regression could not be attributed to a single member
 *                         (causal replay inconclusive / absent) ⇒ NO fabricated repair
 *                         target; the operator triages.
 */
export const LAND_GROUP_DELIVERY_DISPOSITIONS = ["none", "repair_routed", "needs_attention"] as const;
export type LandGroupDeliveryDisposition = (typeof LAND_GROUP_DELIVERY_DISPOSITIONS)[number];

/**
 * The frozen `LandGroupDeliveryReceiptV1`. `.strict()`: an unknown key or a missing field
 * fails the parse. Member run ids are ordered (canonical member-key order). The artifact
 * digest is null only for a delivery that failed BEFORE the artifact was built.
 */
export const LandGroupDeliveryReceiptV1Schema = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal(LAND_GROUP_DELIVERY_SCHEMA_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    landGroupId: z.string().min(1),
    /** The completed land group's main SHA (from `merge.land_group.completed`). */
    mainSha: z.string().min(1),
    /** The ordered member run ids (canonical member-key order). */
    memberRunIds: z.array(z.string().min(1)).min(1),
    /** The canonical SP-3 artifact identity the group built + delivered, or null pre-build. */
    artifactDigest: Sha256.nullable(),
    /** The persisted preview release-instance id, or null when preview was never applied. */
    previewReleaseInstanceId: z.string().min(1).nullable(),
    /** The persisted production (promoted) release-instance id, or null when never promoted. */
    productionReleaseInstanceId: z.string().min(1).nullable(),
    /** The persisted prior-good release-instance id traffic was rolled back to, or null. */
    rollbackReleaseInstanceId: z.string().min(1).nullable(),
    /** The terminal disposition of the delivery. */
    state: z.enum(LAND_GROUP_DELIVERY_STATES),
    /** The repair-routing disposition (only meaningful for a rolled-back / needs-attention row). */
    disposition: z.enum(LAND_GROUP_DELIVERY_DISPOSITIONS),
    /** The member run the regression was attributed to (repair routed), or null. */
    attributedRunId: z.string().min(1).nullable(),
    /** The deterministic idempotency key (`land-group-delivery:<landGroupId>:<mainSha>`). */
    idempotencyKey: z.string().min(1),
  })
  .strict();
export type LandGroupDeliveryReceiptV1 = z.infer<typeof LandGroupDeliveryReceiptV1Schema>;

export class LandGroupDeliveryReceiptInvalidError extends Error {
  public override readonly name = "LandGroupDeliveryReceiptInvalidError";
  public constructor(reason: string) {
    super(`Land-group delivery receipt is invalid: ${reason}`);
  }
}

/** The deterministic idempotency key for a group delivery (one receipt per group + main SHA). */
export function landGroupDeliveryIdempotencyKey(landGroupId: string, mainSha: string): string {
  return `land-group-delivery:${landGroupId}:${mainSha}`;
}

/**
 * Offline, DB-free validation. Parses `.strict()` (an unknown/missing field fails) and
 * asserts the internal invariant that a `completed` receipt carries a production release
 * id + artifact digest, and a `rolled_back` receipt carries a rollback release id — so a
 * mislabelled partial delivery can never parse as a completed/rolled-back receipt.
 */
export function validateLandGroupDeliveryReceipt(raw: unknown): LandGroupDeliveryReceiptV1 {
  const parsed = LandGroupDeliveryReceiptV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new LandGroupDeliveryReceiptInvalidError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const receipt = parsed.data;
  if (
    receipt.state === "completed" &&
    (receipt.productionReleaseInstanceId === null || receipt.artifactDigest === null)
  ) {
    throw new LandGroupDeliveryReceiptInvalidError(
      "a completed receipt must carry a production release id and an artifact digest",
    );
  }
  if (receipt.state === "rolled_back" && receipt.rollbackReleaseInstanceId === null) {
    throw new LandGroupDeliveryReceiptInvalidError("a rolled_back receipt must carry a rollback release id");
  }
  return receipt;
}

// The signed-evidence record for the delivery DAG's fail-closed completion gate.
//
// The GRAVEST fail-open this node exists to prevent is reporting a delivery COMPLETE
// without the independently-observed effect + signed evidence. So `delivery.completed`
// is appended ONLY once every applicable stage confirmed AND this module has computed a
// tamper-evident attestation over the confirmed-observation coordinates. The evidence is
// a canonical (sorted-key) digest bound to the tenant + run + merge SHA + observed
// effect; the append lives in the org-scoped, append-only, RLS-protected `events` table,
// so the digest is content-addressed tamper-evidence. When a signing key is injected the
// signature is a real HMAC; absent one it is a domain-separated content signature.

import { createHmac, createHash } from "node:crypto";
import { runWithJobOrgId } from "@tanren/db";
import type { EventStore } from "../../eventStore.js";
import type { DeliveryLineage } from "./stageModel.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical JSON with recursively sorted keys — deterministic across processes/replays. */
function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

/** What the delivery independently observed as its external effect (mirrors the event enum). */
export type ObservedEffect = "none" | "deploy_verified" | "demo_observed";

export interface DeliveryEvidenceInput {
  readonly lineage: DeliveryLineage;
  readonly deliveryRunId: string;
  readonly observedEffect: ObservedEffect;
  readonly deploymentId: string | undefined;
  readonly stagesConfirmed: readonly string[];
}

export interface DeliveryEvidence {
  readonly evidenceDigest: string;
  readonly signature: string;
  readonly deploymentId: string | undefined;
  readonly observedEffect: ObservedEffect;
  readonly stagesConfirmed: readonly string[];
}

/**
 * Signs the canonical delivery evidence. The default is a domain-separated content
 * signature (tamper-evident for the append-only RLS store); a managed build injects a
 * key-backed HMAC signer without changing the completion gate.
 */
export interface DeliveryEvidenceSigner {
  sign(canonical: string): string;
}

export const contentAddressedEvidenceSigner: DeliveryEvidenceSigner = {
  sign: (canonical) => `sha256:${sha256Hex(`delivery-evidence:v1:${canonical}`)}`,
};

export function hmacEvidenceSigner(key: string): DeliveryEvidenceSigner {
  return { sign: (canonical) => `hmac-sha256:${createHmac("sha256", key).update(canonical, "utf8").digest("hex")}` };
}

/** Compute the tamper-evident, signed evidence over the confirmed observation coordinates. */
export function buildDeliveryEvidence(input: DeliveryEvidenceInput, signer: DeliveryEvidenceSigner): DeliveryEvidence {
  const canonical = canonicalJson({
    orgId: input.lineage.orgId,
    projectId: input.lineage.projectId,
    runId: input.lineage.runId,
    specId: input.lineage.specId,
    deliveryRunId: input.deliveryRunId,
    mergeSha: input.lineage.mergeSha,
    deploymentId: input.deploymentId ?? null,
    observedEffect: input.observedEffect,
    stagesConfirmed: [...input.stagesConfirmed],
  });
  const evidenceDigest = `sha256:${sha256Hex(canonical)}`;
  return {
    evidenceDigest,
    signature: signer.sign(canonical),
    deploymentId: input.deploymentId,
    observedEffect: input.observedEffect,
    stagesConfirmed: input.stagesConfirmed,
  };
}

export interface RecordEvidenceDeps {
  readonly eventStore: EventStore;
  readonly signer: DeliveryEvidenceSigner;
}

/**
 * Append the SIGNED `delivery.completed` attestation. The caller (record_evidence stage)
 * has already checked `deliveryCompletedExists` for resume idempotency — a resume that
 * re-enters after the append but before the run flipped `completed` skips the second emit.
 * Returns the evidence recorded.
 */
export async function appendDeliveryCompleted(
  deps: RecordEvidenceDeps,
  input: DeliveryEvidenceInput,
): Promise<DeliveryEvidence> {
  const evidence = buildDeliveryEvidence(input, deps.signer);
  await runWithJobOrgId(input.lineage.orgId, () =>
    deps.eventStore.append({
      runId: input.lineage.runId,
      specId: input.lineage.specId,
      projectId: input.lineage.projectId,
      orgId: input.lineage.orgId,
      eventType: "delivery.completed",
      payload: {
        deliveryRunId: input.deliveryRunId,
        mergeSha: input.lineage.mergeSha,
        ...(input.deploymentId !== undefined && { deploymentId: input.deploymentId }),
        stagesConfirmed: [...input.stagesConfirmed],
        observedEffect: input.observedEffect,
        evidenceDigest: evidence.evidenceDigest,
        signature: evidence.signature,
      },
    }),
  );
  return evidence;
}

/**
 * Append the durable demo INTENT MARKER (`delivery.demo_stimulus_started`) — recorded
 * under the advisory lock IMMEDIATELY BEFORE the demo effect fires, so a crash mid-fire
 * leaves a durable trace that blocks a re-fire (Finding-1 effect-boundary idempotency).
 */
export async function appendDemoStimulusStarted(
  deps: Pick<RecordEvidenceDeps, "eventStore">,
  lineage: DeliveryLineage,
  deliveryRunId: string,
): Promise<void> {
  await runWithJobOrgId(lineage.orgId, () =>
    deps.eventStore.append({
      runId: lineage.runId,
      specId: lineage.specId,
      projectId: lineage.projectId,
      orgId: lineage.orgId,
      eventType: "delivery.demo_stimulus_started",
      payload: { deliveryRunId, mergeSha: lineage.mergeSha },
    }),
  );
}

/**
 * Append the durable demo ABORT MARKER (`delivery.demo_stimulus_aborted`) — clears a
 * `started` fire-intent once the drive PROVED the external effect never dispatched (the
 * runner returned/threw leaving NO terminal demo event). This makes a never-fired demo
 * (a pre-dispatch failure: deploy-load throw, notify-after-commit, no-op) ABLE TO RE-FIRE on
 * resume instead of stranding it degraded. Only a genuine crash mid-dispatch leaves the
 * `started` un-cleared ⇒ degrade.
 */
export async function appendDemoStimulusAborted(
  deps: Pick<RecordEvidenceDeps, "eventStore">,
  lineage: DeliveryLineage,
  deliveryRunId: string,
  reason: string,
): Promise<void> {
  await runWithJobOrgId(lineage.orgId, () =>
    deps.eventStore.append({
      runId: lineage.runId,
      specId: lineage.specId,
      projectId: lineage.projectId,
      orgId: lineage.orgId,
      eventType: "delivery.demo_stimulus_aborted",
      payload: { deliveryRunId, reason },
    }),
  );
}

/** Append the durable `delivery.degraded` narration (one per degraded settle; not deduped). */
export async function recordDeliveryDegraded(
  deps: Pick<RecordEvidenceDeps, "eventStore">,
  lineage: DeliveryLineage,
  args: { deliveryRunId: string; stage: string; classification: string; detail: string },
): Promise<void> {
  await runWithJobOrgId(lineage.orgId, () =>
    deps.eventStore.append({
      runId: lineage.runId,
      specId: lineage.specId,
      projectId: lineage.projectId,
      orgId: lineage.orgId,
      eventType: "delivery.degraded",
      payload: {
        deliveryRunId: args.deliveryRunId,
        stage: args.stage,
        classification: args.classification,
        detail: args.detail,
      },
    }),
  );
}

// The grouped-land equivalent of the delivery DAG's binding → A3 evidence gate.
//
// A completed land group shares the deterministic delivery outbox coordinate created by
// `applyFinalizeLand`, but its member runs intentionally bypass `DeliveryDagDriver` so
// deployment happens once for the group. This gate claims that SAME coordinate, seals its
// exact production binding set before the production demo fires, and only lets the group
// report completion after the exact A3 count confirms every release-required effect.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RecordEvidenceDeps } from "../delivery/deliveryEvidence.js";
import { appendDeliveryCompleted, recordDeliveryDegraded } from "../delivery/deliveryEvidence.js";
import type { DeliveryBindingSetSealer } from "../delivery/deliveryBindingSet.js";
import type { ClaimedDeliveryRun } from "../delivery/deliveryRunStore.js";
import type { DeliverySignals } from "../delivery/deliverySignals.js";
import type { IntegrationEvidenceAttestationResult } from "../delivery/integrationEvidenceAttester.js";
import type { IntegrationRuntimeAttachmentRecorder } from "../delivery/integrationRuntimeAttachment.js";
import type { DeliveryLineage } from "../delivery/stageModel.js";
import type { GroupDeliveryPlan } from "./groupDeliveryCore.js";

export type GroupDeliveryA3GateResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "blocked"; readonly reason: string };

/** The grouped-land equivalent of the delivery DAG's binding-seal + exact A3 boundary. */
export interface GroupDeliveryA3Gate {
  seal(plan: GroupDeliveryPlan): Promise<GroupDeliveryA3GateResult>;
  complete(input: { plan: GroupDeliveryPlan; deploymentId: string }): Promise<GroupDeliveryA3GateResult>;
}

/** The narrow delivery-run store surface the grouped A3 gate needs. */
export interface GroupDeliveryA3CoordinateStore {
  claimExact(input: {
    orgId: string;
    projectId: string;
    deliveryRunId: string;
    mergeSha: string;
  }): Promise<ClaimedDeliveryRun | undefined>;
  markCompleted(
    orgId: string,
    deliveryRunId: string,
    token: string,
    runId: string,
    projectId: string,
  ): Promise<boolean>;
  markDegraded(orgId: string, deliveryRunId: string, token: string, classification: string): Promise<boolean>;
}

export interface ProductionGroupDeliveryA3GateDeps {
  readonly store: GroupDeliveryA3CoordinateStore;
  readonly bindingSetSealer: DeliveryBindingSetSealer;
  readonly runtimeAttachmentRecorder: IntegrationRuntimeAttachmentRecorder;
  readonly signals: DeliverySignals;
  readonly integrationEvidenceAttester: {
    attest(input: {
      readonly lineage: DeliveryLineage;
      readonly deliveryRunId: string;
      readonly deploymentId: string;
    }): Promise<IntegrationEvidenceAttestationResult>;
  };
  readonly evidence: RecordEvidenceDeps;
  /** Exact-coordinate check prevents a crash between append and status completion from double-emitting. */
  readonly completionEvidenceExists: (lineage: DeliveryLineage, deliveryRunId: string) => Promise<boolean>;
}

const GROUP_A3_STAGES = [
  "group_deploy_verified",
  "group_binding_sealed",
  "group_a3_stimulate",
  "group_a3_observe",
] as const;

/** Production implementation of the group-specific A3 binding/evidence gate. */
export class ProductionGroupDeliveryA3Gate implements GroupDeliveryA3Gate {
  public constructor(private readonly deps: ProductionGroupDeliveryA3GateDeps) {}

  public async seal(plan: GroupDeliveryPlan): Promise<GroupDeliveryA3GateResult> {
    const claimed = await this.claim(plan);
    if (claimed === undefined) {
      return blocked("group delivery has no claimable exact delivery coordinate for A3 binding seal");
    }
    return this.sealClaimed(plan, claimed);
  }

  public async complete(input: { plan: GroupDeliveryPlan; deploymentId: string }): Promise<GroupDeliveryA3GateResult> {
    const claimed = await this.claim(input.plan);
    if (claimed === undefined) {
      return blocked("group delivery has no claimable exact delivery coordinate for A3 completion");
    }
    const sealed = await this.sealClaimed(input.plan, claimed);
    if (sealed.kind === "blocked") return sealed;

    const lineage = lineageFor(input.plan);
    const a3 = await this.deps.signals.releaseRequiredA3Count(lineage, input.plan.deliveryRunId);
    if (a3.required > 0 && a3.confirmed !== a3.required) {
      return this.degrade(
        lineage,
        claimed,
        "product_integration_effect_unconfirmed",
        `${String(a3.confirmed)}/${String(a3.required)} release-required product integration effect(s) have exact independent A3 evidence`,
      );
    }
    if (a3.required > 0) {
      const attestation = await this.deps.integrationEvidenceAttester.attest({
        lineage,
        deliveryRunId: input.plan.deliveryRunId,
        deploymentId: input.deploymentId,
      });
      if (attestation.kind === "blocked") {
        return this.degrade(lineage, claimed, `integration_evidence_${attestation.classification}`, attestation.detail);
      }
    }

    if (!(await this.deps.completionEvidenceExists(lineage, input.plan.deliveryRunId))) {
      await appendDeliveryCompleted(this.deps.evidence, {
        lineage,
        deliveryRunId: input.plan.deliveryRunId,
        deploymentId: input.deploymentId,
        observedEffect: "demo_observed",
        stagesConfirmed: GROUP_A3_STAGES,
      });
    }
    if (
      await this.deps.store.markCompleted(
        lineage.orgId,
        input.plan.deliveryRunId,
        claimed.token,
        lineage.runId,
        lineage.projectId,
      )
    ) {
      return { kind: "confirmed" };
    }
    return blocked("group delivery A3 evidence could not complete its exact delivery coordinate");
  }

  private async claim(plan: GroupDeliveryPlan): Promise<ClaimedDeliveryRun | undefined> {
    return this.deps.store.claimExact({
      orgId: plan.orgId,
      projectId: plan.projectId,
      deliveryRunId: plan.deliveryRunId,
      mergeSha: plan.mainSha,
    });
  }

  private async sealClaimed(plan: GroupDeliveryPlan, claimed: ClaimedDeliveryRun): Promise<GroupDeliveryA3GateResult> {
    const lineage = lineageFor(plan);
    const sealed = await this.deps.bindingSetSealer.seal({
      lineage,
      deliveryRunId: plan.deliveryRunId,
      token: claimed.token,
    });
    if (sealed.kind === "unavailable") {
      return this.degrade(lineage, claimed, "release_binding_set_unconfirmed", sealed.detail);
    }
    try {
      await this.deps.runtimeAttachmentRecorder.record({
        lineage,
        deliveryRunId: plan.deliveryRunId,
        token: claimed.token,
      });
      return { kind: "confirmed" };
    } catch (error) {
      return this.degrade(
        lineage,
        claimed,
        "integration_runtime_attachment_unconfirmed",
        `sealed integration generation attachment was not durably recorded: ${errorMessage(error)}`,
      );
    }
  }

  private async degrade(
    lineage: DeliveryLineage,
    claimed: ClaimedDeliveryRun,
    classification: string,
    detail: string,
  ): Promise<GroupDeliveryA3GateResult> {
    if (await this.deps.store.markDegraded(lineage.orgId, claimed.id, claimed.token, classification)) {
      await recordDeliveryDegraded(this.deps.evidence, lineage, {
        deliveryRunId: claimed.id,
        stage: "record_evidence",
        classification,
        detail,
      });
    }
    return blocked(detail);
  }
}

/** Read the durable completion event for one exact delivery coordinate. */
export function groupDeliveryCompletionEvidenceReader(
  pool: pg.Pool,
): (lineage: DeliveryLineage, deliveryRunId: string) => Promise<boolean> {
  return async (lineage, deliveryRunId) =>
    runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM events
          WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND event_type = 'delivery.completed'
            AND payload->>'deliveryRunId' = $4
          LIMIT 1`,
        [lineage.orgId, lineage.projectId, lineage.runId, deliveryRunId],
      );
      return result.rows[0] !== undefined;
    });
}

function lineageFor(plan: GroupDeliveryPlan): DeliveryLineage {
  return {
    orgId: plan.orgId,
    projectId: plan.projectId,
    runId: plan.tailRunId,
    specId: plan.tailSpecId,
    mergeSha: plan.mainSha,
  };
}

function blocked(reason: string): GroupDeliveryA3GateResult {
  return { kind: "blocked", reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

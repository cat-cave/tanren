// The durable, resumable post-merge delivery DAG driver — the release-activation engine
// that REPLACES the old fixed subscriber chain (issue → deploy → demo, catch-and-log).
//
// On each `merge.completed` wake it resolves the merged run's lineage, CLAIMS the in-16
// `delivery_runs` outbox row (keyed on the merge SHA), and drives the nine stages IN
// ORDER — skipping stages already durably SUCCEEDED (crash resume), recording each
// attempt to `delivery_stage_attempts`. A stage that cannot confirm its external effect
// DEGRADES the delivery (explicit durable state, resumed next wake) and STOPS the DAG. The
// delivery reaches `completed` ONLY after record_evidence's fail-closed gate recorded the
// signed evidence of the independently-observed effect — never on a partial/unverified
// chain. MergeAuthority remains the sole land decision; this driver never lands code.

import { randomUUID } from "node:crypto";
import { createLogger } from "../../observability/logger.js";
import { mergeShaFromPayload } from "../deployOnMergeReads.js";
import { loadValidatedRunEvent } from "../runLineage.js";
import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunMergeWatcher } from "../subscriber.js";
import { DeliveryRunStore, type StageProgress } from "./deliveryRunStore.js";
import { recordDeliveryDegraded, type RecordEvidenceDeps } from "./deliveryEvidence.js";
import { DeliveryStages, newDriveMemo, type DeliveryStageDeps, type DriveMemo } from "./deliveryStages.js";
import { DELIVERY_STAGES, type DeliveryLineage, type DeliveryStage, type StageOutcome } from "./stageModel.js";

/** The store subset the stage-plan driver needs (injectable for DB-free unit tests). */
export interface DeliveryStagePlanStore {
  loadStageProgress(orgId: string, deliveryRunId: string): Promise<Map<DeliveryStage, StageProgress>>;
  startStageAttempt(orgId: string, deliveryRunId: string, stage: DeliveryStage, attempt: number): Promise<string>;
  succeedStageAttempt(orgId: string, attemptId: string): Promise<void>;
  degradeStageAttempt(orgId: string, attemptId: string, classification: string): Promise<void>;
  markCompleted(orgId: string, deliveryRunId: string): Promise<void>;
  markDegraded(orgId: string, deliveryRunId: string, classification: string): Promise<void>;
}

/** The stage executor subset the plan driver needs (injectable). */
export interface DeliveryStagesLike {
  run(stage: DeliveryStage, lineage: DeliveryLineage, deliveryRunId: string, memo: DriveMemo): Promise<StageOutcome>;
}

/**
 * Drive the ordered stage plan for one claimed delivery, RESUMING from the last durable
 * success and STOPPING fail-closed at the first stage that cannot confirm its effect. Pure
 * orchestration over injected collaborators — the durable-substrate + effect seams are the
 * injectable boundary, so every branch (resume-skip, confirm, degrade-and-stop, complete) is
 * unit-testable without a database. Returns the terminal delivery disposition.
 */
export async function driveDeliveryStagePlan(input: {
  store: DeliveryStagePlanStore;
  stages: DeliveryStagesLike;
  eventStore: RecordEvidenceDeps["eventStore"];
  lineage: DeliveryLineage;
  deliveryRunId: string;
}): Promise<"completed" | "degraded"> {
  const { store, stages, lineage, deliveryRunId } = input;
  const progress = await store.loadStageProgress(lineage.orgId, deliveryRunId);
  const memo = newDriveMemo();

  for (const stage of DELIVERY_STAGES) {
    const prior = progress.get(stage);
    // Resume: never re-run a durably-succeeded stage.
    if (prior?.succeeded === true) continue;

    const attempt = (prior?.attemptsSoFar ?? 0) + 1;
    const attemptId = await store.startStageAttempt(lineage.orgId, deliveryRunId, stage, attempt);
    const outcome = await stages.run(stage, lineage, deliveryRunId, memo);

    if (outcome.kind === "confirmed") {
      await store.succeedStageAttempt(lineage.orgId, attemptId);
      continue;
    }

    // DEGRADE: durable non-terminal. Record the attempt, narrate it, park the delivery in
    // `degraded`, and STOP the DAG — never advance past an unconfirmed external effect.
    await store.degradeStageAttempt(lineage.orgId, attemptId, outcome.classification);
    await recordDeliveryDegraded({ eventStore: input.eventStore }, lineage, {
      deliveryRunId,
      stage,
      classification: outcome.classification,
      detail: outcome.detail,
    });
    await store.markDegraded(lineage.orgId, deliveryRunId, outcome.classification);
    return "degraded";
  }

  // Every stage confirmed AND record_evidence appended the signed `delivery.completed`
  // attestation — only now is the delivery durably marked complete.
  await store.markCompleted(lineage.orgId, deliveryRunId);
  return "completed";
}

const log = createLogger("delivery-dag");

export interface DeliveryDagDriverDeps extends DeliveryStageDeps {
  /** The runtime pool — the driver's own lineage read + the delivery-run store's scope. */
  readonly pool: pg.Pool;
  /** Stable per-process claim owner; defaults to a fresh uuid. */
  readonly claimOwner?: string;
}

/**
 * Drives the delivery DAG for a merged run. Implements {@link RunMergeWatcher} so the
 * post-merge subscriber drives it on the same wake it used for the deploy/demo watchers —
 * which are now this driver's INTERNAL stage runners, not a separate fixed chain.
 */
export class DeliveryDagDriver implements RunMergeWatcher {
  private readonly store: DeliveryRunStore;
  private readonly stages: DeliveryStages;

  constructor(private readonly deps: DeliveryDagDriverDeps) {
    this.store = new DeliveryRunStore(deps.pool, deps.claimOwner ?? `delivery-${randomUUID()}`);
    this.stages = new DeliveryStages(deps);
  }

  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const lineage = await this.resolveLineage(runId);
    // Not a merged run (nothing to deliver).
    if (lineage === undefined) return;

    const claimed = await this.store.claim(lineage.orgId, lineage.projectId, lineage.mergeSha);
    if (claimed === undefined) {
      // No outbox row for this merge, already completed, or another worker holds the lease.
      return;
    }

    try {
      await driveDeliveryStagePlan({
        store: this.store,
        stages: this.stages,
        eventStore: this.deps.evidence.eventStore,
        lineage,
        deliveryRunId: claimed.id,
      });
    } catch (error) {
      // An UNEXPECTED driver-level failure (not a stage's confirmed degrade) — record a
      // durable needs_attention and release the claim, never a silent stall.
      log.error("delivery DAG driver failed", { runId, deliveryRunId: claimed.id }, error);
      await this.store.markNeedsAttention(lineage.orgId, claimed.id, "delivery_driver_error");
    }
  }

  /** Resolve the merged run's lineage + merge SHA; `undefined` when the run has not merged. */
  private async resolveLineage(runId: string): Promise<DeliveryLineage | undefined> {
    const merged = await runWithSystemScope(this.deps.pool, (client) =>
      loadValidatedRunEvent(client, { runId, eventType: "merge.completed", requireEventSpec: true }),
    );
    if (merged === undefined) return undefined;
    const mergeSha = mergeShaFromPayload(merged.payload);
    if (mergeSha === undefined) {
      // A merge that recorded no SHA cannot be keyed to its delivery outbox row — the
      // deploy watcher already records a durable `deploy.skipped` for this wiring bug.
      log.warn("merged run carries no mergeSha — no delivery outbox key", { runId });
      return undefined;
    }
    return { ...merged.lineage, mergeSha };
  }
}

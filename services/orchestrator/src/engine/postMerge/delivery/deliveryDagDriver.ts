// The durable, resumable post-merge delivery DAG driver — the release-activation engine
// that REPLACES the old fixed subscriber chain (issue → deploy → demo, catch-and-log).
//
// On each `merge.completed` wake it resolves the merged run's lineage, CLAIMS the in-16
// `delivery_runs` outbox row (keyed on the merge SHA) with a fresh FENCING TOKEN, and
// drives the nine stages IN ORDER — skipping stages already durably SUCCEEDED (crash
// resume), recording each attempt to `delivery_stage_attempts`. Every durable write is
// CAS-guarded on the fencing token: before each stage the driver RENEWS its claim (a
// progress-based sign-of-life, not a timer); a lost fence ABORTS the drive, recording
// NOTHING terminal (the live owner keeps ownership). A stage that cannot confirm its
// external effect DEGRADES the delivery (durable, resumed next wake) and STOPS the DAG.
// The delivery reaches `completed` ONLY when markCompleted's fenced statement finds the
// durable signed `delivery.completed` evidence row — never on a partial/unverified chain.
// MergeAuthority remains the sole land decision; this driver never lands code.

import { createLogger } from "../../observability/logger.js";
import { mergeShaFromPayload } from "../deployOnMergeReads.js";
import { loadValidatedRunEvent } from "../runLineage.js";
import { isLandGroupMember } from "../landGroupDelivery/landGroupDeliveryReads.js";
import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunMergeWatcher } from "../subscriber.js";
import { DeliveryRunStore, type StageProgress } from "./deliveryRunStore.js";
import { recordDeliveryDegraded, type RecordEvidenceDeps } from "./deliveryEvidence.js";
import { DeliveryStages, newDriveMemo, type DeliveryStageDeps, type DriveMemo } from "./deliveryStages.js";
import { DELIVERY_STAGES, type DeliveryLineage, type DeliveryStage, type StageOutcome } from "./stageModel.js";

/** The fenced store subset the stage-plan driver needs (injectable for DB-free unit tests). */
export interface DeliveryStagePlanStore {
  loadStageProgress(orgId: string, deliveryRunId: string): Promise<Map<DeliveryStage, StageProgress>>;
  renewClaim(orgId: string, deliveryRunId: string, token: string): Promise<boolean>;
  startStageAttempt(
    orgId: string,
    deliveryRunId: string,
    token: string,
    stage: DeliveryStage,
    attempt: number,
  ): Promise<string | undefined>;
  succeedStageAttempt(orgId: string, deliveryRunId: string, token: string, attemptId: string): Promise<boolean>;
  degradeStageAttempt(
    orgId: string,
    deliveryRunId: string,
    token: string,
    attemptId: string,
    classification: string,
  ): Promise<boolean>;
  markCompleted(
    orgId: string,
    deliveryRunId: string,
    token: string,
    runId: string,
    projectId: string,
  ): Promise<boolean>;
  markDegraded(orgId: string, deliveryRunId: string, token: string, classification: string): Promise<boolean>;
}

/** The stage executor subset the plan driver needs (injectable). */
export interface DeliveryStagesLike {
  run(
    stage: DeliveryStage,
    lineage: DeliveryLineage,
    deliveryRunId: string,
    memo: DriveMemo,
    token: string,
  ): Promise<StageOutcome>;
}

/** The terminal disposition of one drive. `claim_lost` ⇒ superseded; record nothing terminal. */
export type DriveDisposition = "completed" | "degraded" | "claim_lost";

/**
 * Drive the ordered stage plan for one claimed delivery under its FENCING TOKEN, RESUMING
 * from the last durable success and STOPPING fail-closed at the first stage that cannot
 * confirm its effect. Every durable write is CAS-guarded on the token and its affected-row
 * count is checked: a lost fence returns `claim_lost` and the driver records NOTHING
 * terminal (the live owner keeps the run). Pure orchestration over injected collaborators —
 * every branch is unit-testable without a database.
 */
export async function driveDeliveryStagePlan(input: {
  store: DeliveryStagePlanStore;
  stages: DeliveryStagesLike;
  eventStore: RecordEvidenceDeps["eventStore"];
  lineage: DeliveryLineage;
  deliveryRunId: string;
  token: string;
}): Promise<DriveDisposition> {
  const { store, stages, lineage, deliveryRunId, token } = input;
  const orgId = lineage.orgId;
  const progress = await store.loadStageProgress(orgId, deliveryRunId);
  // Demo re-fire is gated by the durable EFFECT-BOUNDARY intent marker (inside the demo
  // stage), NOT by the attempt count — a never-fired demo (crash before fire / lock held /
  // pending) resumes and RUNS, never sticking degraded.
  const memo = newDriveMemo();

  for (const stage of DELIVERY_STAGES) {
    const prior = progress.get(stage);
    // Resume: never re-run a durably-succeeded stage.
    if (prior?.succeeded === true) continue;

    // FENCE + sign-of-life: re-assert ownership before any effect/write. Lost ⇒ abort.
    if (!(await store.renewClaim(orgId, deliveryRunId, token))) return "claim_lost";

    const attempt = (prior?.attemptsSoFar ?? 0) + 1;
    const attemptId = await store.startStageAttempt(orgId, deliveryRunId, token, stage, attempt);
    if (attemptId === undefined) return "claim_lost";

    const outcome = await stages.run(stage, lineage, deliveryRunId, memo, token);

    if (outcome.kind === "confirmed") {
      if (!(await store.succeedStageAttempt(orgId, deliveryRunId, token, attemptId))) return "claim_lost";
      continue;
    }

    // DEGRADE: settle the stage attempt AND flip the run to `degraded` — both FENCED. A lost
    // fence on EITHER write (Finding 2: the degradeStageAttempt boolean is checked too) aborts
    // so a stale owner never leaves a half-written degrade while the live owner continues.
    // STOP — never advance past an unconfirmed external effect.
    if (!(await store.degradeStageAttempt(orgId, deliveryRunId, token, attemptId, outcome.classification)))
      return "claim_lost";
    if (!(await store.markDegraded(orgId, deliveryRunId, token, outcome.classification))) return "claim_lost";
    await recordDeliveryDegraded({ eventStore: input.eventStore }, lineage, {
      deliveryRunId,
      stage,
      classification: outcome.classification,
      detail: outcome.detail,
    });
    return "degraded";
  }

  // Every stage confirmed; markCompleted's fenced statement also asserts the durable signed
  // `delivery.completed` evidence row exists (record_evidence appended it) — completion is
  // the evidence's consequence. A lost fence or missing evidence ⇒ NOT completed.
  return (await store.markCompleted(orgId, deliveryRunId, token, lineage.runId, lineage.projectId))
    ? "completed"
    : "claim_lost";
}

const log = createLogger("delivery-dag");

export type DeliveryDagDriverDeps = DeliveryStageDeps & {
  /** The runtime pool — the driver's own lineage read + the delivery-run store's scope. */
  readonly pool: pg.Pool;
};

/**
 * Drives the delivery DAG for a merged run. Implements {@link RunMergeWatcher} so the
 * post-merge subscriber drives it on the same wake it used for the deploy/demo watchers —
 * which are now this driver's INTERNAL stage runners, not a separate fixed chain.
 */
export class DeliveryDagDriver implements RunMergeWatcher {
  private readonly store: DeliveryRunStore;
  private readonly stages: DeliveryStages;

  constructor(private readonly deps: DeliveryDagDriverDeps) {
    this.store = new DeliveryRunStore(deps.pool);
    this.stages = new DeliveryStages(deps);
  }

  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const lineage = await this.resolveLineage(runId);
    // Not a merged run (nothing to deliver).
    if (lineage === undefined) return;

    // mq-13 MEMBERSHIP GUARD: a land-group MEMBER's per-run delivery is owned by the GROUP-level
    // LandGroupDeliveryLoop (which deploys/previews/promotes the WHOLE group ONCE and emits the
    // group's `deploy.verified` / `demo.completed` on the tail run). Skip the per-run delivery for
    // a group member so a group does not deploy once per member; a solo (non-group) run is
    // unaffected and keeps its full per-run delivery DAG.
    const isMember = await runWithSystemScope(this.deps.pool, (client) =>
      isLandGroupMember(client, lineage.orgId, runId),
    );
    if (isMember) return;

    const claimed = await this.store.claim(lineage.orgId, lineage.projectId, lineage.mergeSha);
    if (claimed === undefined) {
      // No outbox row for this merge, or the run is already `completed` (terminal).
      return;
    }

    try {
      await driveDeliveryStagePlan({
        store: this.store,
        stages: this.stages,
        eventStore: this.deps.evidence.eventStore,
        lineage,
        deliveryRunId: claimed.id,
        token: claimed.token,
      });
    } catch (error) {
      // An UNEXPECTED driver-level failure (not a stage's confirmed degrade) — record a
      // FENCED needs_attention; if the fence was lost the live owner keeps the run (no-op).
      log.error("delivery DAG driver failed", { runId, deliveryRunId: claimed.id }, error);
      await this.store.markNeedsAttention(lineage.orgId, claimed.id, claimed.token, "delivery_driver_error");
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

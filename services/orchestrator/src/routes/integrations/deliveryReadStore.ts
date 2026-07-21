// in-20 — the delivery-DAG read side of the integration HTTP read surface.
// Extracted from `integrationReadStore.ts` so each store module stays under the
// 500-line ceiling. Reads `delivery_runs` + `delivery_stage_attempts` +
// `delivery_run_bindings` and composes the project-scoped delivery-DAG status.
//
// Runs on the caller-provided org-scoped client (RLS denies a cross-org read →
// zero rows → empty list, never a laundered foreign run). Per-stage progress
// surfaces the LATEST attempt of each stage (the highest `attempt` value) — the
// full attempt history is in the events table, not this rollup.

import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import {
  DeliveryDagStatusResponse,
  DeliveryRunStatusRead,
  DeliveryStageAttemptStatusRead,
  DeliveryStageCurrentAttemptView,
  DeliveryStageRead,
  INTEGRATION_READ_SURFACE_VERSION,
} from "./contract.js";
import type { DeliveryRunBindingRef, DeliveryRunView } from "./contract.js";
import { asDate, asNonNegativeInt, asStringOrNull, type IntegrationReadScope } from "./shared.js";

interface DeliveryRunRow {
  id: string;
  authority_decision_id: string;
  merge_sha: string;
  status: string;
  retry_after: unknown;
  failure_classification: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

interface DeliveryStageRow {
  delivery_run_id: string;
  stage: string;
  ordinal: number;
  attempt: number;
  status: string;
  failure_classification: unknown;
  started_at: unknown;
  completed_at: unknown;
}

interface DeliveryRunBindingRow {
  delivery_run_id: string;
  binding_id: string;
  binding_generation: number;
}

/** Reads the project's delivery-DAG status (in-17/19 live state). */
export async function readDeliveryDagStatus(
  client: IntegrationQueryClient,
  scope: IntegrationReadScope,
): Promise<DeliveryDagStatusResponse> {
  const runsResult = await client.query(
    `SELECT id, authority_decision_id, merge_sha, status, retry_after, failure_classification,
            created_at, updated_at, completed_at
       FROM delivery_runs
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at DESC, id`,
    [scope.orgId, scope.projectId],
  );
  const runsRows = runsResult.rows as unknown as DeliveryRunRow[];
  if (runsRows.length === 0) {
    return DeliveryDagStatusResponse.parse({
      version: INTEGRATION_READ_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      deliveryRuns: [],
    });
  }

  const runIds = runsRows.map((row) => row.id);
  const stagesByRun = new Map<string, DeliveryStageRow[]>();
  const bindingsByRun = new Map<string, DeliveryRunBindingRow[]>();

  if (runIds.length > 0) {
    const stagesResult = await client.query(
      `SELECT delivery_run_id, stage, ordinal, attempt, status, failure_classification,
              started_at, completed_at
         FROM delivery_stage_attempts
        WHERE org_id = $1 AND delivery_run_id = ANY($2::text[])
        ORDER BY delivery_run_id, ordinal, attempt`,
      [scope.orgId, runIds],
    );
    for (const row of stagesResult.rows as unknown as DeliveryStageRow[]) {
      const list = stagesByRun.get(row.delivery_run_id) ?? [];
      list.push(row);
      stagesByRun.set(row.delivery_run_id, list);
    }

    const bindingsResult = await client.query(
      `SELECT delivery_run_id, binding_id, binding_generation
         FROM delivery_run_bindings
        WHERE org_id = $1 AND delivery_run_id = ANY($2::text[])`,
      [scope.orgId, runIds],
    );
    for (const row of bindingsResult.rows as unknown as DeliveryRunBindingRow[]) {
      const list = bindingsByRun.get(row.delivery_run_id) ?? [];
      list.push(row);
      bindingsByRun.set(row.delivery_run_id, list);
    }
  }

  const deliveryRuns: DeliveryRunView[] = runsRows.map((row) => {
    const stageRows = stagesByRun.get(row.id) ?? [];
    const bindingRows = bindingsByRun.get(row.id) ?? [];
    return composeDeliveryRun(row, stageRows, bindingRows);
  });

  return DeliveryDagStatusResponse.parse({
    version: INTEGRATION_READ_SURFACE_VERSION,
    orgId: scope.orgId,
    projectId: scope.projectId,
    deliveryRuns,
  });
}

function composeDeliveryRun(
  run: DeliveryRunRow,
  stageRows: DeliveryStageRow[],
  bindingRows: DeliveryRunBindingRow[],
): DeliveryRunView {
  const latestAttemptByStage = new Map<string, DeliveryStageRow>();
  for (const stage of stageRows) {
    const prior = latestAttemptByStage.get(stage.stage);
    if (prior === undefined || stage.attempt > prior.attempt) {
      latestAttemptByStage.set(stage.stage, stage);
    }
  }
  const stages: DeliveryStageCurrentAttemptView[] = [...latestAttemptByStage.values()].map((row) =>
    latestStageView(row),
  );
  stages.sort((a, b) => a.ordinal - b.ordinal);
  const bindings: DeliveryRunBindingRef[] = bindingRows.map((row) => ({
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
  }));
  return {
    deliveryRunId: run.id,
    authorityDecisionId: run.authority_decision_id,
    mergeSha: run.merge_sha,
    status: DeliveryRunStatusRead.parse(run.status),
    retryAfter: asDate(run.retry_after),
    failureClassification: asStringOrNull(run.failure_classification),
    stages,
    bindings,
    createdAt: asDate(run.created_at) ?? new Date(0),
    updatedAt: asDate(run.updated_at) ?? new Date(0),
    completedAt: asDate(run.completed_at),
  };
}

function latestStageView(row: DeliveryStageRow): DeliveryStageCurrentAttemptView {
  return DeliveryStageCurrentAttemptView.parse({
    stage: DeliveryStageRead.parse(row.stage),
    ordinal: asNonNegativeInt(row.ordinal),
    latestAttempt: row.attempt,
    latestStatus: DeliveryStageAttemptStatusRead.parse(row.status),
    failureClassification: asStringOrNull(row.failure_classification),
    startedAt: asDate(row.started_at),
    completedAt: asDate(row.completed_at),
  });
}

import type {
  AdvanceSideEffectWatermarkInput,
  EffectObservation,
  EffectObservationClassification,
} from "../contracts/sideEffectObserverAdapter.js";
import type { QueryClient } from "../data/orgScopedDb.js";

interface EffectObservationRow {
  readonly org_id: string;
  readonly project_id: string;
  readonly observation_id: string;
  readonly trigger_id_hash: string | null;
  readonly observer: string;
  readonly provider: string;
  readonly provider_object_hash: string | null;
  readonly cursor: string | null;
  readonly occurrence_count: number | string;
  readonly latency_ms: number | string | null;
  readonly classification: EffectObservationClassification;
  readonly created_at: Date;
}

export interface AppendEffectObservationInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly observationId: string;
  readonly triggerIdHash?: string;
  readonly observer: string;
  readonly provider: string;
  readonly providerObjectHash?: string;
  readonly cursor?: string;
  readonly occurrenceCount: number;
  readonly latencyMs?: number;
  readonly classification: EffectObservationClassification;
}

export interface FindEffectObservationsInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly observer: string;
  readonly provider: string;
  readonly triggerIdHash: string;
}

const OBSERVATION_COLUMNS = `org_id, project_id, observation_id, trigger_id_hash, observer, provider,
  provider_object_hash, cursor, occurrence_count, latency_ms, classification, created_at`;

function mapObservation(row: EffectObservationRow): EffectObservation {
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    observationId: row.observation_id,
    ...(row.trigger_id_hash === null ? {} : { triggerIdHash: row.trigger_id_hash }),
    observer: row.observer,
    provider: row.provider,
    ...(row.provider_object_hash === null ? {} : { providerObjectHash: row.provider_object_hash }),
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    occurrenceCount: Number(row.occurrence_count),
    ...(row.latency_ms === null ? {} : { latencyMs: Number(row.latency_ms) }),
    classification: row.classification,
    createdAt: row.created_at,
  };
}

/**
 * PostgreSQL statements for immutable side-effect evidence and its mutable
 * observer cursor. Callers provide an already org-scoped client so a sequence
 * of duplicate detection, append, and event publication can be one transaction.
 */
export class EffectObservationsRepository {
  /**
   * Serialize duplicate detection for one observer/provider trigger within
   * the caller's transaction. The evidence table intentionally has no unique
   * constraint for this semantic key because every observation is immutable.
   */
  public async lockTrigger(client: QueryClient, input: FindEffectObservationsInput): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.orgId}:${input.projectId}:${input.observer}:${input.provider}:${input.triggerIdHash}`,
    ]);
  }

  public async append(client: QueryClient, input: AppendEffectObservationInput): Promise<EffectObservation> {
    const result = await client.query<EffectObservationRow>(
      `INSERT INTO behavior_effect_observations
         (org_id, project_id, observation_id, trigger_id_hash, observer, provider,
          provider_object_hash, cursor, occurrence_count, latency_ms, classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${OBSERVATION_COLUMNS}`,
      [
        input.orgId,
        input.projectId,
        input.observationId,
        input.triggerIdHash ?? null,
        input.observer,
        input.provider,
        input.providerObjectHash ?? null,
        input.cursor ?? null,
        input.occurrenceCount,
        input.latencyMs ?? null,
        input.classification,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("effect observation append did not return a row; verify org/project scope");
    }
    return mapObservation(row);
  }

  public async findByTrigger(
    client: QueryClient,
    input: FindEffectObservationsInput,
  ): Promise<ReadonlyArray<EffectObservation>> {
    const result = await client.query<EffectObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS}
         FROM behavior_effect_observations
        WHERE org_id = $1
          AND project_id = $2
          AND observer = $3
          AND provider = $4
          AND trigger_id_hash = $5
        ORDER BY created_at, observation_id`,
      [input.orgId, input.projectId, input.observer, input.provider, input.triggerIdHash],
    );
    return result.rows.map(mapObservation);
  }

  public async listForProject(
    client: QueryClient,
    input: Pick<FindEffectObservationsInput, "orgId" | "projectId">,
  ): Promise<ReadonlyArray<EffectObservation>> {
    const result = await client.query<EffectObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS}
         FROM behavior_effect_observations
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at, observation_id`,
      [input.orgId, input.projectId],
    );
    return result.rows.map(mapObservation);
  }

  public async advanceWatermark(client: QueryClient, input: AdvanceSideEffectWatermarkInput): Promise<void> {
    await client.query(
      `INSERT INTO effect_observer_watermarks (org_id, project_id, observer, watermark)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, project_id, observer)
       DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()`,
      [input.orgId, input.projectId, input.observer, input.watermark],
    );
  }
}

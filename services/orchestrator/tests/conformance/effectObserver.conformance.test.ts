import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { EventName } from "../../src/engine/events/index.js";
import { PgSideEffectObserverAdapter } from "../../src/engine/verification/effectObserver/pgSideEffectObserverAdapter.js";
import { EffectObservationsRepository } from "../../src/engine/repositories/effectObservations.js";
import {
  MemoryDb,
  type BehaviorEffectObservationRecord,
  type EffectObserverWatermarkRecord,
  type QueryResult,
} from "./conformanceMemoryDb.js";

const ORG_A = "org_effect_a";
const ORG_B = "org_effect_b";
const PROJECT_A = "project_effect_a";
const TRIGGER_A = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-01-01T00:00:00.000Z");

class RecordingEventStore implements EventStore {
  public readonly eventTypes: string[] = [];

  public async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.eventTypes.push(input.eventType);
  }
}

// This pg-shaped conformance fake owns both barrier-table handlers. It mirrors
// the real RLS policy by returning only rows that match the SET LOCAL org scope,
// and mirrors the immutable-table trigger for UPDATE/DELETE attempts.
class EffectObserverScopedClient {
  private orgId: string | undefined;

  public constructor(private readonly db: MemoryDb) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  public async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
    const orgMatch = /^SET LOCAL app\.current_org_id = '([^']+)'$/u.exec(sql);
    if (orgMatch !== null) {
      this.orgId = orgMatch[1];
      return { rows: [], rowCount: 0 };
    }
    if (sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") {
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith("SELECT org_id, project_id, observation_id") &&
      sql.includes("FROM behavior_effect_observations")
    ) {
      return this.selectObservations(sql, params);
    }
    if (sql.startsWith("INSERT INTO behavior_effect_observations")) return this.insertObservation(params);
    if (sql.startsWith("INSERT INTO effect_observer_watermarks")) return this.upsertWatermark(params);
    const immutableMutation = /^(UPDATE|DELETE)(?: FROM)? behavior_effect_observations/u.exec(sql);
    if (immutableMutation !== null) return this.immutableMutation(immutableMutation[1], params);
    throw new Error(`EffectObserverMemoryDb: unrecognized SQL: ${sql}`);
  }

  public release(): void {}

  private selectObservations(sql: string, params: readonly unknown[]): QueryResult {
    const [orgId, projectId, observer, provider, triggerIdHash] = params as [
      string,
      string,
      string | undefined,
      string | undefined,
      string | undefined,
    ];
    const rows = this.db.behaviorEffectObservations.filter(
      (row) =>
        row.org_id === this.orgId &&
        row.org_id === orgId &&
        row.project_id === projectId &&
        (observer === undefined || row.observer === observer) &&
        (provider === undefined || row.provider === provider) &&
        (triggerIdHash === undefined || row.trigger_id_hash === triggerIdHash),
    );
    if (sql.includes("ORDER BY created_at, observation_id")) {
      rows.sort(
        (left, right) =>
          left.created_at.getTime() - right.created_at.getTime() ||
          left.observation_id.localeCompare(right.observation_id),
      );
    }
    return { rows, rowCount: rows.length };
  }

  private insertObservation(params: readonly unknown[]): QueryResult {
    const [
      orgId,
      projectId,
      observationId,
      triggerIdHash,
      observer,
      provider,
      providerObjectHash,
      cursor,
      occurrenceCount,
      latencyMs,
      classification,
    ] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string | null,
      string | null,
      number,
      number | null,
      string,
    ];
    if (this.orgId !== orgId) throw new Error("new row violates row-level security policy");
    const row: BehaviorEffectObservationRecord = {
      org_id: orgId,
      project_id: projectId,
      observation_id: observationId,
      trigger_id_hash: triggerIdHash,
      observer,
      provider,
      provider_object_hash: providerObjectHash,
      cursor,
      occurrence_count: occurrenceCount,
      latency_ms: latencyMs,
      classification,
      created_at: NOW,
    };
    this.db.behaviorEffectObservations.push(row);
    return { rows: [row], rowCount: 1 };
  }

  private upsertWatermark(params: readonly unknown[]): QueryResult {
    const [orgId, projectId, observer, watermark] = params as [string, string, string, string];
    if (this.orgId !== orgId) throw new Error("new row violates row-level security policy");
    const existing = this.db.effectObserverWatermarks.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.observer === observer,
    );
    if (existing !== undefined) {
      existing.watermark = watermark;
      existing.updated_at = NOW;
      return { rows: [], rowCount: 1 };
    }
    const row: EffectObserverWatermarkRecord = {
      org_id: orgId,
      project_id: projectId,
      observer,
      watermark,
      updated_at: NOW,
    };
    this.db.effectObserverWatermarks.push(row);
    return { rows: [], rowCount: 1 };
  }

  private immutableMutation(operation: string, params: readonly unknown[]): QueryResult {
    const [orgId, observationId] = params as [string, string];
    const visible = this.db.behaviorEffectObservations.some(
      (row) => row.org_id === this.orgId && row.org_id === orgId && row.observation_id === observationId,
    );
    if (!visible) return { rows: [], rowCount: 0 };
    throw new Error(`behavior_effect_observations rows are immutable (append-only): ${operation} rejected`);
  }
}

class EffectObserverMemoryPool {
  public readonly totalCount = 0;

  public constructor(private readonly db: MemoryDb) {}

  public async connect(): Promise<EffectObserverScopedClient> {
    return new EffectObserverScopedClient(this.db);
  }
}

describe("PgSideEffectObserverAdapter conformance (in-memory pg, RLS-modeled)", () => {
  it("records each classification, advances its mutable watermark, and preserves append-only RLS evidence", async () => {
    const db = new MemoryDb();
    const pool = new EffectObserverMemoryPool(db) as unknown as pg.Pool;
    const events = new RecordingEventStore();
    const repository = new EffectObservationsRepository();
    const observationIds = ["effect_ok", "effect_duplicate", "effect_missing"];
    const adapter = new PgSideEffectObserverAdapter(pool, {
      repository,
      eventsForClient: () => events,
      observationId: () => observationIds.shift() ?? "effect_extra",
    });

    const ok = await adapter.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      triggerIdHash: TRIGGER_A,
      afterWatermark: "cursor_1",
    });
    const duplicate = await adapter.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      triggerIdHash: TRIGGER_A,
      afterWatermark: "cursor_1",
    });
    const missing = await adapter.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      afterWatermark: "cursor_2",
    });
    await adapter.advanceWatermark({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      watermark: "cursor_2",
    });
    await adapter.advanceWatermark({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      watermark: "cursor_3",
    });

    expect([ok[0]?.classification, duplicate[0]?.classification, missing[0]?.classification]).toEqual([
      "ok",
      "duplicate",
      "missing",
    ]);
    expect(duplicate[0]?.occurrenceCount).toBe(2);
    expect(db.effectObserverWatermarks).toMatchObject([
      { org_id: ORG_A, project_id: PROJECT_A, watermark: "cursor_3" },
    ]);
    expect(events.eventTypes).toEqual([
      "behavior.effect.observed",
      "behavior.effect.duplicate",
      "behavior.effect.missing",
      "observer.inconclusive_external",
      "observer.watermark.advanced",
      "observer.watermark.advanced",
    ]);

    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query(
          "UPDATE behavior_effect_observations SET observer = 'changed' WHERE org_id = $1 AND observation_id = $2",
          [ORG_A, "effect_ok"],
        ),
      ),
    ).rejects.toThrow(/immutable.*append-only/iu);

    await expect(
      runWithOrgScope(pool, ORG_A, (client) =>
        client.query("DELETE FROM behavior_effect_observations WHERE org_id = $1 AND observation_id = $2", [
          ORG_A,
          "effect_ok",
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);

    const foreignRows = await runWithOrgScope(pool, ORG_B, (client) =>
      repository.listForProject(client, { orgId: ORG_A, projectId: PROJECT_A }),
    );
    expect(foreignRows).toEqual([]);
  });
});

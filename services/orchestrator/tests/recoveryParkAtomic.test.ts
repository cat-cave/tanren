import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { RecoveryParkInput } from "../src/engine/contracts/index.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

const INPUT: RecoveryParkInput = {
  orgId: "org_park",
  projectId: "project_park",
  queueId: "queue_park",
  runId: "run_park",
  specId: "spec_park",
  message: "the resolver proved a genuine intent conflict",
};
const PARK_EVENT_TYPES = new Set(["dag.spec.needs_attention", "merge.dequeued"]);

interface FakeState {
  specStatus: string;
  queueStatus: string;
  dequeueReason: string | null;
  events: string[];
}

function cloneState(state: FakeState): FakeState {
  return { ...state, events: [...state.events] };
}

function requireSql(sql: string, fragments: readonly string[]): void {
  const missing = fragments.filter((fragment) => !sql.includes(fragment));
  if (missing.length > 0) throw new Error(`recovery park SQL lost required predicates: ${missing.join(", ")}`);
}

/** Transactional in-memory pg surface for the exact fixed SQL this seam owns. */
function fakePool(
  initial: Partial<FakeState> = {},
  failOnEventType?: string,
): { pool: pg.Pool; setSpecStatus: (status: string) => void; sql: () => string[]; state: () => FakeState } {
  let committed: FakeState = {
    specStatus: "in_flight",
    queueStatus: "merging",
    dequeueReason: null,
    events: [],
    ...initial,
  };
  let transaction: FakeState | undefined;
  const statements: string[] = [];
  const active = (): FakeState => transaction ?? committed;

  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.trim();
      statements.push(
        normalized.startsWith("INSERT") ? `${normalized}\n-- event-type: ${String(params[5])}` : normalized,
      );
      if (normalized === "BEGIN") {
        transaction = cloneState(committed);
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
      if (normalized === "COMMIT") {
        if (transaction !== undefined) committed = transaction;
        transaction = undefined;
        return { rows: [], rowCount: 0 };
      }
      if (normalized === "ROLLBACK") {
        transaction = undefined;
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT mq.status AS queue_status")) {
        requireSql(normalized, [
          "r.run_id = mq.run_id",
          "r.spec_id = mq.spec_id",
          "r.project_id = mq.project_id",
          "r.org_id = mq.org_id",
          "s.spec_id = mq.spec_id",
          "s.project_id = mq.project_id",
          "s.org_id = mq.org_id",
          "p.project_id = mq.project_id",
          "p.org_id = mq.org_id",
          "mq.queue_id = $1",
          "mq.org_id = $2",
          "mq.project_id = $3",
          "mq.run_id = $4",
          "mq.spec_id = $5",
          "FOR UPDATE OF mq, r, s, p",
        ]);
        const owns = [INPUT.queueId, INPUT.orgId, INPUT.projectId, INPUT.runId, INPUT.specId].every(
          (value, index) => params[index] === value,
        );
        if (!owns) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              queue_status: active().queueStatus,
              dequeue_reason: active().dequeueReason,
              spec_status: active().specStatus,
              pr_url: "https://github.example/pulls/17",
              pr_number: "17",
            },
          ],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("UPDATE specs")) {
        requireSql(normalized, [
          "spec_id = $1",
          "org_id = $2",
          "project_id = $3",
          "status IN ('open', 'in_flight', 'review')",
        ]);
        if (!["open", "in_flight", "review"].includes(active().specStatus)) {
          return { rows: [], rowCount: 0 };
        }
        active().specStatus = "needs_attention";
        return { rows: [{ spec_id: INPUT.specId }], rowCount: 1 };
      }
      const eventType = String(params[5]);
      if (normalized.startsWith("INSERT") && PARK_EVENT_TYPES.has(eventType)) {
        if (eventType === failOnEventType) throw new Error("injected event-store failure");
        active().events.push(eventType);
        return { rows: [{ id: String(active().events.length) }], rowCount: 1 };
      }
      if (normalized.startsWith("NOTIFY")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("UPDATE merge_queue")) {
        requireSql(normalized, [
          "queue_id = $1",
          "org_id = $2",
          "project_id = $3",
          "run_id = $4",
          "spec_id = $5",
          "status IN ('queued', 'merging')",
        ]);
        if (!["queued", "merging"].includes(active().queueStatus)) {
          return { rows: [], rowCount: 0 };
        }
        active().queueStatus = "dequeued";
        active().dequeueReason = "needs_attention";
        return { rows: [{ queue_id: INPUT.queueId }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL in recovery park fake: ${normalized}`);
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
  return {
    pool,
    setSpecStatus: (status) => {
      committed.specStatus = status;
    },
    sql: () => [...statements],
    state: () => cloneState(committed),
  };
}

describe("DirectRunStateWriter recovery park authority", () => {
  it("commits the spec park, exact event order, and dequeue as one outcome", async () => {
    const fake = fakePool();
    const writer = new DirectRunStateWriter(fake.pool);

    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({ kind: "parked", newlyParked: true });
    expect(fake.state()).toEqual({
      specStatus: "needs_attention",
      queueStatus: "dequeued",
      dequeueReason: "needs_attention",
      events: ["dag.spec.needs_attention", "merge.dequeued"],
    });
    const operations = fake
      .sql()
      .filter((sql) => sql.startsWith("SELECT mq.") || sql.startsWith("UPDATE") || sql.startsWith("INSERT"))
      .map((sql) => {
        if (sql.startsWith("SELECT")) return "lock-ownership";
        if (sql.startsWith("UPDATE specs")) return "park-spec";
        if (sql.startsWith("UPDATE merge_queue")) return "dequeue";
        return sql.includes("dag.spec.needs_attention") ? "park-event" : "dequeue-event";
      });
    expect(operations).toEqual(["lock-ownership", "park-spec", "park-event", "dequeue-event", "dequeue"]);
  });

  it("also owns an unclaimed queued culprit without requiring a split claim write", async () => {
    const fake = fakePool({ queueStatus: "queued" });
    const writer = new DirectRunStateWriter(fake.pool);

    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({ kind: "parked", newlyParked: true });
    expect(fake.state()).toMatchObject({
      specStatus: "needs_attention",
      queueStatus: "dequeued",
      dequeueReason: "needs_attention",
    });
  });

  it("rolls back a failure after the spec update and retains the claimed queue item", async () => {
    const fake = fakePool({}, "merge.dequeued");
    const writer = new DirectRunStateWriter(fake.pool);

    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "write_failed",
      retryAfterMs: 3_000,
    });
    expect(fake.state()).toEqual({
      specStatus: "in_flight",
      queueStatus: "merging",
      dequeueReason: null,
      events: [],
    });
  });

  it.each([
    ["orgId", "org_other"],
    ["projectId", "project_other"],
    ["queueId", "queue_other"],
    ["runId", "run_other"],
    ["specId", "spec_other"],
  ] as const)("fails closed when %s does not match exact ownership", async (key, value) => {
    const fake = fakePool();
    const writer = new DirectRunStateWriter(fake.pool);

    await expect(writer.parkRecoveryAndDequeue({ ...INPUT, [key]: value })).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "ownership_missing",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    });
    expect(fake.state()).toMatchObject({ specStatus: "in_flight", queueStatus: "merging", events: [] });
  });

  it("reports inactive ownership as unknown, but proves active retention for an ineligible spec", async () => {
    const inactive = fakePool({ queueStatus: "dequeued", dequeueReason: "blocked" });
    const terminalSpec = fakePool({ specStatus: "cancelled" });

    await expect(new DirectRunStateWriter(inactive.pool).parkRecoveryAndDequeue(INPUT)).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "queue_not_active",
      queueDisposition: "unknown",
    });
    await expect(new DirectRunStateWriter(terminalSpec.pool).parkRecoveryAndDequeue(INPUT)).resolves.toMatchObject({
      kind: "parking_failed",
      reason: "spec_not_recoverable",
      queueDisposition: "retained",
    });
    expect(inactive.state().events).toEqual([]);
    expect(terminalSpec.state().events).toEqual([]);
  });

  it("uses the exact committed queue receipt after legal spec progression without duplicate events", async () => {
    const fake = fakePool();
    const writer = new DirectRunStateWriter(fake.pool);

    await writer.parkRecoveryAndDequeue(INPUT);
    fake.setSpecStatus("open");
    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({ kind: "parked", newlyParked: false });
    expect(fake.state().events).toEqual(["dag.spec.needs_attention", "merge.dequeued"]);
  });

  it("rejects empty messages identically before the direct writer touches the database", async () => {
    const fake = fakePool();
    await expect(
      new DirectRunStateWriter(fake.pool).parkRecoveryAndDequeue({ ...INPUT, message: "" }),
    ).resolves.toEqual({
      kind: "parking_failed",
      reason: "invalid_input",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    });
    expect(fake.sql()).toEqual([]);
  });
});

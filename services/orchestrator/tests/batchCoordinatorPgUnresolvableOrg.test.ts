// Follow-up observability pin for PR #763 (task #51): `PgBatchMergeEventEmitter.withScopedStore`
// carried the SAME silent-return pattern PR #763 fixed on `PgDagEventEmitter.withScopedStore`
// and PR #770 fixed on `PgPercolationEventEmitter.withScopedStore` — a null-org project row
// (or a missing project row) silently dropped every merge.batch.* event, so an operator could
// not see WHY a batch halt/no-emit happened without grepping engine logs.
//
// The fix makes the drop LOUD: an ERROR log carrying the projectId + eventKind + a
// `unresolvable_project_org` reason, so an operator has a grep-able signal. We do NOT
// synthesize an org to durably persist the event — events.org_id is NOT NULL + FK-tied
// to organizations, mirroring the v68-fix rationale in `jobReaper.ts` that refused to
// fake tenancy to satisfy that NOT NULL. These tests pin the loud-log shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { setSystemPool, resetSystemPool, allowRuntimePoolAsSystemForTests } from "@tanren/db";
import { PgBatchMergeEventEmitter } from "../src/engine/merge/batchCoordinatorPg.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";

interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * A minimal `pg.Pool` stand-in. The emitter's org resolver runs
 * `SELECT org_id FROM projects WHERE project_id = $1` under `runWithSystemScope`;
 * this pool answers that read with a scripted row (a NULL org_id represents an
 * unresolvable project). Every non-tx-control statement is recorded so we can
 * assert the emitter did NOT dive into a scoped write when org was null.
 */
class RecordingPool {
  readonly queries: RecordedQuery[] = [];
  /** The row returned to the emitter's org SELECT. `null` = unresolvable. */
  scriptedProjectOrgId: string | null = null;
  /** Set to true when the emitter's org SELECT should return NO rows (missing project). */
  projectMissing = false;

  private record(text: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const trimmed = text.trim();
    const isTxControl = ["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL");
    if (isTxControl) return { rows: [], rowCount: 0 };
    this.queries.push({ text, params });
    if (/SELECT org_id FROM projects/u.test(text)) {
      if (this.projectMissing) return { rows: [], rowCount: 0 };
      return { rows: [{ org_id: this.scriptedProjectOrgId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    return this.record(text, params);
  }
  async connect(): Promise<pg.PoolClient> {
    const record = (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> =>
      Promise.resolve(this.record(text, params));
    return {
      query: (text: string, params: unknown[] = []) => record(text, params),
      release: () => {},
    } as unknown as pg.PoolClient;
  }
}

function poolAs(pool: RecordingPool): pg.Pool {
  return pool as unknown as pg.Pool;
}

function parseLogLine(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * A minimal `RunStateWriter` that only surfaces `append` — the sole method the
 * `PgBatchMergeEventEmitter` emit-path drives. `appends` captures every `append`
 * call so we can pin BOTH the negative test (no append fired on null-org) AND
 * the positive test (append DID fire on the resolved-org path).
 */
class RecordingWriter implements Pick<RunStateWriter, "append"> {
  readonly appends: AppendEventInput[] = [];
  async append(input: AppendEventInput): Promise<void> {
    this.appends.push(input);
  }
}

function writerAs(writer: RecordingWriter): RunStateWriter {
  return writer as unknown as RunStateWriter;
}

function entry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    orgId: "org_1",
    projectId: "project_1",
    queueId: "q_1",
    runId: "run_1",
    specId: "spec_1",
    prUrl: "https://example/pr/1",
    prNumber: 1,
    dependsOn: [],
    priority: "P1",
    orderKey: 1,
    ...overrides,
  };
}

describe("PgBatchMergeEventEmitter — unresolvable-project-org fails LOUD (task #51, PR #763/#770 follow-up)", () => {
  let pool: RecordingPool;
  let writer: RecordingWriter;
  let emitter: PgBatchMergeEventEmitter;
  // The logger writes at ERROR to console.error — spy on it so we can parse the
  // structured JSON line and assert against the observability contract.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousLogLevel: string | undefined;

  beforeEach(() => {
    // Force the log level down to `error` (default `info` already emits errors,
    // but pin it in case the ambient env raised it) so the drop line always fires.
    previousLogLevel = process.env["TANREN_LOG_LEVEL"];
    process.env["TANREN_LOG_LEVEL"] = "error";
    allowRuntimePoolAsSystemForTests();
    pool = new RecordingPool();
    writer = new RecordingWriter();
    setSystemPool(poolAs(pool));
    emitter = new PgBatchMergeEventEmitter(poolAs(pool), writerAs(writer));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    resetSystemPool();
    if (previousLogLevel === undefined) {
      delete process.env["TANREN_LOG_LEVEL"];
    } else {
      process.env["TANREN_LOG_LEVEL"] = previousLogLevel;
    }
  });

  it("emitChecking with a NULL project.org_id logs at ERROR with the fail-closed reason (no silent drop)", async () => {
    pool.scriptedProjectOrgId = null;

    await emitter.emitChecking({
      projectId: "proj_null_org",
      batch: [entry()],
      formation: { batch: [entry()], capped: false, eligibleCount: 1 },
      maxBatchSize: 4,
    });

    // The ONLY statement that ran is the org SELECT under runWithSystemScope —
    // no INSERT INTO events (a null-org append would violate events.org_id NOT NULL).
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0]!.text).toMatch(/SELECT org_id FROM projects/u);
    // The writer's append was NOT invoked — the null-org branch short-circuited.
    expect(writer.appends).toHaveLength(0);

    // The observability signal: an ERROR log line carrying the projectId,
    // the exact event kind that was dropped, and the machine-parseable
    // `unresolvable_project_org` reason so an operator can grep/alert.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["level"]).toBe("error");
    expect(line["msg"]).toMatch(/merge\.batch event DROPPED/u);
    expect(line["projectId"]).toBe("proj_null_org");
    expect(line["eventKind"]).toBe("merge.batch.checking");
    expect(line["reason"]).toBe("unresolvable_project_org");
    expect(line["component"]).toBe("batch-merge-event-emitter");
  });

  it("emitPassed with a MISSING project row logs at ERROR too (same fail-loud posture)", async () => {
    pool.projectMissing = true;

    await emitter.emitPassed({
      projectId: "proj_does_not_exist",
      batch: [entry()],
      integrationBranch: "tanren/integ/foo",
    });

    expect(writer.appends).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["msg"]).toMatch(/merge\.batch event DROPPED/u);
    expect(line["projectId"]).toBe("proj_does_not_exist");
    expect(line["eventKind"]).toBe("merge.batch.passed");
    expect(line["reason"]).toBe("unresolvable_project_org");
    expect(line["component"]).toBe("batch-merge-event-emitter");
  });

  it("emitBisecting with a NULL org logs at ERROR with the bisecting eventKind", async () => {
    pool.scriptedProjectOrgId = null;

    await emitter.emitBisecting({
      projectId: "proj_null_org",
      batch: [entry()],
      message: "check failed",
    });

    expect(writer.appends).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["eventKind"]).toBe("merge.batch.bisecting");
    expect(line["reason"]).toBe("unresolvable_project_org");
  });

  it("emitInfraBlocked with a NULL org logs at ERROR with the infra_blocked eventKind", async () => {
    pool.scriptedProjectOrgId = null;

    await emitter.emitInfraBlocked({
      projectId: "proj_null_org",
      batch: [entry()],
      message: "creds missing",
      attempts: 1,
    });

    expect(writer.appends).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["eventKind"]).toBe("merge.batch.infra_blocked");
    expect(line["reason"]).toBe("unresolvable_project_org");
  });

  it("emitCulprit with a NULL org logs at ERROR with the culprit eventKind", async () => {
    pool.scriptedProjectOrgId = null;

    await emitter.emitCulprit({
      projectId: "proj_null_org",
      culprit: entry(),
      checks: 3,
      message: "bisect isolated culprit",
    });

    expect(writer.appends).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["eventKind"]).toBe("merge.batch.culprit");
    expect(line["reason"]).toBe("unresolvable_project_org");
  });

  it("a resolved org still routes through the scoped writer — the fail-loud branch does NOT fire", async () => {
    // Negative pin: a healthy project row (org_id present) must not trip the
    // ERROR log — otherwise every legitimate emit would flood the stream.
    pool.scriptedProjectOrgId = "org_ok";

    await emitter.emitChecking({
      projectId: "proj_ok",
      batch: [entry()],
      formation: { batch: [entry()], capped: false, eligibleCount: 1 },
      maxBatchSize: 4,
    });

    // Observable state — the org resolver ran AND the writer's append DID fire
    // with the resolved orgId (proving the non-null branch was taken).
    expect(writer.appends).toHaveLength(1);
    const appended = writer.appends[0]!;
    expect(appended.orgId).toBe("org_ok");
    expect(appended.eventType).toBe("merge.batch.checking");
    expect(appended.projectId).toBe("proj_ok");
    // And the fail-loud log line never fired.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

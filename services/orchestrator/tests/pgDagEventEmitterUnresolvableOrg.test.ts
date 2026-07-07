// Follow-up observability pin for PR #753 (task #38): `PgDagEventEmitter.withScopedStore`
// used to silently return when the project row was missing OR its `org_id` was NULL,
// so the fail-closed `dag.budget.paused` event (or any other dag.* event routed through
// this seam) was DROPPED. The safety invariant still held (walker returned
// `budget_paused`, subscriber short-circuited), but the operator could not see WHY
// without grepping engine logs.
//
// The fix makes the drop LOUD: an ERROR log carrying the projectId + eventKind + a
// `unresolvable_project_org` reason, so an operator has a grep-able signal. We do NOT
// synthesize an org to durably persist the event — events.org_id is NOT NULL + FK-tied
// to organizations, mirroring the v68-fix rationale in `jobReaper.ts` that refused to
// fake tenancy to satisfy that NOT NULL. These tests pin the loud-log shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { setSystemPool, resetSystemPool, allowRuntimePoolAsSystemForTests } from "@tanren/db";
import { PgDagEventEmitter } from "../src/engine/dag/dagEventEmitterPg.js";

interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * A minimal `pg.Pool` stand-in. The emitter's org resolver runs
 * `SELECT org_id FROM projects WHERE project_id = $1` under `runWithSystemScope`;
 * this pool answers that read with a scripted row (a NULL org_id represents an
 * unresolvable project — the exact halt shape PgBudgetGate signals with
 * `failClosed: "unresolvable_project_org"`). Every event-append statement is
 * recorded so we can assert the append DID NOT fire when org was null.
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

describe("PgDagEventEmitter — unresolvable-project-org fails LOUD (task #38, PR #753 follow-up)", () => {
  let pool: RecordingPool;
  let emitter: PgDagEventEmitter;
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
    setSystemPool(poolAs(pool));
    emitter = new PgDagEventEmitter(poolAs(pool));
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

  it("emitBudgetPaused with a NULL project.org_id logs at ERROR with the fail-closed reason (no silent drop)", async () => {
    // The exact PgBudgetGate `unresolvable_project_org` shape.
    pool.scriptedProjectOrgId = null;

    await emitter.emitBudgetPaused({
      projectId: "proj_null_org",
      ceilingUsd: 0,
      spentUsd: 0,
      period: "monthly",
      readyHeldBack: 0,
      reason: "unresolvable_project_org",
    });

    // The ONLY statement that ran is the org SELECT under runWithSystemScope —
    // no event INSERT (a null-org write would violate events.org_id NOT NULL).
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0]!.text).toMatch(/SELECT org_id FROM projects/u);

    // The observability signal: an ERROR log line carrying the projectId,
    // the exact event kind that was dropped, and the machine-parseable
    // `unresolvable_project_org` reason so an operator can grep/alert.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["level"]).toBe("error");
    expect(line["msg"]).toMatch(/dag event DROPPED/u);
    expect(line["projectId"]).toBe("proj_null_org");
    expect(line["eventKind"]).toBe("dag.budget.paused");
    expect(line["reason"]).toBe("unresolvable_project_org");
    expect(line["component"]).toBe("dag-event-emitter");
  });

  it("emitBudgetPaused with a MISSING project row logs at ERROR too (same fail-loud posture)", async () => {
    // The exact PgBudgetGate `owner === null` shape.
    pool.projectMissing = true;

    await emitter.emitBudgetPaused({
      projectId: "proj_does_not_exist",
      ceilingUsd: 0,
      spentUsd: 0,
      period: "monthly",
      readyHeldBack: 0,
      reason: "unresolvable_project_org",
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["msg"]).toMatch(/dag event DROPPED/u);
    expect(line["projectId"]).toBe("proj_does_not_exist");
    expect(line["eventKind"]).toBe("dag.budget.paused");
    expect(line["reason"]).toBe("unresolvable_project_org");
  });

  it("emitBudgetMilestone with an unresolvable org logs at ERROR + returns false (no silent skip)", async () => {
    // The milestone's own inline org resolver has the same silent-return
    // hazard as withScopedStore; the fix mirrors the same loud-log posture.
    pool.scriptedProjectOrgId = null;

    const emitted = await emitter.emitBudgetMilestone({
      projectId: "proj_null_org",
      band: 80,
      ceilingUsd: 100,
      spentUsd: 90,
      period: "monthly",
    });

    // The milestone contract returns `false` on no-emit; the callers log a
    // "deduped" debug on false, which was fine — but the underlying REASON
    // for the no-emit was previously invisible. Now the ERROR line carries it.
    expect(emitted).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLogLine(errorSpy.mock.calls[0]![0] as string);
    expect(line["projectId"]).toBe("proj_null_org");
    expect(line["eventKind"]).toBe("dag.budget.milestone");
    expect(line["reason"]).toBe("unresolvable_project_org");
  });

  it("a resolved org still routes through the scoped store — the fail-loud branch does NOT fire", async () => {
    // Negative pin: a healthy project row (org_id present) must not trip the
    // ERROR log — otherwise every legitimate emit would flood the stream.
    pool.scriptedProjectOrgId = "org_ok";

    // A resolved org routes through runWithOrgScope → BEGIN + SET LOCAL + INSERT
    // + COMMIT on the org-scoped client. The BEGIN/SET LOCAL/COMMIT are inert in
    // the recorder; the INSERT is captured so we can pin BOTH observable outcomes
    // (the ERROR log did NOT fire AND the event INSERT did fire, proving the
    // non-null branch was taken).
    await emitter.emitBudgetPaused({
      projectId: "proj_ok",
      ceilingUsd: 100,
      spentUsd: 10,
      period: "monthly",
      readyHeldBack: 0,
      reason: undefined,
    });

    // Observable state — the org resolver ran AND the events INSERT ran.
    const inserts = pool.queries.filter((q) => /INSERT INTO events/u.test(q.text));
    expect(inserts).toHaveLength(1);
    const insert = inserts[0]!;
    // The INSERT carries the resolved org_id (position $5 in the append SQL).
    expect(insert.params[4]).toBe("org_ok");
    // And the fail-loud log line never fired.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

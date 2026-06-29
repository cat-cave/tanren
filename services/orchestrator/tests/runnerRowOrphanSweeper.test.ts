// Unit pins for the runner-row orphan sweeper (task #9). The recording-pool
// shape mirrors `runnerStore.test.ts` — the sweeper writes ONE business UPDATE
// per tick under `runWithSystemScope`; the recorder captures it so the SQL
// shape (the allocator allowlist, the run-terminal allowlist, the released_at
// gate, the join + RETURNING) is asserted without a real Postgres. The
// real-pg shape lives in `runnerRowOrphanSweeper.integration.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { setSystemPool, resetSystemPool, allowRuntimePoolAsSystemForTests } from "@tanren/db";
import {
  RunnerRowOrphanSweeper,
  RUNNER_ROW_ORPHAN_SWEEPER_ALLOCATORS,
  RUNNER_ROW_ORPHAN_TERMINAL_RUN_STATUSES,
  type ReclaimedOrphan,
} from "../src/engine/allocators/runnerRowOrphanSweeper.js";

interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * A minimal pg.Pool stand-in: a `connect()` returning a client whose `query()`
 * records every BUSINESS statement (BEGIN/COMMIT/SET LOCAL are inert) and
 * returns a scripted reclaim result. The shape is the same as the
 * `runnerStore.test.ts` pool — the sweeper's UPDATE runs under
 * `runWithSystemScope`, which opens a short SYSTEM-scope txn for the statement.
 */
class RecordingPool {
  readonly queries: RecordedQuery[] = [];
  /** The rows the next business UPDATE returns (scripted RETURNING result). */
  scriptedReclaim: Array<{ runner_id: string; run_id: string | null; org_id: string | null; allocator: string }> = [];
  /** When set, the next business UPDATE throws — exercises the per-tick error tolerance. */
  failNextUpdate: Error | undefined = undefined;

  private record(text: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const trimmed = text.trim();
    const isTxControl = ["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL");
    if (isTxControl) {
      return { rows: [], rowCount: 0 };
    }
    this.queries.push({ text, params });
    if (this.failNextUpdate !== undefined) {
      const error = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw error;
    }
    const rows = this.scriptedReclaim;
    this.scriptedReclaim = [];
    return { rows, rowCount: rows.length };
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    return this.record(text, params);
  }
  async connect(): Promise<pg.PoolClient> {
    const record = (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> =>
      // `query` MUST return a thenable so `runWithSystemScope`'s rollback path
      // can do `client.query("ROLLBACK").catch(...)` on the error branch — same
      // shape as the runnerStore.test.ts pool's connect().
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

describe("RunnerRowOrphanSweeper (task #9)", () => {
  let pool: RecordingPool;
  let sweeper: RunnerRowOrphanSweeper;

  beforeEach(() => {
    // runWithSystemScope reads the registered system pool — point it at the
    // recording pool so the sweeper's UPDATE actually lands on our recorder.
    allowRuntimePoolAsSystemForTests();
    pool = new RecordingPool();
    setSystemPool(poolAs(pool));
    sweeper = new RunnerRowOrphanSweeper({ pool: poolAs(pool) });
  });

  afterEach(async () => {
    await sweeper.stop();
    resetSystemPool();
  });

  it("emits the documented atomic UPDATE…FROM runs join (no select-then-update split)", async () => {
    await sweeper.tick();

    expect(pool.queries).toHaveLength(1);
    const { text } = pool.queries[0]!;
    // ONE atomic statement — the SELECT+UPDATE split would open a race window
    // where a concurrent release lands between the read + the write. Pin the
    // single-statement shape with `UPDATE runners r … FROM runs run … RETURNING`.
    expect(text).toMatch(/UPDATE\s+runners\s+r/u);
    expect(text).toMatch(/SET\s+status\s*=\s*'abandoned',\s*released_at\s*=\s*now\(\)/u);
    expect(text).toMatch(/FROM\s+runs\s+run/u);
    expect(text).toMatch(/WHERE\s+r\.run_id\s*=\s*run\.run_id/u);
    expect(text).toMatch(/AND\s+r\.released_at\s+IS\s+NULL/u);
    expect(text).toMatch(/AND\s+r\.allocator\s*=\s*ANY\(\$1::text\[\]\)/u);
    expect(text).toMatch(/AND\s+run\.status\s*=\s*ANY\(\$2::text\[\]\)/u);
    expect(text).toMatch(/RETURNING\s+r\.runner_id,\s*r\.run_id,\s*r\.org_id,\s*r\.allocator/u);
  });

  it("binds the long-lived allocator allowlist ($1) and the hard-terminal run-status allowlist ($2)", async () => {
    await sweeper.tick();

    const params = pool.queries[0]!.params;
    // $1 — the allocator allowlist: only the long-lived external-host paths.
    // A cloud/sidecar entry sneaking in here would silently sweep rows whose
    // teardown is owned by another layer (the cloud allocator's resources Map
    // or the sidecar service's own sweeper) and double-release them.
    expect(params[0]).toEqual(RUNNER_ROW_ORPHAN_SWEEPER_ALLOCATORS);
    expect(params[0]).toEqual(["static-runner", "manual-ssh"]);
    // $2 — the hard-terminal run-status allowlist. `halted` is INTENTIONALLY
    // ABSENT (a halted run is recoverable — its runner row must survive); only
    // the irreversible terminal states (`completed`, `failed`, `cancelled`)
    // release the row.
    expect(params[1]).toEqual(RUNNER_ROW_ORPHAN_TERMINAL_RUN_STATUSES);
    expect(params[1]).toEqual(["completed", "failed", "cancelled"]);
    expect(params[1]).not.toContain("halted");
  });

  it("zero reclaimed rows is a clean idempotent pass (empty summary, no per-row noise)", async () => {
    pool.scriptedReclaim = [];
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
    expect(summary.countsByAllocator).toEqual({});
  });

  it("returns one ReclaimedOrphan per reclaimed row + counts each by allocator", async () => {
    pool.scriptedReclaim = [
      { runner_id: "runner_a", run_id: "run_a", org_id: "org_1", allocator: "static-runner" },
      { runner_id: "runner_b", run_id: "run_b", org_id: "org_1", allocator: "manual-ssh" },
      { runner_id: "runner_c", run_id: "run_c", org_id: "org_2", allocator: "manual-ssh" },
    ];

    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual<ReclaimedOrphan[]>([
      { runnerId: "runner_a", runId: "run_a", orgId: "org_1", allocator: "static-runner" },
      { runnerId: "runner_b", runId: "run_b", orgId: "org_1", allocator: "manual-ssh" },
      { runnerId: "runner_c", runId: "run_c", orgId: "org_2", allocator: "manual-ssh" },
    ]);
    expect(summary.countsByAllocator).toEqual({ "static-runner": 1, "manual-ssh": 2 });
  });

  it("a per-tick UPDATE failure is tolerated (empty summary, next tick retries) — never throws out of tick()", async () => {
    // One bad poll never stops the loop — the sidecar sweeper's documented
    // tolerance contract (services/allocator/src/sweeper.ts). A throw here
    // would crash the worker's drain handler that awaits `stop()`.
    pool.failNextUpdate = new Error("transient pg connection blip");

    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
    expect(summary.countsByAllocator).toEqual({});
    // Next tick proceeds normally.
    pool.scriptedReclaim = [
      { runner_id: "runner_recovered", run_id: "run_r", org_id: "org_1", allocator: "static-runner" },
    ];
    const summary2 = await sweeper.tick();
    expect(summary2.reclaimed).toHaveLength(1);
  });

  it("concurrent tick() calls are serialized (the second is a clean no-op while the first is in flight)", async () => {
    // A `pool.connect()` that NEVER resolves makes the first tick stall in-
    // flight; a second concurrent tick must short-circuit to an empty summary
    // (the `ticking` guard), not double-fire the UPDATE.
    let resolveConnect: ((client: pg.PoolClient) => void) | undefined;
    const blockingConnect = new Promise<pg.PoolClient>((resolve) => {
      resolveConnect = resolve;
    });
    const stallingPool = {
      connect: () => blockingConnect,
      query: pool.query.bind(pool),
    } as unknown as pg.Pool;
    setSystemPool(stallingPool);
    const stalling = new RunnerRowOrphanSweeper({ pool: stallingPool });

    const inFlight = stalling.tick();
    // A second tick while the first is in flight returns an empty summary
    // SYNCHRONOUSLY (the `ticking` guard short-circuits before any SQL).
    const overlap = await stalling.tick();
    expect(overlap.reclaimed).toEqual([]);

    // Unblock the first tick (resolves to the underlying recording pool's
    // client). With nothing scripted, the inflight tick reclaims nothing.
    resolveConnect!(await pool.connect());
    await inFlight;
    await stalling.stop();
  });

  it("stop() drains the in-flight tick (teardown never races a live sweep)", async () => {
    // A delayed connect lets us prove stop() AWAITS the in-flight tick rather
    // than just clearing the timer — mirrors the H10 pattern from
    // RunWorkspaceReaper.stop / the sidecar RunnerSweeper.stop.
    let resolveConnect: ((client: pg.PoolClient) => void) | undefined;
    const delayedConnect = new Promise<pg.PoolClient>((resolve) => {
      resolveConnect = resolve;
    });
    const delayedPool = {
      connect: () => delayedConnect,
      query: pool.query.bind(pool),
    } as unknown as pg.Pool;
    setSystemPool(delayedPool);
    const delayed = new RunnerRowOrphanSweeper({ pool: delayedPool });
    const tickPromise = delayed.tick();
    let tickSettled = false;
    void tickPromise.then(() => {
      tickSettled = true;
    });

    const stopPromise = delayed.stop();
    // stop() must NOT resolve while the tick is still in flight.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(tickSettled).toBe(false);

    // Unblock the tick; stop() should now resolve once the tick settles.
    resolveConnect!(await pool.connect());
    await stopPromise;
    expect(tickSettled).toBe(true);
  });

  it("a stopped sweeper's tick is a clean no-op (no UPDATE fires)", async () => {
    await sweeper.stop();
    const summary = await sweeper.tick();
    expect(summary.reclaimed).toEqual([]);
    expect(pool.queries).toHaveLength(0);
  });
});

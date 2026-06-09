// Fast unit cover (no live DB) for the runner-lifecycle hardening at the store
// SQL seam — runs in `just fast-check` where the RLS integration suite skips:
//   fix #2: markReleased is an atomic CLAIM (`AND released_at IS NULL` in the
//           UPDATE) → rowCount===0 returns undefined (the loser does NO teardown);
//   fix #3: insert's `ON CONFLICT ... WHERE runners.released_at IS NOT NULL` only
//           re-adopts a RELEASED runner_id; a LIVE conflict yields rowCount===0,
//           which we reject LOUD — never silently overwriting a live container_id.
//
// We drive the real PgRunnerStore against a fake `pg.Pool`/client that records
// the issued SQL and returns a scripted rowCount, so the assertions are about the
// store's own query shape + rowCount-driven branching, not about Postgres.
import { describe, expect, it } from "vitest";
import { PgRunnerStore } from "../src/pgRunnerStore.js";
import type { RunnerRecord } from "../src/runnerLifecycle.js";

interface FakeResult {
  rowCount: number;
  rows: unknown[];
}

class FakeClient {
  readonly queries: string[] = [];
  constructor(private readonly responder: (sql: string) => FakeResult) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string): Promise<FakeResult> {
    this.queries.push(sql);
    // Transaction control statements from runWithOrgScope are inert here.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/iu.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    return this.responder(sql);
  }
  release(): void {}
}

class FakePool {
  readonly clients: FakeClient[] = [];
  readonly poolQueries: string[] = [];
  constructor(private readonly responder: (sql: string) => FakeResult) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this.responder);
    this.clients.push(client);
    return client;
  }
  // markReleased / findActive go straight at the pool (system pool), not via connect.
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string): Promise<FakeResult> {
    this.poolQueries.push(sql);
    return this.responder(sql);
  }
  lastQuery(): string {
    return this.poolQueries.at(-1) ?? "";
  }
}

function recordFor(runnerId: string): RunnerRecord {
  return {
    runnerId,
    runId: "run_x",
    projectId: "proj_x",
    handle: "run_x",
    orgId: "org_test",
    containerId: "host-1",
    workspaceVolume: "vol-ws",
    codexHomeVolume: "vol-ch",
    sshHost: "10.0.0.1",
    sshPort: 2200,
    hostKeyFingerprint: "SHA256:abc",
    imageSha: "img@sha256:dead",
    createdAt: new Date(),
    released: false,
  };
}

describe("PgRunnerStore.markReleased atomic claim (fix #2)", () => {
  it("UPDATE carries the `released_at IS NULL` claim predicate", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [released_row()] }));
    const store = new PgRunnerStore(pool as never, pool as never);
    await store.markReleased("runner_a", "completed");
    const sql = pool.lastQuery();
    expect(sql).toMatch(/UPDATE runners/u);
    expect(sql).toMatch(/released_at IS NULL/u);
  });

  it("rowCount===0 (lost the claim) → undefined, no record (caller does NO teardown)", async () => {
    const pool = new FakePool(() => ({ rowCount: 0, rows: [] }));
    const store = new PgRunnerStore(pool as never, pool as never);
    expect(await store.markReleased("runner_a", "completed")).toBeUndefined();
  });

  it("rowCount===1 (won the claim) → the released record", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [released_row()] }));
    const store = new PgRunnerStore(pool as never, pool as never);
    const rec = await store.markReleased("runner_a", "completed");
    expect(rec?.runnerId).toBe("runner_a");
    expect(rec?.released).toBe(true);
  });
});

describe("PgRunnerStore.insert never overwrites a live container_id (fix #3)", () => {
  it("ON CONFLICT only re-adopts a RELEASED row (WHERE released_at IS NOT NULL)", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [] }));
    const store = new PgRunnerStore(pool as never, pool as never);
    await store.insert(recordFor("runner_a"));
    const insertSql = pool.clients[0]?.queries.find((q) => /INSERT INTO runners/u.test(q)) ?? "";
    expect(insertSql).toMatch(/ON CONFLICT \(runner_id\) DO UPDATE/u);
    expect(insertSql).toMatch(/WHERE runners\.released_at IS NOT NULL/u);
    // It clears released_at on the re-adopt branch.
    expect(insertSql).toMatch(/released_at = NULL/u);
  });

  it("rowCount===0 (a LIVE conflict matched nothing) → fails LOUD, never silent", async () => {
    // The INSERT...ON CONFLICT matched the live row but the WHERE excluded it →
    // zero rows affected. The store must throw rather than silently no-op.
    const pool = new FakePool((sql) =>
      /INSERT INTO runners/u.test(sql) ? { rowCount: 0, rows: [] } : { rowCount: 0, rows: [] },
    );
    const store = new PgRunnerStore(pool as never, pool as never);
    await expect(store.insert(recordFor("runner_live"))).rejects.toThrow(/already has a LIVE row/u);
  });

  it("rowCount===1 (fresh insert or released re-adopt) → succeeds", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [] }));
    const store = new PgRunnerStore(pool as never, pool as never);
    await expect(store.insert(recordFor("runner_ok"))).resolves.toBeUndefined();
  });
});

function released_row(): Record<string, unknown> {
  return {
    runner_id: "runner_a",
    run_id: "run_x",
    project_id: "proj_x",
    org_id: "org_test",
    container_id: "host-1",
    ssh_host: "10.0.0.1",
    ssh_port: 2200,
    host_key_fingerprint: "SHA256:abc",
    image_sha: "img@sha256:dead",
    created_at: new Date(),
  };
}

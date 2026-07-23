// #1254 hazard C — cross-process fixed-pool lease reservation, real-Postgres.
//
// Proves the reservation moved off the pre-#1254 in-memory per-process maps onto
// the shared `runners` table:
//   (A) TWO concurrent reservers cannot exceed `maxConcurrent` (cap fenced atomically);
//   (B) TWO concurrent reservers cannot double-book one host (unique live lease);
//   (C) a released lease is re-claimable;
//   (D) a non-owner / stale-token release is REJECTED (fencing);
//   (E) org RLS isolation — a cross-org caller cannot see or release another org's lease.
//
// The two "processes" are two PgRunnerStore instances over the restricted
// tanren_app pool, firing concurrently so the Postgres advisory lock + partial
// unique index are the real arbiters (not JS scheduling).
import { migrate, runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PgRunnerStore,
  PoolLeaseCapacityError,
  PoolLeaseExhaustedError,
  StaleLeaseReleaseError,
  type PoolLeaseCandidate,
  type ReservePoolLeaseInput,
} from "../src/engine/allocators/runnerStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_runner_pool_lease_a";
const ORG_B = "org_runner_pool_lease_b";

function databaseName(): string {
  return `tanren_runner_pool_lease_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_USER;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

function host(id: string, n: number): PoolLeaseCandidate {
  return { leaseKey: id, sshHost: `10.0.0.${n}`, sshPort: 22, hostKeyFingerprint: "SHA256:x", containerId: id };
}

// Each reserver is a distinct owner (a distinct "process").
function reserve(
  store: PgRunnerStore,
  orgId: string,
  poolKey: string,
  runnerId: string,
  candidates: PoolLeaseCandidate[],
  ownerId: string,
  maxConcurrent?: number,
): Promise<Awaited<ReturnType<PgRunnerStore["reservePoolLease"]>>> {
  const input: ReservePoolLeaseInput = {
    runnerId,
    runId: null,
    projectId: null,
    orgId,
    allocator: "manual-ssh",
    poolKey,
    owner: ownerId,
    imageSha: "img@sha256:x",
    candidates,
    ...(maxConcurrent !== undefined && { maxConcurrent }),
  };
  return runWithJobOrgId(orgId, () => store.reservePoolLease(input));
}

describeDb("runner pool lease — cross-process reservation + RLS (#1254)", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store1: PgRunnerStore;
  let store2: PgRunnerStore;

  async function liveCount(orgId: string, poolKey: string): Promise<number> {
    // Owner connection bypasses RLS → the ground truth across all orgs.
    const result = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM runners WHERE org_id = $1 AND pool_key = $2 AND released_at IS NULL",
      [orgId, poolKey],
    );
    return Number(result.rows[0]?.n ?? "0");
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();

    owner = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(owner);
    for (const orgId of [ORG_A, ORG_B]) {
      await owner.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [orgId],
      );
    }
    app = new Pool({ connectionString: connectionUrl(ADMIN_URL, database, true) });
    store1 = new PgRunnerStore(app);
    store2 = new PgRunnerStore(app);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("(A) two concurrent reservers cannot exceed maxConcurrent", async () => {
    const pool = "cap";
    const candidates = [host("cap-a", 1), host("cap-b", 2), host("cap-c", 3)];
    // Three concurrent claims, cap of 2 → exactly one must be refused.
    const results = await Promise.allSettled([
      reserve(store1, ORG_A, pool, "runner_cap_1", candidates, "proc-1", 2),
      reserve(store2, ORG_A, pool, "runner_cap_2", candidates, "proc-2", 2),
      reserve(store1, ORG_A, pool, "runner_cap_3", candidates, "proc-1", 2),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PoolLeaseCapacityError);
    // The shared store holds exactly the cap — never over-allocated across processes.
    expect(await liveCount(ORG_A, pool)).toBe(2);
  });

  it("(B) two concurrent reservers cannot double-book one host", async () => {
    const pool = "book";
    const only = [host("book-a", 9)];
    const results = await Promise.allSettled([
      reserve(store1, ORG_A, pool, "runner_book_1", only, "proc-1"),
      reserve(store2, ORG_A, pool, "runner_book_2", only, "proc-2"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PoolLeaseExhaustedError);
    // Exactly ONE live lease on the host — no double-book.
    const rows = await owner.query("SELECT runner_id FROM runners WHERE lease_key = $1 AND released_at IS NULL", [
      "book-a",
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("(C) a released lease is re-claimable", async () => {
    const pool = "reclaim";
    const only = [host("reclaim-a", 5)];
    const first = await reserve(store1, ORG_A, pool, "runner_reclaim", only, "proc-1");
    // A fresh reservation while it is LIVE is refused (host busy).
    await expect(reserve(store2, ORG_A, pool, "runner_reclaim_2", only, "proc-2")).rejects.toBeInstanceOf(
      PoolLeaseExhaustedError,
    );
    await runWithJobOrgId(ORG_A, () =>
      store1.releasePoolLease({ runnerId: "runner_reclaim", owner: "proc-1", fencingToken: first.fencingToken }),
    );
    // Now the host is free again → a new run claims it.
    const second = await reserve(store2, ORG_A, pool, "runner_reclaim_2", only, "proc-2");
    expect(second.leaseKey).toBe("reclaim-a");
  });

  it("(D) a non-owner / stale-token release is rejected (fencing)", async () => {
    const pool = "fence";
    const only = [host("fence-a", 7)];
    const first = await reserve(store1, ORG_A, pool, "runner_fence", only, "proc-1");

    // A DIFFERENT owner cannot release the live lease.
    await expect(
      runWithJobOrgId(ORG_A, () =>
        store2.releasePoolLease({ runnerId: "runner_fence", owner: "intruder", fencingToken: first.fencingToken }),
      ),
    ).rejects.toBeInstanceOf(StaleLeaseReleaseError);

    // The real owner + token releases cleanly.
    const released = await runWithJobOrgId(ORG_A, () =>
      store1.releasePoolLease({ runnerId: "runner_fence", owner: "proc-1", fencingToken: first.fencingToken }),
    );
    expect(released.released).toBe(true);

    // Re-claim the same runner id → a NEW fencing token. A stale release carrying
    // the OLD token is fenced off even from the same owner.
    const second = await reserve(store1, ORG_A, pool, "runner_fence", only, "proc-1");
    expect(second.fencingToken).not.toBe(first.fencingToken);
    await expect(
      runWithJobOrgId(ORG_A, () =>
        store1.releasePoolLease({ runnerId: "runner_fence", owner: "proc-1", fencingToken: first.fencingToken }),
      ),
    ).rejects.toBeInstanceOf(StaleLeaseReleaseError);
  });

  it("(E) org RLS isolation — a cross-org caller cannot see or release another org's lease", async () => {
    const pool = "rls";
    const only = [host("rls-a", 4)];
    await reserve(store1, ORG_A, pool, "runner_rls_a", only, "proc-a");

    // ORG_B, scoped through the app role, sees ZERO of ORG_A's runner rows.
    const crossView = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT runner_id FROM runners WHERE lease_key = $1", ["rls-a"]),
    );
    expect(crossView.rowCount).toBe(0);

    // ORG_B releasing ORG_A's runner id is a no-op (it cannot see the row) — never
    // an accidental cross-org free.
    const crossRelease = await runWithJobOrgId(ORG_B, () =>
      store2.releasePoolLease({ runnerId: "runner_rls_a", owner: "proc-a", fencingToken: "1" }),
    );
    expect(crossRelease.released).toBe(false);

    // ORG_A's lease is still LIVE.
    expect(await liveCount(ORG_A, pool)).toBe(1);

    // And ORG_B can hold its OWN lease on the same host id (per-org lease key).
    const bLease = await reserve(store2, ORG_B, pool, "runner_rls_b", only, "proc-b");
    expect(bLease.leaseKey).toBe("rls-a");
    expect(await liveCount(ORG_B, pool)).toBe(1);
  });
});

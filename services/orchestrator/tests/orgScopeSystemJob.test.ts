// DB-free behavior tests for the per-job SYSTEM scope (`runWithSystemJobScope` /
// `isSystemJobScope`) — the EXPLICIT null-org / cross-org marker that replaced
// the resolvers' old implicit bare-pool fallback (the scoping-hardening
// directive: no silent unscoped tenant op). Companion to orgScopeResolvers.test.ts;
// kept separate so each file stays under the per-file line cap.
//
// Routing is proven with a REAL AsyncLocalStorage plus a fake pool/client that
// RECORDS calls — every assertion is on the real routing decision, never a mock.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { getJobOrgId, isSystemJobScope, runWithJobOrgId, runWithSystemJobScope } from "@tanren/db";
import {
  hasOrgScope,
  MissingOrgScopeError,
  orgScopingPool,
  resolveQueryClient,
  withJobOrgScope,
} from "../src/engine/data/orgScopedDb.js";

interface FakePool {
  pool: pg.Pool;
  client: pg.PoolClient;
  poolSql: string[];
  clientSql: string[];
  readonly connects: number;
}

function fakePool(): FakePool {
  const fp = { poolSql: [] as string[], clientSql: [] as string[], connects: 0 };
  const client = {
    query: async (sql: string) => {
      fp.clientSql.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as pg.PoolClient;
  const pool = {
    query: async (sql: string) => {
      fp.poolSql.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      fp.connects += 1;
      return client;
    },
  } as unknown as pg.Pool;
  return Object.assign(fp, { pool, client }) as unknown as FakePool;
}

describe("runWithSystemJobScope / isSystemJobScope — the connectionless null-org marker", () => {
  it("isSystemJobScope is false outside the scope, true inside, cleared after", async () => {
    expect(isSystemJobScope()).toBe(false);
    let inside = false;
    await runWithSystemJobScope(async () => {
      inside = isSystemJobScope();
    });
    expect(inside).toBe(true);
    expect(isSystemJobScope()).toBe(false);
  });

  it("holds NO job-org-id (it is a SYSTEM marker, not an org)", async () => {
    let jobOrg: string | undefined = "sentinel";
    await runWithSystemJobScope(async () => {
      jobOrg = getJobOrgId();
    });
    expect(jobOrg).toBeUndefined();
  });

  it("propagates the work's return value", async () => {
    expect(await runWithSystemJobScope(async () => 7)).toBe(7);
  });

  it("makes hasOrgScope true (it is a valid ambient tenant-op context)", async () => {
    let seen = false;
    await runWithSystemJobScope(async () => {
      seen = hasOrgScope();
    });
    expect(seen).toBe(true);
  });
});

describe("resolver system-job arms — explicit system scope, never an unscoped bare-pool op", () => {
  it("resolveQueryClient returns the pool under a per-job org id AND under a system-job scope", async () => {
    const { pool } = fakePool();
    let underOrg: unknown;
    let underSystem: unknown;
    await runWithJobOrgId("org_job", async () => {
      underOrg = resolveQueryClient(pool);
    });
    await runWithSystemJobScope(async () => {
      underSystem = resolveQueryClient(pool);
    });
    expect(underOrg).toBe(pool);
    expect(underSystem).toBe(pool);
  });

  it("withJobOrgScope opens a short system-scope txn (BEGIN/COMMIT, NO SET LOCAL) under a system-job scope", async () => {
    const fp = fakePool();
    let ran: unknown;
    await runWithSystemJobScope(async () => {
      await withJobOrgScope(fp.pool, async (c) => {
        ran = c;
        await c.query("SELECT op");
      });
    });
    expect(ran).toBe(fp.client);
    expect(fp.connects).toBe(1);
    expect(fp.clientSql).toContain("SELECT op");
    expect(fp.clientSql.some((s) => s.startsWith("SET LOCAL"))).toBe(false);
    expect(fp.poolSql).not.toContain("SELECT op");
  });

  it("withJobOrgScope THROWS MissingOrgScopeError with no scope, no job-org-id, no system-job", async () => {
    const fp = fakePool();
    await expect(withJobOrgScope(fp.pool, async (c) => c.query("SELECT op"))).rejects.toThrow(MissingOrgScopeError);
    expect(fp.connects).toBe(0);
    expect(fp.poolSql).not.toContain("SELECT op");
  });

  it("orgScopingPool .query() routes through a short system-scope txn under a system-job scope", async () => {
    const fp = fakePool();
    const scoping = orgScopingPool(fp.pool);
    await runWithSystemJobScope(async () => {
      await scoping.query("SELECT sys");
    });
    expect(fp.clientSql).toContain("SELECT sys");
    expect(fp.poolSql).not.toContain("SELECT sys");
    expect(fp.connects).toBe(1);
    expect(fp.clientSql.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(fp.clientSql.some((s) => s.startsWith("SET LOCAL"))).toBe(false);
  });

  it("orgScopingPool .query() THROWS MissingOrgScopeError with no ambient scope at all", async () => {
    const fp = fakePool();
    const scoping = orgScopingPool(fp.pool);
    await expect(scoping.query("SELECT direct")).rejects.toThrow(MissingOrgScopeError);
    expect(fp.poolSql).not.toContain("SELECT direct");
    expect(fp.connects).toBe(0);
  });
});

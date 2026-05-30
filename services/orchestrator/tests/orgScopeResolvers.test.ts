// DB-free behavior tests for the org-scope RESOLVER logic — the pure routing
// primitives the RLS data-access layer rests on, exercised WITHOUT a real
// Postgres so Stryker can see and mutate them. The end-to-end proof of the
// SET LOCAL transaction + policy-scoped reads lives in the TANREN_RLS_DB_TEST=1
// integration suite (rlsR2*/rlsR3a*/rlsR3b*), which Stryker SKIPS; this file pins
// the decisions Stryker CAN reach: resolveQueryClient / resolveWritableClient,
// isPool / hasOrgScope, withJobOrgScope + orgScopingPool (the per-op 3-arm proxy,
// one short txn per op), runWithJobOrgId / getJobOrgId, runWithOrgScope /
// runWithSystemScope (BEGIN / SET LOCAL / COMMIT vs ROLLBACK + release), the
// assertSafeOrgId guard, and the getSystemPool env memo.
//
// Routing is proven with a REAL AsyncLocalStorage plus a fake pool/client that
// RECORDS calls — every assertion is on the real routing decision (which receiver
// the op landed on, the exact SQL emitted), never on a mock's return value.

import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  getJobOrgId,
  getOrgScope,
  getOrgScopedClient,
  getSystemPool,
  resetSystemPool,
  runWithJobOrgId,
  runWithOrgScope,
  runWithSystemScope,
  setSystemPool,
} from "@tanren/db";
import {
  hasOrgScope,
  isPool,
  orgScopingPool,
  resolveQueryClient,
  resolveWritableClient,
  withJobOrgScope,
} from "../src/engine/data/orgScopedDb.js";

// A no-op query stub for the isPool tests (it only reads `connect`).
const queryStub = async (): Promise<{ rows: never[] }> => ({ rows: [] });

// A fake pool + the single distinct client its connect() hands out. Every
// statement run on either receiver is recorded verbatim (transaction-control and
// SET LOCAL statements included) so a test can assert the EXACT routing and SQL.
interface FakePool {
  pool: pg.Pool;
  client: pg.PoolClient;
  poolSql: string[];
  clientSql: string[];
  readonly connects: number;
  readonly releases: number;
}

function fakePool(): FakePool {
  const fp = { poolSql: [] as string[], clientSql: [] as string[], connects: 0, releases: 0 };
  const client = {
    query: async (sql: string) => {
      fp.clientSql.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      fp.releases += 1;
    },
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
  // Return the SAME object the closures mutate so `connects`/`releases` read live.
  return Object.assign(fp, { pool, client }) as unknown as FakePool;
}

afterEach(() => {
  // Defensive: tests that touch the system-pool memo restore it themselves, but
  // clear here too so a thrown assertion can never leak the memo to a later test.
  resetSystemPool();
});

describe("resolveQueryClient — ambient-scope vs pool", () => {
  it("returns the bare pool when no scope is open", () => {
    const { pool } = fakePool();
    expect(resolveQueryClient(pool)).toBe(pool);
  });

  it("returns the ambient org-scoped client inside a runWithOrgScope txn", async () => {
    const { pool, client } = fakePool();
    let resolved: unknown;
    await runWithOrgScope(pool, "org_acme", async () => {
      resolved = resolveQueryClient(pool);
    });
    // The checked-out client, NOT the pool — the query joins the open txn.
    expect(resolved).toBe(client);
    expect(resolved).not.toBe(pool);
  });
});

describe("hasOrgScope — scope presence", () => {
  it("is false outside any scope", () => {
    expect(hasOrgScope()).toBe(false);
  });

  it("is true inside an org scope, and true under a system scope (null org still counts)", async () => {
    const { pool } = fakePool();
    let inOrg = false;
    let inSystem = false;
    await runWithOrgScope(pool, "org_acme", async () => {
      inOrg = hasOrgScope();
    });
    await runWithSystemScope(pool, async () => {
      inSystem = hasOrgScope();
    });
    expect(inOrg).toBe(true);
    expect(inSystem).toBe(true);
  });
});

describe("isPool — pool vs handed-in-client discriminator", () => {
  it("is true only when `connect` is a FUNCTION (false for absent or non-function)", () => {
    expect(isPool({ query: queryStub, connect: () => ({}) } as unknown as pg.Pool)).toBe(true);
    expect(isPool({ query: queryStub } as unknown as pg.PoolClient)).toBe(false);
    expect(isPool({ query: queryStub, connect: "nope" } as unknown as pg.Pool)).toBe(false);
  });
});

describe("resolveWritableClient — write-path routing", () => {
  it("routes a pool through the ambient scoped client inside a scope", async () => {
    const { pool, client } = fakePool();
    let resolved: unknown;
    await runWithOrgScope(pool, "org_acme", async () => {
      resolved = resolveWritableClient(pool);
    });
    expect(resolved).toBe(client);
  });

  it("returns the pool itself when handed a pool with no scope open", () => {
    const { pool } = fakePool();
    expect(resolveWritableClient(pool)).toBe(pool);
  });

  it("uses a handed-in query-only client verbatim even inside a scope", async () => {
    const { pool } = fakePool();
    const handedIn = { query: async () => ({ rows: [] }) } as unknown as pg.PoolClient;
    // A specific client is the caller's own transaction — never re-resolved to
    // the ambient one, or that transaction would be split.
    let resolved: unknown;
    await runWithOrgScope(pool, "org_acme", async () => {
      resolved = resolveWritableClient(handedIn);
    });
    expect(resolved).toBe(handedIn);
  });
});

describe("withJobOrgScope — the per-job 3-arm resolution", () => {
  it("arm 1: reuses the open connection scope and opens NO new txn", async () => {
    const fp = fakePool();
    let ran: unknown;
    await runWithOrgScope(fp.pool, "org_acme", async () => {
      await withJobOrgScope(fp.pool, async (c) => {
        ran = c;
        await c.query("SELECT op");
      });
    });
    // Runs on the already-open client; no second connect/BEGIN beyond the outer
    // scope's (the one runWithOrgScope took).
    expect(ran).toBe(fp.client);
    expect(fp.connects).toBe(1);
    expect(fp.clientSql.filter((s) => s === "BEGIN")).toHaveLength(1);
  });

  it("arm 2: opens exactly ONE short runWithOrgScope txn per op from the job org-id", async () => {
    const fp = fakePool();
    let ran: unknown;
    await runWithJobOrgId("org_job", async () => {
      await withJobOrgScope(fp.pool, async (c) => {
        ran = c;
        await c.query("SELECT op");
      });
    });
    expect(fp.connects).toBe(1);
    expect(ran).toBe(fp.client);
    expect(fp.clientSql.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(fp.clientSql.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(fp.clientSql).toContain("SET LOCAL app.current_org_id = 'org_job'");
    expect(fp.releases).toBe(1);
  });

  it("arm 3: falls through to the bare pool with no scope and no job org-id", async () => {
    const fp = fakePool();
    let ran: unknown;
    await withJobOrgScope(fp.pool, async (c) => {
      ran = c;
      await c.query("SELECT op");
    });
    expect(ran).toBe(fp.pool);
    expect(fp.connects).toBe(0);
    expect(fp.poolSql).toContain("SELECT op");
  });

  it("arm 1 takes precedence over an also-present job org-id", async () => {
    const fp = fakePool();
    let ran: unknown;
    await runWithJobOrgId("org_job", async () => {
      await runWithOrgScope(fp.pool, "org_conn", async () => {
        await withJobOrgScope(fp.pool, async (c) => {
          ran = c;
        });
      });
    });
    // The open connection scope wins; arm 2 must NOT open a second txn.
    expect(ran).toBe(fp.client);
    expect(fp.connects).toBe(1);
  });

  it("propagates the op's return value", async () => {
    const fp = fakePool();
    expect(await withJobOrgScope(fp.pool, async () => 42)).toBe(42);
  });
});

describe("orgScopingPool — the pool-shaped routing proxy", () => {
  it("reports as a pool (isPool → true) so stores self-route", () => {
    const fp = fakePool();
    expect(isPool(orgScopingPool(fp.pool))).toBe(true);
  });

  it("routes .query() through the bare pool when no scope / job org is set", async () => {
    const fp = fakePool();
    const scoping = orgScopingPool(fp.pool);
    await scoping.query("SELECT direct");
    expect(fp.poolSql).toContain("SELECT direct");
    expect(fp.connects).toBe(0);
  });

  it("routes each .query() through its OWN short txn under a job org-id (one per call)", async () => {
    const fp = fakePool();
    const scoping = orgScopingPool(fp.pool);
    await runWithJobOrgId("org_job", async () => {
      await scoping.query("SELECT a");
      await scoping.query("SELECT b");
    });
    // Both statements landed on the checked-out client, each in its own short txn.
    expect(fp.clientSql).toContain("SELECT a");
    expect(fp.poolSql).not.toContain("SELECT a");
    expect(fp.connects).toBe(2);
    expect(fp.clientSql.filter((s) => s === "BEGIN")).toHaveLength(2);
    expect(fp.clientSql.filter((s) => s === "COMMIT")).toHaveLength(2);
  });

  it("delegates non-query methods (connect) to the underlying pool verbatim", async () => {
    const fp = fakePool();
    const scoping = orgScopingPool(fp.pool);
    const c = await scoping.connect();
    // The proxy's connect must hand back the real pool's client, unwrapped.
    expect(c).toBe(fp.client);
    expect(fp.connects).toBe(1);
  });

  it("BINDS delegated methods to the underlying pool (a DETACHED method still reaches `this`)", () => {
    // Read a method off the proxy and call it DETACHED: if it were handed back
    // UNBOUND, `this` would be undefined and the call would throw — so a detached
    // call returning the pool's own field pins the `.bind(target)` arm. (Calling
    // it as `scoping.method()` would not distinguish bound from unbound.)
    const base = {
      query: async () => ({ rows: [] }),
      connect: async () => ({}),
      totalCount: 1234,
      readCount(this: { totalCount: number }) {
        return this.totalCount;
      },
    } as unknown as pg.Pool;
    const scoping = orgScopingPool(base) as unknown as { readCount: () => number };
    const detached = scoping.readCount;
    expect(detached()).toBe(1234);
  });

  it("exposes a non-function field off the underlying pool unchanged (else-arm)", () => {
    // The ternary's else-arm returns the raw value for non-functions.
    const base = {
      query: async () => ({ rows: [] }),
      connect: async () => ({}),
      label: "primary-pool",
    } as unknown as pg.Pool;
    const scoping = orgScopingPool(base) as unknown as { label: string };
    expect(scoping.label).toBe("primary-pool");
    expect(typeof scoping.label).toBe("string");
  });
});

describe("runWithJobOrgId / getJobOrgId — the lightweight per-job org ALS", () => {
  it("getJobOrgId is undefined outside any job scope", () => {
    expect(getJobOrgId()).toBeUndefined();
  });

  it("exposes the org id inside the run and clears it after", async () => {
    let inside: string | undefined;
    await runWithJobOrgId("org_job", async () => {
      inside = getJobOrgId();
    });
    expect(inside).toBe("org_job");
    expect(getJobOrgId()).toBeUndefined();
  });

  it("does NOT establish a connection scope (getOrgScope stays undefined)", async () => {
    // The job-org ALS holds ONLY an org id, never a checked-out connection.
    let scopeInside: unknown = "sentinel";
    await runWithJobOrgId("org_job", async () => {
      scopeInside = getOrgScope();
    });
    expect(scopeInside).toBeUndefined();
  });

  it("nests: an inner id shadows then restores the outer id", async () => {
    const seen: Array<string | undefined> = [];
    await runWithJobOrgId("org_outer", async () => {
      seen.push(getJobOrgId());
      await runWithJobOrgId("org_inner", async () => {
        seen.push(getJobOrgId());
      });
      seen.push(getJobOrgId());
    });
    expect(seen).toEqual(["org_outer", "org_inner", "org_outer"]);
  });
});

describe("runWithOrgScope — transaction lifecycle + ambient store", () => {
  it("emits BEGIN, the org GUC, then COMMIT in order on the checked-out client", async () => {
    const fp = fakePool();
    await runWithOrgScope(fp.pool, "org_acme", async (c) => {
      await c.query("SELECT work");
    });
    expect(fp.clientSql).toEqual(["BEGIN", "SET LOCAL app.current_org_id = 'org_acme'", "SELECT work", "COMMIT"]);
    expect(fp.releases).toBe(1);
  });

  it("interpolates a DIFFERENT org id into its own SET LOCAL (not a constant)", async () => {
    const fp = fakePool();
    await runWithOrgScope(fp.pool, "org_zeta", async () => undefined);
    expect(fp.clientSql).toContain("SET LOCAL app.current_org_id = 'org_zeta'");
  });

  it("puts the same client + org id on the store, the callback, and getOrgScopedClient", async () => {
    const fp = fakePool();
    let scope: { client: unknown; orgId: string | null } | undefined;
    let cbClient: unknown;
    let ambient: unknown;
    await runWithOrgScope(fp.pool, "org_acme", async (c) => {
      scope = getOrgScope();
      cbClient = c;
      ambient = getOrgScopedClient();
    });
    expect(scope?.client).toBe(fp.client);
    expect(scope?.orgId).toBe("org_acme");
    expect(cbClient).toBe(fp.client);
    expect(ambient).toBe(fp.client);
    expect(getOrgScope()).toBeUndefined();
  });

  it("ROLLBACKs (not COMMITs) and re-throws when the work throws, still releasing", async () => {
    const fp = fakePool();
    const boom = new Error("work failed");
    await expect(
      runWithOrgScope(fp.pool, "org_acme", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fp.clientSql).toContain("ROLLBACK");
    expect(fp.clientSql).not.toContain("COMMIT");
    expect(fp.releases).toBe(1);
  });
});

describe("assertSafeOrgId injection guard (via runWithOrgScope)", () => {
  it("rejects an org id with a quote BEFORE checking out a connection", async () => {
    const fp = fakePool();
    await expect(runWithOrgScope(fp.pool, "org'; DROP", async () => undefined)).rejects.toThrow(/unsafe org id/u);
    // The guard runs first: no connection was ever taken, so nothing to leak.
    expect(fp.connects).toBe(0);
    expect(fp.clientSql).toHaveLength(0);
  });

  it("rejects an empty id, whitespace, and SQL metacharacters", async () => {
    const fp = fakePool();
    for (const bad of ["", "org acme", "org;drop", "org(1)", "org*", "org\n"]) {
      await expect(runWithOrgScope(fp.pool, bad, async () => undefined)).rejects.toThrow(/unsafe org id/u);
    }
    expect(fp.connects).toBe(0);
  });

  it("ACCEPTS the allowed slug character classes (letters, digits, _ : . -)", async () => {
    const fp = fakePool();
    // If the guard regex were inverted/over-tightened, a legitimate id would
    // throw — each allowed class must instead pass through to a txn.
    const ok = ["org_acme", "ORG1", "org:tenant.sub-1", "a", "0"];
    for (const id of ok) {
      await runWithOrgScope(fp.pool, id, async () => undefined);
    }
    expect(fp.connects).toBe(ok.length);
  });
});

describe("runWithSystemScope — cross-org txn (no org GUC)", () => {
  it("opens BEGIN/COMMIT with NO SET LOCAL and a null-org ambient store", async () => {
    const fp = fakePool();
    let scope: { client: unknown; orgId: string | null } | undefined;
    await runWithSystemScope(fp.pool, async (c) => {
      scope = getOrgScope();
      await c.query("SELECT cross_org");
    });
    expect(fp.clientSql).toEqual(["BEGIN", "SELECT cross_org", "COMMIT"]);
    expect(fp.clientSql.some((s) => s.startsWith("SET LOCAL"))).toBe(false);
    expect(scope?.orgId).toBeNull();
    expect(scope?.client).toBe(fp.client);
    expect(fp.releases).toBe(1);
  });

  it("prefers the configured system pool over the passed pool", async () => {
    const passed = fakePool();
    const system = fakePool();
    setSystemPool(system.pool);
    try {
      await runWithSystemScope(passed.pool, async () => undefined);
      // The connection must come from the system pool, leaving the passed pool
      // untouched — the BYPASSRLS data-plane split.
      expect(system.connects).toBe(1);
      expect(passed.connects).toBe(0);
    } finally {
      resetSystemPool();
    }
  });

  it("ROLLBACKs and re-throws when the work throws, still releasing", async () => {
    const fp = fakePool();
    const boom = new Error("system work failed");
    await expect(
      runWithSystemScope(fp.pool, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fp.clientSql).toContain("ROLLBACK");
    expect(fp.clientSql).not.toContain("COMMIT");
    expect(fp.releases).toBe(1);
  });
});

describe("getSystemPool / setSystemPool / resetSystemPool — env-driven memo", () => {
  const KEY = "TANREN_SYSTEM_DATABASE_URL";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
    resetSystemPool();
  });

  it("resolves to undefined when the env var is unset OR the empty string", () => {
    delete process.env[KEY];
    resetSystemPool();
    expect(getSystemPool()).toBeUndefined();
    process.env[KEY] = "";
    resetSystemPool();
    expect(getSystemPool()).toBeUndefined();
  });

  it("memoizes the resolution: a later env change is NOT picked up until reset", () => {
    delete process.env[KEY];
    resetSystemPool();
    expect(getSystemPool()).toBeUndefined();
    // Change the env AFTER the first resolution — the memo must hold until reset.
    process.env[KEY] = "postgres://system/db";
    expect(getSystemPool()).toBeUndefined();
    resetSystemPool();
    const pool = getSystemPool();
    expect(pool).toBeDefined();
    void (pool as pg.Pool | undefined)?.end?.();
  });

  it("setSystemPool overrides resolution; resetSystemPool re-reads env (→ undefined)", () => {
    const fp = fakePool();
    setSystemPool(fp.pool);
    expect(getSystemPool()).toBe(fp.pool);
    delete process.env[KEY];
    resetSystemPool();
    expect(getSystemPool()).toBeUndefined();
  });

  it("setSystemPool(undefined) forces undefined (resolved) even when env is set", () => {
    process.env[KEY] = "postgres://system/db";
    setSystemPool(undefined);
    // Marked resolved → env is NOT re-read.
    expect(getSystemPool()).toBeUndefined();
  });
});

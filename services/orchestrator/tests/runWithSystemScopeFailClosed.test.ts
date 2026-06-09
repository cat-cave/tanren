// System-vs-tenant DB split — runWithSystemScope FAILS CLOSED.
//
// The split must never silently collapse onto the tenant runtime pool: a cross-org
// (system) read on the NOBYPASSRLS app role sees ZERO rows under enforced RLS. When
// TANREN_SYSTEM_DATABASE_URL is unset AND no pool was injected (and the suite-wide
// "use the passed pool" test opt-in is OFF — the production misconfiguration
// shape), runWithSystemScope must throw LOUD before any connect/query, never quietly
// use the passed pool. Kept in its own file so orgScopeResolvers.test.ts stays under
// the 500-line cap.

import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { allowRuntimePoolAsSystemForTests, resetSystemPool, runWithSystemScope } from "@tanren/db";

// A minimal pool that counts connect() calls and records SQL — so a passing test
// proves NOTHING was checked out or queried (the guard fires before side effects).
function fakePool(): { pool: pg.Pool; connects: number; sql: string[] } {
  const state = { connects: 0, sql: [] as string[] };
  const client = {
    query: async (text: string) => {
      state.sql.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => {
      state.connects += 1;
      return client;
    },
  } as unknown as pg.Pool;
  return Object.assign(state, { pool });
}

describe("runWithSystemScope — fail-closed on an unconfigured system pool", () => {
  const KEY = "TANREN_SYSTEM_DATABASE_URL";
  const original = process.env[KEY];

  afterEach(() => {
    // Restore the suite-wide opt-in + env so later tests keep the unit-suite default.
    allowRuntimePoolAsSystemForTests(true);
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
    resetSystemPool();
  });

  it("throws LOUD (no silent collapse to the tenant pool), before any connect/query", async () => {
    delete process.env[KEY];
    resetSystemPool();
    allowRuntimePoolAsSystemForTests(false);
    const fp = fakePool();
    await expect(runWithSystemScope(fp.pool, async () => {})).rejects.toThrow(
      /TANREN_SYSTEM_DATABASE_URL is required for system-scoped/u,
    );
    expect(fp.connects).toBe(0);
    expect(fp.sql).toHaveLength(0);
  });
});

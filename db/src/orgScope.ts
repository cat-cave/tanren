// RLS wave R1: request/job-scoped DB session context.
//
// The locked RLS mechanism is "app-managed per-request connection checkout +
// `SET LOCAL app.current_org_id` inside a transaction" (NOT pgBouncer). This
// module is that mechanism, INERT in R1: it checks out a `pg` client, opens a
// transaction, stamps `app.current_org_id` (so a future R2 policy can read it
// via `current_setting('app.current_org_id', true)`), runs the caller's work on
// that client, and commits — putting the client/org on an AsyncLocalStorage so
// handlers can reach it with `getOrgScopedClient()` without prop-drilling.
//
// With no policies (R1), the only observable effect is the GUC being set inside
// the transaction; every query behaves exactly as it did against the pool.
//
// The worker uses `runWithSystemScope` for the cross-org `job_queue` claim (no
// org context — the claim spans tenants), then `runWithOrgScope` for the
// claimed job's per-org work, mirroring the data-plane split.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

/** What a scoped section can read off the ambient store. */
export interface OrgScope {
  /** The checked-out client bound to the open transaction. */
  client: PoolClient;
  /** The org the transaction is scoped to; `null` for a system/cross-org scope. */
  orgId: string | null;
}

const storage = new AsyncLocalStorage<OrgScope>();

/**
 * The ambient org-scoped client, or `undefined` outside any scope. Handlers
 * that have adopted the org-scoped path call `getOrgScopedClient()` and run
 * their queries on it; code still on the raw pool is unaffected.
 */
export function getOrgScope(): OrgScope | undefined {
  return storage.getStore();
}

/** The ambient scoped client, or `undefined` outside a scope. */
export function getOrgScopedClient(): PoolClient | undefined {
  return storage.getStore()?.client;
}

/**
 * Guard `app.current_org_id` against injection: the value is interpolated into
 * a `SET LOCAL` statement (GUCs cannot be parameterized), so it must be a
 * well-formed org id. Org ids are `org_*` slugs; reject anything else loudly so
 * a malformed id can never smuggle SQL into the session-context statement.
 */
function assertSafeOrgId(orgId: string): void {
  if (!/^[A-Za-z0-9_:.-]+$/u.test(orgId)) {
    throw new Error(`unsafe org id for session context: ${JSON.stringify(orgId)}`);
  }
}

/**
 * Check out a client, open a transaction with `app.current_org_id` set to
 * `orgId`, run `work` with that client on the ambient store, and COMMIT (or
 * ROLLBACK on throw). The client is always released.
 *
 * `SET LOCAL` scopes the GUC to the transaction, so the value never leaks to a
 * later checkout of the same pooled connection — the per-request isolation the
 * RLS mechanism depends on.
 */
export async function runWithOrgScope<T>(
  pool: Pool,
  orgId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertSafeOrgId(orgId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL cannot bind parameters; the value is validated above. The GUC
    // is transaction-local, so it is cleared on COMMIT/ROLLBACK automatically.
    await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);
    const result = await storage.run({ client, orgId }, () => work(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * System/cross-org scope: check out a client and open a transaction WITHOUT an
 * org GUC, for genuinely cross-tenant system work (the worker's `job_queue`
 * claim). A future R2 policy keys off `app.current_org_id`; leaving it unset
 * here is the explicit "no tenant row filter" signal. The claim must set the
 * claimed job's org via `runWithOrgScope` before doing any tenant work.
 */
export async function runWithSystemScope<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await storage.run({ client, orgId: null }, () => work(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

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
import { Pool, type PoolClient } from "pg";

/** What a scoped section can read off the ambient store. */
export interface OrgScope {
  /** The checked-out client bound to the open transaction. */
  client: PoolClient;
  /** The org the transaction is scoped to; `null` for a system/cross-org scope. */
  orgId: string | null;
}

const storage = new AsyncLocalStorage<OrgScope>();

// RLS wave R3a-worker: a SEPARATE, lightweight ambient store holding ONLY the
// run's org id — NOT a checked-out connection. The worker's per-job workflow
// execution interleaves DB writes with minutes of external I/O (allocate,
// clone, bootstrap, CI polling), so it CANNOT hold one `runWithOrgScope`
// connection across the whole job. Instead it sets this org-id once around the
// job (`runWithJobOrgId`) and each tenant-table DB op opens its OWN short
// `runWithOrgScope` transaction from it — a connection is held only for the
// duration of one DB operation, never across external I/O.
const jobOrgStorage = new AsyncLocalStorage<string>();

/**
 * The ambient org-scoped client, or `undefined` outside any scope. Handlers
 * that have adopted the org-scoped path call `getOrgScopedClient()` and run
 * their queries on it; code still on the raw pool is unaffected.
 */
export function getOrgScope(): OrgScope | undefined {
  return storage.getStore();
}

/**
 * Run `work` with the job's org id on the lightweight ambient store. This holds
 * NO connection — only the org id — so it is safe to keep open across the whole
 * job, including its minutes of external I/O. Code that needs a scoped DB op
 * reads it with `getJobOrgId()` and opens a SHORT `runWithOrgScope` per op.
 */
export function runWithJobOrgId<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  return jobOrgStorage.run(orgId, work);
}

/** The ambient per-job org id, or `undefined` when no job org context is set. */
export function getJobOrgId(): string | undefined {
  return jobOrgStorage.getStore();
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

// RLS R3b: the BYPASSRLS system pool. Under enforced policies, the default
// runtime role (`tanren_app`, NOBYPASSRLS) running with an empty GUC sees ZERO
// rows — so a genuinely cross-org SYSTEM read (the reaper's lineage sweep, the
// worker's job bootstrap, cross-org dev seeding) cannot run on the app role.
// `runWithSystemScope` therefore connects via a SEPARATE pool as the narrow
// `tanren_system` BYPASSRLS role (migration 0030), whose URL is
// TANREN_SYSTEM_DATABASE_URL. When that env is unset (single-role dev, CI inert
// paths, tests) the passed pool is used verbatim — behavior-identical to before
// the flip, since without policies the app role's own connection already reads
// every row.
let systemPool: Pool | undefined;
let systemPoolResolved = false;

/**
 * Lazily resolve the BYPASSRLS system pool from TANREN_SYSTEM_DATABASE_URL. A
 * single process-wide pool (created once) — or `undefined` when the env is unset
 * (then {@link runWithSystemScope} uses the caller's pool). Exposed so wiring /
 * tests can override; {@link resetSystemPool} clears the memo.
 */
export function getSystemPool(): Pool | undefined {
  if (!systemPoolResolved) {
    systemPoolResolved = true;
    const url = process.env["TANREN_SYSTEM_DATABASE_URL"];
    systemPool = url === undefined || url === "" ? undefined : new Pool({ connectionString: url });
  }
  return systemPool;
}

/** Inject a system pool explicitly (tests / wiring). Pass `undefined` to clear. */
export function setSystemPool(pool: Pool | undefined): void {
  systemPool = pool;
  systemPoolResolved = true;
}

/** Reset the memoized system pool so the next {@link getSystemPool} re-reads env. */
export function resetSystemPool(): void {
  systemPool = undefined;
  systemPoolResolved = false;
}

/**
 * System/cross-org scope: check out a client and open a transaction WITHOUT an
 * org GUC, for genuinely cross-tenant system work (the worker's `job_queue`
 * claim, the reaper's lineage sweep, cross-org dev seeding). The connection is
 * taken from the BYPASSRLS {@link getSystemPool} when one is configured (R3b),
 * so an empty-GUC read still returns rows across tenants under enforced
 * policies; otherwise it uses the passed `pool` (inert/dev fallback). Leaving
 * the GUC unset is the explicit "no per-tenant row filter" signal; any tenant
 * work must establish an org via `runWithOrgScope` first.
 */
export async function runWithSystemScope<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const effectivePool = getSystemPool() ?? pool;
  const client = await effectivePool.connect();
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

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
  /** The pool that owns the checked-out client; another plane must open its own scope. */
  pool: Pool;
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

// The SYSTEM counterpart of `jobOrgStorage`: a lightweight per-job marker (holds
// NO connection) that flags the ambient work as a genuinely cross-org / null-org
// SYSTEM job — the system / null-org (`org_id NULL`) job whose tenant ops have no
// org GUC to carry. Like `jobOrgStorage` it is safe to keep open across the
// job's minutes of external I/O; each tenant op then opens its OWN short
// `runWithSystemScope` (the BYPASSRLS system pool) from it. This makes the
// null-org path an EXPLICIT system scope rather than an implicit raw-pool
// fallback (the scoping-hardening directive: no silent unscoped tenant op).
const jobSystemStorage = new AsyncLocalStorage<true>();

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

/**
 * Run `work` flagged as a per-job SYSTEM scope: the null-org / cross-org job
 * whose tenant ops must run on the BYPASSRLS system pool. Holds NO connection
 * (safe across the job's external I/O); each tenant op opens a SHORT
 * `runWithSystemScope` from this marker. The EXPLICIT system entry-point for a
 * system / null-org job, replacing the old implicit bare-pool handoff.
 */
export function runWithSystemJobScope<T>(work: () => Promise<T>): Promise<T> {
  return jobSystemStorage.run(true, work);
}

/** True when an ambient per-job SYSTEM scope (null-org / cross-org job) is set. */
export function isSystemJobScope(): boolean {
  return jobSystemStorage.getStore() === true;
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
  const active = storage.getStore();
  if (active !== undefined && active.orgId !== null && active.pool === pool) {
    if (active.orgId !== orgId) {
      throw new Error(`cannot enter org scope ${orgId} from active scope ${active.orgId ?? "system"}`);
    }
    return work(active.client);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL cannot bind parameters; the value is validated above. The GUC
    // is transaction-local, so it is cleared on COMMIT/ROLLBACK automatically.
    await client.query(`SET LOCAL app.current_org_id = '${orgId}'`);
    const result = await storage.run({ client, pool, orgId }, () => work(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
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
// TANREN_SYSTEM_DATABASE_URL. Both compose profiles (dev + prod) ALWAYS set that
// env, so a genuine deployment always resolves a real BYPASSRLS pool. There is NO
// silent collapse to the tenant runtime pool: if the env is unset AND no pool was
// explicitly injected (the test/wiring opt-in below), {@link runWithSystemScope}
// throws LOUD — a cross-org system read on the NOBYPASSRLS app role would silently
// see ZERO rows under enforced policies, the exact system-vs-tenant split this
// guards. Tests that legitimately run on a single pool inject it explicitly via
// {@link setSystemPool}; they never rely on an env-missing fallback.
let systemPool: Pool | undefined;
let systemPoolResolved = false;
// True once the system pool has been EXPLICITLY configured — either resolved from
// a non-blank TANREN_SYSTEM_DATABASE_URL, or injected via setSystemPool (even with
// `undefined`, the "use the passed runtime pool" test/single-role opt-in). When
// this is false, runWithSystemScope refuses to run rather than silently collapsing
// onto the tenant pool.
let systemPoolExplicitlyConfigured = false;
// TEST-ONLY escape hatch: many unit tests drive a system-scoped path against an
// in-memory fake pool that ignores RLS entirely, so the BYPASSRLS-vs-app
// distinction is moot there. Rather than inject every per-file fake as the system
// pool, the test harness opts in ONCE (test/setup) so runWithSystemScope uses the
// PASSED pool. This NEVER fires in production: nothing in the app wiring calls it,
// and prod/dev resolve a real TANREN_SYSTEM_DATABASE_URL pool. An explicit
// setSystemPool injection (a real BYPASSRLS pool in an RLS integration test) still
// takes precedence over this opt-in.
let runtimePoolAsSystemForTests = false;

/**
 * Lazily resolve the BYPASSRLS system pool from TANREN_SYSTEM_DATABASE_URL. A
 * single process-wide pool (created once) — or `undefined` when the env is unset.
 * A non-blank env resolution marks the pool EXPLICITLY configured; an unset env
 * does NOT (so {@link runWithSystemScope} fails loud unless a pool was injected via
 * {@link setSystemPool}). Exposed so wiring / tests can override; {@link resetSystemPool}
 * clears the memo.
 */
export function getSystemPool(): Pool | undefined {
  if (!systemPoolResolved) {
    systemPoolResolved = true;
    const url = process.env["TANREN_SYSTEM_DATABASE_URL"];
    if (url === undefined || url === "") {
      systemPool = undefined;
    } else {
      systemPool = new Pool({ connectionString: url });
      systemPoolExplicitlyConfigured = true;
    }
  }
  return systemPool;
}

/**
 * Inject a system pool explicitly (tests / wiring). Pass `undefined` to declare
 * "no separate system pool — use the passed runtime pool" (single-role dev / a
 * test on one pool). Either form marks the pool EXPLICITLY configured, so the
 * env-missing fail-loud in {@link runWithSystemScope} is suppressed.
 */
export function setSystemPool(pool: Pool | undefined): void {
  systemPool = pool;
  systemPoolResolved = true;
  systemPoolExplicitlyConfigured = true;
}

/** Reset the memoized system pool so the next {@link getSystemPool} re-reads env. */
export function resetSystemPool(): void {
  systemPool = undefined;
  systemPoolResolved = false;
  systemPoolExplicitlyConfigured = false;
}

/**
 * TEST-ONLY: opt every subsequent {@link runWithSystemScope} into using the PASSED
 * pool when no system pool is otherwise configured — for unit tests that drive a
 * system-scoped path against an in-memory fake pool (no real RLS). Pass `false` to
 * clear. NEVER called by production wiring; an explicit {@link setSystemPool}
 * injection still wins. See test/setup/systemPool.ts.
 */
export function allowRuntimePoolAsSystemForTests(allow = true): void {
  runtimePoolAsSystemForTests = allow;
}

/**
 * Whether {@link runWithSystemScope} may run: a system pool is explicitly
 * configured (env-resolved or injected), OR the test opt-in is active. Forces the
 * lazy env resolution first so a set env is honored.
 */
function isSystemScopeRunnable(): boolean {
  getSystemPool();
  return systemPoolExplicitlyConfigured || runtimePoolAsSystemForTests;
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
 *
 * Fails LOUD when no system pool is configured (env unset, no `setSystemPool`
 * injection, and not under the test opt-in): a cross-org read on the NOBYPASSRLS
 * app role would silently return ZERO rows under enforced policies — the
 * system-vs-tenant split must never collapse silently onto the tenant pool. Both
 * compose profiles set TANREN_SYSTEM_DATABASE_URL, so a real deployment always
 * passes this; only a misconfiguration trips it.
 */
export async function runWithSystemScope<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isSystemScopeRunnable()) {
    throw new Error(
      "TANREN_SYSTEM_DATABASE_URL is required for system-scoped (cross-org) work: the system pool is the narrow " +
        "BYPASSRLS `tanren_system` role; without it a cross-org read on the NOBYPASSRLS app role silently sees ZERO " +
        "rows under enforced RLS. Set TANREN_SYSTEM_DATABASE_URL (both compose profiles do), or inject a pool via " +
        "setSystemPool() in tests — there is no silent fallback to the tenant runtime pool.",
    );
  }
  const effectivePool = getSystemPool() ?? pool;
  const client = await effectivePool.connect();
  try {
    await client.query("BEGIN");
    const result = await storage.run({ client, pool: effectivePool, orgId: null }, () => work(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

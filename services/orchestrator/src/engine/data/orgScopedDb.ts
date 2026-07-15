// RLS wave R2 — cohort-1 data-access seam (runs + events).
//
// This is the first piece of the data-access layer (DAL) the future-refactor doc
// (`docs/architecture/future-refactor-and-scale.md` move #1) names as the single
// highest-leverage structural move: collapse the ~269 raw `pool.query` sites
// behind a layer that is **org-scoped by construction**, so tenant isolation is a
// structural property rather than a hand-written `WHERE org_id = $n` per call.
//
// R1 (`db/src/orgScope.ts`) built the mechanism: `runWithOrgScope` checks out a
// client, opens a transaction with `SET LOCAL app.current_org_id = <org>`, and
// puts that client on an AsyncLocalStorage so ambient code can reach it with
// `getOrgScopedClient()` — no prop-drilling. R2 routes the runs + events query
// sites through that ambient client.
//
// `resolveQueryClient(pool)` is the seam: it returns the ambient org-scoped
// client when a `runWithOrgScope` / `runWithSystemScope` transaction is open, and
// **falls back to the pool** when there is none (startup, cross-org system ops,
// or any caller that has not yet established a scope). The fallback keeps R2
// behavior-identical to before — INERT, since R1 set no policies, so a query on
// the pool and the same query on the scoped client return the same rows.
//
// R3 will TIGHTEN this: once policies are enabled and the runtime role is flipped
// to `tanren_app`, a tenant query that runs on the pool (no `SET LOCAL`
// app.current_org_id) sees an empty GUC and returns ZERO rows. At that point the
// fallback for tenant tables must become an error, not a silent pool query. The
// app-layer `WHERE org_id = $n` predicates stay either way (belt-and-suspenders).
//
// RLS wave R3a-worker extends the seam with a THIRD resolution arm for the
// per-job WORKFLOW execution. The worker cannot hold one `runWithOrgScope`
// connection across a run's minutes of external I/O, so it sets a lightweight
// per-job org id (`runWithJobOrgId`, holding NO connection) and each DB op opens
// a SHORT `runWithOrgScope` from it. `orgScopingPool` is the realization: a
// pool-shaped wrapper whose `.query()` resolves, per op, as:
//   1. ambient connection scope open  → run on that scoped client (no new txn);
//   2. else ambient job-org-id present → open a SHORT runWithOrgScope per op;
//   3. else                            → run on the underlying pool (inert).
// Because the existing stores already self-route through `resolveWritableClient`
// (which returns the wrapper unchanged when it is the constructed "pool"), and
// the raw workflow sites call `input.pool.query` directly, handing the workflow
// an `orgScopingPool` org-scopes EVERY worker tenant-table op with NO change to
// the stage code — connections held only for one DB op, never across I/O.

import type pg from "pg";
import {
  getJobOrgId,
  getOrgScope,
  getOrgScopedClient,
  isSystemJobScope,
  runWithOrgScope,
  runWithSystemScope,
} from "@tanren/db";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Thrown when a TENANT-table read/write resolves with NO ambient org scope at
 * all — neither an open connection scope (`runWithOrgScope` / `runWithSystemScope`)
 * nor a per-job org id (`runWithJobOrgId`). Under the runtime `tanren_app`
 * (NOBYPASSRLS) role such a query runs with an empty `app.current_org_id` GUC and
 * the deny-by-default RLS policies return ZERO rows — a SILENT degrade. Per the
 * no-fallback directive we FAIL LOUDLY here instead: the call site must establish
 * the correct scope (`runWithOrgScope` / `withJobOrgScope` / a request's
 * `runWithJobOrgId`), or, for a genuinely cross-org/system operation, the
 * EXPLICIT `runWithSystemScope` (never the implicit raw-pool fallback this seam
 * used to provide).
 *
 * `context` names the resolver that raised it so a surfaced latent call site is
 * traceable from the stack alone.
 */
export class MissingOrgScopeError extends Error {
  constructor(context: string) {
    super(
      `tenant-table access with no ambient org scope (${context}): establish one via runWithOrgScope / withJobOrgScope / a request's runWithJobOrgId, or runWithSystemScope for a cross-org system operation`,
    );
    this.name = "MissingOrgScopeError";
  }
}

/**
 * Resolve the query client a tenant-table read/write should run on:
 *   1. an OPEN connection scope (`runWithOrgScope` / `runWithSystemScope`) →
 *      that scoped client (the read joins the open transaction / its GUC);
 *   2. else a per-job org id (`runWithJobOrgId`) is set → the `pool`, which —
 *      handed as an {@link orgScopingPool} — opens a SHORT `runWithOrgScope` per
 *      `.query`, so each statement carries the job's org GUC;
 *   3. else a per-job SYSTEM scope (`runWithSystemJobScope`, the explicit
 *      null-org / cross-org job marker) → the `pool`, which as an
 *      {@link orgScopingPool} opens a SHORT `runWithSystemScope` (BYPASSRLS) per
 *      `.query`;
 *   4. else → no scope at all → THROW {@link MissingOrgScopeError}.
 *
 * Arm 4 used to fall back to the bare `pool`. Under the enforced `tanren_app`
 * RLS role that silently returns ZERO rows (empty GUC → deny-by-default), so the
 * fallback is now a LOUD error: an unscoped tenant read is a scoping bug, not a
 * legitimate empty result. The call site must establish a scope (a null-org /
 * cross-org system op uses the EXPLICIT `runWithSystemJobScope` /
 * `runWithSystemScope`, never the implicit raw-pool fallback this seam dropped).
 */
export function resolveQueryClient(pool: pg.Pool): QueryClient {
  const ambient = getOrgScopedClient();
  if (ambient !== undefined) {
    return ambient;
  }
  if (getJobOrgId() !== undefined || isSystemJobScope()) {
    return pool;
  }
  throw new MissingOrgScopeError("resolveQueryClient");
}

/**
 * True when ANY ambient org context is established for a tenant read/write: an
 * open connection scope (`runWithOrgScope` / `runWithSystemScope`), a per-job
 * org id (`runWithJobOrgId`), or a per-job SYSTEM scope (`runWithSystemJobScope`,
 * the explicit null-org / cross-org marker). This is the assertion boundary the
 * resolvers enforce — when it is false a tenant query has no scope and
 * {@link resolveQueryClient} / {@link withJobOrgScope} throw
 * {@link MissingOrgScopeError} rather than silently degrading to the bare pool.
 */
export function hasOrgScope(): boolean {
  return getOrgScope() !== undefined || getJobOrgId() !== undefined || isSystemJobScope();
}

/**
 * Discriminate a real `pg.Pool` (or {@link orgScopingPool} proxy / minimal pool
 * double) from a checked-out `PoolClient` / query-only client.
 *
 * Write-path stores (event store, cost recorder, task helpers) are constructed
 * with EITHER the shared pool OR a specific in-transaction client: a pool routes
 * its write through the ambient org-scoped client when a scope is open (RLS R2);
 * a handed-in client is used verbatim (the caller already owns that transaction,
 * e.g. `createQueuedRunFromSpec` / a `RunPlannerLoopInput` PoolClient).
 *
 * **Do NOT key on `connect` alone.** A `PoolClient` is a `Client` and therefore
 * has `connect()` — treating that as "is a pool" re-connects an already-checked-
 * out client, loses the caller's open transaction, and can fail the reconnect.
 * Order: (1) real Pool surface via `totalCount` + `connect`; (2) reject
 * `release` (PoolClient); (3) accept connect-without-release test doubles.
 */
export function isPool(client: QueryClient): client is pg.Pool {
  const connectFn = "connect" in client && typeof Reflect.get(client, "connect") === "function";
  // 1. Real `pg.Pool` (and orgScopingPool Proxy): live counters Client never has.
  if (connectFn && "totalCount" in client && typeof Reflect.get(client, "totalCount") === "number") {
    return true;
  }
  // 2. PoolClient always carries `release()`; a real Pool does not. Reject so a
  // handed-in in-transaction client is never re-connected (the unsound case).
  if ("release" in client && typeof Reflect.get(client, "release") === "function") {
    return false;
  }
  // 3. Minimal pool doubles (tests) implement `connect` without `release` or
  // totalCount — accept them as pools so callers need no cast; production always
  // has a real Pool (arm 1).
  return connectFn;
}

/**
 * Resolve the client a write should run on given the client a store was
 * constructed with. When that is the shared pool, route through
 * {@link resolveQueryClient} — the ambient scoped client if a connection scope is
 * open, the pool itself when a per-job org id self-routes each `.query`, else a
 * thrown {@link MissingOrgScopeError} (no silent unscoped tenant write). When it
 * is a specific in-transaction client, use it as-is — the caller owns that
 * transaction. This is the write-path companion to {@link resolveQueryClient}
 * (which always starts from the pool); it centralizes the `isPool` discriminator
 * the event store, cost recorder, and task helpers all share.
 */
export function resolveWritableClient(client: QueryClient): QueryClient {
  return isPool(client) ? resolveQueryClient(client) : client;
}

/**
 * Run one tenant-table DB `op` under the right scope WITHOUT requiring an open
 * connection scope, using the per-job org-id resolution arm (R3a-worker):
 *
 *   1. ambient connection scope open  → run `op` on that scoped client;
 *   2. else ambient job-org-id present → open a SHORT `runWithOrgScope` per call
 *      (a connection held only for this op, never across external I/O);
 *   3. else a per-job SYSTEM scope set → open a SHORT `runWithSystemScope`
 *      (BYPASSRLS) per call — the explicit null-org / cross-org job path;
 *   4. else                            → THROW {@link MissingOrgScopeError}.
 *
 * Use this for a TIGHT batch of statements that must share one transaction /
 * snapshot with no external I/O between them (e.g. a SELECT + its dependent
 * UPDATEs); a single statement can just go through {@link orgScopingPool}. Arm 4
 * used to run `op` on the bare pool; under the enforced `tanren_app` RLS role
 * that silently returns ZERO rows, so an unscoped tenant op now FAILS LOUDLY —
 * the caller must establish a job org id / connection / system-job scope first.
 */
export async function withJobOrgScope<T>(pool: pg.Pool, op: (client: QueryClient) => Promise<T>): Promise<T> {
  const ambient = getOrgScopedClient();
  if (ambient !== undefined) {
    return op(ambient);
  }
  const jobOrgId = getJobOrgId();
  if (jobOrgId !== undefined) {
    return runWithOrgScope(pool, jobOrgId, (client) => op(client));
  }
  if (isSystemJobScope()) {
    return runWithSystemScope(pool, (client) => op(client));
  }
  throw new MissingOrgScopeError("withJobOrgScope");
}

/**
 * Wrap `pool` in a pool-shaped proxy whose `.query()` routes EACH call through
 * {@link withJobOrgScope}: an open connection scope is reused, else a per-job
 * org-id opens a short `runWithOrgScope` for that one statement, else the call
 * falls through to the underlying pool. `.connect()` and every other pool method
 * delegate verbatim, and the proxy reports as a pool (`isPool` → true), so a
 * store constructed with it (`new PgEventStore(orgScopingPool(pool))`) still
 * self-routes correctly and a handed-in specific client is unaffected.
 *
 * Handing this to the run worker's workflow as `input.pool` org-scopes every
 * tenant-table op — direct `input.pool.query` AND store writes — for the
 * duration of one DB op only, never across the run's external I/O. With no
 * job-org-id set (a system / null-org job) the proxy is behavior-identical to the
 * bare pool.
 */
export function orgScopingPool(pool: pg.Pool): pg.Pool {
  const scopingQuery = ((...args: unknown[]) =>
    withJobOrgScope(pool, (client) =>
      (client.query as (...a: unknown[]) => Promise<unknown>)(...args),
    )) as pg.Pool["query"];
  // A Proxy preserves the pool's own methods/fields (connect, end, on, totalCount…)
  // and only overrides `query`, so the wrapper is a drop-in `pg.Pool`.
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return scopingQuery;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

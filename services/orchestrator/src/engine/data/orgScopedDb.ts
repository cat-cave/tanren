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
import { getJobOrgId, getOrgScope, getOrgScopedClient, runWithOrgScope } from "@tanren/db";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Resolve the query client a tenant-table read/write should run on: the ambient
 * org-scoped client if a scope is open, else the pool (inert R1-equivalent
 * fallback). Use this anywhere a runs/events query currently issues
 * `pool.query(...)` so the query joins the ambient org transaction when there is
 * one.
 *
 * The returned client is the same connection the surrounding `runWithOrgScope`
 * transaction is using, so reads see that transaction's writes — exactly the
 * pool's behavior in R1 (no policies), and the RLS-correct behavior in R3.
 */
export function resolveQueryClient(pool: pg.Pool): QueryClient {
  return getOrgScopedClient() ?? pool;
}

/**
 * True when an ambient org scope is open (request middleware / worker per-job
 * context established one). Cohort callers do not need this for correctness — the
 * fallback handles its absence — but it documents the seam and lets a future R3
 * change assert "tenant query must have a scope" at the boundary.
 */
export function hasOrgScope(): boolean {
  return getOrgScope() !== undefined;
}

/**
 * A `pg.Pool` exposes `connect`; a checked-out `PoolClient` does not. Write-path
 * stores (event store, cost recorder, task helpers) are constructed with EITHER
 * the shared pool OR a specific in-transaction client, and need to tell them
 * apart: a pool should route its write through the ambient org-scoped client when
 * a scope is open (RLS R2), while a handed-in client is used verbatim (the caller
 * already owns that transaction, e.g. `createQueuedRunFromSpec`).
 */
export function isPool(client: QueryClient): client is pg.Pool {
  return typeof (client as { connect?: unknown }).connect === "function";
}

/**
 * Resolve the client a write should run on given the client a store was
 * constructed with. When that is the shared pool, route through the ambient
 * org-scoped client if a scope is open, else the pool (inert fallback). When it
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
 *   3. else                            → run `op` on the underlying pool (inert).
 *
 * Use this for a TIGHT batch of statements that must share one transaction /
 * snapshot with no external I/O between them (e.g. a SELECT + its dependent
 * UPDATEs); a single statement can just go through {@link orgScopingPool}. The
 * fallback (arm 3) keeps behavior identical to the pre-R3a pool path.
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
  return op(pool);
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
 * job-org-id set (a legacy/unscoped run) the proxy is behavior-identical to the
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

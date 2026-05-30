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

import type pg from "pg";
import { getOrgScope, getOrgScopedClient } from "@tanren/db";

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

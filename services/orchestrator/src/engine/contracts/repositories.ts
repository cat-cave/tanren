// The `Repositories` seam: the data-access layer's contract surface, aggregating
// the per-entity repository stores into one slottable interface — the same shape
// `JobQueue`/`EventStore`/`SecretStore` already have (a contract + a pg-backed
// impl + a conformance suite). Track C of the forward roadmap (the data-access
// layer) promotes the existing `engine/repositories/**` stores to this seam so
// callers depend on the CONTRACT, not the concrete pg module, and a backend can
// be slotted as a new impl + registry entry rather than a refactor.
//
// Every store method takes an explicit `QueryClient` (a pool OR a `runWithOrgScope`
// client) plus the acting `ActorRef`. The seam does NOT open transactions or widen
// org scope: the caller decides whether to run on the bare pool or inside an
// org-scoped transaction, exactly as it did before the move. Under RLS, a read on
// an org-scoped client sees only that org's rows; a read on the wrong scope sees
// zero — the seam carries that through unchanged.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { ProjectStore } from "../repositories/projects.js";
import { RunStore } from "../repositories/runs.js";
import { SpecStore } from "../repositories/specs.js";
import { TaskStore } from "../repositories/tasks.js";
import { JobStore } from "../repositories/jobs.js";
import { ActorStore } from "../repositories/actors.js";

/** A pool or a checked-out (org-scoped) client — anything that can run a query. */
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The aggregate data-access seam. Each member is a per-entity repository whose
 * methods take a `QueryClient` + `ActorRef`. Implementations are value objects
 * (no constructor state) because the client is passed per-call — the scope lives
 * with the caller, not the repository.
 */
export interface Repositories {
  readonly runs: typeof RunStore;
  readonly specs: typeof SpecStore;
  readonly projects: typeof ProjectStore;
  readonly tasks: typeof TaskStore;
  readonly jobs: typeof JobStore;
  readonly actors: typeof ActorStore;
}

/**
 * The Postgres-backed implementation of the {@link Repositories} seam: the
 * existing `engine/repositories/**` stores, bound together. There is exactly one
 * impl today (pg); a future backend is a new object satisfying `Repositories`,
 * not a rewrite of the call sites.
 */
export const pgRepositories: Repositories = {
  runs: RunStore,
  specs: SpecStore,
  projects: ProjectStore,
  tasks: TaskStore,
  jobs: JobStore,
  actors: ActorStore,
} as const;

export type { ActorRef };

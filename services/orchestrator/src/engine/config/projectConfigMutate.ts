// Progress-based internal RMW for projects.config. Thin consumer of the sole
// ProjectStore snapshot/CAS primitive — never a second write authority.
//
// Loop: snapshot → pure mutate → CAS (store serializes no-ops); on lost race,
// re-read and recompute. No fixed attempt cap. Terminates on success or a typed
// terminal missing-project error.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { ProjectStore } from "../repositories/projects.js";
import type { ConfigRevision } from "./configRevision.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Thrown when the project row is absent (or invisible under RLS) mid-mutate. */
export class ProjectConfigMissingError extends Error {
  constructor(public readonly projectId: string) {
    super(`project config missing for project_id '${projectId}' (absent or off-scope under RLS)`);
    this.name = "ProjectConfigMissingError";
  }
}

/**
 * Apply a pure merge against the current project config until the CAS wins.
 * `mutate` must be pure (no I/O); validation throws fail closed immediately.
 * Semantic no-ops go through store CAS (revision-predicated, no unlocked skip).
 */
export async function mutateProjectConfig<T>(
  client: QueryClient,
  projectId: string,
  actor: ActorRef,
  mutate: (current: unknown) => T,
): Promise<{ value: T; config: unknown; revision: ConfigRevision }> {
  for (;;) {
    const snapshot = await ProjectStore.getConfigSnapshot(client, projectId, actor);
    if (snapshot === undefined) {
      throw new ProjectConfigMissingError(projectId);
    }
    const value = mutate(snapshot.config);
    // Callers that return a partial field use a separate merge; the common path
    // is mutate → next full config object. When mutate returns the next config
    // blob itself, treat it as the write payload.
    const nextConfig: unknown = value;
    const outcome = await ProjectStore.compareAndSwapConfig(client, projectId, snapshot.revision, nextConfig, actor);
    if (outcome.status === "ok") {
      return { value, config: outcome.config, revision: outcome.revision };
    }
    if (outcome.status === "not_found") {
      throw new ProjectConfigMissingError(projectId);
    }
    // conflict — peer advanced; loop and recompute from the new snapshot.
  }
}

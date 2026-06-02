// Forge-tools data-access repository: the tenant-table reads the Forge tool
// surface (engine/forge/tools/**) and the Forge provider factory issue. These
// were inline `.query` sites scattered across authz.ts (access gates), read.ts
// (the `tanren.read_*` tools), write.ts (the rerun lookup), repo.ts (the project
// repo/credential load), and providerFactory.ts (the runner-context load). The
// AUTHZ logic, redaction, and GitHub I/O stay in those modules; this repository
// owns ONLY the raw SQL — each method emits the exact statement (columns,
// predicates, ordering, casts) the inline site did, and runs on the client the
// caller hands in (the ambient org-scoped client via `resolveQueryClient`), so
// org-scope/RLS visibility is byte-identical to the sites it replaces.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const ForgeToolsStore = {
  // --- access gates (authz.ts) ---

  /** The project's org id (or null when the project is absent / has no org). */
  async getProjectOrgId(client: QueryClient, projectId: string, _actor: ActorRef): Promise<string | null> {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  },

  /** Count a user's project_members role rows for the project-access gate. */
  async countProjectMemberRole(
    client: QueryClient,
    projectId: string,
    userId: string,
    _actor: ActorRef,
  ): Promise<number> {
    const member = await client.query<{ role: string }>(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
      [projectId, userId],
    );
    return member.rowCount ?? 0;
  },

  /** A run's project/spec ids for the run-access gate (undefined when absent). */
  async getRunProjectAndSpec(
    client: QueryClient,
    runId: string,
    _actor: ActorRef,
  ): Promise<{ projectId: string; specId: string } | undefined> {
    const result = await client.query<{ project_id: string; spec_id: string }>(
      "SELECT project_id, spec_id FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { projectId: row.project_id, specId: row.spec_id };
  },

  /** A spec's project id for the spec-access gate (undefined when absent). */
  async getSpecProjectId(client: QueryClient, specId: string, _actor: ActorRef): Promise<string | undefined> {
    const result = await client.query<{ project_id: string }>("SELECT project_id FROM specs WHERE spec_id = $1", [
      specId,
    ]);
    return result.rows[0]?.project_id;
  },

  // --- read tools (read.ts) ---

  /** The full spec row for `tanren.read_spec` (`SELECT *`). */
  async getSpecRow(
    client: QueryClient,
    specId: string,
    _actor: ActorRef,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>("SELECT * FROM specs WHERE spec_id = $1", [specId]);
    return result.rows[0];
  },

  /** The full run row for `tanren.read_run` (`SELECT *`). */
  async getRunRow(client: QueryClient, runId: string, _actor: ActorRef): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>("SELECT * FROM runs WHERE run_id = $1", [runId]);
    return result.rows[0];
  },

  /** The run's full task rows ordered start-then-id for `tanren.read_run`. */
  async listRunTasks(
    client: QueryClient,
    runId: string,
    _actor: ActorRef,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const tasks = await client.query<Record<string, unknown>>(
      `SELECT * FROM tasks WHERE run_id = $1
     ORDER BY started_at ASC NULLS FIRST, task_id ASC`,
      [runId],
    );
    return tasks.rows;
  },

  /**
   * The redaction-ready event projection for `tanren.read_events`. The dynamic
   * WHERE clause + the LIMIT placeholder are built by the caller (run/spec/since
   * filters), so this method takes the assembled `where` fragment, `limitIndex`,
   * and the bound params verbatim — the emitted SQL is byte-identical.
   */
  async listEventsForTool(
    client: QueryClient,
    where: string,
    limitIndex: number,
    params: unknown[],
    _actor: ActorRef,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await client.query(
      `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
     FROM events
     ${where}
     ORDER BY ts ASC, id ASC
     LIMIT $${limitIndex}`,
      params,
    );
    return result.rows as Array<Record<string, unknown>>;
  },

  /**
   * The cost-record projection for `tanren.read_costs`. Same dynamic-WHERE
   * contract as `listEventsForTool`: the caller assembles the predicate + binds.
   */
  async listCostsForTool(
    client: QueryClient,
    where: string,
    params: unknown[],
    _actor: ActorRef,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await client.query(
      `SELECT id, task_id, run_id, project_id, cli, provider, model,
            input_tokens, cached_input_tokens, cache_creation_tokens,
            output_tokens, reasoning_output_tokens, total_tokens, cost_usd,
            billing_mode, cost_basis, recorded_at
     FROM cost_records
     ${where}
     ORDER BY recorded_at ASC, id ASC`,
      params,
    );
    return result.rows as Array<Record<string, unknown>>;
  },

  /** The org/project-reachable persona ids for `tanren.read_behaviors`. */
  async listProjectPersonaIds(client: QueryClient, projectId: string, _actor: ActorRef): Promise<string[]> {
    const personaResult = await client.query<{ id: string }>(
      `SELECT id FROM personas WHERE org_id = (
       SELECT org_id FROM projects WHERE project_id = $1
     ) AND (scope = 'org' OR project_id = $1)`,
      [projectId],
    );
    return personaResult.rows.map((row) => row.id);
  },

  /** The behavior rows for the given personas, ordered by title. */
  async listBehaviorsForPersonas(
    client: QueryClient,
    personaIds: string[],
    _actor: ActorRef,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await client.query(
      `SELECT id, persona_id, title, given, "when", "then", description, metadata, created_at, updated_at
     FROM behaviors
     WHERE persona_id = ANY($1::text[])
     ORDER BY title`,
      [personaIds],
    );
    return result.rows as ReadonlyArray<Record<string, unknown>>;
  },

  // --- write tool (write.ts) ---

  /** The spec id of the run owning a task, for `tanren.rerun_task`. */
  async getSpecIdForTask(client: QueryClient, taskId: string, _actor: ActorRef): Promise<string | undefined> {
    const result = await client.query<{ spec_id: string }>(
      `SELECT r.spec_id FROM tasks t
     INNER JOIN runs r ON r.run_id = t.run_id
     WHERE t.task_id = $1`,
      [taskId],
    );
    return result.rows[0]?.spec_id;
  },

  // --- project load (repo.ts) ---

  /** The repo url + config blob for a project (repo tools' credential load). */
  async getProjectRepoAndConfig(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<{ repoUrl: string; config: Record<string, unknown> | null } | undefined> {
    const result = await client.query<{ repo_url: string; config: Record<string, unknown> | null }>(
      "SELECT repo_url, config FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { repoUrl: row.repo_url, config: row.config };
  },

  // --- runner context load (providerFactory.ts) ---

  /** The runner image + config + org id for the Forge provider factory. */
  async getProjectRunnerContext(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<{ runnerImage: string; config: unknown; orgId: string | null } | undefined> {
    const result = await client.query<{ runner_image: string; config: unknown; org_id: string | null }>(
      "SELECT runner_image, config, org_id FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { runnerImage: row.runner_image, config: row.config, orgId: row.org_id };
  },
} as const;

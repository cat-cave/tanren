import type pg from "pg";
import { z } from "zod";
import { nullableText } from "../data/scalarText.js";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Narrow structural port shared by pg clients and integration-scoped clients. */
export interface ProjectConfigQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface ProjectConfigSnapshot {
  config: unknown;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("project config must be JSON-serializable");
  return encoded;
}

/** A project's lifecycle: deriving, autonomous-walker-driven, or operator-paused. */
export const ProjectLifecycleEnum = z.enum(["deriving", "active", "archived"]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleEnum>;

// The project row as the HTTP project/brownfield routes read it. `config` is an
// opaque JSON blob the route layer migrates/validates with `migrateProjectConfig`
// — the repository does not interpret it, so it stays `unknown` here. The SQL the
// methods emit is BYTE-IDENTICAL to the raw queries the routes issued before the
// move (this slice is a mechanical relocation behind the seam, not a rewrite):
// the project SELECT keeps the exact 7-column list (no `org_id`) the list/read
// routes used, and the ownership gates keep their original column shapes.
export const ProjectRow = z.object({
  projectId: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  runnerImage: z.string(),
  allocator: z.string(),
  config: z.unknown(),
  // Mandatory at the repository boundary. An omitted/unknown lifecycle must not
  // silently turn a partial greenfield shell into an active autonomous project.
  lifecycle: ProjectLifecycleEnum,
  // Present only on the single-project read (which selects it for the tenant
  // check); null when the column is absent/unset.
  orgId: z.string().nullable().optional(),
});
export type ProjectRow = z.infer<typeof ProjectRow>;

interface RawProjectRow {
  project_id: unknown;
  name: unknown;
  repo_url: unknown;
  default_branch: unknown;
  runner_image: unknown;
  allocator: unknown;
  config: unknown;
  lifecycle: unknown;
  org_id?: unknown;
}

// The exact column list the list/read routes used (7 columns, no org_id) — the
// fakes + RLS column expectations key off this prefix.
const SELECT_PROJECT_COLUMNS = "project_id, name, repo_url, default_branch, runner_image, allocator, config";

function decodeProjectRow(raw: RawProjectRow): ProjectRow {
  return ProjectRow.parse({
    projectId: raw.project_id,
    name: raw.name,
    repoUrl: raw.repo_url,
    defaultBranch: raw.default_branch,
    runnerImage: raw.runner_image,
    allocator: raw.allocator,
    config: raw.config,
    lifecycle: raw.lifecycle,
    orgId: raw.org_id === undefined ? undefined : nullableText(raw.org_id),
  });
}

export const ProjectStore = {
  /** All projects for an org, ordered by name (the project-list route). */
  async listForOrg(client: QueryClient, orgId: string, _actor: ActorRef): Promise<ProjectRow[]> {
    const result = await client.query<RawProjectRow>(
      `SELECT ${SELECT_PROJECT_COLUMNS}, lifecycle
         FROM projects
        WHERE org_id = $1
        ORDER BY name`,
      [orgId],
    );
    return result.rows.map((row) => decodeProjectRow(row));
  },

  /**
   * A single project by its REPO URL — the natural idempotency key for a greenfield
   * create (one project per greenfield repo). The explicit org predicate and RLS
   * both bound the row to the caller's org, so a retry only ever re-attaches to a
   * project the SAME org already created. `undefined` when no row exists. Used by the idempotent
   * greenfield create to resume a stranded provisioning instead of double-provisioning
   * + 409-ing on the already-created repo (audit §3.10).
   */
  async findByRepoUrl(
    client: QueryClient,
    orgId: string,
    repoUrl: string,
    _actor: ActorRef,
  ): Promise<ProjectRow | undefined> {
    // Match on the CANONICAL repo URL ignoring a trailing `.git` on either side: the
    // forge `html_url` the project row stores has no `.git`, while the deterministic
    // clone remote (`githubHttpsRemote`) does. A retry must re-attach regardless of
    // which form the caller passes — so both stored and queried URLs are `.git`-trimmed.
    const canonical = repoUrl.replace(/\.git$/u, "");
    const result = await client.query<RawProjectRow>(
      `SELECT ${SELECT_PROJECT_COLUMNS}, org_id, lifecycle
         FROM projects
        WHERE regexp_replace(repo_url, '\\.git$', '') = $1 AND org_id = $2
        LIMIT 1`,
      [canonical, orgId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return decodeProjectRow(row);
  },

  /**
   * A single project by id, selecting `org_id` too so the caller can compare it
   * against the path org (the project-read tenant check). No org filter; the
   * caller decides access. `undefined` when no row exists.
   */
  async get(client: QueryClient, projectId: string, _actor: ActorRef): Promise<ProjectRow | undefined> {
    const result = await client.query<RawProjectRow>(
      `SELECT ${SELECT_PROJECT_COLUMNS}, org_id, lifecycle
         FROM projects
        WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeProjectRow(row);
  },

  /**
   * The org id for a project (the brownfield-link + project-PATCH tenant gate),
   * or `undefined` when no row exists. SQL matches the original `SELECT org_id
   * FROM projects WHERE project_id = $1`.
   */
  async getOrgId(client: QueryClient, projectId: string, _actor: ActorRef): Promise<string | null | undefined> {
    const result = await client.query<{ org_id?: unknown }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return nullableText(row.org_id);
  },

  /**
   * The org id + default branch for a project (the brownfield full-track guard),
   * or `undefined` when no row exists. SQL matches the original `SELECT org_id,
   * default_branch FROM projects WHERE project_id = $1`.
   */
  async getOwnership(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<{ orgId: string | null; defaultBranch: string | null } | undefined> {
    const result = await client.query<{ org_id?: unknown; default_branch?: unknown }>(
      "SELECT org_id, default_branch FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      orgId: nullableText(row.org_id),
      defaultBranch: nullableText(row.default_branch),
    };
  },

  /** The raw stored `config` blob for a project (the posture writer read-modify-writes it). */
  async getConfig(client: QueryClient, projectId: string, _actor: ActorRef): Promise<unknown> {
    const result = await client.query<{ config?: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.config;
  },

  /** Read the exact state a subsequent config compare-and-swap must match. */
  async getConfigSnapshot(
    client: ProjectConfigQueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<ProjectConfigSnapshot | undefined> {
    const result = await client.query("SELECT config FROM projects WHERE project_id = $1", [projectId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { config: z.object({ config: z.unknown() }).parse(row).config };
  },

  /** Exact-state CAS: never erases a config mutation committed after the snapshot. */
  async updateConfigIfCurrent(
    client: ProjectConfigQueryClient,
    projectId: string,
    snapshot: ProjectConfigSnapshot,
    config: unknown,
    _actor: ActorRef,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE projects SET config = $1::jsonb
       WHERE project_id = $2 AND config = $3::jsonb
       RETURNING project_id`,
      [json(config), projectId, json(snapshot.config)],
    );
    return (result.rowCount ?? 0) === 1;
  },

  /** Set a project's repo URL (the brownfield link write). */
  async updateRepoUrl(client: QueryClient, projectId: string, repoUrl: string, _actor: ActorRef): Promise<void> {
    await client.query("UPDATE projects SET repo_url = $1 WHERE project_id = $2", [repoUrl, projectId]);
  },
} as const;

export {
  ProjectDerivationConflictError,
  ProjectDerivationRow,
  ProjectDerivationStore,
  projectDerivationFingerprint,
  withProjectDerivationLock,
} from "./projectDerivations.js";
export type { DerivationKind, DerivationPhase, DerivationStatus } from "./projectDerivations.js";

/** Progress-based CAS merge: every failed attempt proves another writer advanced. */
export async function mutateProjectConfig<T>(
  client: ProjectConfigQueryClient,
  projectId: string,
  actor: ActorRef,
  mutate: (current: unknown) => T,
): Promise<T> {
  for (;;) {
    const snapshot = await ProjectStore.getConfigSnapshot(client, projectId, actor);
    if (snapshot === undefined) throw new Error("project_config_missing");
    const next = mutate(snapshot.config);
    if (await ProjectStore.updateConfigIfCurrent(client, projectId, snapshot, next, actor)) return next;
  }
}

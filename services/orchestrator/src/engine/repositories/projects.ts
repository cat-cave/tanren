import type pg from "pg";
import { z } from "zod";
import {
  type ConfigCasOutcome,
  type ConfigSnapshot,
  configCasImpossibleMiss,
  revisionText,
} from "../config/configRevision.js";
import { nullableText } from "../data/scalarText.js";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** A project's lifecycle: deriving, autonomous-walker-driven, or operator-paused. */
export const ProjectLifecycleEnum = z.enum(["deriving", "active", "archived"]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleEnum>;

// The project row as the HTTP project/brownfield routes read it. `config` is an
// opaque JSON blob the route layer migrates/validates with `migrateProjectConfig`
// — the repository does not interpret it, so it stays `unknown` here.
export const ProjectRow = z.object({
  projectId: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  runnerImage: z.string(),
  allocator: z.string(),
  config: z.unknown(),
  /** Decimal string of config_revision — present when the SELECT includes it. */
  configRevision: z.string().optional(),
  // Mandatory at the repository boundary. An omitted/unknown lifecycle must not
  // silently turn a partial greenfield shell into an active autonomous project.
  lifecycle: ProjectLifecycleEnum,
  // Present only on the single-project read (which selects it for the tenant
  // check); null when the column is absent/unset.
  orgId: z.string().nullable().optional(),
});
export type ProjectRow = z.infer<typeof ProjectRow>;

export type ProjectConfigSnapshot = ConfigSnapshot;

interface RawProjectRow {
  project_id: unknown;
  name: unknown;
  repo_url: unknown;
  default_branch: unknown;
  runner_image: unknown;
  allocator: unknown;
  config: unknown;
  config_revision?: unknown;
  lifecycle: unknown;
  org_id?: unknown;
}

// List/read columns. config_revision is selected so HTTP can surface the CAS token.
const SELECT_PROJECT_COLUMNS =
  "project_id, name, repo_url, default_branch, runner_image, allocator, config, config_revision";

function decodeProjectRow(raw: RawProjectRow): ProjectRow {
  return ProjectRow.parse({
    projectId: raw.project_id,
    name: raw.name,
    repoUrl: raw.repo_url,
    defaultBranch: raw.default_branch,
    runnerImage: raw.runner_image,
    allocator: raw.allocator,
    config: raw.config,
    configRevision: raw.config_revision === undefined ? undefined : revisionText(raw.config_revision),
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
   * against the path org. `undefined` when no row exists.
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
   * or `undefined` when no row exists.
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
   * or `undefined` when no row exists.
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

  /** The raw stored `config` blob for a project (read-only consumers). */
  async getConfig(client: QueryClient, projectId: string, _actor: ActorRef): Promise<unknown> {
    const result = await client.query<{ config?: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.config;
  },

  /**
   * Snapshot of config + application generation. `undefined` when the row is
   * absent or invisible under the client's org RLS scope (foreign ≡ missing).
   */
  async getConfigSnapshot(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<ProjectConfigSnapshot | undefined> {
    const result = await client.query<{ config: unknown; revision: unknown }>(
      "SELECT config, config_revision::text AS revision FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return { config: row.config, revision: revisionText(row.revision) };
  },

  /**
   * Sole write authority for projects.config after create INSERT.
   * One revision-predicated UPDATE: bumps only when config is JSONB-distinct.
   * Zero rows → authoritative re-read (not_found / conflict / same-rev no-op ok).
   * Serialization point is the UPDATE; never an unlocked pre-read short-circuit.
   */
  async compareAndSwapConfig(
    client: QueryClient,
    projectId: string,
    expectedRevision: string,
    nextConfig: unknown,
    _actor: ActorRef,
  ): Promise<ConfigCasOutcome> {
    // Fail closed before $n::bigint — reject overflow/non-canonical tokens loudly.
    const expected = revisionText(expectedRevision);
    const nextJson = JSON.stringify(nextConfig);
    const result = await client.query<{ config: unknown; revision: unknown }>(
      `UPDATE projects
          SET config = $1::jsonb,
              config_revision = config_revision + 1
        WHERE project_id = $2
          AND config_revision = $3::bigint
          AND config IS DISTINCT FROM $1::jsonb
        RETURNING config, config_revision::text AS revision`,
      [nextJson, projectId, expected],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return { status: "ok", config: row.config, revision: revisionText(row.revision) };
    }
    // Miss: re-read under the same client. Same expected revision ⇒ true no-op
    // (UPDATE saw config IS NOT DISTINCT FROM next). Else conflict / not_found.
    const probe = await client.query<{ config: unknown; revision: unknown; config_equal: boolean }>(
      `SELECT config, config_revision::text AS revision,
              (config IS NOT DISTINCT FROM $2::jsonb) AS config_equal
         FROM projects WHERE project_id = $1`,
      [projectId, nextJson],
    );
    const after = probe.rows[0];
    if (after === undefined) {
      return { status: "not_found" };
    }
    const rev = revisionText(after.revision);
    if (rev !== expected) {
      return { status: "conflict", current: { config: after.config, revision: rev } };
    }
    if (after.config_equal) {
      return { status: "ok", config: after.config, revision: rev };
    }
    return configCasImpossibleMiss("project", projectId, expected);
  },

  /** Set a project's repo URL (the brownfield link write). Does NOT bump config_revision. */
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

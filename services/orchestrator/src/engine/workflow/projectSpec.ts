import { randomUUID } from "node:crypto";
import { getSystemPool, notifyJobEnqueued, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { type ProjectConfigV1, defaultProjectConfigV1, migrateProjectConfig } from "../config/index.js";
import { PgEventStore } from "../eventStore.js";
import { DEFAULT_SPEC_PRIORITY, SpecPriority } from "../state/spec.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotFoundError,
  SpecNotRunnableError,
} from "./projectSpecErrors.js";

/** The pool or a checked-out client — anything that can run a query. */
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const defaultBranch = "main";
const defaultRunnerImage = "ghcr.io/cat-cave/tanren-runner:v0";
const defaultAllocator = "local-docker";
const initialPlannerModel = "fake-planner";

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  runnerImage?: string;
  allocator?: string;
  // Optional jsonb blob; `createProject` parses it through `migrateProjectConfig`
  // (fail-hard on missing/unknown `version`) before persisting. Omitted ⇒ a
  // fully-defaulted V1; supplied ⇒ MUST be an explicit `version: 1` blob (no
  // silent upgrade), never storing unknown fields in the typed V1 shape.
  config?: unknown;
}

export interface ProjectContract {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  runnerImage: string;
  allocator: string;
  config: ProjectConfigV1;
}

export interface CreateSpecInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  /** Execution priority (§1b); omitted ⇒ the `tbd` default the DagWalker schedules last. */
  priority?: SpecPriority;
}

export interface SpecContract {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
  priority: SpecPriority;
}

export interface CreateSpecRunInput {
  specId: string;
  trigger?: string;
  branch?: string;
  // P2c-1 (§2c): a SPECULATIVE start; `speculativeBase` is the dynamic base, gate
  // skipped. P2c-2: `integratedAncestorShas` is the per-ancestor head SHA the run
  // integrated against (the change-percolation divergence key), persisted on the run.
  speculative?: { speculativeBase: string; integratedAncestorShas?: Record<string, string> };
}

export interface SpecRunContract {
  runId: string;
  specId: string;
  projectId: string;
  trigger: string;
  branch: string;
  status: "queued";
  plannerTaskId: string;
  plannerJobId: string;
  project: ProjectContract;
  spec: SpecContract;
}

// Domain errors live in `./projectSpecErrors.js` (max-classes-per-file). Import
// them for local `throw` sites and re-export so existing callers are unchanged.
export {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotFoundError,
  SpecNotRunnableError,
};

export async function createProject(
  pool: pg.Pool,
  input: CreateProjectInput,
  _actor?: ActorContext,
): Promise<ProjectContract> {
  const projectId = `project_${randomUUID()}`;
  const project: ProjectContract = {
    projectId,
    name: input.name,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch ?? defaultBranch,
    runnerImage: input.runnerImage ?? defaultRunnerImage,
    allocator: input.allocator ?? defaultAllocator,
    // No config supplied ⇒ fully-defaulted V1. A supplied config must be an
    // explicit `version: 1` blob; an unversioned blob or unknown keys is
    // rejected (fail-hard, no silent upgrade).
    config: input.config === undefined ? defaultProjectConfigV1() : migrateProjectConfig(input.config),
  };

  // RLS R3b: an org-carrying operator persists under `runWithOrgScope`; a null-org
  // caller is cross-org system seeding → the BYPASSRLS `tanren_system` pool.
  const orgId = _actor?.orgId ?? null;
  const persist = async (client: QueryClient): Promise<void> => {
    await client.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        project.projectId,
        project.name,
        project.repoUrl,
        project.defaultBranch,
        project.runnerImage,
        project.allocator,
        JSON.stringify(project.config),
        orgId,
      ],
    );
    if (_actor !== undefined) {
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [project.projectId, _actor.userId],
      );
    }
  };
  await (orgId === null ? persist(getSystemPool() ?? pool) : runWithOrgScope(pool, orgId, persist));
  return project;
}

export async function createSpec(pool: pg.Pool, input: CreateSpecInput, actor?: ActorContext): Promise<SpecContract> {
  // RLS (specs write): an org-carrying actor runs the spec pre-checks + INSERT
  // through the org-scoped client; a legacy/unscoped actor keeps the pool path.
  const orgId = actor?.orgId ?? null;
  if (orgId !== null) {
    return runWithOrgScope(pool, orgId, (client) => createSpecOnClient(client, input, actor));
  }
  return createSpecOnClient(pool, input, actor);
}

async function createSpecOnClient(
  client: QueryClient,
  input: CreateSpecInput,
  actor?: ActorContext,
): Promise<SpecContract> {
  await ensureProjectExists(client, input.projectId);
  await ensureProjectAccess(client, input.projectId, actor);
  await ensureSpecDependenciesExist(client, input.projectId, input.dependsOn ?? []);
  const spec: SpecContract = {
    specId: `spec_${randomUUID()}`,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    dependsOn: input.dependsOn ?? [],
    status: "pending",
    priority: input.priority ?? DEFAULT_SPEC_PRIORITY,
  };

  await client.query(
    // org_id derived in-statement from the parent project (tanren tenancy).
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, depends_on, status, priority)
     VALUES ($1, $2, (SELECT org_id FROM projects WHERE project_id = $2), $3, $4, $5::jsonb, $6::text[], $7, $8)`,
    [
      spec.specId,
      spec.projectId,
      spec.title,
      spec.description,
      JSON.stringify(spec.acceptanceCriteria),
      spec.dependsOn,
      spec.status,
      spec.priority,
    ],
  );
  return spec;
}

export async function createQueuedRunFromSpec(
  pool: pg.Pool,
  input: CreateSpecRunInput,
  actor?: ActorContext,
): Promise<SpecRunContract> {
  // RLS (write path): an org-carrying actor runs the run-create transaction through
  // the org-scoped client; a null-org (CLI) caller keeps the manual-transaction path.
  const orgId = actor?.orgId ?? null;
  if (orgId !== null) {
    return runWithOrgScope(pool, orgId, (client) => createQueuedRunFromSpecOnClient(client, input, actor));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await createQueuedRunFromSpecOnClient(client, input, actor);
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureProjectAccess(pool: QueryClient, projectId: string, actor?: ActorContext): Promise<void> {
  if (actor === undefined || actor.scopes.includes("platform:admin")) {
    return;
  }
  const result = await pool.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
    projectId,
  ]);
  const projectOrg = result.rows[0]?.org_id ?? null;
  // org_id is mandatory (no null-org bypass): a project with no resolvable org
  // is denied, never granted.
  if (projectOrg === null) {
    throw new ProjectAccessDeniedError(projectId);
  }
  const memberResult = await pool.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId],
  );
  if ((memberResult.rowCount ?? 0) > 0) {
    return;
  }
  if (actor.orgId === projectOrg && actor.scopes.includes("org:member")) {
    return;
  }
  throw new ProjectAccessDeniedError(projectId);
}

function defaultRunBranch(spec: SpecContract): string {
  const slug = spec.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 48);
  return `tanren/${slug || "spec"}-${spec.specId.replace(/^spec_/u, "").slice(0, 8)}`;
}

async function ensureProjectExists(pool: QueryClient, projectId: string): Promise<void> {
  const result = await pool.query("SELECT project_id FROM projects WHERE project_id = $1", [projectId]);
  if (result.rowCount === 0) {
    throw new ProjectNotFoundError(projectId);
  }
}

async function ensureSpecDependenciesExist(pool: QueryClient, projectId: string, dependsOn: string[]): Promise<void> {
  const uniqueDependsOn = [...new Set(dependsOn)];
  if (uniqueDependsOn.length === 0) {
    return;
  }
  const result = await pool.query("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY($2::text[])", [
    projectId,
    uniqueDependsOn,
  ]);
  const found = new Set(result.rows.map((row) => String(row.spec_id)));
  const missing = uniqueDependsOn.filter((specId) => !found.has(specId));
  if (missing.length > 0) {
    throw new SpecNotFoundError(missing.join(", "));
  }
}

async function createQueuedRunFromSpecOnClient(
  client: pg.PoolClient,
  input: CreateSpecRunInput,
  actor?: ActorContext,
): Promise<SpecRunContract> {
  const loaded = await loadSpecWithProject(client, input.specId);
  await ensureClientProjectAccess(client, loaded.project.projectId, actor);
  // P2c-1: a speculative start skips the done-only gate (the walker enforced the threshold gate).
  if (input.speculative === undefined) await ensureSpecDependenciesDone(client, loaded.spec);
  const plannerTaskId = `task_${randomUUID()}`;
  const run: SpecRunContract = {
    runId: `run_${randomUUID()}`,
    specId: loaded.spec.specId,
    projectId: loaded.project.projectId,
    trigger: input.trigger ?? "cli",
    branch: input.branch ?? defaultRunBranch(loaded.spec),
    status: "queued",
    plannerTaskId,
    plannerJobId: "",
    project: loaded.project,
    spec: { ...loaded.spec, status: "active" },
  };

  // P2c-2: the percolation divergence key — set only on a speculative start.
  const integratedShas = input.speculative?.integratedAncestorShas;
  await client.query(
    // org_id derived in-statement from the parent project (tanren tenancy).
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, speculative_base, integrated_ancestor_shas)
     VALUES ($1, $2, $3, (SELECT org_id FROM projects WHERE project_id = $3), $4, $5, 'queued', $6, $7)`,
    [
      run.runId,
      run.specId,
      run.projectId,
      run.trigger,
      run.branch,
      input.speculative?.speculativeBase ?? null,
      integratedShas === undefined ? null : JSON.stringify(integratedShas),
    ],
  );
  await claimPendingSpec(client, loaded.spec);
  await client.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), 'plan', 'Plan spec implementation', 'queued', 'answerer', 'fake', $3)`,
    [plannerTaskId, run.runId, initialPlannerModel],
  );
  const job = await client.query(
    // RLS R3b: stamp the run's org_id on the queue row (job_queue is OUTSIDE RLS).
    `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
     VALUES ($1, $2, 'plan', $3::jsonb, (SELECT org_id FROM runs WHERE run_id = $1))
     RETURNING id::text`,
    [run.runId, plannerTaskId, JSON.stringify({ specId: run.specId, projectId: run.projectId, branch: run.branch })],
  );
  run.plannerJobId = String(job.rows[0]?.id);
  // LISTEN/NOTIFY: wake an idle worker the instant this run's plan job is enqueued.
  // The NOTIFY rides this transaction's COMMIT, so it fires exactly when the queued
  // row becomes visible — never before.
  await notifyJobEnqueued(client);
  const eventStore = new PgEventStore(client);
  await eventStore.append({
    runId: run.runId,
    specId: run.specId,
    projectId: run.projectId,
    eventType: "run.queued",
    payload: {
      trigger: run.trigger,
      branch: run.branch,
      plannerTaskId: run.plannerTaskId,
      plannerJobId: run.plannerJobId,
      project: {
        repoUrl: run.project.repoUrl,
        defaultBranch: run.project.defaultBranch,
        runnerImage: run.project.runnerImage,
        allocator: run.project.allocator,
      },
      spec: {
        title: run.spec.title,
        acceptanceCriteria: run.spec.acceptanceCriteria,
        dependsOn: run.spec.dependsOn,
      },
    },
  });
  await eventStore.append({
    runId: run.runId,
    taskId: run.plannerTaskId,
    specId: run.specId,
    projectId: run.projectId,
    eventType: "task.queued",
    payload: { taskKind: "plan", jobId: run.plannerJobId },
  });
  return run;
}

async function claimPendingSpec(client: pg.PoolClient, spec: SpecContract): Promise<void> {
  const result = await client.query(
    "UPDATE specs SET status = 'active' WHERE spec_id = $1 AND status = 'pending' RETURNING spec_id",
    [spec.specId],
  );
  if (result.rowCount === 0) {
    throw new SpecNotRunnableError(spec.specId, spec.status);
  }
}

async function ensureSpecDependenciesDone(client: pg.PoolClient, spec: SpecContract): Promise<void> {
  if (spec.dependsOn.length === 0) {
    return;
  }
  const result = await client.query(
    "SELECT spec_id FROM specs WHERE project_id = $1 AND status = 'done' AND spec_id = ANY($2::text[])",
    [spec.projectId, spec.dependsOn],
  );
  const done = new Set(result.rows.map((row) => String(row.spec_id)));
  const blocked = spec.dependsOn.filter((specId) => !done.has(specId));
  if (blocked.length > 0) {
    throw new SpecDependenciesBlockedError(spec.specId, blocked);
  }
}

async function loadSpecWithProject(
  pool: QueryClient,
  specId: string,
): Promise<{ project: ProjectContract; spec: SpecContract }> {
  const result = await pool.query(
    `SELECT p.project_id, p.name, p.repo_url, p.default_branch, p.runner_image, p.allocator, p.config,
            s.spec_id, s.title, s.description, s.acceptance_criteria, s.depends_on, s.status, s.priority
       FROM specs s JOIN projects p ON p.project_id = s.project_id
      WHERE s.spec_id = $1`,
    [specId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SpecNotFoundError(specId);
  }
  const decoded = SpecProjectRowSchema.parse(row);
  return {
    project: {
      projectId: decoded.project_id,
      name: decoded.name,
      repoUrl: decoded.repo_url,
      defaultBranch: decoded.default_branch,
      runnerImage: decoded.runner_image,
      allocator: decoded.allocator,
      // Read-path parser: a stored row missing `version` (or carrying an
      // unknown version) raises a typed UnknownConfigVersionError out of
      // migrateProjectConfig — no silent default.
      config: migrateProjectConfig(decoded.config),
    },
    spec: {
      specId: decoded.spec_id,
      projectId: decoded.project_id,
      title: decoded.title,
      description: decoded.description,
      acceptanceCriteria: decoded.acceptance_criteria,
      dependsOn: decoded.depends_on,
      status: decoded.status,
      priority: decoded.priority,
    },
  };
}

const RecordOrEmpty = z
  .unknown()
  .transform((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
  );

const StringArrayOrEmpty = z
  .unknown()
  .transform((value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []));

const SpecProjectRowSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  repo_url: z.string(),
  default_branch: z.string(),
  runner_image: z.string(),
  allocator: z.string(),
  config: RecordOrEmpty,
  spec_id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: StringArrayOrEmpty,
  depends_on: StringArrayOrEmpty,
  status: z.string(),
  priority: SpecPriority,
});

async function ensureClientProjectAccess(
  client: pg.PoolClient,
  projectId: string,
  actor?: ActorContext,
): Promise<void> {
  if (actor === undefined || actor.scopes.includes("platform:admin")) {
    return;
  }
  const projectRow = await client.query<{ org_id: string | null }>(
    "SELECT org_id FROM projects WHERE project_id = $1",
    [projectId],
  );
  const projectOrg = projectRow.rows[0]?.org_id ?? null;
  if (projectOrg === null) {
    throw new ProjectAccessDeniedError(projectId);
  }
  const memberResult = await client.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId],
  );
  if ((memberResult.rowCount ?? 0) > 0) {
    return;
  }
  if (actor.orgId === projectOrg && actor.scopes.includes("org:member")) {
    return;
  }
  throw new ProjectAccessDeniedError(projectId);
}

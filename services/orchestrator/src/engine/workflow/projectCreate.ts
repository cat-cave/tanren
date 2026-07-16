import { randomUUID } from "node:crypto";
import { getSystemPool, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { type ProjectConfigV1, defaultProjectConfigV1 } from "../config/index.js";
import type { ProjectLifecycle } from "../repositories/projects.js";
import { assertProjectCreateConfigAllowed, type ProjectConfigWriteProof } from "./projectConfigWriteGuards.js";

export type ProjectCreateQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  runnerImage?: string;
  allocator?: string;
  config?: unknown;
}

export interface CreateProjectOptions {
  configWriteProof?: ProjectConfigWriteProof;
  /** Greenfield/derive shells are explicitly non-runnable until their receipts complete. */
  initialLifecycle?: Extract<ProjectLifecycle, "deriving" | "active">;
}

export interface ProjectContract {
  projectId: string;
  orgId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  runnerImage: string;
  allocator: string;
  config: ProjectConfigV1;
  lifecycle: ProjectLifecycle;
}

const defaultBranch = "main";
const defaultRunnerImage = "ghcr.io/cat-cave/tanren-runner:v0";
const defaultAllocator = "local-docker";

function buildProject(
  input: CreateProjectInput,
  actor: ActorContext | undefined,
  options: CreateProjectOptions,
): ProjectContract {
  return {
    projectId: `project_${randomUUID()}`,
    orgId: actor?.orgId ?? "",
    name: input.name,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch ?? defaultBranch,
    runnerImage: input.runnerImage ?? defaultRunnerImage,
    allocator: input.allocator ?? defaultAllocator,
    lifecycle: options.initialLifecycle ?? "active",
    config:
      input.config === undefined
        ? defaultProjectConfigV1()
        : assertProjectCreateConfigAllowed(input.config, options.configWriteProof),
  };
}

export async function createProjectOnClient(
  client: ProjectCreateQueryClient,
  input: CreateProjectInput,
  actor?: ActorContext,
  options: CreateProjectOptions = {},
): Promise<ProjectContract> {
  const project = buildProject(input, actor, options);
  const orgId = actor?.orgId ?? null;
  await client.query(
    `INSERT INTO projects
       (project_id, name, repo_url, default_branch, runner_image, allocator, config, lifecycle, org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      project.projectId,
      project.name,
      project.repoUrl,
      project.defaultBranch,
      project.runnerImage,
      project.allocator,
      JSON.stringify(project.config),
      project.lifecycle,
      orgId,
    ],
  );
  if (actor !== undefined) {
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [project.projectId, actor.userId],
    );
  }
  return project;
}

export async function createProject(
  pool: pg.Pool,
  input: CreateProjectInput,
  actor?: ActorContext,
  options: CreateProjectOptions = {},
): Promise<ProjectContract> {
  const orgId = actor?.orgId ?? null;
  if (orgId === null) return createProjectOnClient(getSystemPool() ?? pool, input, actor, options);
  return runWithOrgScope(pool, orgId, (client) => createProjectOnClient(client, input, actor, options));
}

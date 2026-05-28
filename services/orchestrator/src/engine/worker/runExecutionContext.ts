// P3-0001: load everything a claimed `plan` job needs to execute the real
// planner-loop workflow. This is the inverse of `createQueuedRunFromSpec`: the
// trigger persists a run + spec + project + a queued `plan` job; the worker
// claims that job and re-hydrates the `PlannerRunContext` from those rows plus
// the project's resolved credentials.
//
// Kept deliberately small and SQL-explicit so the worker's read surface is
// independent of the route layer and easy to fake in tests.

import { z } from "zod";
import type pg from "pg";
import { migrateProjectConfig, type ProjectConfigV1 } from "../config/index.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import type { PlannerRunContext } from "../workflow/plannerRun.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Thrown when a claimed job references a run/spec/project row that is gone. */
export class RunExecutionContextNotFoundError extends Error {
  constructor(runId: string) {
    super(`run execution context not found for run ${runId}`);
    this.name = "RunExecutionContextNotFoundError";
  }
}

const RunSpecProjectRowSchema = z.object({
  run_id: z.string(),
  spec_id: z.string(),
  project_id: z.string(),
  branch: z.string(),
  repo_url: z.string(),
  default_branch: z.string(),
  runner_image: z.string(),
  config: z.unknown(),
  org_id: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.unknown()
});

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface RunExecutionContext {
  context: PlannerRunContext;
  projectConfig: ProjectConfigV1;
  orgId: string | null;
}

/**
 * Re-hydrate a `PlannerRunContext` for a claimed `plan` job. Joins the run to
 * its spec + project, resolves the run's Codex + GitHub credential refs from
 * project config / org defaults, and returns a context ready for
 * `runPlannerLoopWorkflow`.
 *
 * @param identitySecretRef the runner identity key ref (same value `main.ts`
 *        seeds for the server). Threaded in rather than read here so the worker
 *        shares the orchestrator's single identity-secret configuration.
 */
export async function loadRunExecutionContext(
  pool: QueryClient,
  input: { runId: string; identitySecretRef: string }
): Promise<RunExecutionContext> {
  const result = await pool.query(
    `SELECT
       r.run_id,
       r.spec_id,
       r.project_id,
       r.branch,
       p.repo_url,
       p.default_branch,
       p.runner_image,
       p.config,
       p.org_id,
       s.title,
       s.description,
       s.acceptance_criteria
     FROM runs r
     JOIN specs s ON s.spec_id = r.spec_id
     JOIN projects p ON p.project_id = r.project_id
     WHERE r.run_id = $1`,
    [input.runId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RunExecutionContextNotFoundError(input.runId);
  }
  const decoded = RunSpecProjectRowSchema.parse(row);
  // migrateProjectConfig normalizes a Phase 1 `{}` blob into a defaulted V1 and
  // raises on an unknown version, mirroring the route read-path parser.
  const projectConfig = migrateProjectConfig(decoded.config);

  // resolveCredentialsForRun reads organizations.config for the org-default
  // layer. A legacy/unscoped project (org_id NULL) has no org row to fall back
  // to, so we resolve from project config only by passing an empty org id; the
  // resolver throws MissingCredentialError when neither layer supplies a ref.
  const resolved = await resolveCredentialsForRun(pool, {
    projectConfig,
    orgId: decoded.org_id ?? ""
  });

  const context: PlannerRunContext = {
    runId: decoded.run_id,
    specId: decoded.spec_id,
    projectId: decoded.project_id,
    repoUrl: decoded.repo_url,
    targetBranch: decoded.default_branch,
    runBranch: decoded.branch,
    specTitle: decoded.title,
    specDescription: decoded.description,
    acceptanceCriteria: stringArray(decoded.acceptance_criteria),
    runnerImage: decoded.runner_image,
    identitySecretRef: input.identitySecretRef,
    githubCredentialRef: resolved.githubCredentialRef,
    codexCredentialRef: resolved.codexCredentialRef
  };

  return { context, projectConfig, orgId: decoded.org_id };
}

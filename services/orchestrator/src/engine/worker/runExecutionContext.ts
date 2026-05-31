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
import type { RoutingTable } from "../config/shared.js";
import type { ResolvedRunCredentials } from "../credentials/resolveCredentials.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import type { PlannerRunContext } from "../workflow/plannerRun.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The four loop roles the run's adapter selector resolves into concrete
// Writer/Answerer adapters (`buildAdaptersFromRouting`). Each empty role chain
// is filled with the default-Codex entry below. `demo` and `forge` are left
// untouched — `demo` carries its own empty-chain semantics (the narrator's
// deterministic-template fallback), and `forge` is not consumed by the loop.
const DEFAULTED_ROUTING_ROLES = ["plan", "write", "check", "audit"] as const;

/**
 * Build the run's EFFECTIVE routing table: the project's per-role routing chains
 * laid on top of a per-role default that heads every loop-role chain with a
 * Codex entry pointing at the run's resolved LLM credential ref.
 *
 * This is the seam that makes "Codex is the default" a DATA fact, not a code
 * hardcode: a project that overrides a role's chain (e.g. `write` → claude or
 * opencode) runs that provider; a role the project leaves empty falls back to
 * the default-Codex entry. The downstream adapter selector
 * (`buildAdaptersFromRouting`) reads the HEAD of each chain, so a non-empty
 * project override wins and an empty one resolves to Codex.
 *
 * The default entry's `model` is a stable placeholder ("default") — the Codex
 * adapter derives its model from the credential/CLI, not the routing entry, so
 * the value only has to satisfy the schema's non-empty constraint.
 */
export function buildEffectiveRouting(projectRouting: RoutingTable, codexCredentialRef: string): RoutingTable {
  const defaultEntry = { cli: "codex", model: "default", authRef: codexCredentialRef };
  const effective: RoutingTable = {
    plan: projectRouting.plan,
    write: projectRouting.write,
    check: projectRouting.check,
    audit: projectRouting.audit,
    demo: projectRouting.demo,
    forge: projectRouting.forge,
  };
  for (const role of DEFAULTED_ROUTING_ROLES) {
    if (projectRouting[role].chain.length === 0) {
      effective[role] = { chain: [defaultEntry] };
    }
  }
  return effective;
}

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
  acceptance_criteria: z.unknown(),
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
  input: { runId: string; identitySecretRef: string },
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
    [input.runId],
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
    orgId: decoded.org_id ?? "",
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
    codexCredentialRef: resolved.codexCredentialRef,
    // The run's per-role provider routing: project routing chains over a
    // per-role default-Codex table built from the resolved LLM credential. The
    // workflow's adapters are resolved from THIS table — Codex is the default by
    // data, not by a code-level hardcode. Under a managed run the resolved
    // codexCredentialRef is the platform ref and `endpointBaseUrl` points the
    // adapters at the managed OpenAI-compatible endpoint.
    routing: buildEffectiveRouting(projectConfig.routing, resolved.codexCredentialRef),
    ...endpointBaseUrlFrom(resolved),
  };

  return { context, projectConfig, orgId: decoded.org_id };
}

/**
 * The managed-endpoint base URL the run's adapters must be pointed at, when the
 * run resolved to managed mode. Spread into the context so a BYOK run (no
 * override) leaves `endpointBaseUrl` absent — behavior-identical to before.
 */
function endpointBaseUrlFrom(resolved: ResolvedRunCredentials): { endpointBaseUrl?: string } {
  return resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {};
}

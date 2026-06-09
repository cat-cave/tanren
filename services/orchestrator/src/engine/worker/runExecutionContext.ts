// load everything a claimed `plan` job needs to execute the real
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
import { creditRatesFromOrgConfig, installationFromOrgConfig } from "../config/orgConfig.js";
import type { RoutingChainEntry, RoutingTable } from "../config/shared.js";
import { resolveCreditUsdRate } from "../costs/index.js";
import type { ResolvedRunCredentials } from "../credentials/resolveCredentials.js";
import { orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { materializeContractFiles } from "../forge/scaffold/index.js";
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
 * laid on top of a per-role default that heads every loop-role chain with the
 * run's resolved DEFAULT LLM entry (provider-agnostic — codex, claude, or any
 * full-role harness, NOT a hardcoded Codex entry).
 *
 * This is the seam that makes the default a DATA fact, not a code hardcode: a
 * project that overrides a role's chain (e.g. `write` → claude or opencode) runs
 * that provider; a role the project leaves empty falls back to `defaultEntry`.
 * The downstream adapter selector (`buildAdaptersFromRouting`) reads the HEAD of
 * each chain, so a non-empty project override wins and an empty one resolves to
 * the default LLM.
 */
export function buildEffectiveRouting(projectRouting: RoutingTable, defaultEntry: RoutingChainEntry): RoutingTable {
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
  // the speculative integration branch this run's PR bases on (the dynamic
  // base), or NULL for a normal run that bases on `default_branch`.
  speculative_base: z.string().nullable(),
  runner_image: z.string(),
  config: z.unknown(),
  org_id: z.string().nullable(),
  org_config: z.unknown().optional(),
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
       r.speculative_base,
       p.runner_image,
       p.config,
       p.org_id,
       o.config AS org_config,
       s.title,
       s.description,
       s.acceptance_criteria
     FROM runs r
     JOIN specs s ON s.spec_id = r.spec_id
     JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN organizations o ON o.id = p.org_id
     WHERE r.run_id = $1`,
    [input.runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RunExecutionContextNotFoundError(input.runId);
  }
  const decoded = RunSpecProjectRowSchema.parse(row);
  // migrateProjectConfig parses the stored V1 row and raises on a missing or
  // unknown version (no silent default), mirroring the route read-path parser.
  const projectConfig = migrateProjectConfig(decoded.config);

  // resolveCredentialsForRun reads organizations.config for the org-default layer.
  // A run is ALWAYS tenant-scoped: `projects.org_id` (joined as `p.org_id`) is
  // NOT-NULL, so a real run row carries a real org id. We thread it through
  // `orgScopeFromRunOrgId`, which FAILS LOUD (`UnscopedOrgError`) on an empty/absent
  // org id — a missing tenant scope at a run path is a scoping/RLS-denial BUG, never
  // a license to coerce `?? ""` and silently degrade to project-config-only BYOK
  // (the no_silent_fallbacks doctrine).
  const resolved = await resolveCredentialsForRun(pool, {
    projectConfig,
    orgScope: orgScopeFromRunOrgId(decoded.org_id),
  });

  // cost PR-C: resolve the run's CONFIGURED per-credential credit→USD rate, keyed on
  // the resolved default-LLM credential's ref-KIND, project-`creditRates` over
  // org-`defaultCreditRates`. A null resolution (no rate configured for this kind) is
  // threaded as an ABSENT context field, so a real credit drawdown lands
  // NULL-and-loud rather than at a removed magic constant.
  const creditRate = resolveCreditUsdRate({
    authRef: resolved.defaultLlm.authRef,
    projectRates: projectConfig.creditRates,
    orgRates: creditRatesFromOrgConfig(decoded.org_config),
  });

  const context: PlannerRunContext = {
    runId: decoded.run_id,
    specId: decoded.spec_id,
    projectId: decoded.project_id,
    orgId: decoded.org_id,
    repoUrl: decoded.repo_url,
    // autonomy-engine.md §2c: DYNAMIC BASE. A speculative run's PR bases
    // on its integration branch (the prospective merged world of its unmerged
    // ancestors); a normal run bases on `default_branch`. The run's MERGE stage
    // still re-gates against `default_branch` once ancestors genuinely merge.
    targetBranch: decoded.speculative_base ?? decoded.default_branch,
    runBranch: decoded.branch,
    specTitle: decoded.title,
    specDescription: decoded.description,
    acceptanceCriteria: stringArray(decoded.acceptance_criteria),
    runnerImage: decoded.runner_image,
    identitySecretRef: input.identitySecretRef,
    githubCredentialRef: resolved.githubCredentialRef,
    // Part 2: the org App installation, so the clone resolves App-first.
    ...(installationFromOrgConfig(decoded.org_config) !== undefined && {
      installation: installationFromOrgConfig(decoded.org_config),
    }),
    defaultLlm: resolved.defaultLlm,
    // The run's per-role provider routing: project routing chains over a
    // per-role default table built from the resolved DEFAULT LLM entry. The
    // workflow's adapters are resolved from THIS table — the default is by data,
    // not a code-level hardcode. Under a managed run the resolved defaultLlm is
    // the platform entry and `endpointBaseUrl` points the adapters at the managed
    // OpenAI-compatible endpoint.
    routing: buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm),
    ...endpointBaseUrlFrom(resolved),
    // The project's governance posture drives the in-loop gate's advisory-step
    // policy (lenient ⇒ lint/typecheck advisory, build/test blocking). Threaded
    // from the resolved project config so a greenfield `lenient` project lands
    // functional-but-weak code instead of stalling the gate.
    governancePosture: projectConfig.governancePosture,
    // AUDIT-EVIDENCE BASELINE: the governance policy version (the project config
    // version), threaded onto the gate.verdict roll-up the run emits.
    policyVersion: projectConfig.version,
    // GREENFIELD MARKER from the resolved project config. Drives the in-loop
    // deps-ensure install MODE: greenfield ⇒ non-frozen install (a writer-added
    // devDep installs even without a regenerated lockfile); brownfield (false) ⇒
    // the frozen, lockfile-safe default so an existing committed lockfile is never
    // silently mutated. Legacy rows parse to `false` (brownfield) — main's behavior.
    greenfield: projectConfig.greenfield,
    // cost PR-C: the CONFIGURED per-credential credit→USD rate (absent ⇒ no rate
    // configured for this credential's kind; a real drawdown then lands NULL-and-loud).
    ...(creditRate.usdPerCredit !== null && { creditUsdRate: creditRate.usdPerCredit }),
    // DETERMINISTIC CONTRACT FILES (v27 fix): when the project captured a lifecycle,
    // project it onto the contract-file manifest (`.tanren/ci.yml` verbatim + the
    // lifecycle-filled `justfile`) the workspace-prep materializes before the writer
    // runs — so the contract files are NEVER LLM-authored. Absent lifecycle ⇒ no
    // manifest ⇒ no materialization (a brownfield project ships its own contract).
    ...(projectConfig.lifecycle !== undefined && {
      contractFiles: materializeContractFiles(projectConfig.lifecycle),
    }),
    // TEMPLATING WAVE 3 (templating-system.md §3): when a validated template was
    // SELECTED at derive, its repo ref is persisted on the project config — thread it
    // so the workspace-prep SEEDS the template's conforming files into the repo BEFORE
    // the writer runs (the writer's "seed already committed" assertion then holds, and
    // it specializes instead of authoring from scratch). Absent ⇒ from-scratch path.
    ...(projectConfig.templateRef !== undefined && {
      templateSeed: { repoRef: projectConfig.templateRef.repoRef },
    }),
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

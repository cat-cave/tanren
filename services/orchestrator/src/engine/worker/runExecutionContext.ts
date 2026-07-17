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
import { loadDesignContextBlock } from "../design/designWriterContext.js";
import { materializeContractFiles } from "../forge/scaffold/index.js";
import { resolveAncestorStack } from "../dag/ancestorStack.js";
import { resolveProjectEnv } from "../environments/index.js";
// The P4 JIT env-image refinement step (env-management.md §4 + §7) is the "second half"
// of env resolution — the no-match router that must run OUTSIDE this read txn (it builds
// + validates an image). Re-exported here (env resolution's home) so the run executor
// imports it alongside `loadRunExecutionContext` without a separate dependency.
export { refineRunnerImageForEnv, type EnvCreationDeps } from "./runExecutorEnvRefine.js";
import { systemActor } from "../state/actor.js";
import { SpecMode } from "../state/spec.js";
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
  // The ordered ancestor stack (`runs.ancestor_stack` jsonb) — the jj-local base source. A
  // non-empty stack is a DEPENDENT speculative run: its bootstrap assembles `main + ordered
  // ancestors` LOCALLY from these ancestor PR-head refs. Nullable/unknown (empty otherwise).
  ancestor_stack: z.unknown().optional(),
  runner_image: z.string(),
  config: z.unknown(),
  org_id: z.string().nullable(),
  org_config: z.unknown().optional(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.unknown(),
  origin_issue_loop_id: z.string().nullish(),
  // Task #86: the spec's writer-prompt MODE (`specialize_seed` for the greenfield scaffold
  // spec; `from_scratch` otherwise). The `specs.mode` column is NOT NULL with default
  // `from_scratch` (migrated in PR #756), so a real row always carries a value.
  mode: SpecMode,
});

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface RunExecutionContext {
  context: PlannerRunContext;
  projectConfig: ProjectConfigV1;
  // A run is ALWAYS tenant-scoped ({@link loadRunExecutionContext} routes
  // `runs.org_id` through {@link orgScopeFromRunOrgId}, which throws
  // `UnscopedOrgError` on a missing/empty value). The vestigial `string | null`
  // branch is gone — every returned execution context carries a real, non-empty
  // org id, matching the narrowed {@link PlannerRunContext.orgId}.
  orgId: string;
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
       r.ancestor_stack,
       p.runner_image,
       p.config,
       p.org_id,
       o.config AS org_config,
       s.title,
       s.description,
       s.acceptance_criteria,
       s.mode,
       s.origin_issue_loop_id
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
  // Resolve the dependent run's ordered ancestor stack from `runs.ancestor_stack` (the
  // jj-local base source). Empty for a non-speculative run. The bootstrap reads it via the
  // context to assemble its base LOCALLY from the ancestor PR-head refs.
  const ancestorStack = resolveAncestorStack({ ancestorStack: decoded.ancestor_stack });
  // migrateProjectConfig parses the stored V1 row and raises on a missing or
  // unknown version (no silent default), mirroring the route read-path parser.
  const projectConfig = migrateProjectConfig(decoded.config);

  // Environment management (environment-management.md §3 Layer 4 + §6 + §7 P3): the
  // PER-PROJECT env resolution at the image seam. Resolve the runner image from the
  // `environments` registry by the project's TOOLCHAIN CONTENT KEY (`env_key`)
  // instead of using the per-project `runner_image` default directly: read the
  // project's committed toolchain (the deterministic `mise.lock` counterpart) →
  // computeEnvKey → registry lookup for a VALIDATED/OFFICIAL match → `env.image_ref`.
  // On a no-match (or no declared toolchain — a fresh greenfield first boot) it
  // FALLS BACK to the warm golden base, so a project with no env resolves exactly as
  // today. `pool` here is the run's ORG-SCOPED client (loadRunContextScoped wraps
  // this in runWithOrgScope), so the RLS-scoped registry lookup sees the org's envs
  // + the cross-org official catalogue.
  const envBinding = await resolveProjectEnv(
    pool,
    { toolchain: projectConfig.lifecycle?.toolchain, baseImage: decoded.runner_image },
    systemActor,
  );

  // resolveCredentialsForRun reads organizations.config for the org-default layer.
  // A run is ALWAYS tenant-scoped: `projects.org_id` (joined as `p.org_id`) is
  // NOT-NULL, so a real run row carries a real org id. We thread it through
  // `orgScopeFromRunOrgId`, which FAILS LOUD (`UnscopedOrgError`) on an empty/absent
  // org id — a missing tenant scope at a run path is a scoping/RLS-denial BUG, never
  // a license to coerce `?? ""` and silently degrade to project-config-only BYOK
  // (the no_silent_fallbacks doctrine).
  // A run is ALWAYS tenant-scoped (see above): this resolves to `{ kind: "org", orgId }` or
  // fails LOUD. The single resolved scope is reused for the credential resolve AND the WS-D2
  // design-contract read, so neither path re-derives (or silently coerces) the tenant scope.
  const orgScope = orgScopeFromRunOrgId(decoded.org_id);
  const resolved = await resolveCredentialsForRun(pool, {
    projectConfig,
    orgScope,
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

  // WS-D2 (native design subsystem): load + render the project's HEAD `DesignContract`
  // into the writer-prompt design block — persona-scoped, behavior-linked, domain-general
  // (designWriterContext.ts). Today the writer gets ZERO design context; this threads the
  // durable design artifact straight into Tanren's own implementing agent (the no-handoff
  // loop). `pool` is the run's ORG-SCOPED client (loadRunContextScoped wraps this in
  // runWithOrgScope), so the read is RLS-scoped + actor-authorized. ABSENT (undefined) ⇒ the
  // project has no design contract (a real empty state) ⇒ the writer gets no block — NEVER a
  // fabricated default. A malformed persisted contract fails LOUDLY in the store's re-parse.
  //
  // H2 BLOCKING (unify): the design contract is PROJECT-scoped — there is exactly ONE
  // product-level head per project, shared across every spec type (scaffold specs need
  // product identity for README naming; feature specs need it for behavior grading).
  // Migration 0028 collapsed the broken `(project_id, mode, version)` mode-keying that
  // silently no-op'd for scaffold/build/deploy specs. The writer prompt's mode-awareness
  // remains where it belongs — `subtaskWriterPrompt.ts` tail blocks (v64 load-bearing).
  const designContextBlock = await loadDesignContextBlock({
    client: pool,
    orgScope,
    projectId: decoded.project_id,
  });

  const context: PlannerRunContext = {
    runId: decoded.run_id,
    specId: decoded.spec_id,
    projectId: decoded.project_id,
    ...(decoded.origin_issue_loop_id !== null && decoded.origin_issue_loop_id !== undefined
      ? { issueLoopId: decoded.origin_issue_loop_id }
      : {}),
    // A run is ALWAYS tenant-scoped: `orgScopeFromRunOrgId` above threw
    // `UnscopedOrgError` on an empty/absent value, so `orgScope.orgId` is a real
    // non-empty string. This is the SINGLE production hydration site — the
    // invariant is enforced HERE, not at every downstream consumer.
    orgId: orgScope.orgId,
    repoUrl: decoded.repo_url,
    // §2c jj-local: the run's history root is `default_branch`. A DEPENDENT speculative run
    // jj-ASSEMBLES `main + ordered ancestors` LOCALLY at bootstrap from `ancestorStack`
    // (threaded below) — the base is no longer a synthesized host ref. The run's MERGE stage
    // still re-gates against `default_branch` once ancestors genuinely merge.
    targetBranch: decoded.default_branch,
    runBranch: decoded.branch,
    specTitle: decoded.title,
    specDescription: decoded.description,
    acceptanceCriteria: stringArray(decoded.acceptance_criteria),
    // Task #86 (v64 root cause): the spec's writer-prompt MODE. Threaded so the
    // greenfield scaffold spec's `specialize_seed` mode reaches `writerPromptFor()`
    // and the writer is told the composed seed is already in place + proven green
    // (touch ONLY product-identity surfaces) rather than today's "build everything
    // ELSE" guidance that produced v64's 6-hour non-converging writer-checker loop.
    specMode: decoded.mode,
    // env P3: the env-RESOLVED runner image — `env.image_ref` on a registry match,
    // else the golden base (the no-match / no-toolchain fallback). Replaces the
    // direct `runner_image` default read; the existing flow (no env) is preserved.
    runnerImage: envBinding.imageRef,
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
    // apex v67/v69 loop-close fix: thread the resolved merge integration so
    // `publishCleanedDraftPr` can wire the EARLY-PATH merge_queue enqueue (the
    // PR is durable the instant github.pr.created fires; the merge coordinator
    // must own it without waiting for the writer chain to reach mergeForRun).
    mergeIntegration: projectConfig.mergeIntegration,
    // The project's audit posture (blockReviewAt / p2p3Handling / autonomousRemediation).
    // Threaded so `assertAuditPostureReentersFindings` at the planner-run boundary
    // sees what the operator PUT via the governance API — an autonomous run on the
    // BALANCED default would strand findings and the preflight FAILS LOUD; an
    // autonomous project that PUT AUTONOMOUS_AUDIT_POSTURE passes the preflight.
    auditPosture: projectConfig.auditPosture,
    // The project's convergence policy (sustained-non-recovery thresholds, etc.).
    // Threaded so the in-loop hold/escape-hatch logic reads the operator's choice
    // rather than the absent-config default.
    convergencePolicy: projectConfig.convergencePolicy,
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
    // WS-D2: the rendered HEAD `DesignContract` design block (absent ⇒ no design contract ⇒ no block).
    ...(designContextBlock !== undefined && { designContextBlock }),
    // DETERMINISTIC CONTRACT FILES (v27 fix): when the project captured a lifecycle,
    // project it onto the contract-file manifest (`.tanren/ci.yml` verbatim + the
    // lifecycle-filled `justfile`) the workspace-prep materializes before the writer
    // runs — so the contract files are NEVER LLM-authored. Absent lifecycle ⇒ no
    // manifest ⇒ no materialization (a brownfield project ships its own contract).
    ...(projectConfig.lifecycle !== undefined && {
      contractFiles: materializeContractFiles(projectConfig.lifecycle),
    }),
    // walker-jj-local-integration-design.md §2.1: re-hydrate the ordered ancestor stack
    // from `runs.ancestor_stack`. A non-empty stack means this is a DEPENDENT speculative
    // run; the workspace bootstrap jj-assembles its base from these ancestor PR-head refs
    // LOCALLY. Spread so a non-speculative run leaves it absent.
    ...(ancestorStack.length > 0 && { ancestorStack }),
  };

  // env P3: record the resolved env binding on the returned project config so the
  // resolution decision is OBSERVABLE (the env-layer counterpart of `templateRef`).
  // Present only when the project declared a toolchain (so an `envKey` was computed)
  // — a no-toolchain project (golden-base path) leaves it absent, exactly as today.
  const resolvedConfig: ProjectConfigV1 =
    envBinding.envKey === undefined
      ? projectConfig
      : {
          ...projectConfig,
          environmentRef: {
            envKey: envBinding.envKey,
            imageRef: envBinding.imageRef,
            ...(envBinding.environmentRef !== undefined && { environmentRef: envBinding.environmentRef }),
          },
        };

  // A run's tenant scope is enforced at hydration ({@link orgScopeFromRunOrgId}
  // threw above on empty), so the returned `orgId` is a real non-empty string —
  // matching the narrowed `RunExecutionContext.orgId` invariant.
  return { context, projectConfig: resolvedConfig, orgId: orgScope.orgId };
}

/**
 * The managed-endpoint base URL the run's adapters must be pointed at, when the
 * run resolved to managed mode. Spread into the context so a BYOK run (no
 * override) leaves `endpointBaseUrl` absent — behavior-identical to before.
 */
function endpointBaseUrlFrom(resolved: ResolvedRunCredentials): { endpointBaseUrl?: string } {
  return resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {};
}

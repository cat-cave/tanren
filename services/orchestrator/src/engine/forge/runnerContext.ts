// The Forge runner-context load — the PRIVILEGED infra/bootstrap read a Forge
// answerer makes LAZILY (inside `forgeAllocatingAnswererAdapter.runAnswerer`) to
// resolve a project's (or the greenfield org's) runner image + `forge` routing +
// credentials before it allocates a runner. Extracted from `providerFactory.ts` so
// the answerer-factory module stays under its dependency ceiling and this
// scoping-sensitive read lives in one cohesive place.
//
// SCOPING (the intake-poller / audit-scheduler regression): the poller + scheduler
// wake CROSS-ORG with NO ambient org scope and resolve a per-source / per-job
// project's answerer LAZILY. So the project read must run SYSTEM-scoped (the
// BYPASSRLS `tanren_system` pool): a raw-pool read under the NOBYPASSRLS `tanren_app`
// role with no `app.current_org_id` GUC is denied by `projects`' deny-by-default RLS
// and reads back ZERO rows, which misreports an EXISTING project as
// `ForgeProjectNotFoundError`. The downstream credential read (`organizations.config`)
// then runs under the RESOLVED org's scope (least privilege) so it too sees its row.

import type pg from "pg";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { AllocatorConfig, migrateProjectConfig } from "../config/index.js";
import type { ProjectConfigV1 } from "../config/index.js";
import { type TenantScope, orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { ForgeToolsStore } from "../repositories/forgeTools.js";
import { systemActor } from "../state/actor.js";
import type { RoutingChainEntry } from "../config/shared.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The default runner image a greenfield (project-less) Forge surface allocates
// against — the same default the project-config schema applies.
export const DEFAULT_FORGE_RUNNER_IMAGE = AllocatorConfig.parse({}).runnerImage;

/** Thrown when a Forge model call addresses a project row that is gone. */
export class ForgeProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`forge: project not found: ${projectId}`);
    this.name = "ForgeProjectNotFoundError";
  }
}

export interface ForgeRunnerContext {
  runnerImage: string;
  routingForge: RoutingChainEntry | undefined;
  defaultLlm: RoutingChainEntry;
  endpointBaseUrl?: string;
  orgId: string;
}

export async function loadProjectRunnerContext(pool: pg.Pool, projectId: string): Promise<ForgeRunnerContext> {
  // Privileged INFRA/bootstrap read: the runner image + config + org id keyed by a
  // caller-supplied project id (NOT user-controlled tenant data). The intake poller
  // and the audit scheduler wake CROSS-ORG with NO ambient org scope, then resolve a
  // per-source/per-job project's answerer LAZILY — so this read must run SYSTEM-scoped
  // (the BYPASSRLS `tanren_system` pool). A raw-pool read under the NOBYPASSRLS
  // `tanren_app` role with no `app.current_org_id` GUC is denied by the `projects`
  // deny-by-default RLS policy and reads back ZERO rows, which misreports an EXISTING
  // project as `ForgeProjectNotFoundError` — the false negative that stalled the
  // poller + scheduler every tick. A GENUINELY-absent project still reads back
  // `undefined` under the system pool ⇒ still throws (loud, no silent fallback). The
  // repository methods are deliberately scope-agnostic (they run on the client the
  // caller hands in), so the CALLER establishes the privileged scope here rather than
  // the store honoring `systemActor` itself.
  const row = await runWithSystemScope(pool, (client) =>
    ForgeToolsStore.getProjectRunnerContext(client, projectId, systemActor),
  );
  if (row === undefined) {
    throw new ForgeProjectNotFoundError(projectId);
  }
  const projectConfig = migrateProjectConfig(row.config);
  // `projects.org_id` is NOT-NULL; thread it through `orgScopeFromRunOrgId`, which
  // FAILS LOUD on an empty/absent org rather than coercing `?? ""` into a silent
  // BYOK/no-defaults degrade (the no_silent_fallbacks doctrine).
  const orgScope = orgScopeFromRunOrgId(row.orgId);
  // Credential resolution reads `organizations.config` for the RESOLVED project org
  // (the org-default provider-mode + credential layer). It too is a tenant-scoped read
  // that RLS denies to ZERO rows under a cross-org wake with no GUC (which would then
  // throw `OrgProviderModeUnresolved`). Run it under the resolved org's scope (least
  // privilege — every other `resolveCredentialsForRun` caller likewise passes an
  // already-org-scoped client) so the org read sees its own row and the whole load
  // succeeds end-to-end.
  return runWithOrgScope(pool, orgScope.orgId, (client) =>
    resolveForgeRunnerContext(client, projectConfig, orgScope, row.runnerImage),
  );
}

/**
 * The greenfield (project-less) resolution: an empty project config laid over
 * the org defaults, against the default runner image. The org's
 * `defaultCredentials` supply the LLM credential, so the interview reasons with a
 * model before any project row exists. The greenfield interview is ALWAYS org-scoped
 * (`ForgeAnswererTarget.orgId` is mandatory), so the org scope fails loud on an empty
 * org id like every other run path.
 */
export async function loadOrgRunnerContext(pool: QueryClient, orgId: string): Promise<ForgeRunnerContext> {
  const emptyProjectConfig = migrateProjectConfig({ version: 1 });
  return resolveForgeRunnerContext(pool, emptyProjectConfig, orgScopeFromRunOrgId(orgId), DEFAULT_FORGE_RUNNER_IMAGE);
}

// A Forge answerer never publishes a PR or polls CI, so it needs no GitHub
// credential — only the LLM credential + (managed) endpoint. We satisfy the
// shared run-credential resolver's GitHub requirement with this sentinel
// override; it is never materialized (no GitHub call is made on a Forge path).
// Passing only the GitHub override does NOT force BYOK (only a codex override
// would), so managed/BYOK LLM resolution is unchanged.
const FORGE_UNUSED_GITHUB_REF = "forge/unused-github-credential";

async function resolveForgeRunnerContext(
  pool: QueryClient,
  projectConfig: ProjectConfigV1,
  orgScope: TenantScope,
  runnerImage: string,
): Promise<ForgeRunnerContext> {
  const resolved = await resolveCredentialsForRun(pool, {
    projectConfig,
    orgScope,
    override: { githubCredentialRef: FORGE_UNUSED_GITHUB_REF },
  });
  // The `forge` routing chain head, when pinned (e.g. a cheaper model for
  // ideation). Empty (the default) ⇒ fall back to the resolved default LLM entry
  // below — the same data-default the loop's `buildEffectiveRouting` applies.
  const routingForge = projectConfig.routing.forge.chain[0];
  return {
    runnerImage,
    routingForge,
    defaultLlm: resolved.defaultLlm,
    ...(resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {}),
    // Both forge paths reach here only through `orgScopeFromRunOrgId`, whose return
    // type is now the NARROWED `TenantScope` — the previous `kind === "org" ? … : ""`
    // ternary was defensive against an `unscopedPlatform` variant that is unreachable
    // at this call site by the type (drop the empty-string fallback; a real non-empty
    // orgId is guaranteed).
    orgId: orgScope.orgId,
  };
}

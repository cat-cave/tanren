// credential→project→run resolution.
//
// A run needs a Codex credential ref (to build the four Codex roles) and a
// GitHub credential ref (to publish the draft PR + poll CI). A caller may pass
// both explicitly, but this resolver lets a dashboard-created project resolve
// them from project config or org defaults, so a run can be triggered without
// the caller threading the refs by hand.
//
// Priority, per kind: explicit override → project config → org default →
// `MissingCredentialError`. The resolver is PURE w.r.t. the orchestrator
// workflow — it only reads `organizations.config` for the org defaults; it does
// NOT mutate state and does NOT itself touch the workflow. The run executor's
// context loader (runExecutionContext) calls this and threads the result into
// `PlannerRunContext`.

import type pg from "pg";
import {
  type ProviderMode,
  defaultManagedProviderConfig,
  resolveHarnessEndpointOverride,
  type HarnessEndpointOverride,
} from "../config/managedProvider.js";
import { migrateOrgConfig, type OrgConfigV1, type OrgDefaultCredentials } from "../config/orgConfig.js";
import type { ProjectConfigV1 } from "../config/projectConfig.js";
import type { RoutingChainEntry } from "../config/shared.js";

type OrgConfigClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Which run-critical credential kinds the resolver covers. */
export type RunCredentialKind = "llm_default" | "github_token";

/**
 * The resolved credentials a run needs. `defaultLlm` is the provider-agnostic
 * routing entry {cli, model, authRef} that heads every loop-role chain a project
 * leaves empty — NOT a Codex-specific ref. `githubCredentialRef` is guaranteed
 * non-empty on success.
 *
 * SaaS Tier-B #5: `providerMode` records WHICH source the default LLM came from.
 * Under `managed`, `defaultLlm.authRef` is the platform-owned ref (e.g.
 * `credential/openrouter/platform/default`) and `endpointOverride` carries the
 * OpenAI-compatible base URL the harness must be pointed at. Under `byok`
 * (default) `defaultLlm` is the tenant's own resolved default entry and
 * `endpointOverride` is undefined. The GitHub credential is ALWAYS the tenant's;
 * managed mode only swaps the LLM provider source.
 */
export interface ResolvedRunCredentials {
  defaultLlm: RoutingChainEntry;
  githubCredentialRef: string;
  providerMode: ProviderMode;
  endpointOverride?: HarnessEndpointOverride;
}

/** Per-kind explicit overrides (e.g. a re-run with a pinned GitHub ref). */
export interface RunCredentialOverride {
  githubCredentialRef?: string;
}

export interface ResolveCredentialsInput {
  /** The project's typed config (already migrated to V1). */
  projectConfig: Pick<ProjectConfigV1, "credentials" | "providerMode">;
  /** Org id whose `config.defaultCredentials` provides the fallback layer. */
  orgId: string;
  /** Highest-priority refs; wins over project config + org default. */
  override?: RunCredentialOverride;
}

/**
 * The org-config fields the provider-mode resolution reads. Pulled once
 * alongside `defaultCredentials` so a managed run never makes a second org read.
 */
interface OrgProviderModeConfig {
  defaults?: OrgDefaultCredentials;
  providerMode: ProviderMode;
}

/**
 * Thrown when a required credential kind cannot be resolved from any layer.
 * `kind` names which one is missing so the executor can render a precise
 * "bind a Codex bundle / GitHub token" prompt rather than a generic failure.
 */
export class MissingCredentialError extends Error {
  readonly kind: RunCredentialKind;

  constructor(kind: RunCredentialKind) {
    super(
      kind === "llm_default"
        ? "No default LLM resolved for this run (project config and org default are both unset)"
        : "No GitHub credential resolved for this run (project config and org default are both unset)",
    );
    this.name = "MissingCredentialError";
    this.kind = kind;
  }
}

/**
 * Thrown when a run/forge call carries a REAL (non-empty) org id but the org row
 * reads back ABSENT. A real run always has a real org row, so an empty read is a
 * scoping/RLS-denial bug (the read ran off-scope and the deny-by-default policy
 * returned zero rows) — NOT a legitimate "org has no config" signal. Failing
 * loudly here surfaces the scoping bug instead of silently degrading a managed
 * org to BYOK. (The empty-org resolve mode — `orgId === ""`, where callers
 * explicitly pass an empty org to resolve from project config only — legitimately
 * defaults to BYOK.)
 */
export class OrgProviderModeUnresolved extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(
      `Org provider-mode config could not be resolved for org ${JSON.stringify(orgId)}: the organizations row read back empty for a non-empty org id (a scoping/RLS-denial bug, not "no config")`,
    );
    this.name = "OrgProviderModeUnresolved";
    this.orgId = orgId;
  }
}

/**
 * Resolve a run's Codex + GitHub credential refs. Reads the org's
 * `defaultCredentials` from `organizations.config` once and applies the
 * override → project → org-default priority for each kind. Throws
 * `MissingCredentialError` for the first kind that resolves to nothing.
 */
export async function resolveCredentialsForRun(
  pool: OrgConfigClient,
  input: ResolveCredentialsInput,
): Promise<ResolvedRunCredentials> {
  const orgConfig = await loadOrgProviderModeConfig(pool, input.orgId);
  const projectCredentials = input.projectConfig.credentials ?? {};

  // Effective provider mode: project override (when set) wins over the org's
  // default.
  const providerMode: ProviderMode = input.projectConfig.providerMode ?? orgConfig.providerMode;

  // Default LLM routing entry + endpoint. Resolved BEFORE GitHub so a BYOK run
  // with no resolvable default LLM throws MissingCredentialError("llm_default")
  // first (preserving the original error ordering). Managed runs never throw
  // here — they resolve the platform-owned entry.
  let defaultLlm: RoutingChainEntry;
  let endpointOverride: HarnessEndpointOverride | undefined;
  if (providerMode === "managed") {
    // Managed: the PLATFORM-owned credential + endpoint, run through the codex
    // harness pointed at the managed OpenRouter endpoint. These are DEPLOY/hosting
    // config (defaultManagedProviderConfig — owned by the deploy layer), NOT
    // userland org/project config: a tenant chooses managed-vs-byok (providerMode),
    // but does NOT pick the platform credential ref/endpoint. The tenant's own
    // default LLM is NOT consulted under managed.
    const managed = defaultManagedProviderConfig();
    defaultLlm = { cli: "codex", model: "default", authRef: managed.credentialRef };
    endpointOverride = resolveHarnessEndpointOverride("managed", managed);
  } else {
    // BYOK (default): the tenant's own resolved default entry — project over org,
    // no endpoint override. The (cli, authRef) compatibility + full-role rules
    // are enforced where the default is SET (the connect route).
    defaultLlm = pickEntry("llm_default", projectCredentials.defaultLlm, orgConfig.defaults?.defaultLlm);
  }

  // GitHub is ALWAYS the tenant's credential — managed mode only swaps the LLM
  // provider source, never the repo identity used to publish PRs / poll CI.
  const githubCredentialRef = pickRef(
    "github_token",
    input.override?.githubCredentialRef,
    projectCredentials.githubCredentialRef,
    orgConfig.defaults?.github_token,
  );

  return { defaultLlm, githubCredentialRef, providerMode, ...(endpointOverride && { endpointOverride }) };
}

/** First non-empty ref layer wins; otherwise the kind is unresolved. */
function pickRef(kind: RunCredentialKind, ...layers: Array<string | undefined>): string {
  for (const layer of layers) {
    if (typeof layer === "string" && layer.trim() !== "") {
      return layer;
    }
  }
  throw new MissingCredentialError(kind);
}

/** First present routing-entry layer wins; otherwise the kind is unresolved. */
function pickEntry(kind: RunCredentialKind, ...layers: Array<RoutingChainEntry | undefined>): RoutingChainEntry {
  for (const layer of layers) {
    if (layer !== undefined) {
      return layer;
    }
  }
  throw new MissingCredentialError(kind);
}

/**
 * Read + validate the org's default credential refs AND its provider-mode block
 * in a single read. A present org row is parsed through `migrateOrgConfig`, which
 * fail-hard rejects a row missing an explicit `version` (no silent `byok`
 * default for unversioned rows).
 *
 * No-fallback directive: an ABSENT org row is interpreted by the org id —
 *   - the empty-org resolve mode — `orgId === ""`, the explicit "resolve from
 *     project config only" mode callers pass at `runExecutionContext.ts` /
 *     `providerFactory.ts` → no defaults + the `byok` default, the one
 *     legitimate empty-read case;
 *   - a NON-EMPTY org id → THROW {@link OrgProviderModeUnresolved}: a real run
 *     always has a real org row, so an empty read is a scoping/RLS-denial bug,
 *     NOT "no config", and must not silently degrade managed → byok.
 */
async function loadOrgProviderModeConfig(pool: OrgConfigClient, orgId: string): Promise<OrgProviderModeConfig> {
  const result = await pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
  const row = result.rows[0];
  if (row === undefined) {
    if (orgId === "") {
      return { providerMode: "byok" };
    }
    throw new OrgProviderModeUnresolved(orgId);
  }
  const config: OrgConfigV1 = migrateOrgConfig(row.config);
  return {
    defaults: config.defaultCredentials,
    providerMode: config.providerMode,
  };
}

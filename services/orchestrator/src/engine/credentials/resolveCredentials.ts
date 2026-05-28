// P3-0002: credential→project→run resolution.
//
// A run needs a Codex credential ref (to build the four Codex roles) and a
// GitHub credential ref (to publish the draft PR + poll CI). Today the
// acceptance scripts pass both explicitly. This resolver lets a
// dashboard-created project resolve them from project config or org defaults,
// so a run can be triggered without the caller threading the refs by hand.
//
// Priority, per kind: explicit override → project config → org default →
// `MissingCredentialError`. The resolver is PURE w.r.t. the orchestrator
// workflow — it only reads `organizations.config` for the org defaults; it does
// NOT mutate state and does NOT itself touch the workflow. The future run
// executor calls this and threads the result into `PlannerRunContext`.

import type pg from "pg";
import { migrateOrgConfig, type OrgDefaultCredentials } from "../config/orgConfig.js";
import type { ProjectConfigV1 } from "../config/projectConfig.js";

type OrgConfigClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Which run-critical credential kinds the resolver covers. */
export type RunCredentialKind = "codex_chatgpt_auth" | "github_token";

/** The resolved refs a run needs. Both are guaranteed non-empty on success. */
export interface ResolvedRunCredentials {
  codexCredentialRef: string;
  githubCredentialRef: string;
}

/** Per-kind explicit overrides (e.g. acceptance scripts / re-run with a pin). */
export interface RunCredentialOverride {
  codexCredentialRef?: string;
  githubCredentialRef?: string;
}

export interface ResolveCredentialsInput {
  /** The project's typed config (already migrated to V1). */
  projectConfig: Pick<ProjectConfigV1, "credentials">;
  /** Org id whose `config.defaultCredentials` provides the fallback layer. */
  orgId: string;
  /** Highest-priority refs; wins over project config + org default. */
  override?: RunCredentialOverride;
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
      kind === "codex_chatgpt_auth"
        ? "No Codex credential resolved for this run (project config and org default are both unset)"
        : "No GitHub credential resolved for this run (project config and org default are both unset)"
    );
    this.name = "MissingCredentialError";
    this.kind = kind;
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
  input: ResolveCredentialsInput
): Promise<ResolvedRunCredentials> {
  const orgDefaults = await loadOrgDefaultCredentials(pool, input.orgId);
  const projectCredentials = input.projectConfig.credentials ?? {};

  const codexCredentialRef = pickRef(
    "codex_chatgpt_auth",
    input.override?.codexCredentialRef,
    projectCredentials.codexCredentialRef,
    orgDefaults?.codex_chatgpt_auth
  );
  const githubCredentialRef = pickRef(
    "github_token",
    input.override?.githubCredentialRef,
    projectCredentials.githubCredentialRef,
    orgDefaults?.github_token
  );

  return { codexCredentialRef, githubCredentialRef };
}

/** First non-empty layer wins; otherwise the kind is unresolved. */
function pickRef(
  kind: RunCredentialKind,
  ...layers: Array<string | undefined>
): string {
  for (const layer of layers) {
    if (typeof layer === "string" && layer.trim() !== "") {
      return layer;
    }
  }
  throw new MissingCredentialError(kind);
}

/**
 * Read + validate the org's default credential refs. Returns `undefined` when
 * the org row is missing or carries no `defaultCredentials`. The org row is
 * normalized through `migrateOrgConfig` so a legacy `{}` config resolves to no
 * defaults rather than throwing.
 */
async function loadOrgDefaultCredentials(
  pool: OrgConfigClient,
  orgId: string
): Promise<OrgDefaultCredentials | undefined> {
  const result = await pool.query<{ config: unknown }>(
    "SELECT config FROM organizations WHERE id = $1",
    [orgId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return migrateOrgConfig(row.config).defaultCredentials;
}

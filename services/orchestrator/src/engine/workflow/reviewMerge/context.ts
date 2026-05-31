// P3-0008: shared run-context loading for the review + merge stages. Both
// stages need the same run row (PR URL, project config → mergeIntegration,
// org App installation). Kept in one place so reviewPolling.ts and
// mergeDispatch.ts stay focused and under the 500-line cap.

import type pg from "pg";
import { z } from "zod";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../../config/orgConfig.js";
import { migrateProjectConfig } from "../../config/projectConfig.js";
import type { GovernancePosture, MergeIntegration, ReviewPolicy } from "../../config/shared.js";
import { validateGithubCredentialRef } from "../../credentials/githubToken.js";

export type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * P3-0023: the conventional login Tanren's own pushes carry when no org App is
 * installed. The GitHub App bot login is `<app-slug>[bot]`; absent a configured
 * slug we fall back to this so external-change detection still has a Tanren
 * identity to compare against.
 */
export const DEFAULT_TANREN_LOGIN = "tanren[bot]";

export interface ReviewMergeRunContext {
  runId: string;
  specId: string;
  projectId: string;
  prUrl: string;
  /** The PR's base branch (project default), for conflict-event payloads. */
  baseBranch: string;
  /** Resolved per-repo merge integration (project config). */
  mergeIntegration: MergeIntegration;
  /** P3-0023: external-push governance posture (project config). */
  governancePosture: GovernancePosture;
  /**
   * Whether the review stage requires a human verdict before merge (project
   * config). `auto` short-circuits the review poll to an approved verdict;
   * `human` (the default) preserves the GitHub-polling behavior.
   */
  reviewPolicy: ReviewPolicy;
  /**
   * P3-0023: GitHub logins that represent Tanren's own pushes on this repo.
   * External-change detection treats any other contributor as non-Tanren. The
   * App bot login when an App is installed, plus the default bot login.
   */
  tanrenLogins: ReadonlyArray<string>;
  /** App installation, when the org has installed the App (preferred token). */
  installation?: OrgGithubAppInstallation;
  /** Static GitHub credential ref (fallback when no App is installed). */
  staticCredentialRef?: string;
}

export class ReviewMergeRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found for review/merge: ${runId}`);
  }
}

export class ReviewMergePullRequestNotFoundError extends Error {
  constructor(runId: string) {
    super(`run has no pull request URL for review/merge: ${runId}`);
  }
}

/**
 * Options for {@link loadReviewMergeRunContext}.
 *
 * `resolvedGithubCredentialRef` is the GitHub credential ref the run already
 * resolved for the PR-creation + CI-poll steps (`resolveCredentialsForRun` →
 * project RECORD `githubCredentialRef` → org default). The review/merge stage
 * MUST resolve its token from the SAME source as those steps, so the run path
 * threads this in. When present it wins over the project-config-JSONB lookup;
 * absent (e.g. an out-of-band caller with no pre-resolved ref) it falls back to
 * the config-JSONB ref. `projects link --github-credential-ref` writes the
 * project RECORD column, NOT the config JSONB, so the JSONB-only path returned
 * undefined and the resolver fell back to a (removed) static default ref.
 */
export interface LoadReviewMergeRunContextOptions {
  resolvedGithubCredentialRef?: string;
}

/**
 * Build the context options from a stage input that carries an optional
 * `resolvedGithubCredentialRef`. Shared by the review + merge stages so the
 * exactOptionalPropertyTypes spread lives in one place.
 */
export function contextOptionsFor(input: { resolvedGithubCredentialRef?: string }): LoadReviewMergeRunContextOptions {
  return input.resolvedGithubCredentialRef === undefined
    ? {}
    : { resolvedGithubCredentialRef: input.resolvedGithubCredentialRef };
}

export async function loadReviewMergeRunContext(
  pool: RunStateClient,
  runId: string,
  options: LoadReviewMergeRunContextOptions = {},
): Promise<ReviewMergeRunContext> {
  const result = await pool.query(
    `SELECT r.run_id, r.spec_id, r.project_id, r.pr_url, p.config, p.default_branch, o.config AS org_config
     FROM runs r
     JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN organizations o ON o.id = p.org_id
     WHERE r.run_id = $1`,
    [runId],
  );
  const rawRow = result.rows[0];
  if (rawRow === undefined) {
    throw new ReviewMergeRunNotFoundError(runId);
  }
  const row = ReviewMergeRunRow.parse(rawRow);
  if (row.pr_url === null) {
    throw new ReviewMergePullRequestNotFoundError(runId);
  }
  const projectConfig = migrateProjectConfig(row.config);
  const installation = installationFromOrgConfig(row.org_config);
  const staticCredentialRef = resolvedStaticCredentialRef(options.resolvedGithubCredentialRef, row.config);
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    prUrl: row.pr_url,
    baseBranch: row.default_branch ?? "main",
    mergeIntegration: projectConfig.mergeIntegration,
    governancePosture: projectConfig.governancePosture,
    reviewPolicy: projectConfig.reviewPolicy,
    tanrenLogins: tanrenLoginsFor(installation),
    installation,
    ...(staticCredentialRef !== undefined && { staticCredentialRef }),
  };
}

/**
 * Pick the static GitHub credential ref the review/merge stage resolves its
 * token from. The run-resolved ref (the same one the PR-creation + CI-poll steps
 * used) wins; otherwise fall back to the project-config-JSONB ref for out-of-band
 * callers that did not pre-resolve.
 */
function resolvedStaticCredentialRef(resolvedRef: string | undefined, config: unknown): string | undefined {
  if (typeof resolvedRef === "string" && resolvedRef.trim() !== "") {
    return validateGithubCredentialRef(resolvedRef);
  }
  return credentialRefFromConfig(config);
}

/**
 * The logins Tanren's own pushes carry. Always includes the default bot login;
 * a GitHub App installation contributes `<app-slug>[bot]` when the slug is
 * derivable. The org App config carries only `appId`/`installationId`, so the
 * App bot login is added only when an installation is present (the bot pushes
 * under the App identity); the default login keeps detection working without
 * an App. De-duplication happens downstream in `tanrenIdentity`.
 */
function tanrenLoginsFor(installation: OrgGithubAppInstallation | undefined): ReadonlyArray<string> {
  if (installation === undefined) {
    return [DEFAULT_TANREN_LOGIN];
  }
  return [DEFAULT_TANREN_LOGIN, `app/${installation.appId}`];
}

function credentialRefFromConfig(config: unknown): string | undefined {
  const record =
    typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const credentials =
    typeof record["credentials"] === "object" && record["credentials"] !== null
      ? (record["credentials"] as Record<string, unknown>)
      : {};
  const ref = credentials["githubCredentialRef"] ?? record["githubCredentialRef"];
  return typeof ref === "string" ? validateGithubCredentialRef(ref) : undefined;
}

function installationFromOrgConfig(orgConfig: unknown): OrgGithubAppInstallation | undefined {
  if (orgConfig === null || orgConfig === undefined) {
    return undefined;
  }
  try {
    return migrateOrgConfig(orgConfig).github_app;
  } catch {
    return undefined;
  }
}

// Typed row decode (no raw `as` cast — the architecture check forbids those in
// workflow code; we parse the SQL row through a Zod schema instead).
const ReviewMergeRunRow = z.object({
  run_id: z.string(),
  spec_id: z.string(),
  project_id: z.string(),
  pr_url: z.string().nullable(),
  config: z.unknown(),
  default_branch: z.string().nullable(),
  org_config: z.unknown(),
});

// P3-0008: shared run-context loading for the review + merge stages. Both
// stages need the same run row (PR URL, project config → mergeIntegration,
// org App installation). Kept in one place so reviewPolling.ts and
// mergeDispatch.ts stay focused and under the 500-line cap.

import type pg from "pg";
import { z } from "zod";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../../config/orgConfig.js";
import { migrateProjectConfig } from "../../config/projectConfig.js";
import type { MergeIntegration } from "../../config/shared.js";
import { validateGithubCredentialRef } from "../../credentials/githubToken.js";

export type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface ReviewMergeRunContext {
  runId: string;
  specId: string;
  projectId: string;
  prUrl: string;
  /** The PR's base branch (project default), for conflict-event payloads. */
  baseBranch: string;
  /** Resolved per-repo merge integration (project config). */
  mergeIntegration: MergeIntegration;
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

export async function loadReviewMergeRunContext(
  pool: RunStateClient,
  runId: string
): Promise<ReviewMergeRunContext> {
  const result = await pool.query(
    `SELECT r.run_id, r.spec_id, r.project_id, r.pr_url, p.config, p.default_branch, o.config AS org_config
     FROM runs r
     JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN organizations o ON o.id = p.org_id
     WHERE r.run_id = $1`,
    [runId]
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
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    prUrl: row.pr_url,
    baseBranch: row.default_branch ?? "main",
    mergeIntegration: projectConfig.mergeIntegration,
    installation: installationFromOrgConfig(row.org_config),
    staticCredentialRef: credentialRefFromConfig(row.config)
  };
}

function credentialRefFromConfig(config: unknown): string | undefined {
  const record = typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const credentials = typeof record.credentials === "object" && record.credentials !== null ? (record.credentials as Record<string, unknown>) : {};
  const ref = credentials.githubCredentialRef ?? record.githubCredentialRef;
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
  org_config: z.unknown()
});

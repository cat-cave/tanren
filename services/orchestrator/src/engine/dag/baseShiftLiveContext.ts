// The run/spec/project/org context the LIVE base-shift seams clone + re-gate + resolve
// over (tanren-owns-the-engine.md §3 never-discard). A base shift is keyed by the
// dependent's EXISTING run id (never-discard — the same row), so this loader resolves
// EVERYTHING the live opener/re-gate/resolver need straight from that run: the repo URL,
// the dependent's OWN branch (the branch that is rebased in place — never a fresh clone),
// the merge-time credentials + App installation, the governance posture + runner image,
// and the spec intent + effective routing (so the resolver's conflict Answerer +
// checker/auditor reason from the project's per-role data). Mirrors the drive-path
// `loadDriveRunContext` (driveConflictResolve.ts) — the SAME runs⋈specs⋈projects⋈orgs
// join, system-scoped (the cross-org bootstrap), with the credential resolution org-scoped
// on top. FAIL-CLOSED: a missing run is a LOUD throw (the coordinator maps it to a hold —
// the work survives, never silently discarded).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { installationFromOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import {
  CANONICAL_RUNNER_IMAGE,
  type GovernancePosture,
  type RoutingChainEntry,
  type RoutingTable,
} from "../config/shared.js";
import { orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { SpecMode } from "../state/spec.js";
import { buildEffectiveRouting } from "../worker/runExecutionContext.js";

/** The terminal runner image a live base-shift rebase allocates against when none is set. */
const DEFAULT_BASE_SHIFT_RUNNER_IMAGE = CANONICAL_RUNNER_IMAGE;

/** The resolved facts a base shift on the dependent's EXISTING run clones + re-gates over. */
export interface BaseShiftRunContext {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  repoUrl: string;
  /** The dependent's OWN branch (rebased in place — never regenerated). */
  headBranch: string;
  /** The project default branch (the non-speculative rebase target). */
  defaultBranch: string;
  runnerImage: string;
  governancePosture: GovernancePosture;
  installation?: OrgGithubAppInstallation;
  /** The merge-time GitHub credential ref (App-first / static fallback clone+push token). */
  githubCredentialRef: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  /**
   * Task #86: spec writer-prompt MODE (`specialize_seed` for the foundation specs;
   * `from_scratch` otherwise). Threaded into the live base-shift conflict resolver so
   * the re-gate's checker + auditor see the seeded-mode tail block on `specialize_seed`
   * specs (the same agreement the in-loop stages honor).
   */
  specMode: SpecMode;
  routing: RoutingTable;
  defaultLlm: RoutingChainEntry;
  endpointBaseUrl?: string;
}

/**
 * Resolve the {@link BaseShiftRunContext} for a dependent run. The
 * runs⋈specs⋈projects⋈organizations join is the cross-org bootstrap, so it is
 * system-scoped; the credential resolution is org-scoped on top (RLS admits the
 * `organizations` row). FAIL-CLOSED: a run that does not resolve is a LOUD throw.
 */
export async function loadBaseShiftRunContext(pool: pg.Pool, runId: string): Promise<BaseShiftRunContext> {
  const row = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{
      org_id: string;
      project_id: string;
      spec_id: string;
      repo_url: string;
      default_branch: string | null;
      branch: string;
      runner_image: string | null;
      config: unknown;
      org_config: unknown;
      title: string;
      description: string;
      acceptance_criteria: unknown;
      mode: unknown;
    }>(
      `SELECT p.org_id, r.project_id, r.spec_id, p.repo_url, p.default_branch, r.branch,
              p.runner_image, p.config, o.config AS org_config, s.title, s.description,
              s.acceptance_criteria, s.mode
         FROM runs r
         JOIN specs s ON s.spec_id = r.spec_id
         JOIN projects p ON p.project_id = r.project_id
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE r.run_id = $1`,
      [runId],
    );
    return result.rows[0];
  });
  if (row === undefined) {
    throw new Error(`cannot resolve base-shift context: run ${runId} not found`);
  }
  const orgId = row.org_id;
  const projectConfig = migrateProjectConfig(row.config);
  // The credential resolution reads `organizations.config` (a tenant read) — run it
  // org-scoped so RLS admits the row (the same hop the drive resolver uses).
  const resolved = await runWithOrgScope(pool, orgId, (client) =>
    resolveCredentialsForRun(client, { projectConfig, orgScope: orgScopeFromRunOrgId(orgId) }),
  );
  const installation = installationFromOrgConfig(row.org_config);
  // Task #86: parse the spec's writer-prompt MODE off the joined `s.mode` column. The DB
  // CHECK is NOT NULL with default `from_scratch`; a fixture row missing the column safely
  // defaults to `from_scratch` (the legacy byte-shape).
  const specMode = SpecMode.safeParse(row.mode).success ? SpecMode.parse(row.mode) : "from_scratch";
  return {
    orgId,
    projectId: row.project_id,
    specId: row.spec_id,
    runId,
    repoUrl: row.repo_url,
    headBranch: row.branch,
    defaultBranch: row.default_branch ?? "main",
    runnerImage: row.runner_image ?? DEFAULT_BASE_SHIFT_RUNNER_IMAGE,
    governancePosture: projectConfig.governancePosture,
    ...(installation !== undefined && { installation }),
    githubCredentialRef: resolved.githubCredentialRef,
    specTitle: row.title,
    specDescription: row.description,
    acceptanceCriteria: toStringArray(row.acceptance_criteria),
    specMode,
    routing: buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm),
    defaultLlm: resolved.defaultLlm,
    ...(resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {}),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

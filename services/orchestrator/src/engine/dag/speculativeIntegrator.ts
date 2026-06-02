// The pg + VcsProvider-backed SpeculativeIntegrator (autonomy-engine.md §2c). It
// resolves — under the project's org scope (RLS) — the repo, the GitHub
// credential context, and each unmerged ancestor's PR/run branch, then drives
// `VcsProvider.buildIntegrationBranch` to assemble the ephemeral integration ref
// (`tanren/integ/<dependent>`) = `default_branch + each ancestor branch` merged in
// DAG order. It returns the integration branch (the dependent's dynamic base) or
// the ancestor-vs-ancestor conflict pair (which the walker routes to the P2b
// resolver). It NEVER touches `default_branch`; only the ephemeral ref is written.
//
// Resolution mirrors the draft-PR context load (publishDraftPullRequestForRun):
// repo + default_branch from the project, the App installation from the org, the
// static github credential ref from project/org config. The ancestor branch is the
// ancestor's latest run branch (= the PR head branch `draftPrBranchName` produces).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../contracts/speculativeIntegrator.js";
import type { IntegrationAncestor, VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";

/** The ephemeral integration branch ref a dependent's PR bases on. */
export function integrationBranchName(dependentSpecId: string): string {
  if (!/^spec_[A-Za-z0-9._-]+$/u.test(dependentSpecId)) {
    throw new Error(`unsafe dependent spec id for integration branch: ${dependentSpecId}`);
  }
  return `tanren/integ/${dependentSpecId}`;
}

interface IntegrationProjectRow {
  repo_url: string;
  default_branch: string;
  project_config: unknown;
  org_config: unknown;
  org_id: string | null;
}

interface AncestorBranchRow {
  spec_id: string;
  branch: string;
}

export interface PgSpeculativeIntegratorDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
}

export class PgSpeculativeIntegrator implements SpeculativeIntegrator {
  constructor(private readonly deps: PgSpeculativeIntegratorDeps) {}

  async buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome> {
    const integrationBranch = integrationBranchName(input.dependentSpecId);
    const orgId = await this.resolveProjectOrg(input.projectId);
    if (orgId === null) {
      throw new Error(`cannot build integration for ${input.dependentSpecId}: project ${input.projectId} has no org`);
    }

    const { project, ancestors } = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const projectRow = await this.loadProject(client, input.projectId);
      const ancestorRows = await this.loadAncestorBranches(client, input.unmergedAncestorSpecIds);
      return { project: projectRow, ancestors: ancestorRows };
    });

    // Order the ancestor branches in the caller's DAG order (the unmerged list is
    // already DAG-ordered); resolve each spec's branch, dropping none silently —
    // a missing ancestor branch is a hard error (we never integrate a phantom).
    const branchBySpec = new Map(ancestors.map((a) => [a.spec_id, a.branch] as const));
    const ordered: IntegrationAncestor[] = input.unmergedAncestorSpecIds.map((specId) => {
      const branch = branchBySpec.get(specId);
      if (branch === undefined) {
        throw new Error(`unmerged ancestor ${specId} has no run branch to integrate`);
      }
      return { specId, branch };
    });

    const installation = installationFromOrgConfig(project.org_config);
    // The integration push needs only the GitHub credential (App-first, static
    // fallback) — NOT the run's LLM credential. Resolve the static github ref
    // narrowly: project `credentials.githubCredentialRef` → org
    // `defaultCredentials.github_token`. With an App installation present the
    // static ref is optional (the provider mints an App token); with neither the
    // provider's resolveToken hard-throws (no silent fallback).
    const staticRef = resolveGithubStaticRef(project.project_config, project.org_config);
    const token = await this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });

    const result = await this.deps.vcsProvider.buildIntegrationBranch({
      repo: this.deps.vcsProvider.parseRepository(project.repo_url),
      token,
      baseBranch: project.default_branch,
      integrationBranch,
      ancestors: ordered,
    });

    return {
      outcome: result.outcome,
      integrationBranch: result.integrationBranch,
      ...(result.conflictBetween !== undefined && { conflictBetween: result.conflictBetween }),
      message: result.message,
    };
  }

  private async loadProject(client: pg.PoolClient, projectId: string): Promise<IntegrationProjectRow> {
    const result = await client.query<IntegrationProjectRow>(
      `SELECT p.repo_url, p.default_branch, p.config AS project_config, o.config AS org_config, p.org_id
         FROM projects p
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE p.project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`project ${projectId} not found for speculative integration`);
    }
    return row;
  }

  private async loadAncestorBranches(
    client: pg.PoolClient,
    specIds: ReadonlyArray<string>,
  ): Promise<AncestorBranchRow[]> {
    if (specIds.length === 0) return [];
    // The ancestor's latest run branch is its PR head branch. One row per spec.
    const result = await client.query<AncestorBranchRow>(
      `SELECT DISTINCT ON (r.spec_id) r.spec_id, r.branch
         FROM runs r
        WHERE r.spec_id = ANY($1::text[])
        ORDER BY r.spec_id, r.started_at DESC`,
      [[...specIds]],
    );
    return result.rows;
  }

  private async resolveProjectOrg(projectId: string): Promise<string | null> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}

/** Resolve the static GitHub credential ref: project credentials → org default. */
function resolveGithubStaticRef(projectConfig: unknown, orgConfig: unknown): string | undefined {
  try {
    const projectRef = migrateProjectConfig(projectConfig).credentials?.githubCredentialRef;
    if (projectRef !== undefined) return projectRef;
  } catch {
    // fall through to the org default
  }
  if (orgConfig === null || orgConfig === undefined) return undefined;
  try {
    return migrateOrgConfig(orgConfig).defaultCredentials?.github_token;
  } catch {
    return undefined;
  }
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

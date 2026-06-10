// The pg + VcsProvider-backed SpeculativeIntegrator (autonomy-engine.md §2c). It
// resolves — under the project's org scope (RLS) — the repo, the GitHub
// credential context, and each unmerged ancestor's PR/run branch, then drives
// `VcsProvider.buildIntegrationBranch` to assemble the ephemeral integration ref
// (`tanren/integ/<dependent>`) = `default_branch + each ancestor branch` merged in
// DAG order. It returns the integration branch (the dependent's dynamic base) or
// the ancestor-vs-ancestor conflict pair (which the walker routes to the conflict
// resolver). It NEVER touches `default_branch`; only the ephemeral ref is written.
//
// Resolution mirrors the draft-PR context load (publishDraftPullRequestForRun):
// repo + default_branch from the project, the App installation from the org, the
// static github credential ref from project/org config. The ancestor branch is the
// ancestor's latest run branch (= the PR head branch `draftPrBranchName` produces).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { installationFromOrgConfig, migrateOrgConfig } from "../config/orgConfig.js";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../contracts/speculativeIntegrator.js";
import type { IntegrationAncestor, VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { type AncestorStack, resolveDependentAncestorStack } from "./ancestorStack.js";

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

    // Resolve the project context + the ordered ancestor stack under ONE org scope
    // (RLS). The DAG-ordered, org-scoped stack resolution lives in the standalone
    // `resolveDependentAncestorStack` helper (walker-jj-local-integration-design.md
    // §7 PR-2) — this integrator delegates to it; the WS-A PR-3 bootstrap assembler
    // reuses the SAME helper.
    const { project, resolvedStack } = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const projectRow = await this.loadProject(client, input.projectId);
      const stack = await resolveDependentAncestorStack(client, input.unmergedAncestorSpecIds);
      return { project: projectRow, resolvedStack: stack };
    });

    const runIdBySpec = new Map(resolvedStack.map((a) => [a.specId, a.runId] as const));
    const ordered: IntegrationAncestor[] = resolvedStack.map(({ specId, branch }) => ({ specId, branch }));

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

    // WS-A PR-1: assemble the ORDERED ancestor stack (the dual-write source) — the
    // ordered ancestors zipped with their resolved run id + the build's per-ancestor
    // head sha. Empty on `conflict` (no integrated base was built).
    const ancestorStack: AncestorStack =
      result.outcome === "conflict"
        ? []
        : ordered.map(({ specId, branch }) => ({
            specId,
            runId: runIdBySpec.get(specId) ?? "",
            branch,
            headSha: result.ancestorHeadShas?.[specId] ?? "",
          }));

    return {
      outcome: result.outcome,
      integrationBranch: result.integrationBranch,
      ancestorHeadShas: result.ancestorHeadShas,
      ancestorStack,
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

/**
 * Resolve the static GitHub credential ref: project credentials → org default.
 *
 * FAIL-CLOSED on a CORRUPT project config (no_silent_fallbacks): a present-but-
 * unparseable `projects.config` is a corruption that must PROPAGATE, never be
 * silently swallowed into the org-default token — signing the integration push as
 * a DIFFERENT github identity than the project's bound credentials is a
 * wrong-identity fallback. Only an ABSENT project config (the `'{}'::jsonb` default
 * a fresh project carries; `isAbsentProjectConfig`) legitimately falls through to
 * the org default — there genuinely is no project-level credential ref to use.
 */
export function resolveGithubStaticRef(projectConfig: unknown, orgConfig: unknown): string | undefined {
  if (!isAbsentProjectConfig(projectConfig)) {
    // Present config: parse it. A throw here is genuine corruption — let it
    // propagate (loud, fail-closed). NEVER fall through to a different identity.
    const projectRef = migrateProjectConfig(projectConfig).credentials?.githubCredentialRef;
    if (projectRef !== undefined) return projectRef;
    // Parsed clean but no project-level githubCredentialRef bound → org default.
  }
  // Org default. No-silent-fallback contract: an ABSENT config resolves to
  // undefined ("no org default"), but a PRESENT-yet-UNPARSEABLE config is
  // corruption — `migrateOrgConfig` throws and that throw PROPAGATES (loud,
  // fail-closed), never swallowed to a silent undefined.
  if (orgConfig === null || orgConfig === undefined) return undefined;
  return migrateOrgConfig(orgConfig).defaultCredentials?.github_token;
}

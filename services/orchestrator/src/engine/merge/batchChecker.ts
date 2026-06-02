// The pg + VcsProvider-backed BatchChecker (autonomy-engine.md §2d — speculative
// batch-check). It assembles the PROSPECTIVE MERGED STATE for a batch of queued
// entries — `default_branch + each entry's PR branch` speculatively merged in DAG
// order onto an EPHEMERAL batch-integration ref (reuse the P2c-1
// `VcsProvider.buildIntegrationBranch`) — then runs the CI/gate against that ref
// (the `VcsProvider.readBranchChecks` seam + the EXACT `evaluateCiObservation`
// reducer the run loop uses). It NEVER touches `default_branch`; only the ephemeral
// `tanren/batch/<dependent>` ref is written + read.
//
// Resolution mirrors PgSpeculativeIntegrator: repo + default_branch from the project,
// the App installation from the org, the static github credential ref from
// project/org config, each entry's branch = its latest run branch (the PR head
// branch). The batch ref is named for the LAST (deepest) member's spec so it is a
// stable, safe ref per batch tail.
//
// A still-RUNNING integration CI is reported `pending` (NOT a failure): the
// coordinator HOLDS (it does not bisect a not-yet-terminal batch) and the next
// CI-completion notification re-triggers the pass. The integration ref's own
// build-conflict (two entries conflict with each other) is surfaced as `conflict`.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type BatchCheckVerdict, type BatchChecker } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { IntegrationAncestor, VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { evaluateCiObservation } from "../workflow/ciPolling.js";

/** The ephemeral batch-integration ref the prospective merged state is built on. */
export function batchIntegrationBranchName(tailSpecId: string): string {
  if (!/^spec_[A-Za-z0-9._-]+$/u.test(tailSpecId)) {
    throw new Error(`unsafe spec id for batch integration branch: ${tailSpecId}`);
  }
  return `tanren/batch/${tailSpecId}`;
}

interface BatchProjectRow {
  repo_url: string;
  default_branch: string;
  project_config: unknown;
  org_config: unknown;
}

interface BatchBranchRow {
  spec_id: string;
  branch: string;
}

export interface PgBatchCheckerDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
}

export class PgBatchChecker implements BatchChecker {
  constructor(private readonly deps: PgBatchCheckerDeps) {}

  async checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict> {
    // An empty entry set checks the base (`default_branch`) alone — which passes (the
    // base is green) — the bisect's lower-bound invariant, no integration needed.
    if (input.entries.length === 0) {
      return { result: "pass", integrationBranch: "" };
    }

    const tailSpecId = input.entries.at(-1)?.specId;
    if (tailSpecId === undefined) {
      return { result: "pass", integrationBranch: "" };
    }
    const integrationBranch = batchIntegrationBranchName(tailSpecId);

    const orgId = await this.resolveProjectOrg(input.projectId);
    if (orgId === null) {
      throw new Error(`cannot batch-check ${input.projectId}: project has no org`);
    }

    const { project, branches } = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const projectRow = await this.loadProject(client, input.projectId);
      const branchRows = await this.loadEntryBranches(
        client,
        input.entries.map((e) => e.specId),
      );
      return { project: projectRow, branches: branchRows };
    });

    // Order the entries' branches in the caller's DAG order — a missing branch is a
    // hard error (we never integrate a phantom). This is the prospective merge order.
    const branchBySpec = new Map(branches.map((b) => [b.spec_id, b.branch] as const));
    const ordered: IntegrationAncestor[] = input.entries.map((entry) => {
      const branch = branchBySpec.get(entry.specId);
      if (branch === undefined) {
        throw new Error(`batch entry ${entry.specId} has no run branch to integrate`);
      }
      return { specId: entry.specId, branch };
    });

    const installation = installationFromOrgConfig(project.org_config);
    const staticRef = resolveGithubStaticRef(project.project_config, project.org_config);
    const token = await this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
    const repo = this.deps.vcsProvider.parseRepository(project.repo_url);

    // 1. Build the prospective merged state on the ephemeral batch ref (NEVER main).
    const integration = await this.deps.vcsProvider.buildIntegrationBranch({
      repo,
      token,
      baseBranch: project.default_branch,
      integrationBranch,
      ancestors: ordered,
    });
    if (integration.outcome === "conflict") {
      return {
        result: "conflict",
        message: integration.message,
        ...(integration.conflictBetween !== undefined && { conflictBetween: integration.conflictBetween }),
      };
    }

    // 2. Run the CI/gate against the prospective merged tree (the integration ref).
    const checks = await this.deps.vcsProvider.readBranchChecks({ repo, branch: integrationBranch, token });
    const observation = evaluateCiObservation(checks);
    if (observation.status === "passed") {
      return { result: "pass", integrationBranch };
    }
    if (observation.status === "failed") {
      return { result: "fail", message: `batch CI failed (${observation.reason}) on ${integrationBranch}` };
    }
    // Still running — NOT a failure: hold (the coordinator re-checks on CI completion).
    return { result: "pending", message: `batch CI pending (${observation.reason}) on ${integrationBranch}` };
  }

  private async loadProject(client: pg.PoolClient, projectId: string): Promise<BatchProjectRow> {
    const result = await client.query<BatchProjectRow>(
      `SELECT p.repo_url, p.default_branch, p.config AS project_config, o.config AS org_config
         FROM projects p
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE p.project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`project ${projectId} not found for batch check`);
    }
    return row;
  }

  private async loadEntryBranches(client: pg.PoolClient, specIds: ReadonlyArray<string>): Promise<BatchBranchRow[]> {
    if (specIds.length === 0) return [];
    const result = await client.query<BatchBranchRow>(
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

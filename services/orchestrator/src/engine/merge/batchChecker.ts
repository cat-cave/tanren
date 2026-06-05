// The pg + native-gate-backed BatchChecker (autonomy-engine.md §2d — speculative
// batch-check; the no-Actions delivery model). It assembles the PROSPECTIVE MERGED
// STATE for a batch of queued entries — `default_branch + each entry's PR branch`
// speculatively merged in DAG order onto an EPHEMERAL batch-integration ref (reuse
// the `VcsProvider.buildIntegrationBranch`) — then runs the NATIVE GATE against
// that ref: a fresh short-lived runner clones the integration ref, installs deps, and
// runs the repo's `pre_merge` gate tiers over SSH (exit codes only). There is NO forge
// check-run poll — the verdict is Tanren's own gate. It NEVER touches `default_branch`;
// only the ephemeral `tanren/batch/<dependent>` ref is written + gated.
//
// Resolution mirrors PgSpeculativeIntegrator: repo + default_branch from the project,
// the App installation from the org, the static github credential ref from
// project/org config, each entry's branch = its latest run branch (the PR head
// branch). The batch ref is named for the LAST (deepest) member's spec so it is a
// stable, safe ref per batch tail.
//
// Because the native gate is SYNCHRONOUS (it runs to a pass/fail verdict on the
// runner — there is no async forge CI to wait on), there is NO "pending" / no-checks
// settle: the gate either passes (merge the batch) or fails (a bad interaction). The
// integration ref's own build-conflict (two entries conflict with each other) is
// surfaced as `conflict`; a runner/clone/bootstrap fault is `infra-error` (a retriable
// HOLD — never a PR's fault, never a bisect).

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type BatchCheckVerdict, type BatchChecker } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { installationFromOrgConfig, migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { GovernancePosture } from "../config/shared.js";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { IntegrationAncestor, VcsProvider } from "../contracts/vcsProvider.js";
import { orgScopingPool } from "../data/orgScopedDb.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { PgEventStore } from "../eventStore.js";
import { runFreshRunnerMergeGate } from "./freshRunnerGate.js";

/** The terminal runner image a batch re-gate allocates against when the project sets none. */
const DEFAULT_BATCH_RUNNER_IMAGE = "ghcr.io/tanren/runner:latest";

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
  runner_image: string | null;
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
  /** The runner allocator the native batch gate provisions a short-lived runner from. */
  allocator: Allocator;
  /** The SSH substrate the native batch gate clones + gates over. */
  ssh: CommandSubstrate;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
  githubAppMinter?: GithubAppTokenMinter;
  runStateWriter?: RunStateWriter;
  timeoutMs: number;
}

export class PgBatchChecker implements BatchChecker {
  constructor(private readonly deps: PgBatchCheckerDeps) {}

  async checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict> {
    // An empty entry set checks the base (`default_branch`) alone — which passes (the
    // base is green) — the bisect's lower-bound invariant, no integration needed.
    if (input.entries.length === 0) {
      return { result: "pass", integrationBranch: "" };
    }

    // The batch HEAD entry: the tail (deepest) member's queue row — the SAME row the
    // integration ref is keyed on (and the run-id handle the native gate correlates to).
    const headEntry = input.entries.at(-1);
    if (headEntry === undefined) {
      return { result: "pass", integrationBranch: "" };
    }
    const tailSpecId = headEntry.specId;
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

    // The ephemeral `tanren/batch/<tail>` ref is EPHEMERAL per check: build it,
    // gate it, then ALWAYS tear it down (pass / fail / conflict / infra-error) so a
    // retry or the next batch starts from a clean ref instead of a stale leftover.
    // `buildIntegrationBranch`'s `resetRef` IS idempotent (create→force-PATCH), so a
    // leftover ref no longer 422-bricks — but leaving it around accumulates dead refs
    // and re-points the next build off a stale tail; the teardown keeps it clean.
    try {
      // 1. Build the prospective merged state on the ephemeral batch ref (NEVER main).
      const integration = await this.deps.vcsProvider.buildIntegrationBranch({
        repo,
        token,
        baseBranch: project.default_branch,
        integrationBranch,
        ancestors: ordered,
      });
      if (integration.outcome === "conflict") {
        // Distinguish a SPEC-vs-SPEC conflict (two queued entries clash) from a single PR
        // dirty against the BASE. `buildIntegrationBranch` sets `otherSpecId = merged.at(-1)
        // ?? baseBranch`, so a first-merge-onto-base conflict yields `otherSpecId ===
        // default_branch` — that is a base conflict, which the coordinator drives through
        // the real per-run resolver rather than bisecting/dequeuing it. (Preserved from #322.)
        const conflictsWithBase = integration.conflictBetween?.otherSpecId === project.default_branch;
        return {
          result: "conflict",
          message: integration.message,
          conflictsWithBase,
          ...(integration.conflictBetween !== undefined && { conflictBetween: integration.conflictBetween }),
        };
      }

      // 2. Run the NATIVE gate against the prospective merged tree (the integration ref):
      // a fresh runner clones the ref, installs deps, runs the `pre_merge` gate. The gate
      // is synchronous → a definitive pass/fail (no async forge CI, no no-checks settle).
      // A runner/clone/bootstrap fault is an INFRA error (a retriable hold, never a bisect).
      try {
        // The gate's `gate.*` event INSERTs are tenant writes, so run the whole gate
        // under the project's ambient org scope (each event opens its own short
        // org-scoped txn — runWithJobOrgId, NOT a held txn across the SSH ops).
        const { outcome } = await runWithJobOrgId(orgId, () =>
          runFreshRunnerMergeGate(
            {
              allocator: this.deps.allocator,
              ssh: this.deps.ssh,
              secrets: this.deps.secrets,
              vcsProvider: this.deps.vcsProvider,
              ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
              eventStore: this.deps.runStateWriter ?? new PgEventStore(orgScopingPool(this.deps.pool)),
              identitySecretRef: this.deps.identitySecretRef,
              timeoutMs: this.deps.timeoutMs,
            },
            {
              repoUrl: project.repo_url,
              ref: integrationBranch,
              runnerImage: project.runner_image ?? DEFAULT_BATCH_RUNNER_IMAGE,
              governancePosture: resolveGovernancePosture(project.project_config),
              ...(installation !== undefined && { installation }),
              githubCredentialRef: staticRef ?? "",
              orgId,
              projectId: input.projectId,
              // A synthetic `run_`-prefixed handle for runner/workspace naming + event
              // correlation (the batch has no single run). Sanitized to the safe charset.
              runId: `run_batch_${tailSpecId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`,
              specId: tailSpecId,
            },
          ),
        );
        if (outcome.passed) {
          return { result: "pass", integrationBranch };
        }
        return {
          result: "fail",
          message: `batch gate failed on ${integrationBranch}: tier ${outcome.failure.tier} step ${outcome.failure.failedStep}`,
        };
      } catch (error) {
        // The gate could not be RUN (allocate/clone/bootstrap fault) — NOT a verdict. The
        // coordinator must never blame/bisect a PR for this: hold + bounded-retry the batch.
        return {
          result: "infra-error",
          message: `batch gate could not run on ${integrationBranch}: ${error instanceof Error ? error.message : String(error)}`,
          retriable: true,
        };
      }
    } finally {
      // Tear down the ephemeral batch ref (idempotent: deleteBranch swallows 404/422 of
      // an already-gone ref). Best-effort — a teardown hiccup must never overwrite the
      // verdict (resetRef force-updates a leftover anyway), so it is caught + logged.
      await this.deps.vcsProvider.deleteBranch(repo, integrationBranch, token).catch((error: unknown) => {
        console.warn(
          `[merge] batch ref teardown of ${integrationBranch} failed (non-fatal; next build force-resets it):`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  }

  private async loadProject(client: pg.PoolClient, projectId: string): Promise<BatchProjectRow> {
    const result = await client.query<BatchProjectRow>(
      `SELECT p.repo_url, p.default_branch, p.runner_image, p.config AS project_config, o.config AS org_config
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

/** Resolve the project's governance posture from `projects.config` (default `strict`). */
function resolveGovernancePosture(projectConfig: unknown): GovernancePosture {
  try {
    return migrateProjectConfig(projectConfig).governancePosture;
  } catch {
    return "strict";
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

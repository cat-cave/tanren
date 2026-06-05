// The merge-coordinator drive-pass NATIVE re-gate (the no-Actions delivery model).
// When the coordinator drives a queued run's merge and auto-rebase rewrites the branch,
// the prior verdict is stale — so the merge stage re-gates the PR head BEFORE merging.
// At drive time the run's original runner is GONE, so this re-gate PROVISIONS A FRESH
// runner, clones the PR head branch, installs deps, and runs the repo's `pre_merge`
// gate over SSH (the native merge authority — NO forge check-run poll). A passing
// gate is `passed`; a failing/errored gate holds the merge (an unverified rebase
// never merges). The verdict is published to the forge as a `tanren/gate` check-run.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GovernancePosture } from "../config/shared.js";
import { installationFromOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { PgEventStore, type EventStore } from "../eventStore.js";
import { publishGateVerdict } from "../workflow/gate/index.js";
import { runFreshRunnerMergeGate } from "./freshRunnerGate.js";
import type { ReGateCiHook } from "../workflow/reviewMerge/index.js";

/** The terminal runner image a fresh-runner re-gate allocates against when the project sets none. */
const DEFAULT_RE_GATE_RUNNER_IMAGE = "ghcr.io/tanren/runner:latest";

export interface BuildReGateCiForQueuedRunDeps {
  pool: pg.Pool;
  /** The org-scoping pool the re-gate's runner allocation + events self-route through. */
  scopedPool: pg.Pool;
  eventStore?: EventStore;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** The runner allocator the re-gate provisions a short-lived runner from. */
  allocator: Allocator;
  /** The SSH substrate the re-gate clones + gates over. */
  ssh: CommandSubstrate;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  githubCredentialRef: string;
  githubAppMinter?: GithubAppTokenMinter;
  timeoutMs: number;
}

/** The repo + ref + posture context a queued-run re-gate clones and gates. */
interface ReGateRunContext {
  repoUrl: string;
  headBranch: string;
  runnerImage: string;
  governancePosture: GovernancePosture;
  installation?: OrgGithubAppInstallation;
}

/**
 * Build the drive-pass native re-gate hook: provision a fresh runner, clone the
 * queued run's PR head branch, install deps, and run the `pre_merge` gate. A passing
 * gate is `passed`; a failing gate is `failed`; an unexpected throw holds the merge
 * (`pending`) rather than merging an unverified ref. The verdict is published.
 */
export function buildReGateCiForQueuedRun(deps: BuildReGateCiForQueuedRunDeps): ReGateCiHook {
  return async () => {
    const ctx = await loadReGateRunContext(deps);
    const eventStore = deps.eventStore ?? new PgEventStore(deps.scopedPool);
    try {
      const { outcome, headSha } = await runFreshRunnerMergeGate(
        {
          allocator: deps.allocator,
          ssh: deps.ssh,
          secrets: deps.secrets,
          vcsProvider: deps.vcsProvider,
          ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
          eventStore,
          identitySecretRef: deps.identitySecretRef,
          timeoutMs: deps.timeoutMs,
        },
        {
          repoUrl: ctx.repoUrl,
          ref: ctx.headBranch,
          runnerImage: ctx.runnerImage,
          governancePosture: ctx.governancePosture,
          ...(ctx.installation !== undefined && { installation: ctx.installation }),
          githubCredentialRef: deps.githubCredentialRef,
          orgId: deps.orgId,
          projectId: deps.projectId,
          runId: deps.runId,
          specId: deps.specId,
        },
      );
      await publishReGateVerdict(deps, ctx, headSha, outcome.passed);
      return { status: outcome.passed ? "passed" : "failed" };
    } catch (error) {
      // An infra error during the re-gate (allocate/clone/bootstrap) is NOT a verdict —
      // hold the merge (recoverable) rather than merging an unverified ref or failing it.
      console.error(`[merge] native re-gate of run ${deps.runId} errored; holding the merge:`, error);
      return { status: "pending" };
    }
  };
}

/** Publish the native re-gate verdict to the forge against the re-gated head sha. */
async function publishReGateVerdict(
  deps: BuildReGateCiForQueuedRunDeps,
  ctx: ReGateRunContext,
  headSha: string,
  passed: boolean,
): Promise<void> {
  const staticRef = deps.githubCredentialRef;
  if (ctx.installation === undefined && staticRef.trim() === "") {
    return;
  }
  const token = await deps.vcsProvider.resolveToken({
    secrets: deps.secrets,
    ...(ctx.installation !== undefined && { installation: ctx.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
  });
  await publishGateVerdict({
    vcsProvider: deps.vcsProvider,
    repo: deps.vcsProvider.parseRepository(ctx.repoUrl),
    token,
    headSha,
    outcome: passed ? { passed: true, results: [] } : { passed: false, results: [], failure: RE_GATE_FAILURE },
  });
}

/** A synthetic failure outcome for the published verdict when the re-gate failed (detail is on the events). */
const RE_GATE_FAILURE = {
  passed: false as const,
  tier: "pre_merge",
  when: "pre_merge" as const,
  failedStep: "gate",
  exitCode: 1,
  steps: [],
};

/**
 * Resolve the repo URL, PR head branch, runner image, governance posture, and org App
 * installation for the queued run — the context the fresh-runner re-gate clones + gates.
 * The runs⋈projects⋈organizations join is a cross-org bootstrap read, so it is
 * system-scoped (mirrors loadDriveRunContext in driveConflictResolve).
 */
async function loadReGateRunContext(deps: BuildReGateCiForQueuedRunDeps): Promise<ReGateRunContext> {
  const row = await runWithSystemScope(deps.pool, async (client) => {
    const result = await client.query<{
      repo_url: string;
      branch: string;
      runner_image: string | null;
      config: unknown;
      org_config: unknown;
    }>(
      `SELECT p.repo_url, r.branch, p.runner_image, p.config, o.config AS org_config
         FROM runs r
         JOIN projects p ON p.project_id = r.project_id
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE r.run_id = $1`,
      [deps.runId],
    );
    return result.rows[0];
  });
  if (row === undefined) {
    throw new Error(`cannot resolve re-gate context: run ${deps.runId} not found`);
  }
  const installation = installationFromOrgConfig(row.org_config);
  return {
    repoUrl: row.repo_url,
    headBranch: row.branch,
    runnerImage: row.runner_image ?? DEFAULT_RE_GATE_RUNNER_IMAGE,
    governancePosture: migrateProjectConfig(row.config).governancePosture,
    ...(installation !== undefined && { installation }),
  };
}

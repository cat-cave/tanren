// The pg + native-gate-backed BatchChecker (autonomy-engine.md §2d — speculative
// batch-check; the no-Actions delivery model; tanren-owns-the-engine.md §3 — the one
// unified `integration_nodes` run model). It assembles the PROSPECTIVE MERGED STATE
// for a batch of queued entries — `default_branch + each entry's PR branch` integrated
// in DAG order — LOCALLY over jj (no server-side host ref), UPSERTs the integration
// node, then PROOF-REUSES or runs the NATIVE GATE against the assembled state: a fresh
// short-lived runner installs deps and runs the repo's `pre_merge` gate tiers over SSH
// (exit codes only). There is NO forge check-run poll — the verdict is Tanren's own
// gate. It NEVER touches `default_branch`.
//
// Resolution: repo + default_branch from the project, the App installation from the
// org, the static github credential ref from project/org config, each entry's branch =
// its queued run branch (the PR head branch). The integration ref name is keyed on the
// LAST (deepest) member's spec so it is a stable, safe ref per batch tail.
//
// Because the native gate is SYNCHRONOUS (it runs to a pass/fail verdict on the
// runner — there is no async forge CI to wait on), there is NO "pending" / no-checks
// settle: the gate either passes (merge the batch) or fails (a bad interaction). A
// build-conflict (two entries conflict with each other) is surfaced as `conflict`; a
// runner/clone/bootstrap fault is `infra-error` (a retriable HOLD — never a PR's
// fault, never a bisect).

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type BatchCheckVerdict, type BatchChecker } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { bindOrgGithubCredentialRefs, migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import {
  bindProjectGithubCredentialRefs,
  isAbsentProjectConfig,
  migrateProjectConfig,
} from "../config/projectConfig.js";
import { CANONICAL_RUNNER_IMAGE, type GovernancePosture } from "../config/shared.js";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { IntegrationAncestor, RepoRef, ResolvedVcsToken } from "../contracts/codeHostTypes.js";
import type { CodeHost } from "../contracts/codeHost.js";
import { GitHubCodeHost, parseGitHubRepository } from "../providers/githubCodeHost.js";
import type { GitHubHttpClient, GithubAppTokenMinter } from "../providers/github.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import { PgIntegrationNodeModel } from "../dag/integrationNodesPg.js";
import { batchFragmentEvidenceWiring, driveBatchThroughNode } from "./batchIntegrationNodeDrive.js";
import { batchNodeGate, batchNodeResolveConfig, batchProofUnitGraph } from "./batchNodeGate.js";
import { createLogger } from "../observability/logger.js";
import { buildCoverageAuthorityReadyNodeMaterializer } from "../runtimeVerification/coverageAuthorityMaterializer.js";
import { activeQuarantineVersion, loadActiveQuarantine, quarantineEnv } from "../workflow/ciQuarantine.js";

const log = createLogger("merge");

/** The terminal runner image a batch re-gate allocates against when the project sets none. */
const DEFAULT_BATCH_RUNNER_IMAGE = CANONICAL_RUNNER_IMAGE;

/** The integration ref name the assembled prospective merged state is keyed on. */
function batchIntegrationBranchName(tailSpecId: string): string {
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
  run_id: string;
  spec_id: string;
  branch: string;
}

export interface PgBatchCheckerDeps {
  pool: pg.Pool;
  /** The shared (timed) GitHub HTTP client the batch CodeHost + token reads build over. */
  githubHttp: GitHubHttpClient;
  secrets: SecretStore;
  /** The runner allocator the native batch gate provisions a short-lived runner from. */
  allocator: Allocator;
  /** The SSH substrate the native batch gate clones + gates over. */
  ssh: CommandSubstrate;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
  githubAppMinter?: GithubAppTokenMinter;
  runStateWriter: RunStateWriter;
  /**
   * ds-6 pre_merge seam (injected so this file stays under the runtime-import cap): after a
   * passing jj-local integration, bind the composed design system's eager render matrix to
   * the just-integrated node (immutable design proof-units, keyed by the frozen six-input
   * design proof key). ADVISORY — a project with no design system is a clean no-op; any
   * failure is isolated so it never perturbs the native gate verdict. Wired by
   * `buildBatchMergeCoordinator`; absent in unit fixtures (no-op).
   */
  bindDesignDelivery?: (input: {
    orgId: string;
    projectId: string;
    integrationNodeId: string;
    runId: string;
  }) => Promise<void>;
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

    const { project, branches, quarantine } = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const projectRow = await this.loadProject(client, input.projectId);
      const branchRows = await this.loadEntryBranches(
        client,
        input.entries.map((e) => e.runId),
      );
      const activeQuarantine = await loadActiveQuarantine(client, input.projectId);
      return { project: projectRow, branches: branchRows, quarantine: activeQuarantine };
    });

    // Order the entries' branches in the caller's DAG order — a missing branch is a
    // hard error (we never integrate a phantom). This is the prospective merge order.
    const branchByRun = new Map(branches.map((b) => [b.run_id, b.branch] as const));
    const ordered: Array<IntegrationAncestor & { readonly runId: string }> = input.entries.map((entry) => {
      const branch = branchByRun.get(entry.runId);
      if (branch === undefined) {
        throw new Error(`batch entry ${entry.specId} run ${entry.runId} has no run branch to integrate`);
      }
      return { specId: entry.specId, runId: entry.runId, branch };
    });

    const orgConfig =
      project.org_config === null || project.org_config === undefined
        ? undefined
        : bindOrgGithubCredentialRefs(migrateOrgConfig(project.org_config), orgId);
    const installation = orgConfig?.github_app;
    const staticRef = resolveGithubStaticRef(project.project_config, project.org_config, orgId);
    const token = await resolveVcsToken(this.deps.githubHttp, {
      secrets: this.deps.secrets,
      orgId,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
    const repo = parseGitHubRepository(project.repo_url);
    // The host-neutral `CodeHost` the head-sha read routes through (decomposition PR-6):
    // built over the SAME GitHub HTTP client the run's provider holds + a supplier of the
    // token already resolved above (one resolve per check). `fetchRef` ≡ the old
    // `readBranchHeadSha`.
    //
    // §5h SEVER (decomposition PR-7): the old per-entry `readMergeability` `mergeable_state`
    // "dirty" pre-screen is GONE. The host never DECIDES conflict — the jj INTEGRATION-NODE
    // DRIVE below assembles the prospective merged state locally over jj and surfaces a real
    // base-conflict as a `conflict` verdict (with `conflictsWithBase` + `conflictBetween`),
    // the authoritative conflict signal. A `mergeable_state` pre-check would both re-leak the
    // forge coupling AND double-judge a decision jj now owns.
    const codeHost = this.buildCodeHost(token);

    // §3 INTEGRATION-NODE DRIVE: assemble the prospective merged state LOCALLY over jj (no
    // host ref), UPSERT the node, and PROOF-REUSE the gate verdict (skip the re-gate on a
    // recorded passing proof). Fail-closed: a stale reuse can NEVER merge unproven code
    // (the six-component key guard).
    return await this.driveThroughIntegrationNode({
      orgId,
      projectId: input.projectId,
      project,
      ordered,
      installation,
      staticRef,
      repo,
      token,
      codeHost,
      tailSpecId,
      integrationRef: integrationBranch,
      quarantine,
    });
  }

  /**
   * §3 INTEGRATION-NODE DRIVE: assemble the prospective merged state LOCALLY over jj (no
   * `tanren/batch` host ref), UPSERT the node, and PROOF-REUSE the gate verdict. The
   * member head SHAs are read inside the jj integration (captured at integration time —
   * the divergence key the memberKey hashes); the baseSha is the default branch head AT
   * check time (the node's base identity). Org-scoped: the node UPSERT/proof + the gate
   * events run under the project's org (`runWithJobOrgId`).
   */
  private async driveThroughIntegrationNode(args: {
    orgId: string;
    projectId: string;
    project: BatchProjectRow;
    ordered: ReadonlyArray<IntegrationAncestor & { readonly runId: string }>;
    installation: OrgGithubAppInstallation | undefined;
    staticRef: string | undefined;
    repo: RepoRef;
    token: ResolvedVcsToken;
    /** The host-neutral seam the base head-sha read routes through (decomposition PR-6). */
    codeHost: CodeHost;
    tailSpecId: string;
    integrationRef: string;
    quarantine: Awaited<ReturnType<typeof loadActiveQuarantine>>;
  }): Promise<BatchCheckVerdict> {
    const { orgId, projectId, project, ordered, installation, staticRef, repo, tailSpecId, integrationRef } = args;
    const tailRunId = ordered.at(-1)?.runId ?? "";
    const baseSha = await args.codeHost.fetchRef({
      repo,
      remoteBranch: project.default_branch,
    });
    if (baseSha === undefined) {
      // Fail-closed: an unreadable base head is an infra fault (a retriable hold), never a
      // verdict — the coordinator must not blame/bisect a PR for it.
      return {
        result: "infra-error",
        message: `batch base head ${project.default_branch} could not be read for the integration node`,
        retriable: true,
      };
    }
    const runnerImage = project.runner_image ?? DEFAULT_BATCH_RUNNER_IMAGE;
    const governancePosture = resolveGovernancePosture(project.project_config);
    const policyVersion = resolvePolicyVersion(project.project_config);
    const quarantineAppEnv = quarantineEnv(args.quarantine);
    const eventStore = this.deps.runStateWriter;
    const gateDeps = {
      ssh: this.deps.ssh,
      eventStore,
      governancePosture,
      integrationRef,
      orgId,
      projectId,
      tailSpecId,
      appEnv: quarantineAppEnv,
      quarantinedStepNames: args.quarantine.checkNames,
    } as const;
    return runWithJobOrgId(orgId, async () => {
      const verdict = await driveBatchThroughNode(
        {
          orgId,
          projectId,
          baseBranch: project.default_branch,
          baseSha,
          repoUrl: project.repo_url,
          runnerImage,
          tailSpecId,
          members: ordered.map((a) => ({ specId: a.specId, runId: a.runId, branch: a.branch })),
          policyVersion,
          appEnv: quarantineAppEnv,
          quarantineVersion: activeQuarantineVersion(args.quarantine),
        },
        {
          nodes: new PgIntegrationNodeModel(this.deps.pool),
          proofUnits: batchProofUnitGraph(this.deps.pool, eventStore),
          eventStore,
          jjWorkspaceDeps: {
            facts: {
              orgId,
              projectId,
              repoUrl: project.repo_url,
              runnerImage,
              ...(installation !== undefined && { installation }),
              githubCredentialRef: staticRef ?? "",
              identitySecretRef: this.deps.identitySecretRef,
            },
            allocator: this.deps.allocator,
            ssh: this.deps.ssh,
            secrets: this.deps.secrets,
            githubHttp: this.deps.githubHttp,
            ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
          },
          resolveConfig: batchNodeResolveConfig(gateDeps),
          gate: batchNodeGate(gateDeps),
          // mq-12 live trigger: every jj-local batch resolves its composed F2
          // evidence immediately before proof-unit evaluation. This adapter only
          // reads typed data; `batchNodeGate` remains the sole executable authority.
          ...batchFragmentEvidenceWiring(this.deps.pool),
          materializeReadyNode: buildCoverageAuthorityReadyNodeMaterializer(this.deps.pool),
        },
      );
      // ds-6 pre_merge seam: after a passing jj-local integration, bind the composed design
      // system's eager render matrix to THIS integration node (immutable design proof-units,
      // keyed by the frozen six-input design proof key). ADVISORY to merge authority — a
      // project with no composed design system is a clean no-op, and any failure is isolated
      // (logged) so it never perturbs the native gate verdict the coordinator returns.
      if (
        verdict.result === "pass" &&
        verdict.authorityBinding !== undefined &&
        this.deps.bindDesignDelivery !== undefined
      ) {
        try {
          await this.deps.bindDesignDelivery({
            orgId,
            projectId,
            integrationNodeId: verdict.authorityBinding.nodeId,
            runId: tailRunId,
          });
        } catch (error) {
          log.error("ds-6 pre_merge design-delivery binding failed (isolated)", { projectId }, error);
        }
      }
      return verdict;
    });
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

  private async loadEntryBranches(client: pg.PoolClient, runIds: ReadonlyArray<string>): Promise<BatchBranchRow[]> {
    if (runIds.length === 0) return [];
    const result = await client.query<BatchBranchRow>(
      `SELECT r.run_id, r.spec_id, r.branch
         FROM runs r
        WHERE r.run_id = ANY($1::text[])`,
      [[...runIds]],
    );
    return result.rows;
  }

  /**
   * Build the host-neutral `CodeHost` the batch base head-sha read routes through
   * (decomposition PR-6), over the SAME GitHub HTTP client the run's provider holds
   * (the run's `githubHttp`) + a supplier of the token already resolved for this check. The
   * seam stays token-free; the plaintext token travels only in each call's auth header.
   */
  private buildCodeHost(token: ResolvedVcsToken): CodeHost {
    const http = this.deps.githubHttp;
    return new GitHubCodeHost(http, async () => ({
      token: token.token,
      ...(token.refresh !== undefined && { refresh: token.refresh }),
    }));
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
 * Resolve the project's governance posture from `projects.config` (default `strict`).
 *
 * `strict` is the FAIL-CLOSED correct default — a config we cannot read must gate at
 * the most-conservative posture, never silently relax to a laxer one. But the catch is
 * NOT silent (no_silent_fallbacks): a config-parse failure is logged LOUD so a corrupt
 * persisted config is visible, then we proceed at the safe `strict` default.
 */
export function resolveGovernancePosture(projectConfig: unknown): GovernancePosture {
  try {
    return migrateProjectConfig(projectConfig).governancePosture;
  } catch (error) {
    log.warn("governance posture config unreadable; gating fail-closed at `strict`", {}, error);
    return "strict";
  }
}

/**
 * Resolve the project's policy version (the config version) — the posture the verdict is
 * judged under, a proof-reuse key component. FAIL-CLOSED: a config that cannot be read
 * returns `undefined` (the proof-reuse decider forces a recompute on an unresolvable
 * policyVersion, never a stale reuse). Stringified so it keys the proof uniformly.
 */
function resolvePolicyVersion(projectConfig: unknown): string | undefined {
  try {
    return String(migrateProjectConfig(projectConfig).version);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the static GitHub credential ref: project credentials → org default.
 *
 * FAIL-CLOSED on a CORRUPT project config (no_silent_fallbacks; twin of the
 * speculativeIntegrator resolver): a present-but-unparseable `projects.config` is a
 * corruption that must PROPAGATE — never silently swallowed into the org-default
 * token (a wrong-IDENTITY fallback). Only an ABSENT project config (the `'{}'::jsonb`
 * default a fresh project carries; `isAbsentProjectConfig`) legitimately falls
 * through to the org default — there genuinely is no project-level ref to use.
 */
export function resolveGithubStaticRef(projectConfig: unknown, orgConfig: unknown, orgId: string): string | undefined {
  if (!isAbsentProjectConfig(projectConfig)) {
    // Present config: a throw here is genuine corruption — let it propagate (loud,
    // fail-closed). NEVER fall through to a different identity.
    const projectRef = bindProjectGithubCredentialRefs(migrateProjectConfig(projectConfig), orgId).credentials
      ?.githubCredentialRef;
    if (projectRef !== undefined) return projectRef;
    // Parsed clean but no project-level githubCredentialRef bound → org default.
  }
  // Org default. Mirrors `installationFromOrgConfig`'s no-silent-fallback
  // contract: an ABSENT config legitimately resolves to undefined ("no org
  // default ref"), but a PRESENT-yet-UNPARSEABLE config is corruption —
  // `migrateOrgConfig` throws and that throw PROPAGATES (loud, fail-closed),
  // never swallowed to a silent undefined that quietly disables GitHub creds.
  if (orgConfig === null || orgConfig === undefined) return undefined;
  return bindOrgGithubCredentialRefs(migrateOrgConfig(orgConfig), orgId).defaultCredentials?.github_token;
}

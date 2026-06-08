// The drive-path intent-preserving conflict resolver (autonomy-engine.md §2b/§2c)
// — the REAL producer the §2c escalation foundation (coordinatorEscalate.ts) was
// waiting for. It replaces the old blind-re-exec stub: instead of re-enqueuing a
// fresh run that re-hits the same conflict, the drive pass now PROVISIONS a
// short-lived runner + workspace and runs the SAME intent-preserving resolver the
// in-loop `direct_merge` path runs (`buildDefaultConflictResolver`), then CLASSIFIES
// the outcome into one of these autonomous dispositions (captured into a mutable
// `DriveConflictVerdict` the drive reads after `mergeForRun` returns, since the merge
// dispatcher only sees the hook's `{resolved:boolean}`):
//
//   RESOLVED   — reconciled both intents + re-gated clean → `{resolved:true}`; the
//                dispatcher retries the merge and it lands (autonomous).
//   RE-PLANNED — no mechanical resolution but the intents are COMPATIBLE → the
//                resolver routed ONE spec back to the planner WITH the other's change
//                as context (the real `ReplanRouter`, intent-carrying NOT blind
//                re-exec) → `{resolved:false}` → recoverable `merge.conflict`; the
//                re-planned spec re-runs. Bounded by `MAX_CONFLICT_REPLANS`.
//   ESCALATED  — the intents are GENUINELY INCOMPATIBLE: the bounded re-plan budget is
//                exhausted (re-planned `MAX_CONFLICT_REPLANS` times and STILL collides).
//                Re-planning again would re-conflict forever, so this is a PRODUCT
//                DECISION a human must make → the `needs_attention` MergeDriveOutcome
//                (PR1's escalator parks the spec + emits `dag.spec.needs_attention`).
//   YIELD      — a live `percolation_pending` marker means change-percolation already
//                OWNS this spec (it re-executes + routes the same conflict). The drive
//                YIELDS (a recoverable hold, re-driven later) rather than racing it.

import { getSystemPool, runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { Allocator, RunnerHandle } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { CiWhen } from "../ci/index.js";
import type { EventStore } from "../eventStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { GovernancePosture, RoutingChainEntry, RoutingTable } from "../config/shared.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { installationFromOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { buildEffectiveRouting } from "../worker/runExecutionContext.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";
import {
  advisoryStepNamesForPosture,
  type GateOutcome,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import { buildAdaptersFromRouting } from "../providers/adapterSelector.js";
import { buildDefaultConflictResolver } from "../workflow/reviewMerge/conflictResolver/index.js";
import type { ConflictResolverHook } from "../workflow/reviewMerge/index.js";

/**
 * The bounded conflict-RE-PLAN budget: a spec whose conflict could not be
 * mechanically resolved is routed back to the planner AT MOST this many times,
 * carrying the other side's change. Once the count of prior
 * `merge.conflict.replan_routed` events REACHES this (`>=`), the next drive-pass
 * conflict ESCALATES to `needs_attention` instead of re-planning again — so a
 * spec is re-planned at most `MAX_CONFLICT_REPLANS` times, then surfaces a loud
 * "the intents genuinely conflict" product decision (never an infinite re-plan).
 */
export const MAX_CONFLICT_REPLANS = 3;

/** The terminal runner image a runless drive-path resolver allocates against. */
const DEFAULT_RESOLVER_RUNNER_IMAGE_FALLBACK = "ghcr.io/tanren/runner:latest";

/**
 * The drive's read of the resolver's autonomous disposition (see the file header for
 * each case), captured by the hook for the drive to map onto a `MergeDriveOutcome`
 * AFTER `mergeForRun` returns (the dispatcher only forwards `{resolved:boolean}`):
 * resolved → merge retries+lands; replanned → recoverable conflict; escalate →
 * needs_attention; yield → percolation owns the spec, hold + re-drive (no escalation).
 */
export type DriveConflictDisposition = "resolved" | "replanned" | "escalate" | "yield";

/** A mutable single-shot capture cell threaded into the hook + read by the drive. */
export interface DriveConflictVerdict {
  disposition?: DriveConflictDisposition;
  /** The decision message surfaced on escalation (a product-decision ask, not an error). */
  message?: string;
}

/** Thrown when change-percolation owns the spec — the drive yields (recoverable hold). */
export class PercolationOwnsSpecError extends Error {
  constructor(runId: string) {
    super(`change-percolation owns run ${runId}; the merge drive yields rather than racing it`);
    this.name = "PercolationOwnsSpecError";
  }
}

/** The run/spec/project facts the drive-path resolver needs (resolved system-scoped). */
export interface DriveConflictResolveFacts {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  githubCredentialRef: string;
}

/** Everything the drive-path resolver hook needs, threaded from the coordinator deps. */
export interface DriveConflictResolveDeps {
  /** The raw pool (system/credential bootstrap reads run on it). */
  pool: pg.Pool;
  /** The org-scoping pool the merge stage's tenant reads/writes self-route through. */
  scopedPool: pg.Pool;
  facts: DriveConflictResolveFacts;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  runStateWriter?: RunStateWriter;
  /** The merge-stage event store (control plane when wired, else org-scoped pg). */
  eventStore: EventStore;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
  timeoutMs: number;
  /** The capture cell the drive reads after `mergeForRun` returns. */
  verdict: DriveConflictVerdict;
  /**
   * Test seam: build the conflict resolver hook over the provisioned runner +
   * workspace. Production OMITS it → the REAL intent-preserving resolver
   * (`buildResolverForDrive`) is the default (§8a: the default of an injectable
   * seam is the real impl, never a stub). A test injects a scripted hook to assert
   * the classify-then-escalate + percolation/cap guards WITHOUT a live model/runner.
   */
  buildResolver?: (target: RunnerHandle, workspacePath: string, baseSha: string) => ConflictResolverHook;
}

/** The resolved run context the drive-path resolver clones + reasons over. */
interface DriveRunContext {
  repoUrl: string;
  baseBranch: string;
  headBranch: string;
  runnerImage: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  routing: RoutingTable;
  defaultLlm: RoutingChainEntry;
  endpointBaseUrl?: string;
  installation?: OrgGithubAppInstallation;
  governancePosture: GovernancePosture;
}

/**
 * Build the drive-path conflict resolver hook. The merge dispatcher invokes it on a
 * detected conflict; it PROVISIONS a short-lived runner, clones the head + base,
 * runs the real intent-preserving resolver, and CLASSIFIES the outcome into the
 * `verdict` cell (resolved / replanned / escalate / yield) the drive maps onto the
 * `MergeDriveOutcome`. A missing allocator/ssh would have been a LOUD throw at the
 * call site (buildDriveMerge) — this hook always has them.
 */
export function buildDriveConflictResolve(deps: DriveConflictResolveDeps): ConflictResolverHook {
  return async (conflictContext) => {
    // MUTUAL EXCLUSION: if change-percolation already owns this spec (a live
    // `percolation_pending` marker — the same read plannerRunAdapters uses), the
    // drive YIELDS rather than racing percolation's own re-exec + conflict route.
    // The thrown error is caught by the drive and mapped to a recoverable hold.
    if (await percolationOwnsRun(deps.scopedPool, deps.facts)) {
      deps.verdict.disposition = "yield";
      throw new PercolationOwnsSpecError(deps.facts.runId);
    }

    // CLASSIFY-THEN-ESCALATE — the bounded re-plan budget. Count prior
    // `merge.conflict.replan_routed` events for this spec (the bounded-cap
    // convention). At/over the cap the two intents are GENUINELY incompatible:
    // re-planning again would just re-conflict forever, so escalate WITHOUT
    // provisioning a runner or routing another re-plan.
    const priorReplans = await countPriorConflictReplans(deps.pool, deps.facts);
    if (priorReplans >= MAX_CONFLICT_REPLANS) {
      deps.verdict.disposition = "escalate";
      deps.verdict.message =
        `the resolver judged these specs' intents genuinely conflict: spec ${deps.facts.specId} has been ` +
        `re-planned ${priorReplans} times against the conflicting change and STILL collides — a product ` +
        `decision is needed (which behavior wins, or whether the architecture must change).`;
      return { resolved: false };
    }

    const ctx = await loadDriveRunContext(deps);
    const resolverHandle = `${deps.facts.runId}-resolve-${crypto.randomUUID()}`;
    const allocation = await deps.allocator.allocate({
      // Runless: use a synthetic naming handle so retained `runner_${runId}` rows
      // from the original run cannot collide with this short-lived resolver.
      runId: resolverHandle,
      projectId: deps.facts.projectId,
      runnerImage: ctx.runnerImage,
      identitySecretRef: deps.identitySecretRef,
      orgId: deps.facts.orgId,
      runless: true,
      persistedRunId: null,
      persistedProjectId: deps.facts.projectId,
    });
    const workspacePath = workspaceRepoPathForRun(resolverHandle);
    try {
      // Clone the HEAD (PR) branch into the workspace; the resolver's
      // SshWorkspaceConflictApplier.gather() then merges base INTO it to surface
      // the conflict hunks (it needs the head checked out as HEAD).
      const baseSha = await cloneHeadForResolve(deps, ctx, allocation.target, workspacePath);

      const resolver = (deps.buildResolver ?? ((t, w, b) => buildResolverForDrive(deps, ctx, t, w, b)))(
        allocation.target,
        workspacePath,
        baseSha,
      );
      const result = await resolver(conflictContext);

      // RESOLVED → the merge retries + lands (autonomous). UNRESOLVED → the resolver
      // already routed ONE spec back to the planner (the real intent-carrying re-plan)
      // under the cap, so this is a bounded autonomous RE-PLAN — recoverable, NOT escalation.
      deps.verdict.disposition = result.resolved ? "resolved" : "replanned";
      return result;
    } finally {
      // LOUD on release error: a leaked runner is a real fault (cost + capacity), so
      // surface it rather than swallow it (no silent leak).
      await deps.allocator.release(allocation.runnerId, "completed").catch((error: unknown) => {
        console.error(
          `[merge-coordinator] FAILED to release drive-path resolver runner ${allocation.runnerId} for run ${deps.facts.runId} — leaked runner:`,
          error,
        );
        throw error;
      });
    }
  };
}

/**
 * Read the run's in-flight percolation marker (`runs.percolation_pending`) under
 * the org-scoping pool (RLS). A non-null marker means change-percolation owns the
 * spec — the drive yields. Mirrors `readPercolationUpstreamChange` in
 * plannerRunAdapters (the same column + the same per-job org scope).
 */
async function percolationOwnsRun(scopedPool: pg.Pool, facts: DriveConflictResolveFacts): Promise<boolean> {
  return runWithJobOrgId(facts.orgId, async () => {
    const result = await scopedPool.query<{ percolation_pending: unknown }>(
      "SELECT percolation_pending FROM runs WHERE run_id = $1",
      [facts.runId],
    );
    const marker = result.rows[0]?.percolation_pending;
    return marker !== null && marker !== undefined;
  });
}

/**
 * Count prior `merge.conflict.replan_routed` events for the spec — the bounded
 * re-plan budget key. The
 * `events` table is unreadable to the de-privileged data-plane role (0031 REVOKE),
 * so read on the BYPASSRLS system pool with the org GUC still applied on top.
 */
async function countPriorConflictReplans(pool: pg.Pool, facts: DriveConflictResolveFacts): Promise<number> {
  const readPool = getSystemPool() ?? pool;
  return runWithOrgScope(readPool, facts.orgId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM events
        WHERE spec_id = $1 AND event_type = 'merge.conflict.replan_routed'`,
      [facts.specId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

/**
 * Resolve the run/spec/project context the resolver clones + reasons over: the
 * repo URL, base/head branches, the spec intent, the effective routing (so the
 * conflict Answerer + checker/auditor resolve from the project's per-role data),
 * the resolved LLM credential + managed endpoint, and the org App installation.
 * The runs⋈specs⋈projects⋈organizations join is the cross-org bootstrap, so it is
 * system-scoped (the credential resolution is org-scoped on top).
 */
async function loadDriveRunContext(deps: DriveConflictResolveDeps): Promise<DriveRunContext> {
  const row = await runWithSystemScope(deps.pool, async (client) => {
    const result = await client.query<{
      repo_url: string;
      default_branch: string | null;
      speculative_base: string | null;
      branch: string;
      runner_image: string | null;
      config: unknown;
      org_config: unknown;
      title: string;
      description: string;
      acceptance_criteria: unknown;
    }>(
      `SELECT p.repo_url, p.default_branch, r.speculative_base, r.branch, p.runner_image, p.config,
              o.config AS org_config, s.title, s.description, s.acceptance_criteria
         FROM runs r
         JOIN specs s ON s.spec_id = r.spec_id
         JOIN projects p ON p.project_id = r.project_id
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE r.run_id = $1`,
      [deps.facts.runId],
    );
    return result.rows[0];
  });
  if (row === undefined) {
    throw new Error(`cannot resolve drive-path conflict context: run ${deps.facts.runId} not found`);
  }
  const projectConfig = migrateProjectConfig(row.config);
  // Credential resolution reads `organizations.config` (a tenant read) — run it
  // org-scoped so RLS admits the row (the same hop resolveRunFacts uses).
  const resolved = await runWithOrgScope(deps.pool, deps.facts.orgId, (client) =>
    resolveCredentialsForRun(client, { projectConfig, orgId: deps.facts.orgId }),
  );
  const installation = installationFromOrgConfig(row.org_config);
  return {
    repoUrl: row.repo_url,
    // The merge re-gates against the run's MERGE-time base — the speculative
    // integration base when set, else the project default (mirrors the run
    // context's `targetBranch`).
    baseBranch: row.speculative_base ?? row.default_branch ?? "main",
    headBranch: row.branch,
    runnerImage: row.runner_image ?? DEFAULT_RESOLVER_RUNNER_IMAGE_FALLBACK,
    specTitle: row.title,
    specDescription: row.description,
    acceptanceCriteria: toStringArray(row.acceptance_criteria),
    routing: buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm),
    defaultLlm: resolved.defaultLlm,
    ...(resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {}),
    ...(installation !== undefined && { installation }),
    governancePosture: projectConfig.governancePosture,
  };
}

/**
 * Clone the PR HEAD branch into the runner workspace so the resolver's applier can
 * merge base INTO it to surface the hunks. Authenticates App-first (the same seam
 * the run-loop clone uses) so a PRIVATE target clones; returns the clone HEAD as
 * the diff base the re-gate reasons against. Reuses the run-loop clone primitives
 * (gitTokenAuthPrelude / gitAuthedCommand) so the token never hits the command line.
 */
async function cloneHeadForResolve(
  deps: DriveConflictResolveDeps,
  ctx: DriveRunContext,
  target: RunnerHandle,
  workspacePath: string,
): Promise<string> {
  const staticRef = deps.facts.githubCredentialRef;
  const token =
    ctx.installation === undefined && staticRef.trim() === ""
      ? undefined
      : (
          await deps.vcsProvider.resolveToken({
            secrets: deps.secrets,
            ...(ctx.installation !== undefined && { installation: ctx.installation }),
            ...(staticRef.trim() !== "" && { staticRef }),
            ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
          })
        ).token;
  const result = await runWorkspaceSshCommand(deps.ssh, target, {
    label: "prepare conflict-resolve workspace",
    timeoutMs: deps.timeoutMs,
    command: buildCloneHeadCommand(ctx.repoUrl, ctx.headBranch, token, workspacePath),
    ...(token === undefined ? {} : { stdin: token }),
  });
  return result.stdout.trim();
}

/** The git clone of the HEAD branch (authenticated via stdin when a token is present). */
function buildCloneHeadCommand(
  repoUrl: string,
  headBranch: string,
  token: string | undefined,
  workspacePath: string,
): string {
  const branch = quoteSshShellArg(headBranch);
  const dest = quoteSshShellArg(workspacePath);
  // Configure a non-attributable resolver identity for the in-progress merge
  // commit (the resolution is published on the PR branch, attributed by the push
  // token's account; the local commit author is set by the applier's publish step).
  const post = [
    `cd ${dest}`,
    "git config user.name 'Tanren Conflict Resolver'",
    "git config user.email 'resolver@tanren.invalid'",
    "git rev-parse HEAD",
  ];
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}

/**
 * Assemble the real intent-preserving resolver for the drive pass: the conflict
 * Answerer + checker + auditor all resolve from the project routing (the same
 * `buildAdaptersFromRouting` seam the run loop uses), and the re-gate runs the
 * project's CI config over the freshly-cloned workspace. This is the SAME
 * resolver core the in-loop `direct_merge` path runs — only the workspace + the
 * adapters' runner are freshly provisioned (the original run's are gone).
 */
function buildResolverForDrive(
  deps: DriveConflictResolveDeps,
  ctx: DriveRunContext,
  target: RunnerHandle,
  workspacePath: string,
  baseSha: string,
): ConflictResolverHook {
  const adapterDeps = {
    secrets: deps.secrets,
    ssh: deps.ssh,
    target,
    runId: deps.facts.runId,
    ...(ctx.endpointBaseUrl !== undefined && { endpointBaseUrl: ctx.endpointBaseUrl }),
  };
  const adapters = buildAdaptersFromRouting(adapterDeps, ctx.routing);
  return buildDefaultConflictResolver({
    pool: deps.scopedPool,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    eventStore: deps.eventStore,
    ssh: deps.ssh,
    secrets: deps.secrets,
    target,
    workspacePath,
    baseSha,
    timeoutMs: deps.timeoutMs,
    runId: deps.facts.runId,
    projectId: deps.facts.projectId,
    orgId: deps.facts.orgId,
    specId: deps.facts.specId,
    specTitle: ctx.specTitle,
    specDescription: ctx.specDescription,
    acceptanceCriteria: ctx.acceptanceCriteria,
    baseBranch: ctx.baseBranch,
    headBranch: ctx.headBranch,
    ...(ctx.endpointBaseUrl !== undefined && { endpointBaseUrl: ctx.endpointBaseUrl }),
    routing: ctx.routing,
    checker: adapters.checker,
    auditor: adapters.auditor,
    runGate: buildDriveGate(deps, ctx, target, workspacePath),
  });
}

/**
 * The re-gate callback over the freshly-cloned drive workspace: resolve the
 * project's CI config lazily (cached) and run the tiers mapped to `when`. Mirrors
 * `buildDefaultGate` but for the drive's standalone workspace (no run-loop input
 * graph) — the resolver re-gates the RESOLVED tree before any merge.
 */
function buildDriveGate(
  deps: DriveConflictResolveDeps,
  ctx: DriveRunContext,
  target: RunnerHandle,
  workspacePath: string,
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  const advisoryStepNames = advisoryStepNamesForPosture(ctx.governancePosture);
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({
        ssh: deps.ssh,
        target,
        workspacePath,
        timeoutMs: deps.timeoutMs,
      });
    }
    const config = await configPromise;
    return runGateForWhen({
      ssh: deps.ssh,
      target,
      workspacePath,
      config,
      when,
      timeoutMs: deps.timeoutMs,
      appendEvent: async (eventType, payload, eventTaskId) => {
        await deps.eventStore.append({
          runId: deps.facts.runId,
          specId: deps.facts.specId,
          projectId: deps.facts.projectId,
          ...(eventTaskId !== undefined && { taskId: eventTaskId }),
          eventType,
          payload,
        });
      },
      ...(taskId !== undefined && { taskId }),
      advisoryStepNames,
    });
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

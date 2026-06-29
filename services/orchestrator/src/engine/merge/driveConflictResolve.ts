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
import type { GitHubHttpClient } from "../providers/github.js";
import { bootstrapCommand, type CiWhen } from "../ci/index.js";
import type { EventStore } from "../eventStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import {
  CANONICAL_RUNNER_IMAGE,
  type GovernancePosture,
  type RoutingChainEntry,
  type RoutingTable,
} from "../config/shared.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { installationFromOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { buildEffectiveRouting } from "../worker/runExecutionContext.js";
import { orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import {
  advisoryStepNamesForPosture,
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  type GateOutcome,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import { buildAdaptersFromRouting } from "../providers/adapterSelector.js";
import type { SpecMode } from "../state/spec.js";
import { buildDefaultConflictResolver } from "../workflow/reviewMerge/conflictResolver/index.js";
import { atReplanFixedPoint, conflictSignatureOf } from "../workflow/reviewMerge/conflictResolver/replanRouter.js";
import { driveResolveOverJj } from "./driveConflictResolveJj.js";
import type { WorkspaceConflictApplier } from "../contracts/conflictResolution.js";
import type { ConflictResolverHook } from "../workflow/reviewMerge/index.js";

// The drive-path conflict resolver no longer counts re-plans (apex v35 — intelligent
// non-convergence detection). It escalates ONLY at a FIXED POINT (the SAME conflict
// signature recurring), via the shared `convergenceDetector` (`atReplanFixedPoint`) —
// re-planning against a DIFFERENT conflict (e.g. a shifted base) is progress and continues
// UNBOUNDED. There is no `MAX_CONFLICT_REPLANS` budget.

/** The terminal runner image a runless drive-path resolver allocates against. */
const DEFAULT_RESOLVER_RUNNER_IMAGE_FALLBACK = CANONICAL_RUNNER_IMAGE;

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
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714 made the writer-undefined fallback unreachable
   * in production.
   */
  runStateWriter: RunStateWriter;
  /** The merge-stage event store (control plane when wired, else org-scoped pg). */
  eventStore: EventStore;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
  /** The capture cell the drive reads after `mergeForRun` returns. */
  verdict: DriveConflictVerdict;
  /**
   * Test seam: build the conflict resolver hook over the provisioned jj workspace.
   * Production OMITS it → the REAL intent-preserving resolver (`buildResolverForDrive`)
   * is the default (§8a: the default of an injectable seam is the real impl, never a
   * stub). A test injects a scripted hook to assert the classify-then-escalate +
   * percolation/cap guards WITHOUT a live model/runner. It receives the jj workspace's
   * runner + path + base + the jj applier the live workspace built.
   */
  buildResolver?: (
    target: RunnerHandle,
    workspacePath: string,
    baseSha: string,
    applier: WorkspaceConflictApplier,
  ) => ConflictResolverHook;
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
  // Task #86: spec writer-prompt MODE (`specialize_seed` for the foundation specs;
  // `from_scratch` otherwise). Threaded into the drive-path conflict resolver so the
  // re-gate's checker + auditor see the seeded-mode tail block on `specialize_seed`
  // specs (the same agreement the in-loop stages honor).
  specMode: SpecMode;
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

    // CLASSIFY-THEN-ESCALATE — the FIXED-POINT rule (no count). The current conflict's
    // signature is the base it is colliding against; read prior re-plan signatures and ask
    // the shared detector. At a fixed point (the SAME conflict recurring — re-planning would
    // re-conflict identically) the two intents are GENUINELY incompatible: escalate WITHOUT
    // provisioning a runner. A DIFFERENT conflict (e.g. a shifted base) is progress → resolve.
    const currentSignature = conflictSignatureOf(conflictContext.message || conflictContext.baseBranch);
    const priorSignatures = await priorConflictSignatures(deps.pool, deps.facts);
    if (await atReplanFixedPoint(priorSignatures, currentSignature)) {
      deps.verdict.disposition = "escalate";
      deps.verdict.message =
        `the resolver reached a FIXED POINT on spec ${deps.facts.specId}: it is re-planning against the SAME ` +
        `conflicting change it already could not absorb (re-planning would re-conflict identically) — a product ` +
        `decision is needed (which behavior wins, or whether the architecture must change).`;
      return { resolved: false };
    }

    const ctx = await loadDriveRunContext(deps);

    // Provision a live jj workspace (A1's `buildLiveJjWorkspace`) and run the resolver
    // over jj's FIRST-CLASS conflicts — `rebaseOnto` RECORDS the conflict (fail-closed,
    // no `git merge --abort` / `|| true` fail-open). The `buildResolver` TEST SEAM
    // (production omits it) scripts the WHOLE resolver over the SAME jj workspace, so the
    // classify/cap/yield wrapper is asserted without a live model/runner.
    const result = await driveResolveViaJj(deps, ctx, conflictContext);

    // RESOLVED → the merge retries + lands (autonomous). UNRESOLVED → the resolver
    // already routed ONE spec back to the planner (the real intent-carrying re-plan)
    // under the cap, so this is a bounded autonomous RE-PLAN — recoverable, NOT escalation.
    deps.verdict.disposition = result.resolved ? "resolved" : "replanned";
    return result;
  };
}

/**
 * The jj-backed drive resolve: delegate to the extracted `driveResolveOverJj` (which
 * provisions the live jj workspace + the jj applier), passing a `buildResolver` closure
 * that assembles this file's adapters + re-gate over the SAME runner + path the applier
 * resolves into, so the re-gate judges the jj-resolved tree. The `buildResolver` TEST
 * SEAM (production omits it) is threaded over that same jj workspace + applier.
 */
async function driveResolveViaJj(
  deps: DriveConflictResolveDeps,
  ctx: DriveRunContext,
  conflictContext: Parameters<ConflictResolverHook>[0],
): Promise<{ resolved: boolean }> {
  return driveResolveOverJj(
    {
      facts: {
        orgId: deps.facts.orgId,
        projectId: deps.facts.projectId,
        repoUrl: ctx.repoUrl,
        baseBranch: ctx.baseBranch,
        headBranch: ctx.headBranch,
        runnerImage: ctx.runnerImage,
        ...(ctx.installation !== undefined && { installation: ctx.installation }),
        githubCredentialRef: deps.facts.githubCredentialRef,
        identitySecretRef: deps.identitySecretRef,
      },
      allocator: deps.allocator,
      ssh: deps.ssh,
      secrets: deps.secrets,
      githubHttp: deps.githubHttp,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      buildResolver: ({ target, workspacePath, baseSha, applier }) =>
        deps.buildResolver === undefined
          ? buildResolverForDrive(deps, ctx, target, workspacePath, baseSha, applier)
          : deps.buildResolver(target, workspacePath, baseSha, applier),
    },
    conflictContext,
  );
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
 * Read prior `merge.conflict.replan_routed` CONFLICT SIGNATURES for the spec (oldest→newest)
 * — the shared convergence detector's input. The `events` table is unreadable to the
 * de-privileged data-plane role (0031 REVOKE), so read on the BYPASSRLS system pool with the
 * org GUC applied on top. Legacy rows without a `conflictSignature` fall back to a hash of
 * their `newContext` so the detector can still tell same-conflict from different-conflict.
 */
async function priorConflictSignatures(pool: pg.Pool, facts: DriveConflictResolveFacts): Promise<string[]> {
  const readPool = getSystemPool() ?? pool;
  return runWithOrgScope(readPool, facts.orgId, async (client) => {
    const result = await client.query<{ payload: { conflictSignature?: string; newContext?: string } }>(
      `SELECT payload
         FROM events
        WHERE spec_id = $1 AND event_type = 'merge.conflict.replan_routed'
        ORDER BY ts ASC, id ASC`,
      [facts.specId],
    );
    return result.rows.map((row) => row.payload.conflictSignature ?? conflictSignatureOf(row.payload.newContext ?? ""));
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
      ancestor_stack: unknown;
      branch: string;
      runner_image: string | null;
      config: unknown;
      org_config: unknown;
      title: string;
      description: string;
      acceptance_criteria: unknown;
      mode: unknown;
    }>(
      `SELECT p.repo_url, p.default_branch, r.ancestor_stack, r.branch, p.runner_image, p.config,
              o.config AS org_config, s.title, s.description, s.acceptance_criteria, s.mode
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
    resolveCredentialsForRun(client, { projectConfig, orgScope: orgScopeFromRunOrgId(deps.facts.orgId) }),
  );
  const installation = installationFromOrgConfig(row.org_config);
  // jj-local: the merge re-gates against the run's stacked base — the immediate unmerged
  // ancestor's PR-head branch (the LAST `ancestor_stack` entry) when the run is stacked, else
  // the project default. Mirrors the draft-PR stacked base (`resolveDraftPrBaseBranch`).
  const immediateAncestorBranch = immediateAncestorBranchFromStack(row.ancestor_stack);
  // Task #86: read the spec's writer-prompt MODE off the joined `s.mode` column. The DB
  // CHECK is NOT NULL with default `from_scratch`, so a real row always carries one of the
  // two literals; a fixture row without the column safely defaults to `from_scratch`. A
  // narrow literal compare avoids a runtime zod import (the file's max-dependencies cap).
  const specMode: SpecMode = row.mode === "specialize_seed" ? "specialize_seed" : "from_scratch";
  return {
    repoUrl: row.repo_url,
    baseBranch:
      immediateAncestorBranch !== undefined && immediateAncestorBranch !== ""
        ? immediateAncestorBranch
        : (row.default_branch ?? "main"),
    headBranch: row.branch,
    runnerImage: row.runner_image ?? DEFAULT_RESOLVER_RUNNER_IMAGE_FALLBACK,
    specTitle: row.title,
    specDescription: row.description,
    acceptanceCriteria: toStringArray(row.acceptance_criteria),
    specMode,
    routing: buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm),
    defaultLlm: resolved.defaultLlm,
    ...(resolved.endpointOverride ? { endpointBaseUrl: resolved.endpointOverride.baseUrl } : {}),
    ...(installation !== undefined && { installation }),
    governancePosture: projectConfig.governancePosture,
  };
}

/**
 * The immediate-ancestor PR-head branch (the stacked base) from the run's `ancestor_stack`
 * jsonb — the LAST entry's non-empty `branch`, or `undefined` for a non-speculative run. A
 * minimal inline read (no zod) to keep this file's dependency count under the cap.
 */
function immediateAncestorBranchFromStack(ancestorStack: unknown): string | undefined {
  const last = Array.isArray(ancestorStack) ? (ancestorStack.at(-1) as { branch?: unknown } | undefined) : undefined;
  return typeof last?.branch === "string" && last.branch !== "" ? last.branch : undefined;
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
  applier: WorkspaceConflictApplier,
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
    // The jj applier the live workspace built (the sole workspace mechanism).
    applier,
    pool: deps.scopedPool,
    runStateWriter: deps.runStateWriter,
    eventStore: deps.eventStore,
    ssh: deps.ssh,
    secrets: deps.secrets,
    target,
    workspacePath,
    baseSha,
    runId: deps.facts.runId,
    projectId: deps.facts.projectId,
    orgId: deps.facts.orgId,
    specId: deps.facts.specId,
    specTitle: ctx.specTitle,
    specDescription: ctx.specDescription,
    acceptanceCriteria: ctx.acceptanceCriteria,
    // Task #86: thread the spec mode so the re-gate's checker/auditor see the seeded-
    // mode tail block on `specialize_seed` specs.
    specMode: ctx.specMode,
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
      });
    }
    const config = await configPromise;
    // DEPS-BEFORE-GATE (apex v35): install deps on the freshly-cloned drive workspace
    // BEFORE the tiers run — a re-gate over a clone has no `node_modules`, so a writer's
    // `./node_modules/.bin/<tool>` tier step is `command not found` (exit 127) until the
    // project's `just bootstrap` runs. Mirrors the fresh-runner / batch re-gate: the
    // explicit `.tanren/ci.yml` `bootstrap.run` wins, else the stack-agnostic
    // `DEFAULT_BOOTSTRAP_COMMAND` LOUD-fallback. A failure throws (no silent skip), which
    // the resolver surfaces as a re-gate failure (fail-closed, never an unverified pass).
    await ensureWorkspaceDepsInstalled({
      ssh: deps.ssh,
      target,
      workspacePath,
      // The bootstrap command from the already-parsed config (no second `.tanren/ci.yml`
      // read), or — when the config omits `bootstrap.run` — the stack-agnostic
      // DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback.
      command: bootstrapCommand(config) ?? DEFAULT_BOOTSTRAP_COMMAND,
    });
    return runGateForWhen({
      ssh: deps.ssh,
      target,
      workspacePath,
      config,
      when,
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

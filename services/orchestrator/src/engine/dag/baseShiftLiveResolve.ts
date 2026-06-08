// The live base-shift conflict resolve (tanren-owns-the-engine.md §3 never-discard, §2/§5)
// — extracted from `baseShiftLiveSeams.ts` to keep each file under the caps. It is the
// SAME answerer-backed jj resolver the drive path runs (`buildDefaultConflictResolver` +
// the `JjWorkspaceConflictApplier` over A1's `buildLiveJjWorkspace`), adapted to the
// coordinator's `resolve(rebase: conflicted) → {resolved, headSha} | {resolved:false}`
// shape: it provisions its OWN live jj workspace (mirroring `driveResolveOverJj`), runs
// the intent-preserving resolver (rebase → record conflict → answerer → resolveConflict →
// re-gate → force-push the resolved head), and — on a fit — reads the resolved head sha
// back from the forge. An unresolved/irreconcilable conflict returns `{resolved:false}`,
// which the coordinator routes to REPLAN (the work stays ALIVE, never discarded).
//
// FAIL-CLOSED: a failure BEFORE the applier's `gather()` took workspace ownership releases
// the runner loudly; the applier owns release on its terminal publish/abort thereafter.

import { runWithJobOrgId } from "@tanren/db";
import type { CiWhen } from "../ci/index.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import { advisoryStepNamesForPosture, resolveGateConfig, runGateForWhen } from "../workflow/gate/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import { buildAdaptersFromRouting } from "../providers/adapterSelector.js";
import {
  buildJjConflictApplier,
  type JjConflictApplierFacts,
} from "../workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import { buildDefaultConflictResolver } from "../workflow/reviewMerge/conflictResolver/index.js";
import { buildLiveJjWorkspace, type LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import type { BaseShiftRunContext } from "./baseShiftLiveContext.js";
import type { ConflictResolution } from "./baseShiftCoordinator.js";
import type { LiveBaseShiftDeps } from "./baseShiftLiveSeams.js";

/**
 * Run the live intent-preserving jj resolver over a freshly provisioned live jj workspace,
 * re-gating + force-pushing the resolved head on a fit. The conflict is gathered + re-gated
 * against `shiftedBase` — the SAME base the initial `rebaseOnto` used (the speculative
 * integration ref, or plain `default_branch`), NEVER the project default (a P0 fail-open).
 * Returns `{resolved, headSha}` (the resolved head read back from the forge) or
 * `{resolved:false, reason}` (the coordinator replans — the work stays alive). All tenant
 * reads/writes run under the dependent's org.
 */
export async function resolveBaseShiftConflict(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  /** The shifted base the conflict is gathered + re-gated against (NOT the project default). */
  shiftedBase: string;
  timeoutMs: number;
}): Promise<ConflictResolution> {
  const { deps, ctx, shiftedBase, timeoutMs } = input;
  return runWithJobOrgId(ctx.orgId, async () => {
    const live = await buildLiveJjWorkspace({
      facts: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        repoUrl: ctx.repoUrl,
        runnerImage: ctx.runnerImage,
        ...(ctx.installation !== undefined && { installation: ctx.installation }),
        githubCredentialRef: ctx.githubCredentialRef,
        identitySecretRef: deps.identitySecretRef,
      },
      allocator: deps.allocator,
      ssh: deps.ssh,
      secrets: deps.secrets,
      vcsProvider: deps.vcsProvider,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      timeoutMs,
    });
    const resolved = await runResolverOverWorkspace({ deps, ctx, shiftedBase, live, timeoutMs }).catch(
      async (error: unknown) => {
        // FAIL-CLOSED: a failure BEFORE the applier's gather() took ownership would leak the
        // runner — release it loudly. (Once gather() runs, the applier's terminal step owns
        // release; a second release is a no-op.)
        await live.release();
        throw error;
      },
    );
    if (!resolved) {
      // The resolver routed ONE spec back to the planner (bounded re-plan) OR judged the
      // intents irreconcilable — either way the old work no longer fits as-is. The
      // coordinator replans (kept ALIVE), never discards.
      return { resolved: false, reason: "the base-shift conflict could not be reconciled in place" };
    }
    // The resolver force-pushed the resolved head onto the dependent's branch — read it
    // back as the new head sha. A missing head is fail-closed (treated as irreconcilable
    // so the coordinator replans rather than proceeding on an unknown head).
    const headSha = await readResolvedHeadSha(deps, ctx);
    if (headSha === undefined) {
      return { resolved: false, reason: "the resolved head could not be read back from the forge" };
    }
    return { resolved: true, headSha };
  });
}

/**
 * The jj applier facts for a base-shift conflict resolve — the P0-fixed BASE WIRING, pure
 * (no I/O) so it is unit-asserted directly. The conflict is gathered against the SHIFTED
 * base (the SAME one the initial `rebaseOnto` used — the speculative integration ref, or
 * plain `default_branch`), NEVER the project default: `buildLiveJjWorkspace` cloned
 * `shiftedBase`, so its remote bookmark is `<shiftedBase>@origin`. A regression to
 * `ctx.defaultBranch` here is the fail-OPEN the P0 fix closes (work proven against the wrong
 * base then marked `rebased_resolved`).
 */
export function baseShiftApplierFacts(ctx: BaseShiftRunContext, shiftedBase: string): JjConflictApplierFacts {
  return {
    repoUrl: ctx.repoUrl,
    baseBranch: shiftedBase,
    baseRevision: `${shiftedBase}@origin`,
    headBranch: ctx.headBranch,
    ...(ctx.installation !== undefined && { installation: ctx.installation }),
    githubCredentialRef: ctx.githubCredentialRef,
  };
}

/** Build the jj applier + the intent-preserving resolver over the live workspace + run it. */
async function runResolverOverWorkspace(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  /** The shifted base the conflict is gathered + re-gated against (NOT the project default). */
  shiftedBase: string;
  live: LiveJjWorkspace;
  timeoutMs: number;
}): Promise<boolean> {
  const { deps, ctx, shiftedBase, live, timeoutMs } = input;
  const applier = buildJjConflictApplier({
    live,
    ssh: deps.ssh,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    facts: baseShiftApplierFacts(ctx, shiftedBase),
    timeoutMs,
  });
  const adapters = buildAdaptersFromRouting(
    {
      secrets: deps.secrets,
      ssh: deps.ssh,
      target: live.target,
      runId: ctx.runId,
      ...(ctx.endpointBaseUrl !== undefined && { endpointBaseUrl: ctx.endpointBaseUrl }),
    },
    ctx.routing,
  );
  const resolver = buildDefaultConflictResolver({
    applier,
    pool: deps.scopedPool,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    eventStore: deps.eventStore,
    ssh: deps.ssh,
    secrets: deps.secrets,
    target: live.target,
    workspacePath: live.workspacePath,
    // The re-gate baseline is the SHIFTED base the resolved tree sits on (the resolution is
    // proven against the base it lands on, not the project default).
    baseSha: shiftedBase,
    timeoutMs,
    runId: ctx.runId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    specId: ctx.specId,
    specTitle: ctx.specTitle,
    specDescription: ctx.specDescription,
    acceptanceCriteria: ctx.acceptanceCriteria,
    baseBranch: shiftedBase,
    headBranch: ctx.headBranch,
    ...(ctx.endpointBaseUrl !== undefined && { endpointBaseUrl: ctx.endpointBaseUrl }),
    routing: ctx.routing,
    checker: adapters.checker,
    auditor: adapters.auditor,
    runGate: buildBaseShiftReGate(deps, ctx, live.target, live.workspacePath, timeoutMs),
  });
  const result = await resolver({
    runId: ctx.runId,
    prUrl: ctx.repoUrl,
    prNumber: 0,
    baseBranch: shiftedBase,
    message: "base-shift rebase conflict",
  });
  return result.resolved;
}

/**
 * The re-gate over the resolver's live workspace (mirrors `buildDriveGate`): resolve the
 * CI config lazily + run the tiers mapped to `when`, so the resolver re-gates the
 * jj-RESOLVED tree before it publishes.
 */
function buildBaseShiftReGate(
  deps: LiveBaseShiftDeps,
  ctx: BaseShiftRunContext,
  target: RunnerHandle,
  workspacePath: string,
  timeoutMs: number,
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  const advisoryStepNames = advisoryStepNamesForPosture(ctx.governancePosture);
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({ ssh: deps.ssh, target, workspacePath, timeoutMs });
    }
    const config = await configPromise;
    return runGateForWhen({
      ssh: deps.ssh,
      target,
      workspacePath,
      config,
      when,
      timeoutMs,
      appendEvent: async (eventType, payload, eventTaskId) => {
        await deps.eventStore.append({
          runId: ctx.runId,
          specId: ctx.specId,
          projectId: ctx.projectId,
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

/** Read the dependent's head branch sha back from the forge (the resolver force-pushed it). */
async function readResolvedHeadSha(deps: LiveBaseShiftDeps, ctx: BaseShiftRunContext): Promise<string | undefined> {
  const staticRef = ctx.githubCredentialRef.trim();
  const token = await deps.vcsProvider.resolveToken({
    secrets: deps.secrets,
    ...(ctx.installation !== undefined && { installation: ctx.installation }),
    ...(staticRef !== "" && { staticRef }),
    ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
  });
  const repo = deps.vcsProvider.parseRepository(ctx.repoUrl);
  return deps.vcsProvider.readBranchHeadSha({ repo, branch: ctx.headBranch, token });
}

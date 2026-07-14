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
import { bootstrapCommand, type CiWhen } from "../ci/index.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import {
  advisoryStepNamesForPosture,
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { WorkspaceHandle } from "../contracts/workspaceVcsCore.js";
import { buildAdaptersFromRouting } from "../providers/adapterSelector.js";
import {
  buildJjConflictApplier,
  type JjConflictApplierFacts,
} from "../workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import {
  buildDefaultConflictResolver,
  type ConflictResolverResult,
} from "../workflow/reviewMerge/conflictResolver/index.js";
import { buildSemEntityMergeFirstPass } from "../workflow/reviewMerge/conflictResolver/semEntityMerge.js";
import { buildLiveJjWorkspace, type LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { GitHubCodeHost } from "../providers/githubCodeHost.js";
import { parseGitHubRepository } from "../providers/github.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import type { AncestorStack } from "./ancestorStack.js";
import { assembleBaseShiftStackLive } from "./baseShiftStackAssembly.js";
import type { BaseShiftRunContext } from "./baseShiftLiveContext.js";
import type { ConflictResolution } from "./baseShiftCoordinator.js";
import type { LiveBaseShiftDeps } from "./baseShiftLiveSeams.js";

/**
 * Run the live intent-preserving jj resolver, re-gating + force-pushing the resolved head on
 * a fit. The conflict is gathered + re-gated against the SHIFTED base the initial `rebaseOnto`
 * used (NEVER the project default — a P0 fail-open). HOW that shifted base is materialized:
 *
 *   • a NON-EMPTY re-resolved stack (a still-speculative shift): ASSEMBLE the stack LOCALLY
 *     (`main + ordered ancestors`) on the dependent's own short-lived runner (the SAME
 *     `assembleBaseShiftStackLive` the opener uses) and gather + re-gate the recorded conflict
 *     against the LOCALLY-ASSEMBLED stack HEAD — NO synthesized host ref.
 *   • an empty stack (a NON-speculative shift): the single-ref clone of `${shiftedBase}@origin`
 *     (plain `default_branch` — a REAL ref, never a synthesized one).
 *
 * Returns `{resolved, headSha}` (the resolved head read back from the forge) or
 * `{resolved:false, reason}` (the coordinator replans — the work stays alive). All tenant
 * reads/writes run under the dependent's org.
 */
export async function resolveBaseShiftConflict(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  /** The shifted base the conflict is gathered + re-gated against (NOT the project default). */
  shiftedBase: string;
  /**
   * WS-A PR-6b (§2.2): the RE-RESOLVED ordered ancestor stack. With a non-empty
   * stack, the resolver ASSEMBLES it LOCALLY and gathers the conflict against the
   * assembled head instead of cloning `${shiftedBase}@origin`. Empty/absent ⇒ the
   * single-ref clone.
   */
  ancestorStack?: AncestorStack;
}): Promise<ConflictResolution> {
  const { deps, ctx, shiftedBase, ancestorStack } = input;
  return runWithJobOrgId(ctx.orgId, async () => {
    const prepared = await prepareResolveWorkspace({ deps, ctx, shiftedBase, ancestorStack });
    const resolved = await runResolverOverWorkspace({
      deps,
      ctx,
      live: prepared.live,
      reGateBaseSha: prepared.reGateBaseSha,
      applierFacts: prepared.applierFacts,
      ...(prepared.preOpenedWorkspace !== undefined && { preOpenedWorkspace: prepared.preOpenedWorkspace }),
    }).catch(async (error: unknown) => {
      // FAIL-CLOSED: a failure BEFORE the applier's gather() took ownership would leak the
      // runner — release it loudly. (Once gather() runs, the applier's terminal step owns
      // release; a second release is a no-op.)
      await prepared.live.release();
      throw error;
    });
    if (!resolved.resolved) {
      return {
        resolved: false,
        recovery: resolved.recovery,
        reason:
          resolved.recovery.kind === "owned"
            ? "the base-shift conflict recovery already has a durable owner"
            : resolved.recovery.message,
      };
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

/** The materialized resolve workspace + the base wiring the resolver gathers/re-gates against. */
interface PreparedResolveWorkspace {
  /** The OPEN live jj workspace the applier resolves over (the caller owns `release()`). */
  live: LiveJjWorkspace;
  /** The applier facts (the rebase TARGET differs per path: a local sha vs `${shiftedBase}@origin`). */
  applierFacts: JjConflictApplierFacts;
  /** The re-gate baseline (the LOCAL assembled head sha, or `shiftedBase`). */
  reGateBaseSha: string;
  /** Present on the jj-local path: the already-assembled workspace the applier gathers over (no re-clone). */
  preOpenedWorkspace?: WorkspaceHandle;
}

/**
 * Materialize the shifted base the conflict is gathered + re-gated against:
 *   • jj-local path (non-empty ancestor stack): ASSEMBLE `main + ordered ancestors` LOCALLY
 *     (`assembleBaseShiftStackLive`) and hand the applier the OPEN workspace + the assembled
 *     head SHA as the rebase target — NO synthesized-ref clone.
 *   • legacy path: a fresh live workspace the applier clones `${shiftedBase}@origin` into,
 *     with `baseRevision = ${shiftedBase}@origin` (byte-identical to before this PR).
 */
async function prepareResolveWorkspace(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  shiftedBase: string;
  ancestorStack?: AncestorStack;
}): Promise<PreparedResolveWorkspace> {
  const { deps, ctx, shiftedBase, ancestorStack } = input;
  if (ancestorStack !== undefined && ancestorStack.length > 0) {
    // ASSEMBLE the re-resolved stack LOCALLY on the dependent's own runner (the SAME assembly
    // the opener runs). The applier then gathers over THIS open workspace and rebases the
    // dependent's head onto the assembled head SHA — never a synthesized host ref.
    const assembled = await assembleBaseShiftStackLive({ deps, ctx, stack: ancestorStack });
    return {
      live: assembled.live,
      // The applier skips the re-clone (`preOpenedWorkspace`) + rebases onto the LOCAL assembled
      // head sha. `baseBranch` stays the default branch (the assembly's clone base) for diagnostics.
      applierFacts: {
        repoUrl: ctx.repoUrl,
        baseBranch: ctx.defaultBranch,
        baseRevision: assembled.assembledHeadSha,
        headBranch: ctx.headBranch,
        ...(ctx.installation !== undefined && { installation: ctx.installation }),
        githubCredentialRef: ctx.githubCredentialRef,
      },
      reGateBaseSha: assembled.assembledHeadSha,
      preOpenedWorkspace: assembled.workspace,
    };
  }
  // NON-speculative shift: a fresh workspace the applier clones `${shiftedBase}@origin`
  // (plain `default_branch` — a REAL ref) into.
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
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  return { live, applierFacts: baseShiftApplierFacts(ctx, shiftedBase), reGateBaseSha: shiftedBase };
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
  live: LiveJjWorkspace;
  /** The applier facts (the rebase target is a LOCAL sha on the jj-local path, else `${shiftedBase}@origin`). */
  applierFacts: JjConflictApplierFacts;
  /** The re-gate baseline (the LOCAL assembled head sha, or `shiftedBase`). */
  reGateBaseSha: string;
  /** Present on the jj-local path: the already-assembled workspace the applier gathers over (no re-clone). */
  preOpenedWorkspace?: WorkspaceHandle;
}): Promise<ConflictResolverResult> {
  const { deps, ctx, live, applierFacts, reGateBaseSha } = input;
  const applier = buildJjConflictApplier({
    live,
    ssh: deps.ssh,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    facts: applierFacts,
    ...(input.preOpenedWorkspace !== undefined && { preOpenedWorkspace: input.preOpenedWorkspace }),
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
    // §3.2 the deterministic entity-merge FIRST-PASS over the SAME live jj workspace. It reads
    // the three conflict terms marker-free (`jj file show -r <rev>`): theirs = the shifted base
    // the rebase landed on (`applierFacts.baseRevision`), ours = the dependent's PRE-rebase head
    // (`<headBranch>@origin`, untouched by the local rebase). A different-entity-same-file
    // conflict splices deterministically (skipping the agent); anything not provably disjoint
    // (or sem-absent / a same-entity edit) defers to the agent resolver below, exactly as today.
    entityFirstPass: buildSemEntityMergeFirstPass(
      { ssh: deps.ssh, target: live.target, workspacePath: live.workspacePath },
      { oursRev: `${ctx.headBranch}@origin`, theirsRev: applierFacts.baseRevision },
    ),
    pool: deps.scopedPool,
    runStateWriter: deps.runStateWriter,
    eventStore: deps.eventStore,
    ssh: deps.ssh,
    secrets: deps.secrets,
    target: live.target,
    workspacePath: live.workspacePath,
    // The re-gate baseline is the SHIFTED base the resolved tree sits on (the resolution is
    // proven against the base it lands on, not the project default): the LOCALLY-assembled
    // stack head sha on the jj-local path, or the single-ref `shiftedBase` on the legacy path.
    baseSha: reGateBaseSha,
    runId: ctx.runId,
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    specId: ctx.specId,
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
    runGate: buildBaseShiftReGate(deps, ctx, live.target, live.workspacePath),
  });
  const result = await resolver({
    runId: ctx.runId,
    prUrl: ctx.repoUrl,
    prNumber: 0,
    baseBranch: applierFacts.baseBranch,
    message: "base-shift rebase conflict",
  });
  return result;
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
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  const advisoryStepNames = advisoryStepNamesForPosture(ctx.governancePosture);
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({ ssh: deps.ssh, target, workspacePath });
    }
    const config = await configPromise;
    // DEPS-BEFORE-GATE (apex v35): install deps on the base-shift resolver's live jj
    // workspace BEFORE the tiers run. The jj-resolved tree has no `node_modules`, so a
    // writer's `./node_modules/.bin/<tool>` tier step is `command not found` (exit 127)
    // until the project's `just bootstrap` runs. Mirrors the drive / fresh-runner re-gate:
    // explicit `.tanren/ci.yml` `bootstrap.run` wins, else the stack-agnostic
    // `DEFAULT_BOOTSTRAP_COMMAND` LOUD-fallback. A failure throws (no silent skip), which
    // the resolver surfaces as a fail-closed re-gate failure (never an unverified pass).
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
          runId: ctx.runId,
          specId: ctx.specId,
          projectId: ctx.projectId,
          orgId: ctx.orgId,
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

/**
 * Read the dependent's head branch sha back from the forge (the resolver force-pushed it),
 * through the host-neutral `CodeHost.fetchRef` seam (decomposition PR-6) rather than a
 * host read. The `CodeHost` is built over the SAME GitHub HTTP client the run holds
 * (`deps.githubHttp`) + a per-call token supplier (the standalone
 * `resolveVcsToken`, §5a); `parseGitHubRepository` is the pure URL parse. Behavior-identical
 * (`fetchRef` ≡ the old `readBranchHeadSha`).
 */
async function readResolvedHeadSha(deps: LiveBaseShiftDeps, ctx: BaseShiftRunContext): Promise<string | undefined> {
  const staticRef = ctx.githubCredentialRef.trim();
  const http = deps.githubHttp;
  const codeHost = new GitHubCodeHost(http, async () => {
    const resolved = await resolveVcsToken(http, {
      secrets: deps.secrets,
      ...(ctx.installation !== undefined && { installation: ctx.installation }),
      ...(staticRef !== "" && { staticRef }),
      ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
    });
    return { token: resolved.token, ...(resolved.refresh !== undefined && { refresh: resolved.refresh }) };
  });
  return codeHost.fetchRef({ repo: parseGitHubRepository(ctx.repoUrl), remoteBranch: ctx.headBranch });
}

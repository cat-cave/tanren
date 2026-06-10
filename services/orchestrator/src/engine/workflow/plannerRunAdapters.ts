/**
 * plannerRunAdapters — the default production adapter/gate/usage-probe builders
 * for the planner loop. Extracted from plannerRun.ts to keep that file under the
 * 500-line architecture cap. These resolve the run's four role adapters from the
 * project's routing table (per-role provider DATA, not a code-level hardcode),
 * wire the lazily-resolved CI gate, and the codexbar + ccusage usage probe.
 */
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import {
  buildAdaptersFromRouting,
  buildSimulatedReviewerAdapter,
  buildSpecQualityValidator,
} from "../providers/adapterSelector.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import { defaultUsageProbe } from "./plannerRunUsage.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// adapter/usage builders (the managed capturer lives in plannerRunUsage).
export { resolveManagedCapturer } from "./plannerRunUsage.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import { PgBudgetGate } from "../dag/budgetGate.js";
import { runBudgetCeilingPreflight } from "./budgetPreflight.js";
import { assertAuditPostureReentersFindings } from "./auditPosturePreflight.js";
import { resolveDefaultAuditPosture } from "../config/index.js";
import type { GateOutcome } from "./gate/index.js";
import { buildDefaultGate } from "./plannerRunGate.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// adapter/gate builders (the gate callback + JUnit ingest live in plannerRunGate).
export { buildDefaultGate } from "./plannerRunGate.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// input-shaping seams (the optional-property folders live in plannerRunSeams).
export { appTokenSeam, loopConfigSeam, nativeQueueSeam, writerSeam } from "./plannerRunSeams.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { AppendEvent, SubtaskLoopAdapters } from "./subtaskLoop.js";
import { buildDefaultConflictResolver } from "./reviewMerge/conflictResolver/index.js";
import { buildJjConflictApplier } from "./reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { conflictResolverJjLive } from "../merge/conflictResolverJjFlag.js";
import type { WorkspaceConflictApplier } from "../contracts/conflictResolution.js";
import type { ConflictResolverHook } from "./reviewMerge/index.js";

// Builds the run's four role adapters (plan/write/check/audit) by resolving the
// project's effective routing table through the shared adapter selector. The
// routing is per-role provider DATA: the writer runs whatever the `write`
// chain's head names (codex/claude/opencode/...) and each answerer whatever its
// role chain names. Codex is the default ONLY because the default routing data
// (built in runExecutionContext) heads every chain with a Codex entry — there is
// no Codex hardcode here. A role whose chain is empty or names an
// unsupported/role-incapable provider is a HARD failure (EmptyRoutingChainError
// / UnsupportedProviderError from the selector) — never a silent Codex fallback.
//
// All four roles share one runId → one CODEX_HOME (codexHomeForRun) when they
// resolve to Codex, so ccusage at run end accounts for the whole run and
// codexbar reads the run's subscription account. The loop is sequential, so
// there is no concurrent write to a shared home.
export function defaultRoutingAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const routing = input.context.routing;
  if (routing === undefined) {
    throw new Error("context.routing is required to build the run adapters from the project routing table");
  }
  return buildAdaptersFromRouting(
    {
      secrets: input.secrets,
      ssh: input.ssh,
      target: ctx.target,
      runId: ctx.runId,
      endpointBaseUrl: input.context.endpointBaseUrl,
    },
    routing,
  );
}

// Builds the simulated reviewer's Answerer (reviewPolicy: "simulated") from the
// project routing — the `audit` chain head, reusing the same adapter seam every
// Answerer uses (Codex by default). Only called when the review stage needs it.
export function defaultSimulatedReviewer(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): AnswererAdapter<ReviewAnswer> {
  const routing = input.context.routing;
  if (routing === undefined) {
    throw new Error(
      "context.routing is required to build the simulated reviewer Answerer from the project routing table",
    );
  }
  return buildSimulatedReviewerAdapter(
    {
      secrets: input.secrets,
      ssh: input.ssh,
      target: ctx.target,
      runId: ctx.runId,
      endpointBaseUrl: input.context.endpointBaseUrl,
    },
    routing,
  );
}

// Builds the spec-quality VALIDATOR (workstream 1) from the project routing — the
// read-only judge over the loop's TRIAGE `kind: spec` items, riding the `audit` chain
// head like the simulated reviewer, so a triaged spec meets the SAME accomplishable/
// demo-able/non-trivial/legible bar as every spec-emitter before it materializes.
//
// LAZY: the underlying provider validator is resolved on the FIRST `.validate()` call,
// not at run setup. The loop's triage only validates when it routes a `kind: spec`
// item, so a run that never emits a new spec never needs it. This keeps the seam off
// the unconditional setup path (where a test injecting fake adapters has no routing),
// while production resolves the REAL validator (and fails loud if routing is genuinely
// absent) exactly when a spec is about to materialize.
export function defaultSpecQualityValidator(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): SpecQualityAnswerer {
  let resolved: SpecQualityAnswerer | undefined;
  return {
    validate(spec) {
      if (resolved === undefined) {
        const routing = input.context.routing;
        if (routing === undefined) {
          throw new Error(
            "context.routing is required to build the spec-quality validator from the project routing table",
          );
        }
        resolved = buildSpecQualityValidator(
          {
            secrets: input.secrets,
            ssh: input.ssh,
            target: ctx.target,
            runId: ctx.runId,
            endpointBaseUrl: input.context.endpointBaseUrl,
          },
          routing,
        );
      }
      return resolved.validate(spec);
    },
  };
}

// The `pollReviewForRun` fields for reviewPolicy: "simulated". The reviewer
// factory is LAZY — invoked only on the simulated branch — so a human/auto run
// never resolves a reviewer adapter. The spec context the reviewer judges
// against is the run's own spec title/description/acceptance-criteria.
export function simulatedReviewSeam(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): {
  simulatedReviewer: () => AnswererAdapter<ReviewAnswer>;
  simulatedReviewContext: {
    specTitle: string;
    specDescription: string;
    acceptanceCriteria: ReadonlyArray<string>;
  };
} {
  return {
    simulatedReviewer: () => (input.buildSimulatedReviewer ?? ((c) => defaultSimulatedReviewer(input, c)))(ctx),
    simulatedReviewContext: {
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
    },
  };
}

// Builds the PRODUCTION default intent-preserving conflict resolver (
// autonomy-engine.md §2b) — the real replacement for `noopConflictResolver` as
// the `resolveConflict` hook the merge stage calls on a detected conflict. It
// composes the run's already-resolved merge-stage context (the runner target +
// workspace, the gate/checker/auditor the loop built, the project routing, the
// run's spec intent, the diff base sha) into the resolver. Tests inject
// `input.resolveConflict` to skip the live runner/model; production omits it →
// this real resolver is the default (§8a: the default of an injectable seam is
// the REAL impl, never a stub).
export function resolveConflictResolverHook(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
): ConflictResolverHook {
  // Test seam: a scripted resolver skips the live runner/model. Production omits
  // it → the real intent-preserving resolver is the default. The `??` lives HERE
  // (not in the workflow function) so the merge-stage call stays a single
  // expression and the workflow's branch count is unchanged.
  return input.resolveConflict ?? defaultConflictResolver(input, deps);
}

/** The runner/workspace + gate/answerer deps the conflict resolver assembles over. */
interface ConflictResolverDeps {
  eventStore: EventStore;
  target: RunnerHandle;
  workspacePath: string;
  baseSha: string;
  runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  checker: SubtaskLoopAdapters["checker"];
  auditor: SubtaskLoopAdapters["auditor"];
  // WS-A PR-4 (walker-jj-local-integration-design.md §4): the merge-time rebase base when
  // the run's base was jj-ASSEMBLED locally from the ancestor stack (`WALKER_JJ_LOCAL_BASE`
  // on) — the LOCAL assembly bookmark, used INSTEAD of `${targetBranch}@origin`. Absent on
  // the legacy single-ref clone path ⇒ the conflict resolver keeps `${targetBranch}@origin`.
  bootstrappedBaseRevision?: string;
}

function defaultConflictResolver(input: RunPlannerLoopInput, deps: ConflictResolverDeps): ConflictResolverHook {
  // LAZY construction: the real resolver (which needs the project routing to
  // resolve its conflict Answerer) is built only when a conflict ACTUALLY occurs
  // and the hook is invoked. So a run that merges cleanly never constructs it —
  // and `context.routing` (always present in production) is required only on the
  // conflict path, where a missing routing is a genuine misconfiguration to fail
  // loudly on, not a silent no-op.: read the run's percolation marker here so
  // a percolation re-execution's conflict is resolved in UPSTREAM-CHANGE mode.
  return async (conflictContext) => {
    const upstreamChange = await readPercolationUpstreamChange(input);
    // Wave-3/S1 CUTOVER (`conflictResolverJjLive()`, default ON): provision a live jj
    // workspace (A1's `buildLiveJjWorkspace`) and run the WHOLE resolver — adapters +
    // re-gate + applier — over that runner + path, so the re-gate judges the
    // jj-resolved tree. `rebaseOnto` RECORDS the conflict (fail-closed, no
    // `git merge --abort` / `|| true` fail-open). A clean run never reaches here, so no
    // jj runner is allocated for the common path. Flag OFF is the clean kill-switch:
    // the run's own runner + the git-merge-abort `SshWorkspaceConflictApplier`.
    if (conflictResolverJjLive()) {
      return resolveOverLiveJj(input, deps, upstreamChange, conflictContext);
    }
    return buildResolver(input, deps, upstreamChange)(conflictContext);
  };
}

/**
 * Resolve an in-loop conflict over a freshly-provisioned live jj workspace. Mirrors the
 * drive-path jj resolve: build the live workspace, build the conflict adapters + re-gate
 * over its runner + path (so the re-gate runs against the jj-resolved tree), build the jj
 * applier, assemble the resolver, run it. The jj applier owns releasing the live
 * workspace on its terminal step; a failure BEFORE its gather() took ownership releases
 * the runner loudly here (never a leaked runner).
 */
async function resolveOverLiveJj(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
  upstreamChange: { ancestorSpecId: string; changeSummary: string } | undefined,
  conflictContext: Parameters<ConflictResolverHook>[0],
): Promise<{ resolved: boolean }> {
  const context = input.context;
  const orgId = typeof context.orgId === "string" ? context.orgId : "";
  const live = await buildLiveJjWorkspace({
    facts: {
      orgId,
      projectId: context.projectId,
      repoUrl: context.repoUrl,
      runnerImage: context.runnerImage,
      ...(context.installation !== undefined && { installation: context.installation }),
      githubCredentialRef: context.githubCredentialRef,
      identitySecretRef: context.identitySecretRef,
    },
    allocator: input.allocator,
    ssh: input.ssh,
    secrets: input.secrets,
    vcsProvider: input.vcsProvider,
    ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
    timeoutMs: input.timeoutMs,
  });
  const applier = buildJjConflictApplier({
    live,
    ssh: input.ssh,
    secrets: input.secrets,
    vcsProvider: input.vcsProvider,
    ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
    facts: {
      repoUrl: context.repoUrl,
      baseBranch: context.targetBranch,
      // The merge-time base the PR head rebases onto (never-discard, conflict recorded).
      // WS-A PR-4: when the run's base was jj-assembled locally (flag on + non-empty stack)
      // the base is the LOCAL assembly bookmark `bootstrappedBaseRevision`, NOT the
      // freshly-cloned `${targetBranch}@origin` — the PR head rebases onto the re-assembled
      // stack head. (PR-6 makes the merge-time opener re-assemble that stack; PR-4 threads
      // the base name.) Absent ⇒ the legacy single-ref clone base, unchanged.
      baseRevision: deps.bootstrappedBaseRevision ?? `${context.targetBranch}@origin`,
      headBranch: context.runBranch,
      ...(context.installation !== undefined && { installation: context.installation }),
      githubCredentialRef: context.githubCredentialRef,
    },
    timeoutMs: input.timeoutMs,
  });
  try {
    // The adapters + re-gate run over the jj workspace's runner + path; the re-gate
    // baseline is the merge-time base branch (the resolved tree sits on it). ONLY the
    // workspace mechanism changed — the classify/re-gate/replan logic is identical.
    const jjAdapters = buildAdaptersFromRouting(
      {
        secrets: input.secrets,
        ssh: input.ssh,
        target: live.target,
        runId: context.runId,
        ...(context.endpointBaseUrl !== undefined && { endpointBaseUrl: context.endpointBaseUrl }),
      },
      requireRouting(context.routing),
    );
    const resolver = buildResolver(
      input,
      {
        eventStore: deps.eventStore,
        target: live.target,
        workspacePath: live.workspacePath,
        baseSha: context.targetBranch,
        runGate: buildDefaultGate(input, live.target, live.workspacePath, deps.eventStore),
        checker: jjAdapters.checker,
        auditor: jjAdapters.auditor,
      },
      upstreamChange,
      applier,
    );
    return await resolver(conflictContext);
  } catch (error) {
    // FAIL-CLOSED: a failure before the applier's gather() took workspace ownership
    // would leak the runner — release it loudly. (Once gather() runs, the applier's
    // terminal publish/abort owns release; releasing twice is a no-op there.)
    await live.release();
    throw error;
  }
}

function requireRouting(routing: RunPlannerLoopInput["context"]["routing"]): NonNullable<typeof routing> {
  if (routing === undefined) {
    throw new Error("context.routing is required to build the intent-preserving conflict resolver");
  }
  return routing;
}

/**
 * Read the run's in-flight percolation marker (`percolation_pending`). When set,
 * THIS run is a change-percolation re-execution absorbing an ancestor's change, so
 * the resolver runs in upstream-change mode (the ancestor's change flows INTO this
 * spec). Returns undefined for a normal (non-percolation) run.
 */
async function readPercolationUpstreamChange(
  input: RunPlannerLoopInput,
): Promise<{ ancestorSpecId: string; changeSummary: string } | undefined> {
  const result = await input.pool.query<{ percolation_pending: unknown }>(
    "SELECT percolation_pending FROM runs WHERE run_id = $1",
    [input.context.runId],
  );
  const marker = result.rows[0]?.percolation_pending;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const ancestorSpecId = (marker as Record<string, unknown>)["ancestorSpecId"];
  const toSha = (marker as Record<string, unknown>)["toSha"];
  if (typeof ancestorSpecId !== "string") return undefined;
  return {
    ancestorSpecId,
    changeSummary: `the upstream change from ${ancestorSpecId}${typeof toSha === "string" ? ` (head ${toSha})` : ""}`,
  };
}

function buildResolver(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
  upstreamChange?: { ancestorSpecId: string; changeSummary: string },
  applier?: WorkspaceConflictApplier,
): ConflictResolverHook {
  const context = input.context;
  const routing = requireRouting(context.routing);
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  return buildDefaultConflictResolver({
    ...(applier !== undefined && { applier }),
    pool: input.pool,
    ...(input.runStateWriter !== undefined && { runStateWriter: input.runStateWriter }),
    eventStore: deps.eventStore,
    ssh: input.ssh,
    secrets: input.secrets,
    target: deps.target,
    workspacePath: deps.workspacePath,
    baseSha: deps.baseSha,
    timeoutMs: input.timeoutMs,
    runId: context.runId,
    projectId: context.projectId,
    ...(orgId !== undefined && { orgId }),
    specId: context.specId,
    specTitle: context.specTitle,
    specDescription: context.specDescription,
    acceptanceCriteria: context.acceptanceCriteria,
    baseBranch: context.targetBranch,
    headBranch: context.runBranch,
    ...(context.endpointBaseUrl !== undefined && { endpointBaseUrl: context.endpointBaseUrl }),
    routing,
    checker: deps.checker,
    auditor: deps.auditor,
    runGate: deps.runGate,
    ...(upstreamChange !== undefined && { upstreamChange }),
  });
}

/**
 * Build the run's adapters + usage probe through the injectable factories, then
 * run the BUDGET-SAFETY (M6) ceiling-reachability preflight: a configured dollar
 * ceiling against a subscription/self-hosted credential with no usage probe is
 * structurally unreachable, so the run fails closed at setup (a loud
 * `cost.ceiling_unreachable` event + a thrown error). The budget gate is the
 * injectable `input.budgetGate` seam, defaulting to the pg-backed PgBudgetGate over
 * `input.pool` (the narrow type is for test ergonomics; tests inject a gate seam).
 */
export async function resolveRunAdaptersWithBudgetPreflight(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
  appendEvent: AppendEvent,
): Promise<{
  adapters: SubtaskLoopAdapters;
  usageProbe: UsageProbe | undefined;
  specValidator: SpecQualityAnswerer;
  // The resolved budget gate (audit §3.7a) — threaded into the loop for the PER-ITERATION
  // halt-on-ceiling, so it shares the SAME gate the preflight used (no second construction).
  budgetGate: BudgetGate;
}> {
  const adapters = (input.buildAdapters ?? ((c) => defaultRoutingAdapters(input, c)))(ctx);
  // WORKSTREAM 1 ↔ 2 SEAM — the spec-quality validator the loop's TRIAGE gates its
  // `kind: spec` items through. Resolved here (the same place the loop adapters are)
  // so it shares the run's routing/runner; tests override via `buildSpecValidator`.
  const specValidator = (input.buildSpecValidator ?? ((c) => defaultSpecQualityValidator(input, c)))(ctx);
  // The codex usage probe (ccusage + codexbar) is codex-specific. Build it when ANY
  // role adapter is codex (a mixed route still consumes the codex subscription) so
  // codex window pressure is always observed; a run with no codex role gets none.
  const usesCodex = [adapters.planner, adapters.writer, adapters.checker, adapters.auditor].some(
    (a) => a.cli === "codex",
  );
  const usageProbe = input.buildUsageProbe
    ? input.buildUsageProbe(ctx)
    : usesCodex
      ? defaultUsageProbe(input, ctx)
      : undefined;
  const budgetGate = input.budgetGate ?? new PgBudgetGate(input.pool as pg.Pool);
  // Ceiling reachability is about the WRITER's credential: a subscription writer's
  // spend is observable only when a probe covers IT (writer is codex AND a codex
  // probe exists), so a non-codex subscription writer fails closed even if a codex
  // answerer wired a probe (that probe observes codex, not the writer's provider).
  const writerObservable = usageProbe !== undefined && adapters.writer.cli === "codex";
  await runBudgetCeilingPreflight(
    budgetGate,
    input.context.projectId,
    adapters.writer.authRef,
    writerObservable,
    appendEvent,
  );
  // LOOP 3 — AUDIT-POSTURE PREFLIGHT. For an AUTONOMOUS run (the `lenient` apex tier —
  // functional-but-weak autonomous build, no operator in the loop), assert the
  // resolved `auditPosture` RE-ENTERS scheduled-audit findings into the DAG (residual
  // routes/fixes AND blocking findings become remediation specs). A posture that would
  // strand findings silently no-ops the audit→fix→merge proof, so the run FAILS CLOSED
  // at setup (a loud `audit.posture_strands_findings` event + a thrown error). A
  // non-autonomous run is a no-op (a parked blocking finding is its intended human-stop).
  await assertAuditPostureReentersFindings(
    {
      autonomous: input.context.governancePosture === "lenient",
      // The absent-posture default is APEX-MODE-AWARE: under apex mode an autonomous run
      // whose context carries no explicit `auditPosture` resolves to the AUTONOMOUS
      // posture (findings re-enter the DAG) so THIS preflight PASSES without manual
      // per-run config; a non-autonomous run keeps the conservative BALANCED default.
      posture: input.context.auditPosture ?? resolveDefaultAuditPosture(),
    },
    appendEvent,
  );
  return { adapters, usageProbe, specValidator, budgetGate };
}

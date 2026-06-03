/**
 * plannerRunAdapters — the default production adapter/gate/usage-probe builders
 * for the planner loop. Extracted from plannerRun.ts to keep that file under the
 * 500-line architecture cap. These resolve the run's four role adapters from the
 * project's routing table (per-role provider DATA, not a code-level hardcode),
 * wire the lazily-resolved CI gate, and the codexbar + ccusage usage probe.
 */
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import { buildAdaptersFromRouting, buildSimulatedReviewerAdapter } from "../providers/adapterSelector.js";
import type { AnswererAdapter } from "../providers/types.js";
import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { PgBudgetGate } from "../dag/budgetGate.js";
import { runBudgetCeilingPreflight } from "./budgetPreflight.js";
import {
  advisoryStepNamesForPosture,
  type GateOutcome,
  resolveBootstrapCommand,
  resolveGateConfig,
  runGateForWhen,
} from "./gate/index.js";
import { ensureWorkspaceDepsInstalled } from "../workspace/index.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { AppendEvent, SubtaskLoopAdapters } from "./subtaskLoop.js";
import { buildDefaultConflictResolver } from "./reviewMerge/conflictResolver/index.js";
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

// Builds the PRODUCTION default intent-preserving conflict resolver (P2b,
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
  deps: {
    eventStore: EventStore;
    target: SshTarget;
    workspacePath: string;
    baseSha: string;
    runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
    checker: SubtaskLoopAdapters["checker"];
    auditor: SubtaskLoopAdapters["auditor"];
  },
): ConflictResolverHook {
  // Test seam: a scripted resolver skips the live runner/model. Production omits
  // it → the real intent-preserving resolver is the default. The `??` lives HERE
  // (not in the workflow function) so the merge-stage call stays a single
  // expression and the workflow's branch count is unchanged.
  return input.resolveConflict ?? defaultConflictResolver(input, deps);
}

function defaultConflictResolver(
  input: RunPlannerLoopInput,
  deps: {
    eventStore: EventStore;
    target: SshTarget;
    workspacePath: string;
    baseSha: string;
    runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
    checker: SubtaskLoopAdapters["checker"];
    auditor: SubtaskLoopAdapters["auditor"];
  },
): ConflictResolverHook {
  // LAZY construction: the real resolver (which needs the project routing to
  // resolve its conflict Answerer) is built only when a conflict ACTUALLY occurs
  // and the hook is invoked. So a run that merges cleanly never constructs it —
  // and `context.routing` (always present in production) is required only on the
  // conflict path, where a missing routing is a genuine misconfiguration to fail
  // loudly on, not a silent no-op. P2c-2: read the run's percolation marker here so
  // a percolation re-execution's conflict is resolved in UPSTREAM-CHANGE mode.
  return async (conflictContext) => {
    const upstreamChange = await readPercolationUpstreamChange(input);
    return buildResolver(input, deps, upstreamChange)(conflictContext);
  };
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
  deps: {
    eventStore: EventStore;
    target: SshTarget;
    workspacePath: string;
    baseSha: string;
    runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
    checker: SubtaskLoopAdapters["checker"];
    auditor: SubtaskLoopAdapters["auditor"];
  },
  upstreamChange?: { ancestorSpecId: string; changeSummary: string },
): ConflictResolverHook {
  const context = input.context;
  const routing = context.routing;
  if (routing === undefined) {
    throw new Error("context.routing is required to build the intent-preserving conflict resolver");
  }
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  return buildDefaultConflictResolver({
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

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run, so a malformed tanren-ci.yml surfaces at the first gate
// rather than crashing the workflow before the loop starts. Each call runs the
// tiers mapped to `when` over SSH and emits gate.* through the run's store.
//
// GREENFIELD DEPS-ENSURE: before EVERY gate the callback runs a guarded
// `ensureWorkspaceDepsInstalled` (install only when a manifest now exists AND
// node_modules is absent). prepareRunWorkspace bootstraps ONCE right after clone,
// before the writer — but a greenfield clone HEAD ships no manifest, so that cold
// bootstrap skips install; the writer THEN authors `package.json`, and without
// this the first per-iteration gate would run `pnpm lint` against an uninstalled
// tree (`turbo: not found`). The install command is resolved LAZILY (cached
// alongside the config) so a writer-authored `tanren-ci.yml` `bootstrap.run` is
// honored; an `installed` flag is cached so once node_modules exists the next
// gate's ensure is a no-op. Brownfield (deps installed at prepare) → the stat
// check no-ops, behavior unchanged.
export function buildDefaultGate(
  input: RunPlannerLoopInput,
  target: SshTarget,
  workspacePath: string,
  eventStore: EventStore,
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  const context = input.context;
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  // The lazily-resolved install command, cached alongside configPromise. An
  // explicit input.bootstrapCommand wins; otherwise the writer-authored
  // tanren-ci.yml `bootstrap.run` is picked up (undefined ⇒ the deps-ensure step
  // falls back to its pnpm/npm-detecting DEFAULT_BOOTSTRAP_COMMAND).
  let installCommandPromise: Promise<string | undefined> | undefined;
  // Cached once node_modules exists, so pre_audit / later gates do not re-stat.
  let depsInstalled = false;
  // The advisory (warn-but-don't-block) step names for the run's governance
  // posture: `lenient` ⇒ {lint, typecheck} are advisory; every other posture ⇒
  // empty set (strict default — every step blocks, behavior unchanged).
  const advisoryStepNames = advisoryStepNamesForPosture(context.governancePosture);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId,
      eventType,
      payload,
    });
  };
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({
        ssh: input.ssh,
        target,
        workspacePath,
        timeoutMs: input.timeoutMs,
      });
    }
    if (installCommandPromise === undefined) {
      installCommandPromise =
        input.bootstrapCommand === undefined
          ? resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs })
          : Promise.resolve(input.bootstrapCommand);
    }
    // Install deps before the gate runs (idempotent). Once an ensure call has
    // installed (or observed) node_modules we cache the flag and skip the stat.
    if (!depsInstalled) {
      const installCommand = await installCommandPromise;
      const ensured = await ensureWorkspaceDepsInstalled({
        ssh: input.ssh,
        target,
        workspacePath,
        ...(installCommand === undefined ? {} : { command: installCommand }),
        ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
        timeoutMs: input.timeoutMs,
      });
      // The ensure is a no-op either because deps were already present OR because
      // no manifest exists yet. We only latch `depsInstalled` once it actually
      // installed — a manifest-less no-op must re-check at the next gate (the
      // writer may have authored a manifest since), but an install means
      // node_modules now exists so subsequent gates can skip the stat.
      if (ensured.installed) {
        depsInstalled = true;
      }
    }
    const config = await configPromise;
    return runGateForWhen({
      ssh: input.ssh,
      target,
      workspacePath,
      config,
      when,
      timeoutMs: input.timeoutMs,
      appendEvent,
      taskId,
      advisoryStepNames,
      // Plane B: the project's dev+test app env, so the building agent's gate
      // commands run with it. Never logged/emitted. Distinct from Tanren creds.
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
    });
  };
}

export function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  return new SshUsageProbe({
    monitor: new SshCodexbarUsageMonitor(input.ssh),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    timeoutMs: input.timeoutMs,
    pressureThresholdPercent: input.pressureThresholdPercent,
  });
}

/**
 * Build the run's adapters + usage probe through the injectable factories (the
 * production defaults above, or test-injected ones), then run the BUDGET-SAFETY
 * (M6) ceiling-reachability preflight: a configured dollar ceiling against a
 * subscription/self-hosted credential with no usage probe is structurally
 * unreachable, so the run fails closed at setup (a loud `cost.ceiling_unreachable`
 * event + a thrown error). Consolidated here so plannerRun threads it in one call
 * (keeping that file under the 500-line cap). The budget gate is the injectable
 * `input.budgetGate` seam, defaulting to the pg-backed PgBudgetGate over `input.pool`
 * (a real `pg.Pool` at runtime — deps.pool / orgScopingPool; the narrow type is for
 * test ergonomics, and tests over a query-only pool inject a budget-gate seam).
 */
export async function resolveRunAdaptersWithBudgetPreflight(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
  appendEvent: AppendEvent,
): Promise<{ adapters: SubtaskLoopAdapters; usageProbe: UsageProbe | undefined }> {
  const adapters = (input.buildAdapters ?? ((c) => defaultRoutingAdapters(input, c)))(ctx);
  const usageProbe = (input.buildUsageProbe ?? ((c) => defaultUsageProbe(input, c)))(ctx);
  const budgetGate = input.budgetGate ?? new PgBudgetGate(input.pool as pg.Pool);
  await runBudgetCeilingPreflight(
    budgetGate,
    input.context.projectId,
    adapters.writer.authRef,
    usageProbe !== undefined,
    appendEvent,
  );
  return { adapters, usageProbe };
}

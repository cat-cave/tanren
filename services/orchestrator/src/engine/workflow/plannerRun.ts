// P2A-0015 (medium tier): the real planner-loop run-trigger. This is the
// production analogue of runPhase1FixtureWorkflow, but instead of a linear
// write/check/audit it drives the full P2A-0012 planner feedback loop
// (runSubtaskLoop) with real Codex adapters and a live usage probe.
//
// The workflow stays generic and testable: adapters + the usage probe are
// built through injectable factories that DEFAULT to real Codex / SSH usage
// monitors. Tests inject fakes (and omit codexCredentialRef so no auth is
// materialized). The acceptance driver (scripts/acceptance/medium.ts) uses the
// defaults to exercise the live path end-to-end.
//
// On a passing loop the workflow publishes a draft PR and polls CI (the same
// tail Phase 1 lives-proved), then upgrades run state. Non-pass loop outcomes
// (window_exhausted / retry_budget_exhausted / halted) map to a halted run
// without a PR. A Codex usage-limit thrown mid-loop is caught and recorded as
// window_exhausted rather than a generic failure (PROJECT_BRIEF §4.3).
import type pg from "pg";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { CiWhen } from "../ci/index.js";
import type { EscapeHatches } from "../config/shared.js";
import type { Allocator, RunnerAllocation, SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import { type EventName, type EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { CodexUsageLimitError, createCodexAnswerer, createCodexWriter } from "../providers/codex.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { bootstrapWorkspace, WorkspaceBootstrapError, runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";
import { pollCiForRun, type PollCiForRunResult } from "./ciPolling.js";
import { type GateOutcome, resolveGateConfig, runGateForWhen } from "./gate/index.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import {
  mergeForRun,
  pollReviewForRun,
  type ConflictResolverHook,
  type MergeForRunResult,
  type MergeProbe,
  type PollReviewForRunResult,
  type ReviewProbe
} from "./reviewMerge/index.js";
import { reviewerRejection } from "./reviewMerge/steering.js";
import { runSubtaskLoop, type SubtaskLoopAdapters, type SubtaskLoopOutcome } from "./subtaskLoop.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PlannerRunContext {
  runId: string;
  specId: string;
  projectId: string;
  repoUrl: string;
  targetBranch: string;
  runBranch: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  behaviorIds?: string[];
  behaviorContext?: ReadonlyArray<{ id: string; title: string; description: string }>;
  runnerImage: string;
  identitySecretRef: string;
  githubCredentialRef: string;
  // Required to build the default (real Codex) adapters + usage probe. Tests
  // that inject buildAdapters/buildUsageProbe may omit it.
  codexCredentialRef?: string;
}

export interface PlannerRunAdapterContext {
  runId: string;
  target: SshTarget;
  // The shared per-run CODEX_HOME every Codex role materializes against, so a
  // single ccusage read at run end sees the whole run and the codexbar window
  // pre-flight reads the run's account.
  codexHome: string;
}

export interface RunPlannerLoopInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  context: PlannerRunContext;
  escapeHatches: Pick<EscapeHatches, "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure">;
  timeoutMs: number;
  workspacePath?: string;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // P3-0006: the install command run over SSH in the workspace after clone and
  // before the writer loop, so gating + intent-checking see a built tree.
  // Omitted → the default pnpm/npm-detecting command (DEFAULT_BOOTSTRAP_COMMAND).
  // TODO: source from tanren-ci.yml (P3-0004) once merged.
  bootstrapCommand?: string;
  // Test seam: when omitted, the real bootstrapWorkspace runs over SSH. Tests
  // that drive the loop with a RecordingSsh fake inject a no-op (or scripted
  // failure) so unit runs never depend on a real install.
  runBootstrap?: (input: BootstrapStepInput) => Promise<void>;
  // P3-0005 test seam: the deterministic gate the loop runs per writer
  // iteration (fast tier) and before audit (slow tier). When omitted, the
  // default reads the workspace's tanren-ci.yml (or the P3-0004 default) and
  // runs the mapped tiers over SSH. Tests inject a mock to assert routing
  // without a live runner.
  runGate?: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // Test seams. Omitted in production → real Codex adapters + SSH usage probe.
  buildAdapters?: (ctx: PlannerRunAdapterContext) => SubtaskLoopAdapters;
  buildUsageProbe?: (ctx: PlannerRunAdapterContext) => UsageProbe | undefined;
  // P3-0008 review→merge tail seams. Omitted in production → the real GitHub
  // review/merge stages drive through the P3-0003 resolver. Tests inject mocks
  // so unit runs never hit GitHub.
  reviewProbe?: ReviewProbe;
  mergeProbe?: MergeProbe;
  resolveConflict?: ConflictResolverHook;
  // Max review→rework re-entries before the run halts pending operator action.
  maxReviewReworks?: number;
}

export interface BootstrapStepInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  command?: string;
  timeoutMs: number;
}

export interface PlannerRunResult {
  runId: string;
  workspacePath: string;
  outcome: SubtaskLoopOutcome;
  pullRequest?: PublishedDraftPullRequest;
  ci?: PollCiForRunResult;
  // P3-0008 review→merge tail. `review` carries the final review verdict and
  // `merge` the merge-stage outcome. Both omitted when the run halted before CI
  // or stopped at changes-requested after exhausting the rework budget.
  review?: PollReviewForRunResult;
  merge?: MergeForRunResult;
}

export async function runPlannerLoopWorkflow(input: RunPlannerLoopInput): Promise<PlannerRunResult> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = input.context;
  const workspacePath = input.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const recorder = new CostRecorder(input.pool, eventStore);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({ runId: context.runId, specId: context.specId, projectId: context.projectId, taskId, eventType, payload });
  };

  await input.pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [context.runId]);
  await supersedeQueuedPlannerTask(input.pool, context.runId);
  const allocation = await input.allocator.allocate({
    runId: context.runId,
    projectId: context.projectId,
    runnerImage: context.runnerImage,
    identitySecretRef: context.identitySecretRef
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  try {
    await prepareWorkspace(input, allocation.target, workspacePath);
    await appendEvent("workspace.prepared", { workspacePath, repoUrl: context.repoUrl, targetBranch: context.targetBranch });

    // P3-0006: install the target repo's deps in the freshly-cloned workspace
    // before the writer loop, so the checker/auditor gate a built tree.
    const runBootstrap = input.runBootstrap ?? ((stepInput) => bootstrapWorkspace(stepInput).then(() => undefined));
    await runBootstrap({
      ssh: input.ssh,
      target: allocation.target,
      workspacePath,
      command: input.bootstrapCommand,
      timeoutMs: input.timeoutMs
    });

    const adapterCtx: PlannerRunAdapterContext = {
      runId: context.runId,
      target: allocation.target,
      codexHome: codexHomeForRun(context.runId)
    };
    const adapters = (input.buildAdapters ?? ((ctx) => defaultCodexAdapters(input, ctx)))(adapterCtx);
    const usageProbe = (input.buildUsageProbe ?? ((ctx) => defaultUsageProbe(input, ctx)))(adapterCtx);

    // P3-0005: the deterministic gate runs on the just-bootstrapped workspace.
    // Resolve the CI config once (tanren-ci.yml, else the default) and run the
    // tiers mapped to each lifecycle point over SSH — exit codes only, no
    // Answerer. Tests inject input.runGate to skip the live runner.
    const runGate = input.runGate ?? buildDefaultGate(input, allocation.target, workspacePath, eventStore);

    // P3-0008: the write→gate→PR→CI→review tail can re-enter on a
    // changes-requested review, re-running the loop with the reviewer feedback
    // seeded as planner steering, up to maxReviewReworks. On approval it
    // proceeds to the merge stage; on a non-pass loop it halts as before.
    const maxReworks = input.maxReviewReworks ?? 1;
    const seedRejections: PlannerRejectionFeedback[] = [];
    let outcome: SubtaskLoopOutcome | undefined;
    let pullRequest: PublishedDraftPullRequest | undefined;
    let ci: PollCiForRunResult | undefined;
    let review: PollReviewForRunResult | undefined;

    for (let reworks = 0; ; reworks += 1) {
      outcome = await runSubtaskLoop({
        pool: input.pool,
        eventStore,
        recorder,
        adapters,
        context: {
          specTitle: context.specTitle,
          specDescription: context.specDescription,
          acceptanceCriteria: context.acceptanceCriteria,
          behaviorIds: context.behaviorIds ?? [],
          behaviorContext: context.behaviorContext ?? [],
          runId: context.runId,
          specId: context.specId,
          projectId: context.projectId,
          workspacePath
        },
        escapeHatches: input.escapeHatches,
        timeoutMs: input.timeoutMs,
        usageProbe,
        runGate,
        seedRejections: [...seedRejections]
      });

      if (outcome.kind !== "passed") {
        await finalizeNonPass(input.pool, context.runId, runOutcomeFor(outcome));
        return { runId: context.runId, workspacePath, outcome };
      }

      pullRequest = await publishDraftPullRequest({
        pool: input.pool,
        eventStore,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        ssh: input.ssh,
        target: allocation.target,
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        workspacePath,
        repoUrl: context.repoUrl,
        targetBranch: context.targetBranch,
        runBranch: context.runBranch,
        title: `Tanren: ${context.specTitle}`,
        body: context.specDescription,
        githubCredentialRef: context.githubCredentialRef,
        timeoutMs: input.timeoutMs
      });
      ci = await pollCiUntilTerminal(input);

      review = await pollReviewForRun({
        pool: input.pool,
        eventStore,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        runId: context.runId,
        maxPolls: input.maxCiPolls,
        pollDelayMs: input.ciPollDelayMs,
        sleep: input.sleep,
        reviewProbe: input.reviewProbe
      });

      if (review.verdict === "approved") {
        break;
      }
      if (review.verdict === "changes_requested" && reworks < maxReworks) {
        // Re-enter the writer loop with the reviewer feedback as planner
        // steering. The spec returns to in_flight; the next pass re-plans
        // against the changes-requested feedback.
        seedRejections.push(reviewerRejection(review, pullRequest.branch));
        await input.pool.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [context.specId]);
        continue;
      }
      // Pending after the budget, or changes-requested with the rework budget
      // exhausted: halt for operator action (surfaces on the review sub-surface
      // + the recovery surface). No merge.
      await finalizeNonPass(input.pool, context.runId, "halted");
      return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review };
    }

    const merge = await mergeForRun({
      pool: input.pool,
      eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: context.runId,
      mergeProbe: input.mergeProbe,
      resolveConflict: input.resolveConflict
    });

    if (merge.outcome === "conflict") {
      // A merge conflict is recoverable: halt the run with the conflict surfaced
      // (merge.conflict already emitted) for the P2B-0008 recovery surface /
      // future conflict resolver. The spec is not marked done.
      await finalizeNonPass(input.pool, context.runId, "halted");
      return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review, merge };
    }
    if (merge.outcome === "failed") {
      await input.pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
      return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review, merge };
    }

    // merged / queued / handed_off: the run's job is done. A direct merge marks
    // the spec merged; a queue/hand-off leaves the merge to Mergify/an operator,
    // so the spec is review-complete (done) and the merge event records the rest.
    const specStatus = merge.outcome === "merged" ? "merged" : "done";
    await input.pool.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [context.specId, specStatus]);
    await input.pool.query("UPDATE runs SET status = 'done', outcome = 'ok', ended_at = now() WHERE run_id = $1", [context.runId]);
    return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review, merge };
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) {
      // Dependency install failed: the workspace can't build/test, so the run
      // can't be gated. Surface it as a halting, recoverable outcome (lands on
      // the P2B-0008 recovery surface) rather than a crash, reusing the
      // workspace.failed event + the halted run state.
      await appendEvent("workspace.failed", { workspacePath, message: error.message });
      await finalizeNonPass(input.pool, context.runId, "halted");
      throw error;
    }
    if (error instanceof CodexUsageLimitError) {
      // Authenticated but out of quota mid-loop: a recoverable window state,
      // not a crash (PROJECT_BRIEF §4.3). Record it as such.
      await finalizeNonPass(input.pool, context.runId, "window_exhausted");
      await appendEvent("usage.window.pressure", {
        provider: "openai",
        slot: "primary",
        usedPercent: 100,
        resetsAt: new Date().toISOString()
      });
      throw error;
    }
    await input.pool.query("UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1", [context.runId]);
    throw error;
  } finally {
    await input.allocator.release(allocation.runnerId);
    await appendEvent("runner.released", { runnerId: allocation.runnerId });
  }
}

function defaultCodexAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const credentialRef = input.context.codexCredentialRef;
  if (credentialRef === undefined || credentialRef === "") {
    throw new Error("codexCredentialRef is required to build the default Codex adapters");
  }
  // All four roles share one runId → one CODEX_HOME (codexHomeForRun), so
  // ccusage at run end accounts for the whole run and codexbar reads the run's
  // subscription account. The loop is sequential, so there is no concurrent
  // write to the shared home.
  const deps = { secrets: input.secrets, ssh: input.ssh, target: ctx.target, credentialRef, runId: ctx.runId };
  return {
    planner: createCodexAnswerer<PlanAnswer>(deps),
    writer: createCodexWriter(deps),
    checker: createCodexAnswerer<CheckAnswer>(deps),
    auditor: createCodexAnswerer<AuditAnswer>(deps)
  };
}

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run, so a malformed tanren-ci.yml surfaces at the first gate
// rather than crashing the workflow before the loop starts. Each call runs the
// tiers mapped to `when` over SSH and emits gate.* through the run's store.
function buildDefaultGate(
  input: RunPlannerLoopInput,
  target: SshTarget,
  workspacePath: string,
  eventStore: EventStore
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  const context = input.context;
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({ runId: context.runId, specId: context.specId, projectId: context.projectId, taskId, eventType, payload });
  };
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs });
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
      taskId
    });
  };
}

function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  return new SshUsageProbe({
    monitor: new SshCodexbarUsageMonitor(input.ssh),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    timeoutMs: input.timeoutMs,
    pressureThresholdPercent: input.pressureThresholdPercent
  });
}

// Maps a non-pass loop outcome to the persisted run.outcome value. All map to a
// halted run (no PR); the distinct outcome value preserves WHY it stopped.
function runOutcomeFor(outcome: SubtaskLoopOutcome): "window_exhausted" | "retry_budget_exhausted" | "halted" {
  if (outcome.kind === "window_exhausted") {
    return "window_exhausted";
  }
  if (outcome.kind === "retry_budget_exhausted") {
    return "retry_budget_exhausted";
  }
  return "halted";
}

async function finalizeNonPass(
  pool: RunStateClient,
  runId: string,
  outcome: "window_exhausted" | "retry_budget_exhausted" | "halted"
): Promise<void> {
  await pool.query("UPDATE runs SET status = 'halted', outcome = $2, ended_at = now() WHERE run_id = $1", [runId, outcome]);
}

// The spec-run trigger pre-creates a queued 'plan' task + job_queue row for the
// async worker path. This workflow executes the run directly and the loop
// creates its own planner task, so the pre-created artifacts are vestigial —
// cancel them so the run does not carry a dangling queued task.
async function supersedeQueuedPlannerTask(pool: RunStateClient, runId: string): Promise<void> {
  await pool.query("UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'", [
    runId
  ]);
  await pool.query("UPDATE job_queue SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'", [runId]);
}

async function prepareWorkspace(input: RunPlannerLoopInput, target: SshTarget, workspacePath: string): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(workspacePath)}`,
      `git clone --depth 1 --branch ${quoteSshShellArg(input.context.targetBranch)} ${quoteSshShellArg(input.context.repoUrl)} ${quoteSshShellArg(workspacePath)}`,
      `cd ${quoteSshShellArg(workspacePath)}`,
      "git config user.name 'Tanren Planner'",
      "git config user.email 'planner@tanren.invalid'"
    ].join(" && ")
  });
}

async function pollCiUntilTerminal(input: RunPlannerLoopInput): Promise<PollCiForRunResult> {
  const maxPolls = input.maxCiPolls ?? 12;
  const delayMs = input.ciPollDelayMs ?? 10_000;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: PollCiForRunResult | undefined;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    last = await pollCiForRun({
      pool: input.pool,
      eventStore: input.eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: input.context.runId,
      githubCredentialRef: input.context.githubCredentialRef
    });
    if (last.status === "passed") {
      return last;
    }
    if (last.status === "failed") {
      throw new Error(`planner-loop CI failed: ${last.reason}`);
    }
    if (attempt < maxPolls - 1) {
      await sleep(delayMs);
    }
  }
  throw new Error(`planner-loop CI did not finish after ${maxPolls} polls: ${last?.reason ?? "not_polled"}`);
}

function runnerPayload(allocation: RunnerAllocation) {
  return {
    runnerId: allocation.runnerId,
    imageSha: allocation.imageSha,
    target: {
      host: allocation.target.host,
      port: allocation.target.port,
      username: allocation.target.username,
      hostKeyFingerprint: allocation.target.hostKeyFingerprint
    }
  };
}

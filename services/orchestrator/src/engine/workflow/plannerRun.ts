// P2A-0015 (medium tier): the real planner-loop run-trigger. This is the
// production analogue of runPhase1FixtureWorkflow, but instead of a linear
// write/check/audit it drives the full P2A-0012 planner feedback loop
// (runSubtaskLoop) with real Codex adapters and a live usage probe.
//
// The workflow stays generic and testable: adapters + the usage probe are
// built through injectable factories that DEFAULT to real Codex / SSH usage
// monitors. Tests inject fakes (and omit codexCredentialRef so no auth is
// materialized). In production the background run worker (executeNextPlanJob)
// drives this with the defaults to exercise the live path end-to-end.
//
// On a passing loop the workflow publishes a draft PR and polls CI (the same
// tail Phase 1 lives-proved), then upgrades run state. Non-pass loop outcomes
// (window_exhausted / retry_budget_exhausted / halted) map to a halted run
// without a PR. A Codex usage-limit thrown mid-loop is caught and recorded as
// window_exhausted rather than a generic failure (PROJECT_BRIEF §4.3).
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type { EscapeHatches, RoutingTable } from "../config/shared.js";
import type { Allocator, RunnerAllocation, SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import { type EventName, type EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { UsageProbe } from "../usage/index.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { prepareCleanPrBranch } from "../workspace/githubPush.js";
import { pollCiForRun, type PollCiForRunResult } from "./ciPolling.js";
import type { GateOutcome } from "./gate/index.js";
import { buildDefaultGate, defaultRoutingAdapters, defaultUsageProbe } from "./plannerRunAdapters.js";
import { prepareRunWorkspace } from "./plannerRunWorkspace.js";
import {
  buildFinalizeRunState,
  finalizeMergeOutcome,
  finalizeNonPass,
  finalizeWorkflowError,
  runOutcomeFor,
} from "./plannerRunFinalize.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import {
  mergeForRun,
  pollReviewForRun,
  reviewerRejection,
  type ConflictResolverHook,
  type MergeForRunResult,
  type MergeProbe,
  type PollReviewForRunResult,
  type ReviewProbe,
} from "./reviewMerge/index.js";
import { runSubtaskLoop, type SubtaskLoopAdapters, type SubtaskLoopOutcome } from "./subtaskLoop.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PlannerRunContext {
  runId: string;
  specId: string;
  projectId: string;
  /**
   * The org the run belongs to (null for legacy/unscoped runs). Threaded into
   * the allocate request so a backend that persists a `runners` row (the sidecar
   * allocator service) writes it under the org's RLS scope.
   */
  orgId?: string | null;
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
  // The run's effective per-role provider routing table (project routing merged
  // onto a per-role default-Codex table built from `codexCredentialRef`). This
  // is what the default adapters resolve from — Codex stays the default ONLY
  // because the default routing DATA says so, not because of any code-level
  // hardcode. Tests that inject buildAdapters may omit it.
  routing?: RoutingTable;
  // SaaS Tier-B #5: when a MANAGED run resolved an OpenAI-compatible endpoint
  // override, this is the base URL every resolved adapter is pointed at. Absent
  // ⇒ BYOK (adapters use their native endpoints).
  endpointBaseUrl?: string;
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
  // Plane-split P3: the cost recorder the loop persists cost_records through.
  // Defaults to an in-process `CostRecorder` over `pool` + `eventStore` (today's
  // direct DB write). The run worker injects a writer-backed recorder so the cost
  // INSERT routes through the control-plane endpoint when remote-writes is on.
  recorder?: CostRecorder;
  // Plane-split P3: how the workflow finalizes the run (the terminal `UPDATE
  // runs`). Defaults to the in-process org-scoped UPDATE on `pool`; the worker
  // injects a writer-backed finalizer so the finalize routes through the
  // control-plane endpoint when remote-writes is on. Returns nothing — the
  // workflow does not branch on the finalize result.
  finalizeRun?: (input: { runId: string; status: string; outcome: string; fromStatuses: string[] }) => Promise<void>;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  context: PlannerRunContext;
  escapeHatches: Pick<
    EscapeHatches,
    "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
  >;
  timeoutMs: number;
  workspacePath?: string;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // P3-0006: the install command run over SSH in the workspace after clone and
  // before the writer loop, so gating + intent-checking see a built tree. This
  // is an explicit override (operator/test). When omitted, the run resolves the
  // repo's tanren-ci.yml `bootstrap.run` (P3-0004) and uses that; when the repo
  // ships no tanren-ci.yml it falls back to the pnpm/npm-detecting
  // DEFAULT_BOOTSTRAP_COMMAND heuristic.
  bootstrapCommand?: string;
  // Test seam: when omitted, the real bootstrapWorkspace runs over SSH. Tests
  // that drive the loop with a RecordingSsh fake inject a no-op (or scripted
  // failure) so unit runs never depend on a real install.
  runBootstrap?: (input: BootstrapStepInput) => Promise<void>;
  // Test seam mirroring runBootstrap: the synthetic post-bootstrap commit whose
  // sha becomes the writer's diff base (run baseSha). When omitted, the real
  // commitBootstrapState runs over SSH. Tests inject a scripted sha (or a no-op
  // returning "") so unit runs never touch a real git tree.
  commitBootstrap?: (input: CommitBootstrapStepInput) => Promise<string>;
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

export interface CommitBootstrapStepInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
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
  const recorder = input.recorder ?? new CostRecorder(input.pool, eventStore);
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
  // Plane-split P3: how the run's terminal status is finalized (remote via the
  // control-plane endpoint, or the byte-identical in-process UPDATE) — see
  // {@link buildFinalizeRunState}.
  const finalizeRunState = buildFinalizeRunState(input, context.runId);

  await input.pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [context.runId]);
  await supersedeQueuedPlannerTask(input.pool, context.runId);
  const allocation = await input.allocator.allocate({
    runId: context.runId,
    projectId: context.projectId,
    runnerImage: context.runnerImage,
    identitySecretRef: context.identitySecretRef,
    // The run's org. Threaded into the allocate request so a backend that
    // persists a `runners` row (the sidecar allocator service) writes it under
    // the org's RLS scope. Undefined for legacy/unscoped runs (org_id NULL).
    orgId: context.orgId ?? undefined,
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  try {
    // Clone + bootstrap-install + commit-the-bootstrap-state in one stage. The
    // bootstrap commit's sha is the writer's diff base (so the checker/auditor
    // and captured diff see only the writer's changes); the clone HEAD is kept so
    // the PR-branch cleanup can drop the bootstrap commit before the push.
    // P3-0006: deps are installed before the writer loop so gating sees a built
    // tree. baseSha is threaded so replanned already-done work isn't
    // false-rejected as an empty per-iteration delta.
    const { cloneHeadSha, bootstrapSha, baseSha } = await prepareRunWorkspace(input, allocation.target, workspacePath);
    await appendEvent("workspace.prepared", {
      workspacePath,
      repoUrl: context.repoUrl,
      targetBranch: context.targetBranch,
    });

    const adapterCtx: PlannerRunAdapterContext = {
      runId: context.runId,
      target: allocation.target,
      codexHome: codexHomeForRun(context.runId),
    };
    const adapters = (input.buildAdapters ?? ((ctx) => defaultRoutingAdapters(input, ctx)))(adapterCtx);
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
          workspacePath,
          baseSha,
        },
        escapeHatches: input.escapeHatches,
        timeoutMs: input.timeoutMs,
        usageProbe,
        runGate,
        seedRejections: [...seedRejections],
      });

      if (outcome.kind !== "passed") {
        await finalizeNonPass(finalizeRunState, context.runId, runOutcomeFor(outcome));
        return { runId: context.runId, workspacePath, outcome };
      }

      // Prepare the PR branch: replay the writer commits onto the clone HEAD,
      // dropping the synthetic bootstrap commit (and its install artifacts), so
      // the pushed branch / PR carries only the writer's changes. The working
      // HEAD is left intact so a review-rework re-entry keeps its bootstrapSha
      // diff base. No-op (pushes HEAD) on fake-SSH / no-bootstrap paths.
      const pushSourceRef = await prepareCleanPrBranch({
        ssh: input.ssh,
        target: allocation.target,
        workspacePath,
        cloneHeadSha,
        bootstrapSha,
        timeoutMs: input.timeoutMs,
      });

      pullRequest = await publishDraftPullRequest({
        pool: input.pool,
        eventStore,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        ssh: input.ssh,
        target: allocation.target,
        sourceRef: pushSourceRef,
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
        timeoutMs: input.timeoutMs,
      });
      ci = await pollCiUntilTerminal(input);

      review = await pollReviewForRun({
        pool: input.pool,
        eventStore,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        runId: context.runId,
        // Resolve the review-stage GitHub token from the SAME ref the
        // PR-creation + CI-poll steps used (project record → org default), not
        // the project-config JSONB alone.
        resolvedGithubCredentialRef: context.githubCredentialRef,
        maxPolls: input.maxCiPolls,
        pollDelayMs: input.ciPollDelayMs,
        sleep: input.sleep,
        reviewProbe: input.reviewProbe,
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
      await finalizeNonPass(finalizeRunState, context.runId, "halted");
      return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review };
    }

    const merge = await mergeForRun({
      pool: input.pool,
      eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: context.runId,
      // Same source as PR-creation + CI-poll (project record → org default).
      resolvedGithubCredentialRef: context.githubCredentialRef,
      mergeProbe: input.mergeProbe,
      resolveConflict: input.resolveConflict,
    });

    // Finalize the run for the merge stage's outcome (conflict → recoverable
    // halt; failed → failed; merged/queued/handed_off → done + spec status).
    await finalizeMergeOutcome(input, finalizeRunState, context, merge.outcome);
    return { runId: context.runId, workspacePath, outcome, pullRequest, ci, review, merge };
  } catch (error) {
    // Finalize the run for the thrown error (recoverable halt for a known
    // bootstrap/usage-limit fault, else a generic `failed`) + emit its event,
    // then re-throw so the worker's catch path still fails the job.
    await finalizeWorkflowError(error, { finalizeRunState, appendEvent, runId: context.runId, workspacePath });
    throw error;
  } finally {
    await input.allocator.release(allocation.runnerId);
    await appendEvent("runner.released", { runnerId: allocation.runnerId });
  }
}

// The spec-run trigger pre-creates a queued 'plan' task + job_queue row for the
// async worker path. This workflow executes the run directly and the loop
// creates its own planner task, so the pre-created artifacts are vestigial —
// cancel them so the run does not carry a dangling queued task.
async function supersedeQueuedPlannerTask(pool: RunStateClient, runId: string): Promise<void> {
  await pool.query(
    "UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'",
    [runId],
  );
  await pool.query("UPDATE job_queue SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'", [runId]);
}

async function pollCiUntilTerminal(input: RunPlannerLoopInput): Promise<PollCiForRunResult> {
  const maxPolls = input.maxCiPolls ?? 12;
  const delayMs = input.ciPollDelayMs ?? 10_000;
  const sleep =
    input.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let last: PollCiForRunResult | undefined;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    last = await pollCiForRun({
      pool: input.pool,
      eventStore: input.eventStore,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: input.context.runId,
      githubCredentialRef: input.context.githubCredentialRef,
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
      hostKeyFingerprint: allocation.target.hostKeyFingerprint,
    },
  };
}

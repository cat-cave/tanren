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
import type { EscapeHatches, GovernancePosture, RoutingTable } from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { Allocator, SshTarget } from "../contracts/allocator.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import { type EventName, type EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { prepareCleanPrBranch } from "../workspace/githubPush.js";
import type { PollCiForRunResult } from "./ciPolling.js";
import { buildReGateCi, pollCiUntilTerminal } from "./plannerRunCi.js";
import type { GateOutcome } from "./gate/index.js";
import {
  buildDefaultGate,
  resolveConflictResolverHook,
  resolveRunAdaptersWithBudgetPreflight,
  simulatedReviewSeam,
} from "./plannerRunAdapters.js";
import { prepareRunWorkspace } from "./plannerRunWorkspace.js";
import {
  applyScopedRunCredentials,
  buildFinalizeRunState,
  finalizeMergeOutcome,
  finalizeNonPass,
  finalizeWorkflowError,
  markRunRunning,
  type RunCredentialScoping,
  runnerPayload,
  runOutcomeFor,
  setSpecStatus,
  supersedeQueuedPlannerTask,
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
  type NativeQueueEnqueuer,
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
  // P2a (Part 2): the org's GitHub App installation, when installed. The workspace
  // CLONE resolves its token App-first through the VcsProvider seam (like the CI-poll
  // / merge stages) — a private clone uses the auto-rotating installation token when
  // present, else falls back to the static `githubCredentialRef`.
  installation?: OrgGithubAppInstallation;
  // Required to build the default (real Codex) adapters + usage probe. Tests that inject buildAdapters/buildUsageProbe may omit it.
  codexCredentialRef?: string;
  // The run's effective per-role provider routing table (project routing merged onto a
  // per-role default-Codex table from `codexCredentialRef`) — what the default adapters
  // resolve from. Codex is the default by DATA, not a hardcode. Tests may omit it.
  routing?: RoutingTable;
  // SaaS Tier-B #5: a MANAGED run's OpenAI-compatible endpoint override (the base
  // URL every resolved adapter is pointed at). Absent ⇒ BYOK (native endpoints).
  endpointBaseUrl?: string;
  // The project's governance posture, threaded by the run worker. Drives the gate's
  // advisory policy (`lenient` ⇒ lint/typecheck advisory; absent ⇒ strict).
  governancePosture?: GovernancePosture;
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
  // Plane-split P3c: the run/spec/task LIFECYCLE writer. When present (remote-writes
  // on, the run has an org), every non-finalize `runs` / `specs` / `tasks` write the
  // workflow drives routes through the control-plane endpoints; absent (the default),
  // the workflow runs its byte-identical in-process org-scoped writes on `pool`.
  runStateWriter?: RunStateWriter;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  // Dimension D — the per-run credential-scoping seam ({@link applyScopedRunCredentials}).
  credentialScoping?: RunCredentialScoping;
  vcsProvider: VcsProvider;
  /**
   * P2a (Part 2): the shared GitHub App installation-token minter (its cache
   * lives here). Threaded into the App-first clone-token resolution so a private
   * clone reuses the same minted/cached installation token as the run's other
   * stages instead of minting a throwaway. Omitted (the default) → the provider
   * mints a per-call minter when an App is installed.
   */
  githubAppMinter?: GithubAppTokenMinter;
  context: PlannerRunContext;
  escapeHatches: Pick<
    EscapeHatches,
    "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
  >;
  timeoutMs: number;
  workspacePath?: string;
  // Test seam: a pre-resolved GitHub clone token. Production omits it (prepareRunWorkspace resolves it from secrets + context.githubCredentialRef).
  githubToken?: string;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // P3-0006: the install command run over SSH after clone (so gating + intent-
  // checking see a built tree). An explicit override; when omitted the run resolves
  // the repo's tanren-ci.yml `bootstrap.run` (P3-0004), else the pnpm/npm-detecting
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
  // BUDGET-SAFETY (M6): the budget-gate seam the run-setup ceiling preflight resolves the
  // configured ceiling through. Defaults to PgBudgetGate over `pool`; tests inject a fake.
  budgetGate?: BudgetGate;
  // reviewPolicy: "simulated" seam. Omitted in production → the reviewer
  // Answerer is resolved from the project routing (audit chain head; Codex by
  // default). Only invoked when the project's reviewPolicy is "simulated".
  buildSimulatedReviewer?: (ctx: PlannerRunAdapterContext) => AnswererAdapter<ReviewAnswer>;
  // P3-0008 review→merge tail seams. Omitted in production → the real GitHub
  // review/merge stages drive through the P3-0003 resolver. Tests inject mocks
  // so unit runs never hit GitHub.
  reviewProbe?: ReviewProbe;
  mergeProbe?: MergeProbe;
  resolveConflict?: ConflictResolverHook;
  // P2d (native_queue): enters a ready run into the native merge queue (→ mergeForRun).
  nativeQueueEnqueuer?: NativeQueueEnqueuer;
  // Max review→rework re-entries before the run halts pending operator action.
  maxReviewReworks?: number;
  // Plane B (P-APP-ENV-0): the PROJECT's dev+test app env — the env vars + secrets
  // the product Tanren is BUILDING needs to run + test the app it writes. Resolved
  // by the worker from `project_app_env` via `resolveAppEnvForScope` (dev+test), with
  // secret refs read from the secret manager. Materialized over the runner into the
  // building agent's command env (gate steps + bootstrap), NEVER logged and DISTINCT
  // from Tanren's own provider creds (`secrets`, `githubToken`). Undefined ⇒ no env.
  appEnv?: Record<string, string>;
}

export interface BootstrapStepInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  command?: string;
  // Plane B: the project's dev+test app env, injected at the SSH substrate boundary
  // (never folded into `command`, so a bootstrap failure can't leak it into the
  // error message / events). See bootstrap.ts. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
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

/**
 * Plane-split P3c: the optional lifecycle-writer seam for a sub-stage input — the
 * `runStateWriter` when one is wired, else `{}` (the sub-stage does its in-process
 * write). One helper so the workflow threads it into each stage with no per-call
 * `exactOptionalPropertyTypes` ternary (keeping the workflow's branch count down).
 */
function writerSeam(input: RunPlannerLoopInput): { runStateWriter?: RunStateWriter } {
  return input.runStateWriter === undefined ? {} : { runStateWriter: input.runStateWriter };
}

function nativeQueueSeam(input: RunPlannerLoopInput): { enqueueNativeQueue?: NativeQueueEnqueuer } {
  return input.nativeQueueEnqueuer === undefined ? {} : { enqueueNativeQueue: input.nativeQueueEnqueuer };
}

export async function runPlannerLoopWorkflow(rawInput: RunPlannerLoopInput): Promise<PlannerRunResult> {
  const eventStore = rawInput.eventStore ?? new PgEventStore(rawInput.pool);
  const context = rawInput.context;
  const workspacePath = rawInput.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const recorder = rawInput.recorder ?? new CostRecorder(rawInput.pool, eventStore);
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

  // Dimension D: de-privilege the run behind a per-run scoped Vault child token
  // BEFORE any credential read ({@link applyScopedRunCredentials}).
  const input = await applyScopedRunCredentials(rawInput, appendEvent);
  // Plane-split P3: how the run's terminal status is finalized (remote via the
  // control-plane endpoint, or the byte-identical in-process UPDATE) — see
  // {@link buildFinalizeRunState}.
  const finalizeRunState = buildFinalizeRunState(input, context.runId);

  // Plane-split P3c: the `running` transition + the supersede route through the
  // lifecycle writer when wired (remote), else the byte-identical in-process write.
  await markRunRunning(input, context);
  await supersedeQueuedPlannerTask(input, context.runId);
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
    // bootstrap commit's sha is the writer's diff base (so the checker/auditor and
    // captured diff see only the writer's changes); the clone HEAD is kept so the
    // PR-branch cleanup can drop the bootstrap commit before the push. P3-0006: deps
    // install before the writer loop so gating sees a built tree; baseSha is threaded
    // so replanned done work isn't false-rejected as an empty delta. The clone
    // authenticates with the run's GitHub token (same seam as push) for PRIVATE repos.
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
    // Build adapters + usage probe AND run the BUDGET-SAFETY (M6) ceiling preflight (fail closed on an unreachable ceiling).
    const { adapters, usageProbe } = await resolveRunAdaptersWithBudgetPreflight(input, adapterCtx, appendEvent);

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
        ...writerSeam(input),
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
        ...writerSeam(input),
        orgId: context.orgId,
        secrets: input.secrets,
        vcsProvider: input.vcsProvider,
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
        ...writerSeam(input),
        secrets: input.secrets,
        vcsProvider: input.vcsProvider,
        runId: context.runId,
        // Resolve the review-stage GitHub token from the SAME ref the
        // PR-creation + CI-poll steps used (project record → org default), not
        // the project-config JSONB alone.
        resolvedGithubCredentialRef: context.githubCredentialRef,
        maxPolls: input.maxCiPolls,
        pollDelayMs: input.ciPollDelayMs,
        sleep: input.sleep,
        reviewProbe: input.reviewProbe,
        // reviewPolicy: "simulated": the lazy reviewer-Answerer factory + the
        // spec it judges. Used ONLY on the simulated branch (see reviewPolling).
        ...simulatedReviewSeam(input, adapterCtx),
      });

      if (review.verdict === "approved") {
        break;
      }
      if (review.verdict === "changes_requested" && reworks < maxReworks) {
        // Re-enter the writer loop with the reviewer feedback as planner
        // steering. The spec returns to in_flight; the next pass re-plans
        // against the changes-requested feedback.
        seedRejections.push(reviewerRejection(review, pullRequest.branch));
        await setSpecStatus(input, context, "in_flight");
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
      ...writerSeam(input),
      secrets: input.secrets,
      vcsProvider: input.vcsProvider,
      runId: context.runId,
      // Same source as PR-creation + CI-poll (project record → org default).
      resolvedGithubCredentialRef: context.githubCredentialRef,
      mergeProbe: input.mergeProbe,
      // P2b: the intent-preserving conflict resolver is the PRODUCTION DEFAULT
      // for the resolveConflict hook (replacing noopConflictResolver). Tests
      // inject input.resolveConflict to skip the live runner/model; production
      // omits it → the real resolver, built from the run's merge-stage context.
      resolveConflict: resolveConflictResolverHook(input, {
        eventStore,
        target: allocation.target,
        workspacePath,
        baseSha,
        runGate,
        checker: adapters.checker,
        auditor: adapters.auditor,
      }),
      // P2a: after an auto-rebase advances the branch, re-poll CI to a terminal
      // verdict (the prior green is stale) before merging — through the SAME CI
      // path the run already uses.
      reGateCi: buildReGateCi(input),
      // P2d: under `native_queue` the merge stage enters this run into the queue.
      ...nativeQueueSeam(input),
    });

    // Finalize the run + spec for the merge stage's outcome (see
    // finalizeMergeOutcome; a native_queue enqueue leaves the spec NON-done).
    await finalizeMergeOutcome(input, finalizeRunState, context, merge);
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

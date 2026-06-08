// The real planner-loop run-trigger. It drives the full planner feedback loop
// (runSubtaskLoop) with real Codex adapters + a live usage probe, built through
// injectable factories that DEFAULT to real Codex / SSH monitors (tests inject
// fakes); the background run worker drives this with the defaults in production.
// On a passing loop the workflow publishes a draft PR, runs the NATIVE pre-merge
// gate (the merge authority — same in-loop gate over the command substrate, no
// forge CI poll) + publishes its `tanren/gate` verdict, then drives review→merge.
// Non-pass outcomes (window_exhausted / retry_budget_exhausted / halted) map to a
// halted run without a PR. A Codex usage-limit thrown mid-loop is caught and
// recorded as window_exhausted, not a generic failure (PROJECT_BRIEF §4.3).
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type { EscapeHatches, GovernancePosture, RoutingChainEntry, RoutingTable } from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { Allocator, ReleaseReason, RunnerHandle } from "../contracts/allocator.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
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
import { buildReGateCi, type MergeGateRunContext, runMergeGateForRun } from "./plannerRunCi.js";
import type { GateOutcome } from "./gate/index.js";
import {
  buildDefaultGate,
  buildManagedCapturerForRun,
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
  releaseRunnerWithCleanupProof,
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
  // Part 2: the org's GitHub App installation, when installed. The workspace
  // CLONE resolves its token App-first through the VcsProvider seam (like the CI-poll /
  // merge stages), else falls back to the static `githubCredentialRef`.
  installation?: OrgGithubAppInstallation;
  // The run's resolved DEFAULT LLM routing entry {cli, model, authRef} — heads every
  // empty loop-role chain (provider-agnostic, NOT Codex-pinned). Tests may omit it.
  defaultLlm?: RoutingChainEntry;
  // The run's effective per-role routing table (project routing over a per-role
  // default built from `defaultLlm`). The default is by DATA, not a hardcode.
  routing?: RoutingTable;
  // SaaS Tier-B #5: a MANAGED run's OpenAI-compatible endpoint override (the base URL every adapter is pointed at + the real-cost capturer queries). Absent ⇒ BYOK.
  endpointBaseUrl?: string;
  // Governance posture (run worker): drives the gate's advisory policy (`lenient` ⇒ lint/typecheck advisory; absent ⇒ strict).
  governancePosture?: GovernancePosture;
  // AUDIT-EVIDENCE BASELINE: governance policy version (project config version), stamped onto the `gate.verdict` roll-up. Absent on unit paths with no config.
  policyVersion?: number;
  // GREENFIELD MARKER (ProjectConfigV1.greenfield): drives buildDefaultGate's in-loop deps-ensure MODE — greenfield ⇒ NON-FROZEN install; absent/false ⇒ FROZEN brownfield.
  greenfield?: boolean;
  // cost PR-C: the CONFIGURED per-credential credit→USD rate (runExecutionContext
  // resolves it from project/org `creditRates`). Absent ⇒ a real drawdown is NULL-and-loud.
  creditUsdRate?: number;
}

export interface PlannerRunAdapterContext {
  runId: string;
  target: RunnerHandle;
  // The shared per-run CODEX_HOME every Codex role materializes against, so a
  // single ccusage read at run end sees the whole run and the codexbar window
  // pre-flight reads the run's account.
  codexHome: string;
}

export interface RunPlannerLoopInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // The cost recorder the loop persists cost_records through.
  // Defaults to an in-process `CostRecorder` over `pool` + `eventStore` (today's
  // direct DB write). The run worker injects a writer-backed recorder so the cost
  // INSERT routes through the control-plane endpoint when remote-writes is on.
  recorder?: CostRecorder;
  // How the workflow finalizes the run (the terminal `UPDATE runs`).
  // Defaults to the in-process org-scoped UPDATE on `pool`; the worker injects a
  // writer-backed finalizer that routes through the control-plane endpoint when
  // remote-writes is on. Returns nothing — the workflow doesn't branch on it.
  finalizeRun?: (input: { runId: string; status: string; outcome: string; fromStatuses: string[] }) => Promise<void>;
  // the run/spec/task LIFECYCLE writer. When present (remote-writes
  // on, the run has an org), every non-finalize `runs` / `specs` / `tasks` write the
  // workflow drives routes through the control-plane endpoints; absent (the default),
  // the workflow runs its byte-identical in-process org-scoped writes on `pool`.
  runStateWriter?: RunStateWriter;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  // Dimension D — the per-run credential-scoping seam ({@link applyScopedRunCredentials}).
  credentialScoping?: RunCredentialScoping;
  vcsProvider: VcsProvider;
  // Part 2: the shared GitHub App installation-token minter (cache lives here),
  // threaded into App-first clone-token resolution so a private clone reuses the run's
  // minted/cached token. Omitted → the provider mints a per-call minter when installed.
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
  // explicit install-command override run over SSH after clone. When
  // omitted the run resolves the repo's tanren-ci.yml `bootstrap.run`, else a
  // default (cold bootstrap: DEFAULT_BOOTSTRAP_COMMAND; in-loop deps-ensure:
  // greenfield-aware, see buildDefaultGate).
  bootstrapCommand?: string;
  // Test seam: when omitted, the real bootstrapWorkspace runs over SSH. Tests
  // inject a no-op (or scripted failure) so unit runs never depend on a real install.
  runBootstrap?: (input: BootstrapStepInput) => Promise<void>;
  // Test seam mirroring runBootstrap: the synthetic post-bootstrap commit whose sha
  // becomes the writer's diff base (run baseSha). When omitted, the real
  // commitBootstrapState runs over SSH; tests inject a scripted sha (or "").
  commitBootstrap?: (input: CommitBootstrapStepInput) => Promise<string>;
  // test seam: the deterministic gate the loop runs per writer iteration
  // (fast tier) and before audit (slow tier). When omitted, the default reads the
  // workspace's tanren-ci.yml (or the default) and runs the mapped tiers.
  // Tests inject a mock to assert routing without a live runner.
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
  // review→merge tail seams. Omitted in production → the real GitHub
  // review/merge stages drive through the resolver. Tests inject mocks
  // so unit runs never hit GitHub.
  reviewProbe?: ReviewProbe;
  mergeProbe?: MergeProbe;
  resolveConflict?: ConflictResolverHook;
  // native_queue: enters a ready run into the native merge queue (→ mergeForRun).
  nativeQueueEnqueuer?: NativeQueueEnqueuer;
  // Max review→rework re-entries before the run halts pending operator action.
  maxReviewReworks?: number;
  // Plane B: the PROJECT's dev+test app env — env vars + secrets the
  // product Tanren is BUILDING needs to run+test its app. Resolved by the worker
  // from `project_app_env` (dev+test), materialized over the runner into the building
  // agent's command env (gate + bootstrap), NEVER logged and DISTINCT from Tanren's
  // own provider creds. Undefined ⇒ no env.
  appEnv?: Record<string, string>;
}

export interface BootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  command?: string;
  // Plane B: the project's dev+test app env, injected at the SSH substrate boundary
  // (never folded into `command`, so a bootstrap failure can't leak it into the
  // error message / events). See bootstrap.ts. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
  timeoutMs: number;
}

export interface CommitBootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  timeoutMs: number;
}

export interface PlannerRunResult {
  runId: string;
  workspacePath: string;
  outcome: SubtaskLoopOutcome;
  pullRequest?: PublishedDraftPullRequest;
  // The native pre-merge gate verdict (the merge authority). Omitted when the run
  // halted before the gate.
  mergeGate?: GateOutcome;
  // The review→merge tail. `review` carries the final review verdict and `merge` the
  // merge-stage outcome. Both omitted when the run halted before the gate or stopped
  // at changes-requested after exhausting the rework budget.
  review?: PollReviewForRunResult;
  merge?: MergeForRunResult;
}

/**
 * the optional lifecycle-writer seam for a sub-stage input — the
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
    const { runId, specId, projectId } = context;
    await eventStore.append({ runId, specId, projectId, taskId, eventType, payload });
  };

  // Dimension D: de-privilege the run behind a per-run scoped Vault child token
  // BEFORE any credential read ({@link applyScopedRunCredentials}).
  const input = await applyScopedRunCredentials(rawInput, appendEvent);
  // How the run's terminal status is finalized (remote via the
  // control-plane endpoint, or the byte-identical in-process UPDATE) — see
  // {@link buildFinalizeRunState}.
  const finalizeRunState = buildFinalizeRunState(input, context.runId);

  // the `running` transition + the supersede route through the
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

  // The release reason handed to the RELEASE FINALIZER in `finally`; starts
  // `abandoned` and is promoted to completed/failed as the run resolves.
  let releaseReason: ReleaseReason = "abandoned";
  try {
    // Clone + bootstrap-install + commit-the-bootstrap-state in one stage. The
    // bootstrap commit's sha is the writer's diff base (checker/auditor + captured
    // diff see only the writer's changes); the clone HEAD is kept so the PR-branch
    // cleanup drops the bootstrap commit before push.: deps install before
    // the writer loop so gating sees a built tree; baseSha is threaded so replanned
    // done work isn't false-rejected. Clone auth uses the run's GitHub token (PRIVATE repos).
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
    // MANAGED run: the per-call real-`usage.cost` capturer (undefined on BYOK). See its builder.
    const captureRealProviderCost = await buildManagedCapturerForRun(input);
    // the deterministic gate runs on the just-bootstrapped workspace.
    // Resolve the CI config once (tanren-ci.yml, else the default) and run the tiers
    // mapped to each lifecycle point over SSH — exit codes only, no Answerer.
    const runGate = input.runGate ?? buildDefaultGate(input, allocation.target, workspacePath, eventStore);
    // The native merge-gate context: the merge authority runs `runGate` at `pre_merge`
    // on the live runner + publishes the `tanren/gate` verdict. The same context feeds
    // the post-rebase re-gate hook (`buildReGateCi`).
    const mergeGateCtx: MergeGateRunContext = { runGate, target: allocation.target, workspacePath, eventStore };

    // the write→gate→PR→CI→review tail can re-enter on a changes-requested
    // review, re-running the loop with the reviewer feedback seeded as planner
    // steering, up to maxReviewReworks. On approval it proceeds to merge; else halts.
    const maxReworks = input.maxReviewReworks ?? 1;
    const seedRejections: PlannerRejectionFeedback[] = [];
    let outcome: SubtaskLoopOutcome | undefined;
    let pullRequest: PublishedDraftPullRequest | undefined;
    let mergeGate: GateOutcome | undefined;
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
        // cost PR-C: the CONFIGURED per-credential credit→USD rate (see context field).
        ...(context.creditUsdRate !== undefined && { creditUsdRate: context.creditUsdRate }),
        runGate,
        seedRejections: [...seedRejections],
        ...(captureRealProviderCost !== undefined && { captureRealProviderCost }),
      });

      if (outcome.kind !== "passed") {
        await finalizeNonPass(finalizeRunState, context.runId, runOutcomeFor(outcome));
        releaseReason = "failed";
        return { runId: context.runId, workspacePath, outcome };
      }

      // Prepare the PR branch: replay the writer commits onto the clone HEAD, dropping
      // the synthetic bootstrap commit (+ install artifacts), so the pushed branch / PR
      // carries only the writer's changes. The working HEAD is left intact so a
      // review-rework re-entry keeps its bootstrapSha diff base. No-op on fake-SSH.
      const pushSource = await prepareCleanPrBranch({
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
        sourceRef: pushSource.ref,
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
      // THE MERGE AUTHORITY (native delivery): run the `pre_merge` gate on the live
      // runner + publish the `tanren/gate` verdict. Passing proceeds; failing THROWS.
      // COMMIT-BINDING (§5): the gate anchors its verdict on the PUSHED PR head sha (the
      // cleaned ref) — NOT the workspace HEAD — so the authority's gatedHeadSha matches.
      mergeGate = await runMergeGateForRun(input, mergeGateCtx, pushSource.headSha);

      review = await pollReviewForRun({
        pool: input.pool,
        eventStore,
        ...writerSeam(input),
        secrets: input.secrets,
        vcsProvider: input.vcsProvider,
        runId: context.runId,
        // Same token ref as PR-creation + CI-poll (project record → org default).
        resolvedGithubCredentialRef: context.githubCredentialRef,
        maxPolls: input.maxCiPolls,
        pollDelayMs: input.ciPollDelayMs,
        sleep: input.sleep,
        reviewProbe: input.reviewProbe,
        // reviewPolicy "simulated": the lazy reviewer-Answerer + the spec it judges.
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
      releaseReason = "failed";
      return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review };
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
      // the intent-preserving conflict resolver is the PRODUCTION DEFAULT for the
      // resolveConflict hook. Tests inject input.resolveConflict to skip the live
      // runner/model; production omits it → the real resolver, from the merge context.
      resolveConflict: resolveConflictResolverHook(input, {
        eventStore,
        target: allocation.target,
        workspacePath,
        baseSha,
        runGate,
        checker: adapters.checker,
        auditor: adapters.auditor,
      }),
      // After an auto-rebase the prior verdict is stale, so re-run the native
      // `pre_merge` gate + re-publish before merging — the merge authority, no forge poll.
      reGateCi: buildReGateCi(input, mergeGateCtx),
      // §5 cutover: the authority RE-READS the gate + review verdicts FRESH at land
      // time (post-resolution) from the durable record — the in-loop path no longer
      // threads pre-conflict captures (that risked authorizing against stale state).
      ...nativeQueueSeam(input),
    });

    // Finalize the run + spec for the merge stage's outcome (a native_queue enqueue leaves the spec NON-done).
    await finalizeMergeOutcome(input, finalizeRunState, context, merge);
    releaseReason = "completed";
    return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review, merge };
  } catch (error) {
    // Finalize the run for the thrown error (recoverable halt for a known
    // bootstrap/usage-limit fault, else a generic `failed`) + emit its event,
    // then re-throw so the worker's catch path still fails the job.
    releaseReason = "failed";
    await finalizeWorkflowError(error, { finalizeRunState, appendEvent, runId: context.runId, workspacePath });
    throw error;
  } finally {
    // SECURITY-BASELINE CLEANUP-PROOF: remove the run's `/workspace/runs/<runId>`
    // sandbox (layer 1 of the ≈204 GB disk-leak fix), then release through the RELEASE
    // FINALIZER seam + emit `release.finalized`. The helper never throws (a throw here
    // would mask the run's error); `releaseReason` reflects the run's outcome.
    const runWorkspace = { ssh: input.ssh, target: allocation.target, runId: context.runId };
    await releaseRunnerWithCleanupProof(input.allocator, allocation.runnerId, appendEvent, runWorkspace, releaseReason);
  }
}

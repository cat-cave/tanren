// The real planner-loop run-trigger: drives runSubtaskLoop with real Codex adapters
// (injectable factories default to real Codex/SSH; tests inject fakes). On a passing
// loop it publishes a draft PR, runs the NATIVE pre-merge gate (the merge authority,
// in-loop over the command substrate — no forge CI poll) + publishes the `tanren/gate`
// verdict, then drives review→merge. Non-pass outcomes (window_exhausted /
// convergence_stalled / halted) map to a halted run without a PR; a mid-loop Codex
// usage-limit is window_exhausted, not a failure (PROJECT_BRIEF §4.3).
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type {
  AuditPostureConfig,
  ConvergencePolicyConfig,
  EscapeHatches,
  GovernancePosture,
  RoutingChainEntry,
  RoutingTable,
} from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { Allocator, ReleaseReason, RunnerHandle } from "../contracts/allocator.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import type { EventName, EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { ContractFile } from "../forge/scaffold/index.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { buildReGateCi, type MergeGateRunContext, runPublishGateStage } from "./plannerRunCi.js";
import type { GateOutcome } from "./gate/index.js";
import {
  baseShiftRebaseSeam,
  buildDefaultGate,
  buildEntityRiskProducer,
  loopConfigSeam,
  nativeQueueSeam,
  resolveConflictResolverHook,
  resolveManagedCapturer,
  resolveRunAdaptersWithBudgetPreflight,
  simulatedReviewSeam,
  writerSeam,
} from "./plannerRunAdapters.js";
import { prepareRunWorkspace, type BootstrapStepInput, type CommitBootstrapStepInput } from "./plannerRunWorkspace.js";
import type { ProvisionMiseToolchainInput } from "../workspace/bootstrap.js";
import type { BootstrapStackHeadShaWriteBack, EagerBaseNodeUpsert } from "./plannerRunJjLocalBootstrap.js";
import {
  applyReviewVerdict,
  applyScopedRunCredentials,
  buildFinalizeRunState,
  emitPrepBootstrapDeferred,
  finalizeMergeOutcome,
  finalizeNonPassAndPark,
  finalizeWorkflowError,
  markRunRunning,
  type MergeGateBudget,
  releaseRunnerWithCleanupProof,
  type RunCredentialScoping,
  runnerPayload,
  runOutcomeFor,
  supersedeQueuedPlannerTask,
} from "./plannerRunFinalize.js";
import type { PublishedDraftPullRequest } from "./githubDraftPr.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import {
  mergeForRun,
  pollReviewForRun,
  reviewerRejection,
  type ConflictResolverHook,
  type MergeAuthorityBundle,
  type MergeForRunInput,
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
  // The org the run belongs to (null = unscoped); threaded into allocate so the
  // sidecar allocator persists its `runners` row under the org's RLS scope.
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
  // Part 2: the org's GitHub App installation, when installed. Clone/push/PR/CI/merge
  // mint the token App-first through the seam, else the static `githubCredentialRef`.
  installation?: OrgGithubAppInstallation;
  // Resolved DEFAULT LLM entry {cli, model, authRef} — heads every empty loop-role chain (provider-agnostic). Tests may omit.
  defaultLlm?: RoutingChainEntry;
  // Effective per-role routing table (project routing over a per-role default from `defaultLlm`) — by DATA, not a hardcode.
  routing?: RoutingTable;
  // SaaS Tier-B #5: a MANAGED run's OpenAI-compatible endpoint override (the base URL every adapter is pointed at + the real-cost capturer queries). Absent ⇒ BYOK.
  endpointBaseUrl?: string;
  // Governance posture (run worker): drives the gate's advisory policy (`lenient` ⇒ lint/typecheck advisory; absent ⇒ strict).
  governancePosture?: GovernancePosture;
  // SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the per-project audit
  // posture (triage P1–P3 → tasks-here vs new specs) + the convergence policy (the SOLE
  // loop bound). Absent on unit paths ⇒ DEFAULT_AUDIT_POSTURE / DEFAULT_CONVERGENCE_POLICY.
  auditPosture?: AuditPostureConfig;
  convergencePolicy?: ConvergencePolicyConfig;
  // AUDIT-EVIDENCE BASELINE: governance policy version (project config version), stamped onto the `gate.verdict` roll-up. Absent on unit paths with no config.
  policyVersion?: number;
  // GREENFIELD MARKER (ProjectConfigV1.greenfield): drives buildDefaultGate's in-loop deps-ensure MODE — greenfield ⇒ NON-FROZEN install; absent/false ⇒ FROZEN brownfield.
  greenfield?: boolean;
  // cost PR-C: CONFIGURED per-credential credit→USD rate (from project/org `creditRates`). Absent ⇒ a real drawdown is NULL-and-loud.
  creditUsdRate?: number;
  // DETERMINISTIC CONTRACT FILES (v27 fix): the `.tanren/ci.yml` + `justfile` workspace-prep materializes VERBATIM (write-iff-absent) from the captured lifecycle BEFORE the writer runs — so they are NEVER LLM-authored (the writer mangled the ci.yml shape on v27). Absent ⇒ no lifecycle (brownfield ships its own) ⇒ no-op.
  contractFiles?: ReadonlyArray<ContractFile>;
  // TEMPLATING WAVE 3 (templating-system.md §3): the SELECTED template's repo ref to SEED from (from `projectConfig.templateRef`). When set, the run clones the template's conforming files into the workspace BEFORE the writer — so the scaffold writer's "seed already committed" assertion holds and it specializes the seed instead of authoring from scratch. Absent ⇒ no match ⇒ the from-scratch contract-file path runs.
  templateSeed?: { repoRef: string };
  // WS-A PR-4: the ordered ancestor stack this dependent speculative run is stacked on (from
  // `runs.ancestor_stack`). With `WALKER_JJ_LOCAL_BASE` on + non-empty, the workspace bootstrap jj-assembles the base from these ancestor refs vs the legacy single-ref clone.
  ancestorStack?: AncestorStack;
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
  // How the workflow finalizes the run (the terminal `UPDATE runs`). Defaults to the
  // in-process org-scoped UPDATE on `pool`; the worker injects a writer-backed
  // finalizer that routes through the control-plane endpoint when remote-writes is on.
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
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  // Part 2: the shared GitHub App installation-token minter (cache lives here), threaded into
  // App-first clone-token resolution so a private clone reuses the run's minted/cached token.
  githubAppMinter?: GithubAppTokenMinter;
  context: PlannerRunContext;
  escapeHatches: Pick<EscapeHatches, "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure">;
  timeoutMs: number;
  workspacePath?: string;
  // Test seam: a pre-resolved GitHub clone token. Production omits it (prepareRunWorkspace resolves it from secrets + context.githubCredentialRef).
  githubToken?: string;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // explicit install-command override run over SSH after clone. Omitted ⇒ the run
  // resolves the repo's tanren-ci.yml `bootstrap.run`, else a default (cold bootstrap:
  // DEFAULT_BOOTSTRAP_COMMAND; in-loop deps-ensure: greenfield-aware, buildDefaultGate).
  bootstrapCommand?: string;
  // Test seam: omitted ⇒ real bootstrapWorkspace over SSH; tests inject a no-op (or
  // scripted failure) so unit runs never depend on a real install.
  runBootstrap?: (input: BootstrapStepInput) => Promise<void>;
  // Test seam: the mise toolchain provision run BEFORE bootstrap (env-management §3);
  // omitted ⇒ real `mise trust && mise install` over SSH (no-op when no mise.toml).
  provisionMise?: (input: ProvisionMiseToolchainInput) => Promise<void>;
  // Test seam: omitted ⇒ real commitBootstrapState over SSH (the synthetic
  // post-bootstrap commit whose sha is the writer's diff base); tests inject a sha.
  commitBootstrap?: (input: CommitBootstrapStepInput) => Promise<string>;
  // Test seam: the deterministic gate the loop runs per writer iteration (fast tier)
  // and before audit (slow tier). Omitted ⇒ the default reads the workspace's
  // tanren-ci.yml (or the default) and runs the mapped tiers; tests inject a mock.
  runGate?: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // Test seams. Omitted in production → real Codex adapters + SSH usage probe.
  buildAdapters?: (ctx: PlannerRunAdapterContext) => SubtaskLoopAdapters;
  buildUsageProbe?: (ctx: PlannerRunAdapterContext) => UsageProbe | undefined;
  // WS1↔WS2 seam. Omitted → spec-quality validator from project routing; tests inject.
  buildSpecValidator?: (ctx: PlannerRunAdapterContext) => SpecQualityAnswerer;
  // BUDGET-SAFETY (M6) + §3.7a: the budget-gate seam the ceiling preflight + the loop's
  // per-iteration in-flight gate share. Defaults to PgBudgetGate over `pool`; tests inject.
  budgetGate?: BudgetGate;
  // reviewPolicy: "simulated" seam. Omitted in production → the reviewer Answerer is resolved
  // from the project routing (audit chain head; Codex by default). Only for reviewPolicy "simulated".
  buildSimulatedReviewer?: (ctx: PlannerRunAdapterContext) => AnswererAdapter<ReviewAnswer>;
  // review→merge tail seams. Omitted in production → the real GitHub review/merge stages
  // drive through the resolver. Tests inject mocks so unit runs never hit GitHub.
  reviewProbe?: ReviewProbe;
  mergeProbe?: MergeProbe;
  // TEST SEAM (§5h): the in-loop `behind` rebase hook (production → `baseShiftRebaseSeam`).
  baseShiftRebase?: MergeForRunInput["baseShiftRebase"];
  // TEST SEAM: a pre-built bundle (a no-DB unit run injects it; production builds it).
  mergeAuthority?: MergeAuthorityBundle;
  resolveConflict?: ConflictResolverHook;
  // native_queue: enters a ready run into the native merge queue (→ mergeForRun).
  nativeQueueEnqueuer?: NativeQueueEnqueuer;
  // WS-A PR-8 (walker-jj-local-integration-design.md §2.3, fork F4): OBSERVE-ONLY — the port
  // the jj-local dependent bootstrap UPSERTs its `eager_base` integration node through (the
  // proof-reuse substrate the batch `merge_batch` node shares). NEVER gates the run; a
  // failure is loud-logged + swallowed. Built by the worker (`buildEagerBaseNodeUpsert`).
  eagerBaseNodeUpsert?: EagerBaseNodeUpsert;
  /** WS-A PR-8c (§2.3): bootstrap → `runs.ancestor_stack[].headSha` write-back (percolation's divergence key); see plannerRunJjLocalBootstrap. */
  bootstrapStackHeadShaWriteBack?: BootstrapStackHeadShaWriteBack;
  // Max review→rework re-entries before the run halts pending operator action.
  maxReviewReworks?: number;
  // SELF-HEAL (apex v34): max pre_merge-gate→writer self-heal re-entries before a LOUD
  // halt. See `mergeGateSelfHeal` in plannerRunCi.ts. Absent ⇒ the documented default.
  maxMergeGateReworks?: number;
  // Plane B: the PROJECT's dev+test app env — env vars + secrets the product Tanren is
  // BUILDING needs to run+test its app. Resolved by the worker from `project_app_env`,
  // materialized over the runner into the building agent's command env (gate + bootstrap),
  // NEVER logged + DISTINCT from Tanren's own provider creds. Undefined ⇒ no env.
  appEnv?: Record<string, string>;
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
    // the org's RLS scope. Undefined for system / null-org jobs (org_id NULL).
    orgId: context.orgId ?? undefined,
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  // The release reason handed to the RELEASE FINALIZER in `finally`; starts
  // `abandoned` and is promoted to completed/failed as the run resolves.
  let releaseReason: ReleaseReason = "abandoned";
  try {
    // Clone (legacy single-ref OR — WS-A PR-4, flag-gated — the jj-local ancestor-stack
    // bootstrap) + bootstrap-install + commit + materialize contract files. `baseSha` is the
    // answerer review base (the contract-files commit when one was made, else the bootstrap
    // commit); `cloneHeadSha` is the writer's replay base; `bootstrappedBaseRevision` is set
    // ONLY on the jj-local path (the conflict resolver's merge-time base). See the module.
    const { cloneHeadSha, bootstrapSha, baseSha, bootstrappedBaseRevision, prepBootstrapDeferred } =
      await prepareRunWorkspace(input, allocation.target, workspacePath);
    await appendEvent("workspace.prepared", {
      workspacePath,
      repoUrl: context.repoUrl,
      targetBranch: context.targetBranch,
    });
    // SELF-HEAL (apex v35): when the workspace-PREP `just bootstrap` deps-install was DEFERRED
    // to the gate self-heal (a writer-fixable scaffold defect, not a strand) emit the loud
    // `workspace.bootstrap_deferred` — see {@link emitPrepBootstrapDeferred}.
    await emitPrepBootstrapDeferred(appendEvent, workspacePath, prepBootstrapDeferred);

    const adapterCtx: PlannerRunAdapterContext = {
      runId: context.runId,
      target: allocation.target,
      codexHome: codexHomeForRun(context.runId),
    };
    // Build adapters + usage probe + the spec-quality validator AND run the
    // BUDGET-SAFETY (M6) ceiling preflight (fail closed on an unreachable ceiling).
    const adapterResult = await resolveRunAdaptersWithBudgetPreflight(input, adapterCtx, appendEvent);
    const { adapters, usageProbe, specValidator, budgetGate: iterationBudgetGate } = adapterResult;
    // MANAGED real-`usage.cost` capturer; BYOK has no platform metering ref → EXPLICIT narrated skip (apex v30). See helper.
    const captureRealProviderCost = await resolveManagedCapturer(input, appendEvent);
    // The deterministic gate on the just-bootstrapped workspace: resolve the CI config
    // once (tanren-ci.yml, else the default) and run the tiers mapped to each lifecycle
    // point over SSH — exit codes only, no Answerer.
    const runGate = input.runGate ?? buildDefaultGate(input, allocation.target, workspacePath, eventStore);
    // The native merge-gate context: the merge authority runs `runGate` at `pre_merge` on
    // the live runner + publishes `tanren/gate`. Same context feeds the re-gate hook.
    const mergeGateCtx: MergeGateRunContext = { runGate, target: allocation.target, workspacePath, eventStore };

    // the write→gate→PR→CI→review tail re-enters on a changes-requested review (loop
    // re-run with reviewer feedback as planner steering, up to maxReviewReworks).
    const maxReworks = input.maxReviewReworks ?? 1;
    // SELF-HEAL (apex v34): the dedicated pre_merge-gate→writer budget (see
    // `mergeGateSelfHeal` in plannerRunCi.ts), never starving/starved by the review budget.
    const mergeGateBudget: MergeGateBudget = { used: 0, max: input.maxMergeGateReworks ?? 2 };
    const seedRejections: PlannerRejectionFeedback[] = [];
    const entityRiskProducer = buildEntityRiskProducer(input, allocation.target, workspacePath);
    let outcome: SubtaskLoopOutcome | undefined;
    let pullRequest: PublishedDraftPullRequest | undefined;
    let mergeGate: GateOutcome | undefined, review: PollReviewForRunResult | undefined;

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
        budgetGate: iterationBudgetGate,
        runGate,
        entityRiskProducer,
        seedRejections: [...seedRejections],
        ...(captureRealProviderCost !== undefined && { captureRealProviderCost }),
        ...loopConfigSeam(context, specValidator),
      });

      if (outcome.kind !== "passed") {
        // finding #3: halt the run AND park the spec (requeueable, never stuck in_flight).
        await finalizeNonPassAndPark(input, finalizeRunState, context, appendEvent, runOutcomeFor(outcome));
        releaseReason = "failed";
        return { runId: context.runId, workspacePath, outcome };
      }

      // Publish the cleaned draft PR, run the merge-authority `pre_merge` gate, and (apex
      // v34 SELF-HEAL) route a writer-fixable gate failure back to the writer instead of
      // the old `code:internal` throw + strand — all extracted to `runPublishGateStage` in
      // plannerRunCi.ts (keeps this file under cap + its branching out of this function).
      // The stage returns: `rework` (re-enter the writer — `continue`), `halt` (bounded-out:
      // finalized + parked LOUD, the loop returns), or `merged` (gate passed — fall through
      // to review). It also surfaces the published PR + gate verdict for the merge tail.
      const stage = await runPublishGateStage(input, mergeGateCtx, context, {
        cloneHeadSha,
        bootstrapSha,
        finalizeRunState,
        appendEvent,
        seedRejections,
        budget: mergeGateBudget,
      });
      pullRequest = stage.pullRequest;
      mergeGate = stage.mergeGate;
      if (stage.kind === "rework") continue;
      if (stage.kind === "halt") {
        releaseReason = "failed";
        return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate };
      }

      review = await pollReviewForRun({
        pool: input.pool,
        eventStore,
        ...writerSeam(input),
        secrets: input.secrets,
        githubHttp: input.githubHttp,
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

      // Map the review verdict (extracted to plannerRunFinalize.ts, mirroring the merge-gate
      // self-heal): `merge` → proceed; `rework` → re-enter the writer (spec back to
      // in_flight); `halt` → finalized + parked LOUD, the loop returns. No merge on non-pass.
      const reviewMove = await applyReviewVerdict(
        input,
        finalizeRunState,
        context,
        appendEvent,
        { verdict: review.verdict, rejection: reviewerRejection(review, pullRequest.branch) },
        seedRejections,
        reworks < maxReworks,
      );
      if (reviewMove === "merge") break;
      if (reviewMove === "rework") continue;
      releaseReason = "failed";
      return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review };
    }

    const merge = await mergeForRun({
      pool: input.pool,
      eventStore,
      ...writerSeam(input),
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: context.runId,
      // Same source as PR-creation + CI-poll (project record → org default).
      resolvedGithubCredentialRef: context.githubCredentialRef,
      mergeProbe: input.mergeProbe,
      ...(input.mergeAuthority !== undefined && { mergeAuthority: input.mergeAuthority }),
      // The intent-preserving conflict resolver — the PRODUCTION DEFAULT (tests inject input.resolveConflict).
      resolveConflict: resolveConflictResolverHook(input, {
        eventStore,
        target: allocation.target,
        workspacePath,
        baseSha,
        runGate,
        checker: adapters.checker,
        auditor: adapters.auditor,
        // WS-A PR-4: the jj-local-assembled base → the resolver's merge-time base (absent ⇒ unchanged).
        ...(bootstrappedBaseRevision !== undefined && { bootstrappedBaseRevision }),
      }),
      // After an auto-rebase the prior verdict is stale → re-run the native `pre_merge` gate.
      reGateCi: buildReGateCi(input, mergeGateCtx),
      // THE ONE BASE-SHIFT HANDLER (§7 / §5h): the unified jj rebase, no server update-branch.
      baseShiftRebase: baseShiftRebaseSeam(context, input),
      // §5: the authority RE-READS the gate + review verdicts FRESH at land time (post-resolution).
      ...nativeQueueSeam(input),
    });

    // Finalize the run + spec for the merge stage's outcome (a native_queue enqueue leaves the spec NON-done).
    await finalizeMergeOutcome(input, finalizeRunState, context, merge);
    releaseReason = "completed";
    return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review, merge };
  } catch (error) {
    // Finalize the run for the thrown error (recoverable halt for a known bootstrap/
    // usage-limit fault, else a generic `failed`) + park the SPEC (finding #3:
    // requeueable, never stuck in_flight), then re-throw so the worker fails the job.
    releaseReason = "failed";
    await finalizeWorkflowError(error, { finalizeRunState, appendEvent, workspacePath, input, context });
    throw error;
  } finally {
    // SECURITY-BASELINE CLEANUP-PROOF: remove the run's `/workspace/runs/<runId>` sandbox (layer 1 of the ≈204 GB disk-leak fix), then release through the RELEASE FINALIZER seam + emit `release.finalized`. The helper never throws (a throw here would mask the run's error); `releaseReason` reflects the run's outcome.
    const runWorkspace = { ssh: input.ssh, target: allocation.target, runId: context.runId };
    await releaseRunnerWithCleanupProof(input.allocator, allocation.runnerId, appendEvent, runWorkspace, releaseReason);
  }
}

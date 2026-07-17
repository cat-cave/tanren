// The planner-loop's optional-property SEAMS: tiny pure helpers that fold an
// optional injected dependency into the `{ key?: value }` shape a sub-stage input
// expects, so the workflow threads each into a stage with no per-call
// `exactOptionalPropertyTypes` ternary (keeping `runPlannerLoopWorkflow`'s branch
// count under the complexity cap). Pure extraction from plannerRun.ts — no behavior
// change. The `PlannerRunContext` / `RunPlannerLoopInput` types are imported
// TYPE-ONLY from plannerRun.ts to avoid a circular runtime import.
import type { AuditPostureConfig, ConvergencePolicyConfig } from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { TriageSpecValidator } from "./loopFindings.js";
import type { MergeForRunInput, NativeQueueEnqueuer } from "./reviewMerge/index.js";
import type { EventStore } from "../eventStore.js";
import type { GateReworkRouter } from "../contracts/conflictResolution.js";
import { buildInLoopBaseShiftRebaseHook } from "../merge/inLoopBaseShift.js";
import { SpecStatusGateReworkRouter } from "./reviewMerge/conflictResolver/gateReworkRouter.js";
import { buildPriorGateReworkReader, buildReplanEnqueuer } from "./reviewMerge/conflictResolver/replanEnqueuerPg.js";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import { designResolverActor } from "../design/designWriterContext.js";

export function nativeQueueSeam(input: RunPlannerLoopInput): { enqueueNativeQueue?: NativeQueueEnqueuer } {
  return input.nativeQueueEnqueuer === undefined ? {} : { enqueueNativeQueue: input.nativeQueueEnqueuer };
}

export function issueLoopProvenanceSeam(context: PlannerRunContext): { issueLoopId?: string } {
  return context.issueLoopId === undefined ? {} : { issueLoopId: context.issueLoopId };
}

/**
 * apex v67/v69 loop-close fix — the EARLY-PATH merge_queue enqueue seam.
 *
 * `publishCleanedDraftPr` folds this into `publishDraftPullRequest`'s input so the
 * merge_queue INSERT + `merge.scheduled` event fire RIGHT AFTER `github.pr.created`,
 * not at the end of the writer chain. The chain `runPublishGateStage → pollReview
 * → applyReviewVerdict → mergeForRun → enqueueNative` halts on the slightest snag
 * (gate fixed-point halt, review polling halt, transient exception in
 * `finalizeWorkflowThrow`), and apex v67/v69 each watched 4/2 PRs push to GitHub
 * with ZERO merge_queue rows materialize — the walker just re-walked the spec and
 * created a NEW run, abandoning the live PR. Now the merge coordinator owns the
 * PR the instant it exists; `MergeAuthority.authorizeLand` still enforces every
 * land precondition (gate/review/mergeability/etc.) so an early-scheduled entry
 * HOLDS until those clear — never a premature land.
 *
 * Returns `{}` (no hook) unless:
 *   - the project is `native_queue` (direct_merge / external_reviewer / not_configured
 *     have NO queue concept — they would race the coordinator), AND
 *   - the worker wired `input.nativeQueueEnqueuer` (the production
 *     `buildNativeQueueEnqueuer(pool)`; a no-DB unit run omits it).
 *
 * Idempotency: `PgMergeQueueModel.enqueue` dedups by `run_id` via the partial
 * unique index (`merge_queue_active_run_unique`), so the late-path
 * `mergeForRun → enqueueNative` becomes a no-op on the second call (`created: false`)
 * — the writer chain still records its own observable `merge.queued` at the
 * mergeForRun call site. `merge.scheduled` is emitted ONLY when the early-path call
 * actually created the row, so a re-published PR (the writer-rework loop publishes
 * once per iteration) does not double-emit.
 */
export function mergeQueueEarlyEnqueueSeam(
  input: RunPlannerLoopInput,
  context: PlannerRunContext,
  eventStore: EventStore,
  appendEventOrgId: string,
): {
  enqueueAfterCreate?: (info: { prUrl: string; prNumber: number }) => Promise<void>;
  postPrCreatedAtomicWrites?: (info: {
    prUrl: string;
    prNumber: number;
    branch: string;
    baseBranch: string;
  }) => Promise<void>;
} {
  if (context.mergeIntegration !== "native_queue") {
    return {};
  }
  // PRODUCTION path (apex v86 plane-split fix): route the 3-write block through
  // `RunStateWriter.recordDraftPrCreated` so Direct uses a privileged pool and
  // Http POSTs to `/internal/record-draft-pr-created` under the control plane's
  // events grant. The prior shape opened `new PgEventStore(input.pool client)`
  // which the de-privileged `tanren_dataplane` role cannot INSERT — live v86
  // failed with `permission denied for table events` AFTER the GitHub PR 201,
  // leaving the draft PR forever unmerged. `publishDraftPullRequest` skips its
  // inline `github.pr.created` append when this callback is wired.
  const writer = input.runStateWriter;
  if (writer !== undefined) {
    return {
      postPrCreatedAtomicWrites: async ({ prUrl, prNumber, branch, baseBranch }) => {
        await writer.recordDraftPrCreated({
          orgId: appendEventOrgId,
          runId: context.runId,
          specId: context.specId,
          projectId: context.projectId,
          repoUrl: context.repoUrl,
          branch,
          baseBranch,
          prUrl,
          prNumber,
        });
      },
    };
  }
  // LEGACY non-atomic path (test / no-DB run): no writer wired, only
  // `nativeQueueEnqueuer` — 3 separate transactions via eventStore + enqueuer.
  // Production always wires the writer (Direct or Http). NEVER open PgEventStore
  // on input.pool here: that is the plane-split violation the writer path closes.
  const enqueue = input.nativeQueueEnqueuer;
  if (enqueue === undefined) {
    return {};
  }
  return {
    enqueueAfterCreate: async ({ prUrl, prNumber }) => {
      const { created } = await enqueue({
        projectId: context.projectId,
        runId: context.runId,
        specId: context.specId,
        prUrl,
        prNumber,
      });
      if (created) {
        await eventStore.append({
          runId: context.runId,
          specId: context.specId,
          projectId: context.projectId,
          orgId: appendEventOrgId,
          eventType: "merge.scheduled",
          payload: { prUrl, prNumber, integration: "native_queue" },
        });
      }
    },
  };
}

/**
 * The AUTO-REBASE re-gate gate-fail → WRITER REWORK seam (#594 extended to the merge dispatcher's
 * clean-rebase re-gate path). A post-auto-rebase `pre_merge` gate that FAILS a deterministic tier
 * on a CLEANLY-rebased branch (no conflict) is the WRITER's to fix on the new base — route it to
 * rework carrying the gate error as steering (the SAME never-discard re-author the resolver /
 * base-shift coordinator use), NEVER a terminal `merge.failed`. Escalation on a genuine dead-end
 * is owned by the convergence detector inside the router (a fixed point, no count). Tests inject
 * `input.reGateGateRework`; production builds the default router (mirrors `conflictResolver/index`).
 */
export function reGateGateReworkSeam(
  input: RunPlannerLoopInput,
  deps: { prNumber: number },
): { reGateGateRework: GateReworkRouter } {
  if (input.reGateGateRework !== undefined) {
    return { reGateGateRework: input.reGateGateRework };
  }
  const context = input.context;
  const orgId = context.orgId;
  return {
    reGateGateRework: new SpecStatusGateReworkRouter({
      orgId,
      runId: context.runId,
      projectId: context.projectId,
      prNumber: deps.prNumber,
      enqueuer: buildReplanEnqueuer(input.pool, input.runStateWriter),
      priorReworks: buildPriorGateReworkReader(input.pool),
    }),
  };
}

// The SPEC-LOOP REDESIGN loop-config seam: folds the optional triage/convergence
// knobs (audit posture + convergence policy + credit→USD rate) and the WS1↔WS2
// spec-quality validator into the `runSubtaskLoop` input in one spread, so the
// workflow stays under its branch + line caps. Absent knobs ⇒ the loop's defaults;
// the validator is STRICT (no reviseSpec — triage cannot cheaply re-author a spec),
// so a persistently-invalid triaged spec escalates loud.
export function loopConfigSeam(
  context: PlannerRunContext,
  specValidator: SpecQualityAnswerer,
): {
  auditPosture?: AuditPostureConfig;
  convergencePolicy?: ConvergencePolicyConfig;
  creditUsdRate?: number;
  specValidator: TriageSpecValidator;
} {
  return {
    ...(context.auditPosture !== undefined && { auditPosture: context.auditPosture }),
    ...(context.convergencePolicy !== undefined && { convergencePolicy: context.convergencePolicy }),
    ...(context.creditUsdRate !== undefined && { creditUsdRate: context.creditUsdRate }),
    // The validator carries NO emitter `reviseSpec` — but the gate now uses the
    // validator's BUILT-IN re-author as the default, so a failing triaged spec is
    // genuinely re-authored from its guidance before any escalation (never the
    // give-up "after 0 revision(s)").
    specValidator: { validator: specValidator },
  };
}

/**
 * THE ONE BASE-SHIFT HANDLER seam (§7 / decomposition PR-7 §5h): the in-loop `direct_merge`
 * `behind` rebase hook. Production omits `input.baseShiftRebase` → wire the live
 * `BaseShiftCoordinator` (the SAME unified jj rebase the native_queue DRIVE uses), making the
 * base-shift UNCONDITIONAL across every land-driving caller (so the legacy server-side
 * update-branch fallback is gone). A no-DB unit run injects `input.baseShiftRebase` so it
 * never allocates a runner. The runner allocator / SSH / identity are the SAME this run holds.
 */
export function baseShiftRebaseSeam(
  context: PlannerRunContext,
  input: RunPlannerLoopInput,
): NonNullable<MergeForRunInput["baseShiftRebase"]> {
  return (
    input.baseShiftRebase ??
    buildInLoopBaseShiftRebaseHook({
      pool: input.pool,
      githubHttp: input.githubHttp,
      secrets: input.secrets,
      allocator: input.allocator,
      ssh: input.ssh,
      identitySecretRef: context.identitySecretRef,
      ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
      runStateWriter: input.runStateWriter,
    })
  );
}

/**
 * Return the run's tenant org id. `PlannerRunContext.orgId` is now a REQUIRED
 * non-empty string (the hydration boundary enforces the tenant-scope invariant),
 * so this reduces to a direct field read. Kept as a named seam because a few
 * call sites still spell the intent ("the run's org") more clearly through the
 * helper than through a bare field read.
 */
export function requireContextOrgId(context: PlannerRunContext): string {
  return context.orgId;
}

// WS-D4 native design subsystem — the actor identity the in-loop design ORACLE
// reads the contract + entity graph under (the SAME org-scoped seam
// `loadDesignContextBlock` uses for the writer side). A run is ALWAYS tenant-scoped
// (the invariant is enforced at the {@link loadRunExecutionContext} hydration
// boundary), so the actor is UNCONDITIONALLY populated here — the old
// "undefined ⇒ silently skip the oracle" fallback is gone; skipping is now a
// legitimate stage decision (project has no contract), never a quiet degrade.
export function designOracleSeam(context: PlannerRunContext): {
  designOracleActor: { actor: ActorContext; actorRef: ActorRef };
} {
  return {
    designOracleActor: {
      actor: designResolverActor(context.orgId, context.projectId),
      actorRef: { kind: "operator" },
    },
  };
}

// App-first push/PR-create credential seam (clone-path parity): mint the App token when installed, else the static ref.
export function appTokenSeam(
  context: PlannerRunContext,
  input: RunPlannerLoopInput,
): { installation?: OrgGithubAppInstallation; githubAppMinter?: GithubAppTokenMinter } {
  return {
    ...(context.installation !== undefined && { installation: context.installation }),
    ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
  };
}

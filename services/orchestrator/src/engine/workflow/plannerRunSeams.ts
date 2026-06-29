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
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import { designResolverActor } from "../design/designWriterContext.js";

export function nativeQueueSeam(input: RunPlannerLoopInput): { enqueueNativeQueue?: NativeQueueEnqueuer } {
  return input.nativeQueueEnqueuer === undefined ? {} : { enqueueNativeQueue: input.nativeQueueEnqueuer };
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
  deps: { eventStore: EventStore; prNumber: number },
): { reGateGateRework: GateReworkRouter } {
  if (input.reGateGateRework !== undefined) {
    return { reGateGateRework: input.reGateGateRework };
  }
  const context = input.context;
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  return {
    reGateGateRework: new SpecStatusGateReworkRouter({
      pool: input.pool,
      runStateWriter: input.runStateWriter,
      ...(orgId !== undefined && { orgId }),
      eventStore: deps.eventStore,
      runId: context.runId,
      projectId: context.projectId,
      prNumber: deps.prNumber,
      enqueuer: buildReplanEnqueuer(input.pool as pg.Pool, input.runStateWriter),
      priorReworks: buildPriorGateReworkReader(input.pool as pg.Pool),
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

// WS-D4 native design subsystem — the actor identity the in-loop design ORACLE reads the
// contract + entity graph under (the SAME org-scoped seam `loadDesignContextBlock` uses for
// the writer side). A run with no org cannot resolve the entity graph, so the seam is empty
// (the stage is then skipped) rather than reading off the wrong scope. Never a kill-switch:
// when present, the stage runs and self-skips cleanly when the project has no contract.
export function designOracleSeam(context: PlannerRunContext): {
  designOracleActor?: { actor: ActorContext; actorRef: ActorRef };
} {
  const orgId = context.orgId ?? undefined;
  if (orgId === undefined) return {};
  return {
    designOracleActor: { actor: designResolverActor(orgId, context.projectId), actorRef: { kind: "operator" } },
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

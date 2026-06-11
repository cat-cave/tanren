// The planner-loop's optional-property SEAMS: tiny pure helpers that fold an
// optional injected dependency into the `{ key?: value }` shape a sub-stage input
// expects, so the workflow threads each into a stage with no per-call
// `exactOptionalPropertyTypes` ternary (keeping `runPlannerLoopWorkflow`'s branch
// count under the complexity cap). Pure extraction from plannerRun.ts — no behavior
// change. The `PlannerRunContext` / `RunPlannerLoopInput` types are imported
// TYPE-ONLY from plannerRun.ts to avoid a circular runtime import.
import type { AuditPostureConfig, ConvergencePolicyConfig } from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { TriageSpecValidator } from "./loopFindings.js";
import type { MergeForRunInput, NativeQueueEnqueuer } from "./reviewMerge/index.js";
import { buildInLoopBaseShiftRebaseHook } from "../merge/inLoopBaseShift.js";

/**
 * the optional lifecycle-writer seam for a sub-stage input — the
 * `runStateWriter` when one is wired, else `{}` (the sub-stage does its in-process
 * write). One helper so the workflow threads it into each stage with no per-call
 * `exactOptionalPropertyTypes` ternary (keeping the workflow's branch count down).
 */
export function writerSeam(input: RunPlannerLoopInput): { runStateWriter?: RunStateWriter } {
  return input.runStateWriter === undefined ? {} : { runStateWriter: input.runStateWriter };
}

export function nativeQueueSeam(input: RunPlannerLoopInput): { enqueueNativeQueue?: NativeQueueEnqueuer } {
  return input.nativeQueueEnqueuer === undefined ? {} : { enqueueNativeQueue: input.nativeQueueEnqueuer };
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
      ...writerSeam(input),
    })
  );
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

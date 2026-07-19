/**
 * rv-11 A1 acceptance: the PURE outcome-resolution kernel, split out of
 * orchestrator.ts to keep that file under the 500-line cap. These helpers own the
 * fail-closed truth table — a surface we could not drive, an unavailable adapter, a
 * missing driver, or under-coverage NEVER yields a pass — and are unit-tested in
 * isolation from the impure orchestrator seams (store / events / drivers).
 */

import { createHash } from "node:crypto";
import type { Digest } from "../../contracts/cas.js";
import type {
  AdapterUnavailableResult,
  BehaviorVerdictOutcome,
  DriverExecutionResult,
  DriverObservation,
} from "../../contracts/runtimeVerificationAdapters.js";
import type { ExecutionMatrix } from "../../contracts/runtimeVerificationPlan.js";
import type { CausalStageResult } from "./causalStage.js";

export function sha256(value: string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}

export function isUnavailable(
  result: DriverExecutionResult | AdapterUnavailableResult,
): result is AdapterUnavailableResult {
  return result.kind === "unavailable";
}

export function matrixKeyOf(matrix: ExecutionMatrix): string {
  const dims = [matrix.browser, matrix.viewport, matrix.locale, matrix.theme, matrix.device];
  const key = dims.map((values) => values[0] ?? "*").join("/");
  return key.slice(0, 256);
}

export interface AssertionEvaluation {
  readonly executedCount: number;
  readonly passedCount: number;
  readonly observed: readonly { readonly assertionId: string; readonly satisfied: boolean }[];
}

/** The aggregate of driving EVERY required surface for one behavior. */
export interface DriveAggregate {
  readonly observations: readonly DriverObservation[];
  /** At least one required surface was attempted (there was a surface to drive). */
  readonly drove: boolean;
  /** A required surface had no wired driver — the surface could not be exercised. */
  readonly missingDriver: boolean;
  /** A required surface's driver reported its environment unavailable. */
  readonly unavailable?: AdapterUnavailableResult;
}

/**
 * Fold the rv-12 causal stage into the surface-drive aggregate. Causal work
 * counts as "drove" (so a causal-only plan is not spuriously infra-inconclusive),
 * a missing cause driver / effect reader is a missing driver, and a reported
 * unavailability propagates — every causal fail-closed path lands as an
 * infra/external outcome through {@link resolveOutcome}, never a pass.
 */
export function mergeCausalIntoAggregate(surface: DriveAggregate, causal: CausalStageResult): DriveAggregate {
  const unavailable = surface.unavailable ?? causal.unavailable;
  return {
    observations: [...surface.observations, ...causal.observations],
    drove: surface.drove || causal.attempted,
    missingDriver: surface.missingDriver || causal.missingCauseDriver || causal.missingObserver,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

export function resolveOutcome(
  aggregate: DriveAggregate,
  required: number,
  evaluation: AssertionEvaluation,
): BehaviorVerdictOutcome {
  // Infra gaps fail closed BEFORE any coverage claim: a surface we could not
  // drive can never contribute a passing assertion.
  if (!aggregate.drove) return "inconclusive_infrastructure";
  if (aggregate.unavailable !== undefined) return aggregate.unavailable.outcome;
  if (aggregate.missingDriver) return "inconclusive_infrastructure";
  // A plan that requires no assertions has no coverage — never a pass.
  if (required < 1) return "failed_verification_contract";
  if (evaluation.executedCount < required) return "failed_verification_contract";
  if (evaluation.passedCount === required) return "passed";
  return "failed_product";
}

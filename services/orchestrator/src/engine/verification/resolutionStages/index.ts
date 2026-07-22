import type pg from "pg";
import type { ResolutionStage, ResolutionStageKind } from "../../contracts/resolutionStage.js";
import { BaselineReproductionStage } from "./baselineReproductionStage.js";
import { ProductionSymptomStage } from "./productionSymptomStage.js";

export type ResolutionStageFactory = (input: { readonly pool: pg.Pool }) => ResolutionStage;

/**
 * All resolution stages use their production defaults here, matching the
 * internal route construction while allowing a single caller-owned registry.
 */
export const resolutionStages = new Map<ResolutionStageKind, ResolutionStageFactory>([
  ["baseline", ({ pool }) => new BaselineReproductionStage({ pool })],
  ["production", ({ pool }) => new ProductionSymptomStage({ pool })],
]);

export function createResolutionStageRegistry(input: {
  readonly pool: pg.Pool;
}): Map<ResolutionStageKind, ResolutionStage> {
  return new Map([...resolutionStages].map(([kind, factory]) => [kind, factory(input)]));
}

export {
  BaselineReproductionStage,
  type BaselineReproductionContext,
  type BaselineProbe,
  type BaselineReproductionStageDependencies,
  type BaselineRuntimeContextResolver,
} from "./baselineReproductionStage.js";
export { ProductionSymptomStage, type ProductionSymptomStageDeps } from "./productionSymptomStage.js";
export {
  PgRuntimeBehaviorContextLoader,
  LockedBehaviorContextError,
  lockedBehaviorContextFailureResult,
  readRuntimeBehaviorContext,
  type RuntimeBehaviorContextLoader,
  type PgRuntimeBehaviorContextLoaderDeps,
  type LockedBehaviorContextReason,
} from "./resolutionBehaviorContext.js";

// Wave-6 table barrel: keeps the top-level Drizzle schema below the 500-line cap
// while reserving the serialized barrier's shared table namespace for all four lanes.
export { fixtureLeases } from "./schemaFixtureLeases.js";
export { behaviorEffectObservations, effectObserverWatermarks } from "./schemaEffectObservations.js";
export {
  integrationEvaluationProofs,
  integrationProofEdges,
  integrationProofUnits,
} from "./schemaIntegrationProofUnits.js";
export { repositoryVisibilityObservations } from "./schemaRepoVisibilityObservations.js";

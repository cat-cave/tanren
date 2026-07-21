import type { SensitivityRule } from "./sensitivity.js";

// Sensitivity tags for the WAVE-1 integration lifecycle vocabulary (in-3).
// Every frozen payload carries only IDs, generations, hashes, key NAMES,
// provider receipt IDs, and correlation IDs (never tokens, provider bodies, or
// message text), so every reachable path is `public`.

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

const reconcilePaths = ["reconciliationId", "requirementId", "phase", "attempt"] as const;

export const integrationVocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("integration.requirement.derived", [
    "requirementId",
    "capability",
    "plane",
    "direction",
    "criticality",
    "sourceKind",
    "sourceRevisionId",
    "desiredStateHash",
  ]),
  ...publicRules("integration.requirement.superseded", ["requirementId", "supersededByRequirementId"]),
  ...publicRules("integration.reconcile.started", reconcilePaths),
  ...publicRules("integration.reconcile.retry_scheduled", reconcilePaths),
  ...publicRules("integration.reconcile.fixed_point", reconcilePaths),
  ...publicRules("integration.reconcile.state_unknown", reconcilePaths),
  ...publicRules("integration.resource.discovered", ["requirementId", "providerKind", "resourceCount"]),
  ...publicRules("integration.resource.selected", ["requirementId", "providerKind", "externalResourceId"]),
  ...publicRules("integration.resource.provisioned", [
    "requirementId",
    "providerKind",
    "externalResourceId",
    "ownership",
  ]),
  ...publicRules("integration.resource.adopted", ["requirementId", "providerKind", "externalResourceId"]),
  ...publicRules("integration.binding.committed", [
    "bindingId",
    "requirementId",
    "environment",
    "generation",
    "desiredStateHash",
  ]),
  ...publicRules("integration.binding.materialized", ["bindingId", "environment", "generation", "keys", "keys[]"]),
  ...publicRules("integration.binding.drifted", ["bindingId", "environment", "generation", "driftState"]),
  ...publicRules("integration.grant.requested", [
    "requirementId",
    "providerKind",
    "plane",
    "environment",
    "capabilities",
    "capabilities[]",
    "operations",
    "operations[]",
    "scopes",
    "scopes[]",
  ]),
  ...publicRules("integration.grant.linked", ["grantId", "connectionId", "providerKind", "plane", "environment"]),
  ...publicRules("integration.grant.validated", ["grantId", "providerKind", "scopes", "scopes[]"]),
  ...publicRules("integration.grant.rotated", ["grantId", "providerKind", "fromGeneration", "toGeneration"]),
  ...publicRules("integration.grant.revoked", ["grantId", "providerKind"]),
  ...publicRules("integration.runtime.attached", [
    "bindingId",
    "environment",
    "generation",
    "deliveryRunId",
    "deploySha",
    "deploymentId",
    "keys",
    "keys[]",
  ]),
  ...publicRules("integration.validation.started", [
    "validationId",
    "requirementId",
    "bindingId",
    "generation",
    "correlationId",
  ]),
  ...publicRules("integration.stimulus.emitted", ["validationId", "correlationId", "triggerDigest"]),
  ...publicRules("integration.effect.observed", ["validationId", "correlationId", "providerReceiptId"]),
  ...publicRules("integration.validation.passed", [
    "validationId",
    "requirementId",
    "bindingId",
    "generation",
    "correlationId",
    "evidenceDigest",
  ]),
  ...publicRules("integration.validation.failed", [
    "validationId",
    "requirementId",
    "bindingId",
    "generation",
    "correlationId",
    "failureClassification",
  ]),
  ...publicRules("integration.recovery.enqueued", ["requirementId", "remediationSpecId", "reason"]),
  ...publicRules("integration.teardown.completed", ["bindingId", "externalResourceId", "ownership"]),
  ...publicRules("integration.teardown.failed", ["bindingId", "externalResourceId", "failureClassification"]),
];

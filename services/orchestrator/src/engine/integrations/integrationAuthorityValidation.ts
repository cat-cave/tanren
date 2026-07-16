import type { IntegrationOperationTarget, IntegrationResourceConstraints } from "../contracts/integrationAuthority.js";

const TARGET_KEYS = new Set([
  "resourceId",
  "deploymentId",
  "environment",
  "sourceRepo",
  "sourceRef",
  "projectName",
  "orgSlug",
  "stack",
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function integrationOperationTargetsEqual(
  left: IntegrationOperationTarget,
  right: IntegrationOperationTarget,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        TARGET_KEYS.has(key) &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        left[key as keyof IntegrationOperationTarget] === right[key as keyof IntegrationOperationTarget],
    )
  );
}

export function normalizeIntegrationOperationTarget(
  operation: string,
  value: IntegrationOperationTarget,
): IntegrationOperationTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !TARGET_KEYS.has(key))) return undefined;
  const target = { ...value };
  const only = (...allowed: string[]) => Object.keys(target).every((key) => allowed.includes(key));
  switch (operation) {
    case "discover":
      return Object.keys(target).length === 0 ? target : undefined;
    case "provision":
      return nonEmpty(target.projectName) && nonEmpty(target.orgSlug) && only("projectName", "orgSlug", "stack")
        ? target
        : undefined;
    case "bind":
      return nonEmpty(target.resourceId) &&
        nonEmpty(target.projectName) &&
        nonEmpty(target.orgSlug) &&
        only("resourceId", "projectName", "orgSlug", "stack")
        ? target
        : undefined;
    case "attach_runtime_env":
      return nonEmpty(target.resourceId) && target.environment === "production" && only("resourceId", "environment")
        ? target
        : undefined;
    case "intake":
      return nonEmpty(target.resourceId) && only("resourceId") ? target : undefined;
    case "deploy":
      return nonEmpty(target.resourceId) &&
        nonEmpty(target.sourceRepo) &&
        nonEmpty(target.sourceRef) &&
        only("resourceId", "sourceRepo", "sourceRef")
        ? target
        : undefined;
    case "verify":
    case "resolve_demo_surface":
    case "resolve_artifact_identity":
    case "promote":
    case "rollback":
    case "teardown_deployment":
      return nonEmpty(target.resourceId) && nonEmpty(target.deploymentId) && only("resourceId", "deploymentId")
        ? target
        : undefined;
    default:
      return undefined;
  }
}

export function parseIntegrationResourceConstraints(value: unknown): IntegrationResourceConstraints | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !["version", "projectBinding", "resourceIds", "environments"].includes(key)) ||
    row["version"] !== 1 ||
    row["projectBinding"] !== "selected"
  ) {
    return undefined;
  }
  const resourceIds = row["resourceIds"];
  if (
    resourceIds !== "*" &&
    (!Array.isArray(resourceIds) || !resourceIds.every((resourceId) => nonEmpty(resourceId)))
  ) {
    return undefined;
  }
  const environments = row["environments"];
  if (
    environments !== "*" &&
    (!Array.isArray(environments) || !environments.every((environment) => environment === "production"))
  ) {
    return undefined;
  }
  return {
    version: 1,
    projectBinding: "selected",
    resourceIds: resourceIds === "*" ? "*" : [...resourceIds],
    environments: environments === "*" ? "*" : [...environments],
  };
}

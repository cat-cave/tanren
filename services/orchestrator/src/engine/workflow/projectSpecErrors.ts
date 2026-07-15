/**
 * Domain errors for the project/spec workflow. Extracted from `projectSpec.ts`
 * so that module groups query/creation logic, not a cluster of error subclasses
 * (max-classes-per-file). Re-exported from `projectSpec.ts` for callers.
 */

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
  }
}

export class SpecNotFoundError extends Error {
  constructor(specId: string) {
    super(`spec not found: ${specId}`);
  }
}

export class SpecDependenciesBlockedError extends Error {
  constructor(
    readonly specId: string,
    readonly blockedSpecIds: string[],
  ) {
    super(`spec dependencies are not done for ${specId}: ${blockedSpecIds.join(", ")}`);
    this.name = "SpecDependenciesBlockedError";
  }
}

export class SpecNotRunnableError extends Error {
  constructor(
    readonly specId: string,
    readonly status: string,
  ) {
    super(`spec ${specId} cannot be queued from status ${status}`);
  }
}

/** Recovery prepare refused: missing row or status outside the recoverable allowlist. */
export class SpecNotPreparedForRecoveryError extends Error {
  constructor(
    readonly specId: string,
    readonly reason: "missing" | "not_recoverable",
    readonly status?: string,
  ) {
    const detail =
      reason === "missing"
        ? "spec status is missing"
        : `spec status '${status ?? "unknown"}' is not a recoverable recovery source`;
    super(`spec ${specId} cannot be prepared for recovery: ${detail}`);
    this.name = "SpecNotPreparedForRecoveryError";
  }
}

export class ProjectAccessDeniedError extends Error {
  constructor(projectId: string) {
    super(`actor cannot access project: ${projectId}`);
  }
}

// SpecNotInAttentionError lives in `./requeueAttentionSpec.ts` (its sole producer)
// to keep this file under the max-classes-per-file cap; it is re-exported from
// `projectSpec.ts` alongside the others, so callers import it from one place.

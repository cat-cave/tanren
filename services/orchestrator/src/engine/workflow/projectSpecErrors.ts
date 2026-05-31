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
    specId: string,
    readonly blockedSpecIds: string[],
  ) {
    super(`spec dependencies are not done for ${specId}: ${blockedSpecIds.join(", ")}`);
  }
}

export class SpecNotRunnableError extends Error {
  constructor(
    specId: string,
    readonly status: string,
  ) {
    super(`spec ${specId} cannot be queued from status ${status}`);
  }
}

export class ProjectAccessDeniedError extends Error {
  constructor(projectId: string) {
    super(`actor cannot access project: ${projectId}`);
  }
}

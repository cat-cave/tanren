export type FailureKind =
  | "provider_failed"
  | "schema_validation_failed"
  | "cost_resolution_failed"
  | "allocator_failed"
  | "ssh_failed"
  | "github_failed"
  | "ci_failed"
  | "budget_exhausted"
  | "cancelled"
  | "credential_failed"
  | "unknown_failed";

export type Failure =
  | { kind: "provider_failed"; provider: string; message: string }
  | { kind: "schema_validation_failed"; schema: string; message: string }
  | { kind: "cost_resolution_failed"; source: string; message: string }
  | { kind: "allocator_failed"; allocator: string; message: string }
  | { kind: "ssh_failed"; target: string; message: string }
  | { kind: "github_failed"; operation: string; message: string }
  | { kind: "ci_failed"; check: string; message: string }
  | { kind: "budget_exhausted"; budgetName: string; message: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "credential_failed"; credentialRef: string; message: string }
  | { kind: "unknown_failed"; message: string };

const allowedFailureKinds = new Set<FailureKind>([
  "provider_failed",
  "schema_validation_failed",
  "cost_resolution_failed",
  "allocator_failed",
  "ssh_failed",
  "github_failed",
  "ci_failed",
  "budget_exhausted",
  "cancelled",
  "credential_failed",
  "unknown_failed",
]);

export function assertFailureKind(kind: string): asserts kind is FailureKind {
  if (kind.startsWith("host_")) {
    throw new Error(`forbidden failure kind: ${kind}`);
  }
  if (!allowedFailureKinds.has(kind as FailureKind)) {
    throw new Error(`unknown failure kind: ${kind}`);
  }
}

export function defineFailure<T extends Failure>(failure: T): T {
  assertFailureKind(failure.kind);
  return failure;
}

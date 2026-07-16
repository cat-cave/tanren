// Legacy compatibility surfaces for callers that still normalize rollback errors.
// Lifecycle state machines now persist the project shell before provider effects,
// so they never invoke this pre-shell repository compensation path.

/** Idempotent delete for the only external create that can precede the durable shell. */
export type DeleteRepositoryCallback = (target: { owner: string; name: string }) => Promise<void>;

/** A failed pre-shell repository compensation, surfaced instead of swallowed. */
export interface CompensationFailure {
  kind: "github.repo";
  label: string;
  error: unknown;
}

/**
 * Preserves the original shell-create failure while naming a repository that the
 * pre-shell cleanup could not delete. Post-shell failures never use this error:
 * their effects remain anchored to the derivation receipt and are replayed.
 */
export class DeriveRollbackError extends Error {
  readonly compensationFailures: ReadonlyArray<CompensationFailure>;
  constructor(originalError: unknown, compensationFailures: ReadonlyArray<CompensationFailure>) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const gaps = compensationFailures
      .map(
        (failure) =>
          `${failure.kind}=${failure.label} (` +
          `${failure.error instanceof Error ? failure.error.message : String(failure.error)})`,
      )
      .join(", ");
    super(
      `derive failed (${original}); pre-shell repository rollback failed — ` +
        `the following resource may be orphaned: ${gaps}`,
    );
    this.name = "DeriveRollbackError";
    if (originalError instanceof Error) this.cause = originalError;
    this.compensationFailures = compensationFailures;
  }
}

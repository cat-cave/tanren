// Before a durable project shell exists, a newly-created GitHub repository has no
// replay anchor. That one pre-shell effect is compensated if shell creation fails.
// Once the shell exists, every external effect is owned by the durable derivation
// state machine and is resumed rather than destroyed on failure.

import { GreenfieldRepoNotEmptyError, type CreatedRepository } from "../../contracts/codeHostTypes.js";

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

/**
 * Re-attach only to the deterministic, bare auto-init repository left by a
 * previous attempt. A non-empty repository is operator data and is never reset.
 */
export async function resolveGreenfieldReattach(
  owner: string,
  slug: string,
  deterministicRepoUrl: string,
  probeRepoBareAutoInit: ((target: { owner: string; name: string }) => Promise<boolean>) | undefined,
): Promise<CreatedRepository> {
  if (probeRepoBareAutoInit === undefined) {
    throw new Error("greenfield re-attach requires a repo-emptiness probe (probeRepoBareAutoInit) but none was wired");
  }
  if (!(await probeRepoBareAutoInit({ owner, name: slug }))) {
    throw new GreenfieldRepoNotEmptyError(owner, slug);
  }
  return { fullName: `${owner}/${slug}`, repoUrl: deterministicRepoUrl, defaultBranch: "main" };
}

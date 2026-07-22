import {
  type BatchCheckVerdict,
  type BatchChecker,
  bisectCulprit,
  reduceFailingSubset,
} from "../contracts/batchMergeCoordinator.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../credentials/githubTokenResolver.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";

class BatchCheckStillPendingError extends Error {}

/** Bisect sub-check could not RUN (infra) — abort bisect + HOLD; never blame an innocent PR. */
class BatchCheckInfraError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly kind?: "missing_required_credential",
  ) {
    super(message);
  }
}

export class BatchBisector {
  constructor(private readonly checker: BatchChecker) {}

  /** Speculative integrate + CI-check. Thrown checker → infra-error (never blame a PR). */
  async checkEntries(projectId: string, entries: ReadonlyArray<MergeQueueEntry>): Promise<BatchCheckVerdict> {
    try {
      return await this.checker.checkBatch({ projectId, entries });
    } catch (error) {
      return {
        result: "infra-error",
        message: `batch check threw: ${String(error)}`,
        retriable: isRetriableInfraError(error),
        ...(isMissingGithubCredentialError(error) ? { kind: "missing_required_credential" as const } : {}),
      };
    }
  }

  /**
   * Isolate the actual failing set. Prefix bisection is retained for monotonic
   * single-member failures; when its member does not fail alone, ddmin reduces
   * the real failing batch to a 1-minimal interaction set.
   */
  async bisectBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
  ): Promise<
    | Awaited<ReturnType<typeof bisectCulprit>>
    | "pending"
    | { kind: "infra"; message: string; cause?: "missing_required_credential" }
  > {
    try {
      const check = async (entries: ReadonlyArray<MergeQueueEntry>) => {
        const v = await this.checkEntries(projectId, entries);
        if (v.result === "pending") {
          throw new BatchCheckStillPendingError(`sub-batch CI still pending (${entries.length} entries)`);
        }
        if (v.result === "infra-error") {
          throw new BatchCheckInfraError(
            `sub-batch check could not run (${entries.length} entries): ${v.message}`,
            v.retriable,
            v.kind,
          );
        }
        return v.result === "pass" ? "pass" : "fail";
      };
      const prefix = await bisectCulprit(batch, (prefixLength) => check(batch.slice(0, prefixLength)));
      // A real singleton reproduction is the cheap monotonic case. Otherwise
      // the prefix boundary was only a witness, not a culprit: reduce the
      // original failing set and carry that exact solver result upstream.
      if ((await check([prefix.culprit])) === "fail") return prefix;
      const reduced = await reduceFailingSubset(batch, check);
      return {
        ...prefix,
        culprit: reduced.culpritMembers[0]!,
        culpritMembers: reduced.culpritMembers,
        checks: prefix.checks + 1 + reduced.checks,
      };
    } catch (error) {
      if (error instanceof BatchCheckStillPendingError) return "pending";
      if (error instanceof BatchCheckInfraError) {
        if (error.kind === undefined) return { kind: "infra", message: error.message };
        return { kind: "infra", message: error.message, cause: error.kind };
      }
      throw error;
    }
  }
}

function isMissingGithubCredentialError(error: unknown): boolean {
  return error instanceof MissingGithubCredentialRefError || error instanceof NoGithubCredentialConfiguredError;
}

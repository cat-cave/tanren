import { type BatchCheckVerdict, type BatchChecker, bisectCulprit } from "../contracts/batchMergeCoordinator.js";
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

  /** Binary-search failed batch for the single culprit (pending/infra hold without blame). */
  async bisectBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
  ): Promise<
    | Awaited<ReturnType<typeof bisectCulprit>>
    | "pending"
    | { kind: "infra"; message: string; cause?: "missing_required_credential" }
  > {
    try {
      return await bisectCulprit(batch, async (prefixLength) => {
        const v = await this.checkEntries(projectId, batch.slice(0, prefixLength));
        if (v.result === "pending") {
          throw new BatchCheckStillPendingError(`sub-batch CI still pending (prefix length ${prefixLength})`);
        }
        if (v.result === "infra-error") {
          throw new BatchCheckInfraError(
            `sub-batch check could not run (prefix length ${prefixLength}): ${v.message}`,
            v.retriable,
            v.kind,
          );
        }
        return v.result === "pass" ? "pass" : "fail";
      });
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

// gv-2 cross-process list→POST single-flight for strict simulated review.
//
// PostgreSQL session advisory lock serializes publication for the exact
// repo/PR/head/reviewer/intent across orchestrator workers. A JS mutex is
// insufficient. Never hold an open SQL transaction across GitHub I/O — pin a
// pool client, try-acquire the session lock once, run list→reconcile→optional
// POST, release in finally (connection loss/crash releases the session lock).
// Lock busy → typed retriable fail-loud (canonical job redrive), never unfenced POST.

import type pg from "pg";
import { createLogger } from "../../observability/logger.js";
import { SimulatedReviewPublicationError } from "./simulatedReviewPublication.js";

const log = createLogger("simulated-review-publish-fence");

/** Versioned lock namespace — wrong key material never shares authority. */
export const SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE = "tanren:simulated-review-pub:v1" as const;

export type SimulatedReviewPublishFenceKey = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  reviewerLogin: string;
  // state intentionally omitted: opposing APPROVE vs REQUEST_CHANGES for the same
  // PR/head/reviewer must serialize on one fence (gv-2 P1 opposing-state race).
};

/**
 * Fence held by another worker/session. Retriable so the job redrive re-lists
 * and reclaims; never fall back to an unfenced provider POST.
 */
export class SimulatedReviewPublishFenceBusyError extends SimulatedReviewPublicationError {
  override readonly retriable = true as const;
  constructor(message: string) {
    super(message, { retriable: true });
    this.name = "SimulatedReviewPublishFenceBusyError";
  }
}

export function simulatedReviewPublishFenceMaterial(key: SimulatedReviewPublishFenceKey): string {
  const head = key.headSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new SimulatedReviewPublicationError(
      `simulated review publish fence requires exact 40-hex head (got ${key.headSha})`,
    );
  }
  if (key.pullNumber <= 0 || !Number.isInteger(key.pullNumber)) {
    throw new SimulatedReviewPublicationError(
      `simulated review publish fence requires positive integer pullNumber (got ${key.pullNumber})`,
    );
  }
  const login = key.reviewerLogin.trim().toLowerCase();
  if (login === "") {
    throw new SimulatedReviewPublicationError("simulated review publish fence requires reviewer login");
  }
  const owner = key.owner.trim().toLowerCase();
  const repo = key.repo.trim().toLowerCase();
  if (owner === "" || repo === "") {
    throw new SimulatedReviewPublicationError("simulated review publish fence requires owner/repo");
  }
  return [SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE, owner, repo, String(key.pullNumber), head, login].join("|");
}

export interface SimulatedReviewPublishFence {
  /**
   * Run `work` under the exclusive cross-process fence for `key`.
   * Fail loud (retriable busy) if the lock cannot be acquired (never unfenced POST).
   */
  withExclusivePublish<T>(key: SimulatedReviewPublishFenceKey, work: () => Promise<T>): Promise<T>;
}

type ConnectablePool = {
  connect: () => Promise<pg.PoolClient>;
};

type ReleasableClient = pg.PoolClient & {
  release: (destroy?: boolean | Error) => void;
};

/**
 * Session advisory lock fence. Pins one pool client for the critical section
 * so the lock is held for the connection lifetime of the list→POST work, then
 * unlocks in finally. Does NOT open a SQL transaction across GitHub I/O.
 * One `pg_try_advisory_lock` attempt — busy ⇒ retriable fail-loud, zero work.
 */
export class PgAdvisorySimulatedReviewPublishFence implements SimulatedReviewPublishFence {
  constructor(private readonly pool: ConnectablePool) {}

  async withExclusivePublish<T>(key: SimulatedReviewPublishFenceKey, work: () => Promise<T>): Promise<T> {
    const material = simulatedReviewPublishFenceMaterial(key);
    let client: ReleasableClient;
    try {
      client = (await this.pool.connect()) as ReleasableClient;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SimulatedReviewPublicationError(
        `simulated review publish fence could not pin a pool client: ${message}`,
      );
    }
    let locked = false;
    let workError: unknown;
    let result: T | undefined;
    let workFinished = false;
    try {
      // Two-int form: namespace hash + material hash. PostgreSQL hashtext can
      // theoretically collide (false contention, not a safety bypass); wrong
      // head/pr/reviewer still cannot share the material string.
      let acquired: boolean;
      try {
        const lockResult = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
          [SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE, material],
        );
        acquired = lockResult.rows[0]?.acquired === true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SimulatedReviewPublicationError(`simulated review publish fence lock acquisition failed: ${message}`);
      }
      if (!acquired) {
        // Zero provider I/O — canonical job redrive will re-list/reclaim.
        throw new SimulatedReviewPublishFenceBusyError(
          `simulated review publish fence busy for ${material}; redrive will re-list`,
        );
      }
      locked = true;
      try {
        result = await work();
        workFinished = true;
        return result;
      } catch (err) {
        workError = err;
        throw err;
      }
    } finally {
      await this.releaseFence(client, material, locked, workError, workFinished);
    }
  }

  /**
   * Unlock then release. Unlock failure destroys the client so a lock-holding
   * session never returns healthy to the pool; never swallow the unlock error
   * when work succeeded; aggregate when work also failed.
   */
  private async releaseFence(
    client: ReleasableClient,
    material: string,
    locked: boolean,
    workError: unknown,
    workFinished: boolean,
  ): Promise<void> {
    let unlockError: unknown;
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
          SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
          material,
        ]);
      } catch (err) {
        unlockError = err;
        log.error(
          "simulated review publish fence unlock failed — destroying pool client",
          {
            component: "simulated-review-publish-fence",
          },
          {
            material,
            unlockMessage: err instanceof Error ? err.message : String(err),
            poison: true,
          },
        );
        try {
          // Destroy so a live lock-holding session never returns to the pool.
          client.release(true);
        } catch (releaseErr) {
          log.error(
            "simulated review publish fence client destroy after unlock failure also failed",
            {
              component: "simulated-review-publish-fence",
            },
            {
              material,
              releaseMessage: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
            },
          );
        }
        // Do not swallow unlock: if work succeeded, surface unlock; if work failed,
        // rethrow work with unlock attached (preserve original publication error).
        if (workError === undefined && workFinished) {
          const message = unlockError instanceof Error ? unlockError.message : String(unlockError);
          throw new SimulatedReviewPublicationError(
            `simulated review publish fence unlock failed after successful work (client destroyed): ${message}`,
          );
        }
        if (workError !== undefined) {
          const unlockMsg = unlockError instanceof Error ? unlockError.message : String(unlockError);
          if (workError instanceof Error) {
            workError.message = `${workError.message}; also unlock failed (client destroyed): ${unlockMsg}`;
          }
          // workError is rethrown by the outer try — nothing more to throw here.
        }
        return;
      }
    }
    try {
      client.release();
    } catch (releaseErr) {
      log.error(
        "simulated review publish fence client release failed",
        {
          component: "simulated-review-publish-fence",
        },
        {
          material,
          releaseMessage: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        },
      );
    }
  }
}

/**
 * In-process serializing fence for unit tests only (same key material as production).
 * Production wiring must inject {@link PgAdvisorySimulatedReviewPublishFence} or
 * fail closed — never auto-fallback to this class.
 */
export class InMemorySimulatedReviewPublishFence implements SimulatedReviewPublishFence {
  private readonly tails = new Map<string, Promise<unknown>>();
  readonly acquisitions: string[] = [];

  async withExclusivePublish<T>(key: SimulatedReviewPublishFenceKey, work: () => Promise<T>): Promise<T> {
    const material = simulatedReviewPublishFenceMaterial(key);
    const prev = this.tails.get(material) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      material,
      prev.then(() => gate).catch(() => gate),
    );
    try {
      await prev;
    } catch {
      // prior critical-section error must not block the next acquirer
    }
    this.acquisitions.push(material);
    try {
      return await work();
    } finally {
      release();
    }
  }
}

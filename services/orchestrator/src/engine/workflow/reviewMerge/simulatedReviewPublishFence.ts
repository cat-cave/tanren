// gv-2 cross-process list→POST single-flight for strict simulated review.
//
// PostgreSQL session advisory lock serializes publication for the exact
// repo/PR/head/reviewer/intent across orchestrator workers. A JS mutex is
// insufficient. Never hold an open SQL transaction across GitHub I/O — pin a
// pool client, acquire the session lock, run list→reconcile→optional POST,
// release in finally (connection loss/crash releases the session lock).
// Lock acquisition failure fails loud — never fall back to unfenced POST.

import type pg from "pg";
import { SimulatedReviewPublicationError } from "./simulatedReviewPublication.js";

/** Versioned lock namespace — wrong key material never shares authority. */
export const SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE = "tanren:simulated-review-pub:v1" as const;

export type SimulatedReviewPublishFenceKey = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  reviewerLogin: string;
  state: "approved" | "changes_requested";
};

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
  return [SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE, owner, repo, String(key.pullNumber), head, login, key.state].join(
    "|",
  );
}

export interface SimulatedReviewPublishFence {
  /**
   * Run `work` under the exclusive cross-process fence for `key`.
   * Fail loud if the lock cannot be acquired (never unfenced POST).
   */
  withExclusivePublish<T>(key: SimulatedReviewPublishFenceKey, work: () => Promise<T>): Promise<T>;
}

type ConnectablePool = {
  connect: () => Promise<pg.PoolClient>;
};

/**
 * Session advisory lock fence. Pins one pool client for the critical section
 * so the lock is held for the connection lifetime of the list→POST work, then
 * unlocks in finally. Does NOT open a SQL transaction across GitHub I/O.
 */
export class PgAdvisorySimulatedReviewPublishFence implements SimulatedReviewPublishFence {
  constructor(private readonly pool: ConnectablePool) {}

  async withExclusivePublish<T>(key: SimulatedReviewPublishFenceKey, work: () => Promise<T>): Promise<T> {
    const material = simulatedReviewPublishFenceMaterial(key);
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SimulatedReviewPublicationError(
        `simulated review publish fence could not pin a pool client: ${message}`,
      );
    }
    let locked = false;
    try {
      // Two-int form: namespace hash + material hash. Collision-safe for our
      // versioned material; wrong head/pr/reviewer cannot share the key.
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
          SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
          material,
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SimulatedReviewPublicationError(`simulated review publish fence lock acquisition failed: ${message}`);
      }
      locked = true;
      return await work();
    } finally {
      try {
        if (locked) {
          await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
            SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
            material,
          ]);
        }
      } catch {
        // Connection may already be dead — session locks release on disconnect.
      } finally {
        client.release();
      }
    }
  }
}

/**
 * In-process serializing fence for unit tests (same key material as production).
 * Proves mutual exclusion without a live Postgres; production uses the advisory
 * lock implementation above.
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

// Native-queue claim liveness without a wall-clock lease. A held PostgreSQL
// advisory-lock session is the fencing proof: a slow, live drive holds it for as
// long as it keeps advancing; a crash loses the session and therefore the lock.

import type pg from "pg";

type ReleasableClient = pg.PoolClient & {
  release(destroy?: boolean | Error): void;
};

export interface MergeClaimLivenessSession {
  readonly queueId: string;
  release(): Promise<void>;
}

/**
 * Session advisory locks are migration-free and disappear automatically when
 * their owning process loses its database connection. They are deliberately
 * independent of the short RLS transactions used for queue row mutations.
 */
export class PgMergeClaimLiveness {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Acquire the claim's liveness fence without waiting. `null` proves a live
   * coordinator still owns the claim; a returned session must be released.
   */
  async tryAcquire(queueId: string): Promise<MergeClaimLivenessSession | null> {
    const client = (await this.pool.connect()) as ReleasableClient;
    const key = `native-merge-claim:${queueId}`;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
      return new PgMergeClaimLivenessSession(queueId, key, client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
}

class PgMergeClaimLivenessSession implements MergeClaimLivenessSession {
  private released = false;

  constructor(
    readonly queueId: string,
    private readonly key: string,
    private readonly client: ReleasableClient,
  ) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [this.key]);
      this.client.release();
    } catch (error) {
      // Never return a connection whose session may still hold a native-queue
      // fence to the pool. Destroying it makes PostgreSQL release the lock.
      this.client.release(true);
      throw error;
    }
  }
}

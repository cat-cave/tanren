import type pg from "pg";

/**
 * Cross-process serialization for the external deploy trigger. Postgres session
 * advisory locks need no schema migration and vanish automatically when a
 * crashed process loses its connection. A loser returns immediately: the winner
 * owns the run's full trigger/verify drive and appends its durable outcome.
 */
export interface DeployTriggerGate {
  run<T>(runId: string, work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
}

export class PgDeployTriggerGate implements DeployTriggerGate {
  // The advisory-lock key prefix. Defaults to the deploy trigger; a DISTINCT prefix (e.g.
  // the in-17 delivery demo gate) gives a separate lock namespace so cross-stage effects
  // never contend on one lock.
  constructor(
    private readonly pool: pg.Pool,
    private readonly keyPrefix: string = "deploy.triggered",
  ) {}

  async run<T>(runId: string, work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
    const client = await this.pool.connect();
    const key = `${this.keyPrefix}:${runId}`;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired !== true) return { acquired: false };
      try {
        return { acquired: true, value: await work() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      }
    } finally {
      client.release();
    }
  }
}

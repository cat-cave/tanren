/**
 * Best-effort scoped RLS read transaction for the plane-split smoke probe.
 * On any error after BEGIN, ROLLBACK runs before release and never masks the
 * original failure (rollback errors are swallowed).
 */

/** Structural client surface — compatible with pg PoolClient without importing pg. */
export interface ScopedTxClient {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  release(): void;
}

/**
 * BEGIN → set org GUC → work → COMMIT. On failure after BEGIN, best-effort
 * ROLLBACK, then rethrow the original error, then release in `finally`.
 */
export async function runScopedOrgRead<T>(
  client: ScopedTxClient,
  orgId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId ?? ""]);
    const value = await work();
    await client.query("COMMIT");
    began = false;
    return value;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Best-effort only — never mask the original probe error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

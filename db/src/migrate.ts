import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runDrizzleMigrations } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { createDbPool } from "./client.js";

const MIGRATION_LOCK_ID = "746741522030753001";

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    lockHeld = true;
    const db = drizzle(client);
    const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
    await runDrizzleMigrations(db, { migrationsFolder });
  } finally {
    try {
      if (lockHeld) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createDbPool();
  await migrate(pool);
  await pool.end();
}

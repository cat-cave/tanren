import { readFile } from "node:fs/promises";
import type pg from "pg";
import { createDbPool } from "./client.js";

export async function migrate(pool: pg.Pool): Promise<void> {
  const migrationUrl = new URL("../migrations/0001_hello_world.sql", import.meta.url);
  const sql = await readFile(migrationUrl, "utf8");
  await pool.query(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createDbPool();
  await migrate(pool);
  await pool.end();
}

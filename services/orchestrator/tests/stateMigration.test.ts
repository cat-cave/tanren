import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateEnumLists } from "@tanren/db";

const migrationsDir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

// Concatenates the full (append-only, name-ordered) migration history and
// verifies the CURRENT Zod enum lists each appear verbatim as a CHECK
// constraint. Migrations are immutable, so when an enum gains a value a NEW
// migration redefines the constraint with the full list — and that new
// migration is what carries the match. This keeps the SQL CHECK and the Zod
// source a single contract without freezing the assertion to one file.

async function readAllMigrations(): Promise<string> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  const contents = await Promise.all(sqlFiles.map((name) => readFile(`${migrationsDir}${name}`, "utf8")));
  return contents.join("\n");
}

function literalList(values: ReadonlyArray<string>): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
}

describe("typed-state-constraints migration history", () => {
  it("defines a status CHECK with the exact Zod-derived value list", async () => {
    const sql = await readAllMigrations();
    expect(sql).toContain(`"runs"."status" IN (${literalList(stateEnumLists.runs_status)})`);
    expect(sql).toContain(`"specs"."status" IN (${literalList(stateEnumLists.specs_status)})`);
    expect(sql).toContain(`"tasks"."status" IN (${literalList(stateEnumLists.tasks_status)})`);
    expect(sql).toContain(`"job_queue"."status" IN (${literalList(stateEnumLists.job_queue_status)})`);
  });

  it("defines nullable outcome CHECKs", async () => {
    const sql = await readAllMigrations();
    expect(sql).toContain(
      `"runs"."outcome" IS NULL OR "runs"."outcome" IN (${literalList(stateEnumLists.runs_outcome)})`,
    );
    expect(sql).toContain(
      `"tasks"."outcome" IS NULL OR "tasks"."outcome" IN (${literalList(stateEnumLists.tasks_outcome)})`,
    );
  });

  it("defines the task kind, agent_kind, and job task_kind CHECKs", async () => {
    const sql = await readAllMigrations();
    expect(sql).toContain(`"tasks"."kind" IN (${literalList(stateEnumLists.tasks_kind)})`);
    expect(sql).toContain(`"tasks"."agent_kind" IN (${literalList(stateEnumLists.tasks_agent_kind)})`);
    expect(sql).toContain(`"job_queue"."task_kind" IN (${literalList(stateEnumLists.job_queue_task_kind)})`);
  });
});

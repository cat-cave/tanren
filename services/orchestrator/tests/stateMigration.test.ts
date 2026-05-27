import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateEnumLists } from "../../../db/src/stateEnums.js";

const migrationPath = fileURLToPath(
  new URL("../../../db/migrations/0002_thankful_menace.sql", import.meta.url)
);

// Loads the committed migration and verifies the CHECK constraints in it
// match the values in the state enum mirror exactly. This guarantees that the
// SQL CHECK and Zod source remain a single contract.

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

function literalList(values: ReadonlyArray<string>): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
}

describe("0002 typed-state-constraints migration", () => {
  it("includes a status CHECK with the exact Zod-derived value list", async () => {
    const sql = await readMigration();
    expect(sql).toContain(`"runs"."status" IN (${literalList(stateEnumLists.runs_status)})`);
    expect(sql).toContain(`"specs"."status" IN (${literalList(stateEnumLists.specs_status)})`);
    expect(sql).toContain(`"tasks"."status" IN (${literalList(stateEnumLists.tasks_status)})`);
    expect(sql).toContain(`"job_queue"."status" IN (${literalList(stateEnumLists.job_queue_status)})`);
  });

  it("includes nullable outcome CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain(`"runs"."outcome" IS NULL OR "runs"."outcome" IN (${literalList(stateEnumLists.runs_outcome)})`);
    expect(sql).toContain(`"tasks"."outcome" IS NULL OR "tasks"."outcome" IN (${literalList(stateEnumLists.tasks_outcome)})`);
  });

  it("includes the task kind, agent_kind, and job task_kind CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain(`"tasks"."kind" IN (${literalList(stateEnumLists.tasks_kind)})`);
    expect(sql).toContain(`"tasks"."agent_kind" IN (${literalList(stateEnumLists.tasks_agent_kind)})`);
    expect(sql).toContain(`"job_queue"."task_kind" IN (${literalList(stateEnumLists.job_queue_task_kind)})`);
  });
});

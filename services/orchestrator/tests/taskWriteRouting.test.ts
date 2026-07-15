import { describe, expect, it } from "vitest";
import { applyUpdateTask } from "../src/engine/worker/runStateLifecycleSql.js";
import { ensureSystemTask } from "../src/engine/workflow/taskWriteRouting.js";
import type { RunStateWriter, UpdateTaskInput } from "../src/engine/contracts/runStateWriter.js";

class FakeTaskPool {
  readonly queries: { sql: string; params?: unknown[] }[] = [];

  async query(sql: string, params?: unknown[]): Promise<{ rows: { task_id: string }[]; rowCount: number }> {
    this.queries.push({ sql, params });
    if (/SELECT task_id FROM tasks/u.test(sql)) return { rows: [{ task_id: "task_existing" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
}

/**
 * A pool whose `tasks` SELECT returns a single MALFORMED row — the decode gate
 * (`ExistingTaskRow.parse`) must reject it as a Zod failure rather than handing a
 * wrong-type task_id to the downstream UPDATE (which would then target the wrong row).
 */
class MalformedTaskRowPool {
  constructor(private readonly row: unknown) {}

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (/SELECT task_id FROM tasks/u.test(sql)) return { rows: [this.row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

class RecordingWriter implements Pick<RunStateWriter, "updateTask"> {
  updates: UpdateTaskInput[] = [];

  async updateTask(input: UpdateTaskInput): Promise<void> {
    this.updates.push(input);
  }
}

describe("ensureSystemTask", () => {
  it("reopens an existing system task with stale terminal fields cleared on the direct path", async () => {
    const pool = new FakeTaskPool();

    const taskId = await ensureSystemTask(pool, { runId: "run_1", kind: "merge", title: "Merge pull request" });

    expect(taskId).toBe("task_existing");
    const update = pool.queries.find((q) => q.sql.startsWith("UPDATE tasks SET status = 'running'"));
    expect(update?.sql).toContain("outcome = NULL");
    expect(update?.sql).toContain("failure_kind = NULL");
    expect(update?.sql).toContain("ended_at = NULL");
  });

  it("routes reopened system tasks through the shared running transition for remote writes", async () => {
    const pool = new FakeTaskPool();
    const writer = new RecordingWriter() as RunStateWriter;

    await ensureSystemTask(pool, { runId: "run_1", kind: "merge", title: "Merge pull request" }, writer);

    expect(writer.updates).toEqual([{ taskId: "task_existing", transition: "running" }]);
  });
});

describe("applyUpdateTask", () => {
  it("clears stale outcome and failure kind on the running transition", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1 };
      },
    };

    await applyUpdateTask(client, { taskId: "task_existing", transition: "running" });

    expect(queries[0]?.sql).toContain("outcome = NULL");
    expect(queries[0]?.sql).toContain("failure_kind = NULL");
    expect(queries[0]?.sql).toContain("ended_at = NULL");
  });
});

describe("ensureSystemTask — ExistingTaskRow Zod decode rejects malformed rows", () => {
  it("REJECTS a task_id that is a number (wrong primitive type)", async () => {
    const pool = new MalformedTaskRowPool({ task_id: 123 });

    await expect(
      ensureSystemTask(pool, { runId: "run_1", kind: "merge", title: "Merge pull request" }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a null task_id", async () => {
    const pool = new MalformedTaskRowPool({ task_id: null });

    await expect(
      ensureSystemTask(pool, { runId: "run_1", kind: "merge", title: "Merge pull request" }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a row missing the task_id key entirely", async () => {
    const pool = new MalformedTaskRowPool({ unrelated: "field" });

    await expect(
      ensureSystemTask(pool, { runId: "run_1", kind: "merge", title: "Merge pull request" }),
    ).rejects.toThrow(/invalid_type/u);
  });
});
